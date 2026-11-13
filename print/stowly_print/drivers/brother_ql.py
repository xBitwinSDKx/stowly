"""Brother QL über USB und über TCP 9100 (docs/recherche.md, Abschnitt 5; docs/etiketten.md, 6).

Die Bibliothek ``brother_ql_next`` (Paketname ``brother_ql``) erzeugt den Rasterdatenstrom und
öffnet das USB-Gerät. Sie wird nur hier importiert, und zwar erst beim Benutzen: ``stowly_print``
bleibt ohne sie importierbar, und fehlt sie, meldet der Drucker ``config``.

Was der Treiber zusagt:

* ``printed`` nur über USB und nur, wenn das Gerät „Druck abgeschlossen" gemeldet hat.
* ``sent`` über TCP: Der Transport kann nur schreiben.
* ``failed`` nur, wenn sicher nichts hinausging: Gerät nicht gefunden, Verbindung abgelehnt,
  oder der Zustand vor dem Senden meldet schon den Fehler (Etiketten leer, falsche Rolle).
* Geht nach dem ersten gesendeten Byte etwas schief, wirft ``print``: Der Ausgang ist offen.

Rolle dieser Stufe ist die 62-mm-Endlosrolle bei 300 dpi (696 Pixel druckbar), geschnitten
wird nach jedem Etikett.
"""

import errno
import logging
import re
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

from PIL import Image

from stowly_print.model import Capabilities, DriverStatus, Media, PrinterError, PrintOutcome

log = logging.getLogger("stowly_print.brother_ql")

DPI = 300
DEFAULT_MEDIA = "62"
# Was gilt, solange die Bibliothek nichts anderes sagt: (Breite der Rolle in mm, druckbare Pixel).
DEFAULT_ROLL = (62.0, 696)
TCP_PORT = 9100
BROTHER_VENDOR_ID = 0x04F9

STATUS_LENGTH = 32
STATUS_HEADER = b"\x80\x20\x42"
# Byte 18 der Statusmeldung
STATUS_REPLY = 0x00
STATUS_COMPLETED = 0x01
STATUS_ERROR = 0x02
STATUS_NOTIFICATION = 0x05
STATUS_PHASE_CHANGE = 0x06
# Byte 19
PHASE_WAITING = 0x00
PHASE_PRINTING = 0x01

# Byte 8 und 9 der Statusmeldung: Bit -> Fehlercode (Raster Command Reference der QL-Reihe).
_ERRORS_1 = {
    0: PrinterError.NO_MEDIA,  # No media when printing
    1: PrinterError.NO_MEDIA,  # End of media (die-cut size only)
    2: PrinterError.CUTTER_JAM,  # Tape cutter jam
    4: PrinterError.BUSY,  # Main unit in use
    5: PrinterError.OFFLINE,  # Printer turned off
    6: PrinterError.UNKNOWN,  # High-voltage adapter
    7: PrinterError.UNKNOWN,  # Fan doesn't work
}
_ERRORS_2 = {
    0: PrinterError.MEDIA_MISMATCH,  # Replace media error
    1: PrinterError.UNKNOWN,  # Expansion buffer full error
    2: PrinterError.UNKNOWN,  # Transmission / Communication error
    3: PrinterError.UNKNOWN,  # Communication buffer full error
    4: PrinterError.COVER_OPEN,  # Cover opened while printing
    5: PrinterError.UNKNOWN,  # Cancel key
    6: PrinterError.NO_MEDIA,  # Media cannot be fed (also when the media end is detected)
    7: PrinterError.UNKNOWN,  # System error
}

# Schreibweisen, die dasselbe Gerät meinen. Die c-Modelle (USB-C) sprechen dieselbe Sprache.
_MODEL_ALIASES = {
    "QL-820NWBC": "QL-820NWB",
    "QL-810WC": "QL-810W",
}
_USB_ADDRESS = re.compile(
    r"^usb://(?:0x)?([0-9a-f]{4})(?::(?:0x)?([0-9a-f]{4}))?(?:/([A-Za-z0-9._-]{1,64}))?$", re.I
)


class ConfigError(Exception):
    """Mit diesen Angaben zum Drucker kann der Treiber nichts anfangen (Fehlercode ``config``)."""


class Unreachable(Exception):
    """Das Gerät ist nicht da oder nimmt keine Verbindung an. Es ging sicher nichts hinaus."""

    def __init__(self, message: str, code: PrinterError = PrinterError.OFFLINE) -> None:
        super().__init__(message)
        self.code = code


class PrintInterrupted(Exception):
    """Nach Beginn des Sendens ging etwas schief. Ob gedruckt wurde, ist offen."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class Transport(Protocol):
    """Der Weg zum Gerät: Bytes schreiben, Statusbytes lesen."""

    def write(self, data: bytes) -> None: ...

    def read(self, length: int = STATUS_LENGTH) -> bytes:
        """Was gerade anliegt, höchstens ``length`` Bytes; leer, wenn nichts da ist."""
        ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class Address:
    kind: str  # "usb" oder "tcp"
    vendor: int = BROTHER_VENDOR_ID
    product: int | None = None  # None = der erste Drucker dieses Herstellers
    serial: str | None = None
    host: str = ""
    port: int = TCP_PORT


def parse_address(text: str | None) -> Address:
    """Liest ``usb://04f9:209b`` oder ``tcp://192.168.1.60:9100``. ``ConfigError`` bei allem anderen.

    Bei USB darf das Produkt fehlen (``usb://04f9``): Dann gilt der erste Drucker des Herstellers.
    Bei TCP ist der Port freiwillig (Vorgabe 9100).
    """
    if not isinstance(text, str) or not text.strip():
        raise ConfigError("Die Adresse des Druckers fehlt.")
    text = text.strip()
    usb = _USB_ADDRESS.match(text)
    if usb:
        vendor, product, serial = usb.groups()
        return Address(
            kind="usb",
            vendor=int(vendor, 16),
            product=None if product is None else int(product, 16),
            serial=serial,
        )
    if text.lower().startswith("tcp://"):
        try:
            parts = urlsplit(text)
            host, port = parts.hostname, parts.port
        except ValueError as exc:
            raise ConfigError(f"Die Adresse '{text}' ist nicht lesbar.") from exc
        if host and parts.path in ("", "/") and not parts.query and not parts.username:
            return Address(kind="tcp", host=host, port=TCP_PORT if port is None else port)
    raise ConfigError(
        f"Die Adresse '{text}' ist nicht lesbar (erwartet usb://04f9:209b oder tcp://Adresse:9100)."
    )


def normalise_model(model: str | None) -> str:
    """Die Bezeichnung, wie die Bibliothek sie kennt: ``ql820nwbc`` wird ``QL-820NWB``."""
    if not isinstance(model, str) or not model.strip():
        raise ConfigError("Das Modell des Druckers fehlt.")
    name = model.strip().upper().replace(" ", "")
    if name.startswith("QL") and not name.startswith("QL-"):
        name = "QL-" + name[2:]
    return _MODEL_ALIASES.get(name, name)


# --------------------------------------------------------------------------- Statusmeldung


@dataclass(frozen=True)
class DeviceStatus:
    """Die 32 Byte, mit denen ein QL seinen Zustand meldet, soweit Stowly sie braucht."""

    errors: tuple[str, ...]
    media_width_mm: int
    media_type: int  # 0x00 keine Rolle; 0x0A/0x4A endlos; 0x0B/0x4B gestanzt
    media_length_mm: int
    status_type: int
    phase: int
    model_code: int

    @property
    def media_detected(self) -> bool:
        return self.media_type != 0x00 and self.media_width_mm > 0

    @property
    def endless(self) -> bool:
        return self.media_type & 0x0F == 0x0A


def parse_status(frame: bytes) -> DeviceStatus:
    """Deutet eine Statusmeldung. ``ValueError``, wenn es keine ist."""
    if len(frame) != STATUS_LENGTH or not frame.startswith(STATUS_HEADER):
        raise ValueError("keine Statusmeldung eines Brother QL")
    errors: list[str] = []
    for byte, table in ((frame[8], _ERRORS_1), (frame[9], _ERRORS_2)):
        for bit in range(8):
            if byte & (1 << bit):
                code = table.get(bit, PrinterError.UNKNOWN).value
                if code not in errors:
                    errors.append(code)
    return DeviceStatus(
        errors=tuple(errors),
        media_width_mm=frame[10],
        media_type=frame[11],
        media_length_mm=frame[17],
        status_type=frame[18],
        phase=frame[19],
        model_code=frame[4],
    )


class _StatusReader:
    """Liest Statusmeldungen aus einem Transport, auch wenn sie in Stücken ankommen."""

    def __init__(self, transport: Transport, sleep: Callable[[float], None]) -> None:
        self._transport = transport
        self._sleep = sleep
        self._buffer = bytearray()

    def next(self, deadline: float) -> DeviceStatus | None:
        """Die nächste Meldung, oder ``None``, wenn bis ``deadline`` keine kommt."""
        while True:
            start = self._buffer.find(STATUS_HEADER)
            if start < 0:
                # Ein Anfang der Kennung könnte am Ende stehen: die letzten zwei Bytes behalten.
                del self._buffer[:-2]
            else:
                del self._buffer[:start]
                if len(self._buffer) >= STATUS_LENGTH:
                    frame = bytes(self._buffer[:STATUS_LENGTH])
                    del self._buffer[:STATUS_LENGTH]
                    return parse_status(frame)
            if time.monotonic() >= deadline:
                return None
            chunk = self._transport.read(STATUS_LENGTH)
            if chunk:
                self._buffer += chunk
            else:
                self._sleep(0.01)


# --------------------------------------------------------------------------- Transporte


class TcpTransport:
    """Roher Druck über TCP (Port 9100). Schreibt nur; eine Antwort gibt es nicht."""

    def __init__(self, host: str, port: int, *, connect_timeout: float, write_timeout: float) -> None:
        try:
            self._socket = socket.create_connection((host, port), timeout=connect_timeout)
        except OSError as exc:
            raise Unreachable(f"Keine Verbindung zu {host}:{port} ({exc}).") from exc
        self._socket.settimeout(write_timeout)

    def write(self, data: bytes) -> None:
        self._socket.sendall(data)

    def read(self, length: int = STATUS_LENGTH) -> bytes:
        return b""

    def finish(self, linger: float) -> None:
        """Schließt die Schreibrichtung und wartet kurz, ob die Gegenseite die Verbindung abbricht.

        ``sendall`` kehrt zurück, sobald das Betriebssystem die Daten hat. Hat der Drucker
        die Verbindung mittendrin zurückgesetzt, zeigt sich das erst hier.
        """
        self._socket.shutdown(socket.SHUT_WR)
        self._socket.settimeout(linger)
        try:
            while self._socket.recv(256):
                pass
        except TimeoutError:
            # Der Drucker hält die Verbindung einfach offen: kein Fehler.
            return

    def close(self) -> None:
        try:
            self._socket.close()
        except OSError:
            pass


class UsbTransport:
    """Das USB-Gerät über das pyusb-Backend der Bibliothek."""

    def __init__(self, address: Address) -> None:
        try:
            import usb.core
            import usb.util
            from brother_ql.backends import pyusb as backend
        except ImportError as exc:
            raise ConfigError("Für USB fehlt pyusb oder die Bibliothek brother_ql_next.") from exc
        self._usb_core = usb.core
        try:
            candidates = [entry["instance"] for entry in backend.list_available_devices()]
        except usb.core.NoBackendError as exc:
            raise ConfigError("Für USB fehlt die Systembibliothek libusb-1.0.") from exc
        except usb.core.USBError as exc:
            raise Unreachable(f"USB lässt sich nicht abfragen ({exc}).") from exc

        device = None
        for candidate in candidates:
            if candidate.idVendor != address.vendor:
                continue
            if address.product is not None and candidate.idProduct != address.product:
                continue
            if address.serial is not None:
                try:
                    serial = usb.util.get_string(candidate, candidate.iSerialNumber)
                except (usb.core.USBError, ValueError, NotImplementedError):
                    serial = None
                if serial != address.serial:
                    continue
            device = candidate
            break
        if device is None:
            raise Unreachable(
                "Der Drucker ist am USB nicht zu finden (ausgeschaltet oder im Editor-Lite-Modus?)."
            )
        try:
            self._backend = backend.BrotherQLBackendPyUSB(device)
        except usb.core.USBError as exc:
            if exc.errno in (errno.EACCES, errno.EPERM):
                raise ConfigError(
                    "Kein Zugriff auf den USB-Drucker (udev-Regel oder Gruppe plugdev fehlt)."
                ) from exc
            raise Unreachable(f"Der USB-Drucker lässt sich nicht öffnen ({exc}).") from exc
        except (AssertionError, NotImplementedError, ValueError) as exc:
            raise Unreachable(f"Der USB-Drucker lässt sich nicht öffnen ({exc!r}).") from exc

    def write(self, data: bytes) -> None:
        self._backend.write(data)

    def read(self, length: int = STATUS_LENGTH) -> bytes:
        try:
            return bytes(self._backend.read(length))
        except self._usb_core.USBTimeoutError:
            return b""

    def close(self) -> None:
        self._backend.dispose()


# --------------------------------------------------------------------------- Treiber


@dataclass(frozen=True)
class _Setup:
    """Die geprüften Angaben zum Drucker."""

    model: str
    label: str
    address: Address
    width_mm: float
    printable_px: int
    cutter: bool
    min_length_px: int
    max_length_px: int


class BrotherQLDriver:
    """Ein Brother QL. Die Angaben werden erst beim Benutzen geprüft; ein Fehler darin ist ``config``."""

    def __init__(
        self,
        *,
        model: str | None,
        address: str | None,
        media: str | None = DEFAULT_MEDIA,
        opener: Callable[[Address], Transport] | None = None,
        connect_timeout: float = 0.7,
        write_timeout: float = 10.0,
        status_timeout: float = 2.0,
        print_timeout: float = 20.0,
        settle_timeout: float = 2.0,
        linger: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._model = model
        self._address_text = address
        self._media = media
        self._opener = opener
        self._connect_timeout = connect_timeout
        self._write_timeout = write_timeout
        self._status_timeout = status_timeout
        self._print_timeout = print_timeout
        self._settle_timeout = settle_timeout
        self._linger = linger
        self._sleep = sleep
        self._lock = threading.Lock()
        self._setup: _Setup | None = None
        self._problem: str | None = None
        self._checked = False
        self.last_error: str | None = None

    # ------------------------------------------------------------------ Angaben prüfen

    def _library(self) -> Any:
        """Die Bibliothek, erst beim Benutzen geladen."""
        try:
            from brother_ql import conversion, labels, models, raster
        except ImportError as exc:
            raise ConfigError("Die Bibliothek brother_ql_next ist nicht installiert.") from exc
        return conversion, labels, models, raster

    def _check(self) -> _Setup | None:
        """Prüft Modell, Rolle und Adresse einmal. ``None`` heißt ``config``; der Grund steht im Log."""
        if not self._checked:
            try:
                self._setup = self._examine()
            except ConfigError as exc:
                self._problem = str(exc)
                log.warning("Drucker nicht benutzbar: %s", exc)
            self._checked = True
        return self._setup

    def _examine(self) -> _Setup:
        address = parse_address(self._address_text)
        model_name = normalise_model(self._model)
        _conversion, labels, models, _raster = self._library()
        model = models.ModelsManager().get(model_name)
        if model is None:
            raise ConfigError(f"Das Modell '{self._model}' kennt der Treiber nicht.")
        label_name = (self._media or "").strip()
        label = labels.LabelsManager().get(label_name)
        if label is None:
            raise ConfigError(f"Die Rolle '{self._media}' kennt der Treiber nicht.")
        if label.form_factor != labels.FormFactor.ENDLESS or label.color != labels.Color.BLACK_WHITE:
            raise ConfigError(f"Die Rolle '{self._media}' ist keine einfarbige Endlosrolle.")
        return _Setup(
            model=model_name,
            label=label_name,
            address=address,
            width_mm=float(label.tape_size[0]),
            printable_px=int(label.dots_printable[0]),
            cutter=bool(model.cutting),
            min_length_px=int(model.min_max_length_dots[0]),
            max_length_px=int(model.min_max_length_dots[1]),
        )

    @property
    def problem(self) -> str | None:
        """Warum der Drucker nicht benutzbar ist, oder ``None``."""
        self._check()
        return self._problem

    def _is_usb(self) -> bool:
        return isinstance(self._address_text, str) and self._address_text.strip().lower().startswith("usb://")

    # ------------------------------------------------------------------ Treiber-Schnittstelle

    def capabilities(self) -> Capabilities:
        """Spricht das Gerät nicht an. Bei unbrauchbaren Angaben gilt die Vorgabe (62 mm, 696 Pixel)."""
        setup = self._check()
        width_mm, printable_px = DEFAULT_ROLL if setup is None else (setup.width_mm, setup.printable_px)
        usb = self._is_usb()
        return Capabilities(
            dpi=DPI,
            media=Media(width_mm=width_mm, length_mm=None, printable_px=printable_px),
            cutter=True if setup is None else setup.cutter,
            colors=["black"],
            status_query=usb,
            confirms_print=usb,
        )

    def status(self) -> DriverStatus:
        try:
            setup = self._check()
            if setup is None:
                return DriverStatus(reachable=False, ready=None, media_detected=None, errors=["config"])
            # Während eines Drucks gehört das Gerät dem Druck: nicht dazwischenfunken.
            if not self._lock.acquire(blocking=False):
                return DriverStatus(reachable=True, ready=False, media_detected=None, errors=["busy"])
            try:
                return self._query(setup)
            finally:
                self._lock.release()
        except Exception:  # status() wirft nie
            log.exception("Der Zustand des Druckers ließ sich nicht feststellen.")
            return DriverStatus(reachable=False, ready=None, media_detected=None, errors=["unknown"])

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        with self._lock:
            self.last_error = None
            setup = self._check()
            if setup is None:
                return self._failed(PrinterError.CONFIG)
            if image.mode != "1" or image.size[0] != setup.printable_px:
                log.error("Bild passt nicht zum Drucker: %s, Modus %s.", image.size, image.mode)
                return self._failed(PrinterError.CONFIG)
            if not setup.min_length_px <= image.size[1] <= setup.max_length_px:
                log.error(
                    "Etikett ist %d Punkte lang, das Modell druckt %d bis %d.",
                    image.size[1],
                    setup.min_length_px,
                    setup.max_length_px,
                )
                return self._failed(PrinterError.CONFIG)
            try:
                data = self.raster(image, cut=cut)
                transport = self._open(setup)
            except ConfigError as exc:
                log.error("Drucker nicht benutzbar: %s", exc)
                return self._failed(PrinterError.CONFIG)
            except Unreachable as exc:
                log.warning("Drucker nicht erreichbar: %s", exc)
                return self._failed(exc.code)
            try:
                if setup.address.kind == "usb":
                    return self._print_usb(setup, transport, data)
                return self._print_tcp(transport, data)
            finally:
                transport.close()

    # ------------------------------------------------------------------ Datenstrom

    def raster(self, image: Image.Image, *, cut: bool = True) -> bytes:
        """Der vollständige Rasterdatenstrom für ein Etikett, ohne Komprimierung (der QL-800 kann keine)."""
        setup = self._check()
        if setup is None:
            raise ConfigError(self._problem or "Die Angaben zum Drucker sind unbrauchbar.")
        conversion, _labels, _models, raster = self._library()
        instructions = raster.BrotherQLRaster(setup.model)
        # Was ein Modell nicht kann, lässt die Bibliothek dann still weg, statt zu warnen.
        instructions.exception_on_warning = True
        try:
            return bytes(
                conversion.convert(
                    instructions,
                    [image],
                    setup.label,
                    cut=cut,
                    dither=False,
                    compress=False,
                    red=False,
                    rotate=0,
                    dpi_600=False,
                    hq=True,
                    threshold=70,
                )
            )
        except Exception as exc:
            raise ConfigError(f"Der Datenstrom ließ sich nicht erzeugen ({exc!r}).") from exc

    def _status_request(self, setup: _Setup) -> bytes:
        """Puffer leeren und nach dem Zustand fragen (wie die Bibliothek es tut)."""
        _conversion, _labels, _models, raster = self._library()
        instructions = raster.BrotherQLRaster(setup.model)
        instructions.add_invalidate()
        instructions.add_status_information()
        return bytes(instructions.data)

    # ------------------------------------------------------------------ Gerät

    def _open(self, setup: _Setup) -> Transport:
        if self._opener is not None:
            return self._opener(setup.address)
        if setup.address.kind == "usb":
            return UsbTransport(setup.address)
        return TcpTransport(
            setup.address.host,
            setup.address.port,
            connect_timeout=self._connect_timeout,
            write_timeout=self._write_timeout,
        )

    def _failed(self, code: PrinterError | str) -> PrintOutcome:
        self.last_error = str(getattr(code, "value", code))
        return PrintOutcome.FAILED

    def _problems(self, setup: _Setup, status: DeviceStatus) -> list[str]:
        """Fehlercodes einer Statusmeldung, dazu „keine Rolle" und „falsche Rolle"."""
        errors = list(status.errors)
        if not status.media_detected:
            if PrinterError.NO_MEDIA.value not in errors:
                errors.append(PrinterError.NO_MEDIA.value)
        elif status.media_width_mm != round(setup.width_mm) or status.media_type & 0x0F == 0x0B:
            if PrinterError.MEDIA_MISMATCH.value not in errors:
                errors.append(PrinterError.MEDIA_MISMATCH.value)
        return errors

    def _query(self, setup: _Setup) -> DriverStatus:
        try:
            transport = self._open(setup)
        except ConfigError as exc:
            log.warning("Drucker nicht benutzbar: %s", exc)
            return DriverStatus(reachable=False, ready=None, media_detected=None, errors=["config"])
        except Unreachable as exc:
            return DriverStatus(reachable=False, ready=None, media_detected=None, errors=[exc.code.value])
        try:
            if setup.address.kind != "usb":
                # Über das Netz gibt es keinen Zustand (nur per SNMP): Erreichbar ist alles, was sich sagen lässt.
                return DriverStatus(reachable=True, ready=None, media_detected=None, errors=[])
            try:
                transport.write(self._status_request(setup))
                status = _StatusReader(transport, self._sleep).next(time.monotonic() + self._status_timeout)
            except Exception as exc:
                log.warning("Der Drucker antwortet nicht auf die Statusabfrage (%s).", exc)
                return DriverStatus(reachable=True, ready=None, media_detected=None, errors=["unknown"])
            if status is None:
                return DriverStatus(reachable=True, ready=None, media_detected=None, errors=["unknown"])
            errors = self._problems(setup, status)
            return DriverStatus(
                reachable=True,
                ready=not errors and status.phase == PHASE_WAITING,
                media_detected=status.media_detected,
                errors=errors,
            )
        finally:
            transport.close()

    def _print_tcp(self, transport: Transport, data: bytes) -> PrintOutcome:
        try:
            transport.write(data)
            finish = getattr(transport, "finish", None)
            if finish is not None:
                finish(self._linger)
        except Exception as exc:
            raise PrintInterrupted(f"Die Verbindung zum Drucker brach beim Senden ab ({exc}).") from exc
        return PrintOutcome.SENT

    def _print_usb(self, setup: _Setup, transport: Transport, data: bytes) -> PrintOutcome:
        reader = _StatusReader(transport, self._sleep)
        # 1. Zustand vor dem Senden: Hier lässt sich noch sicher „nichts gedruckt" sagen.
        try:
            transport.write(self._status_request(setup))
            before = reader.next(time.monotonic() + self._status_timeout)
        except Exception as exc:
            log.warning("Statusabfrage vor dem Druck gescheitert: %s", exc)
            return self._failed(PrinterError.OFFLINE)
        if before is None:
            log.warning("Der Drucker hat vor dem Druck nicht auf die Statusabfrage geantwortet.")
            return self._failed(PrinterError.UNKNOWN)
        problems = self._problems(setup, before)
        if problems:
            return self._failed(problems[0])

        # 2. Senden. Ab dem ersten Byte ist der Ausgang offen.
        try:
            transport.write(data)
        except Exception as exc:
            raise PrintInterrupted(f"Die Verbindung zum Drucker brach beim Senden ab ({exc}).") from exc

        # 3. Auf die Bestätigung warten.
        deadline = time.monotonic() + self._print_timeout
        completed = False
        while True:
            try:
                status = reader.next(deadline)
            except Exception as exc:
                if completed:
                    break
                raise PrintInterrupted(f"Die Verbindung zum Drucker brach beim Drucken ab ({exc}).") from exc
            if status is None:
                break
            if status.errors or status.status_type == STATUS_ERROR:
                if completed:
                    break
                code = status.errors[0] if status.errors else PrinterError.UNKNOWN.value
                raise PrintInterrupted(f"Der Drucker meldet beim Drucken einen Fehler ({code}).", code)
            if status.status_type == STATUS_COMPLETED:
                completed = True
                # Kurz warten, bis er wieder bereit ist, damit das nächste Etikett ihn nicht belegt antrifft.
                deadline = min(deadline, time.monotonic() + self._settle_timeout)
            elif completed and status.status_type == STATUS_PHASE_CHANGE and status.phase == PHASE_WAITING:
                break
        if completed:
            return PrintOutcome.PRINTED
        raise PrintInterrupted("Der Drucker hat den Druck nicht bestätigt.")
