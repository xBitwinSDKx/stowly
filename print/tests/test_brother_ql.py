"""Brother QL ohne Drucker: Datenstrom, Transporte, Statusauswertung.

Der USB-Weg läuft gegen einen nachgebildeten Transport, der TCP-Weg gegen einen Socket auf
127.0.0.1. Die Statusbytes sind nach der „Raster Command Reference" der QL-Reihe gebaut.

Referenz-Datenstrom neu schreiben: ``python -m pytest tests/test_brother_ql.py --update-references``
"""

import importlib.util
import socket
import struct
import sys
import threading
import time

import pytest
from PIL import Image
from print_support import REFERENCE_DIR, new_id, package_request

from stowly_print.drivers.brother_ql import (
    STATUS_COMPLETED,
    STATUS_ERROR,
    STATUS_PHASE_CHANGE,
    STATUS_REPLY,
    Address,
    BrotherQLDriver,
    ConfigError,
    PrintInterrupted,
    Unreachable,
    normalise_model,
    parse_address,
    parse_status,
)
from stowly_print.model import JobState, PrintOutcome
from stowly_print.render import Fonts
from stowly_print.service import PrinterEntry, PrintService, StaticPrinters

needs_library = pytest.mark.skipif(
    importlib.util.find_spec("brother_ql") is None,
    reason="Die Bibliothek brother_ql_next ist nicht installiert.",
)

USB = "usb://04f9:209b"
INVALIDATE = b"\x00" * 400
STATUS_REQUEST = b"\x1b\x69\x53"


def reference_label() -> Image.Image:
    with Image.open(REFERENCE_DIR / "package-62x29.png") as stored:
        return stored.copy()


def frame(
    *,
    errors_1: int = 0,
    errors_2: int = 0,
    width: int = 62,
    media_type: int = 0x0A,
    length: int = 0,
    status_type: int = STATUS_REPLY,
    phase: int = 0,
    model: int = 0x38,
) -> bytes:
    """Eine Statusmeldung (32 Byte): Kopf 80 20 42, Fehler in Byte 8 und 9, Rolle in 10, 11 und 17."""
    data = bytearray(32)
    data[0:8] = bytes([0x80, 0x20, 0x42, 0x34, model, 0x30, 0x04, 0x00])
    data[8], data[9], data[10], data[11] = errors_1, errors_2, width, media_type
    data[17], data[18], data[19] = length, status_type, phase
    return bytes(data)


READY = frame()
NO_MEDIA = frame(width=0, media_type=0x00, errors_1=0x01)
COVER_OPEN = frame(errors_2=0x10, status_type=STATUS_ERROR)
PRINTING = frame(status_type=STATUS_PHASE_CHANGE, phase=1)
COMPLETED = frame(status_type=STATUS_COMPLETED, phase=1)
WAITING = frame(status_type=STATUS_PHASE_CHANGE, phase=0)


class FakeUsb:
    """Ein USB-Gerät auf dem Papier: merkt sich, was geschrieben wurde, und antwortet nach Drehbuch.

    ``replies`` ist die Folge der Antworten: Auf den n-ten Schreibvorgang hin liegen die Bytes
    des n-ten Eintrags zum Lesen bereit.
    """

    def __init__(self, *replies: bytes, chunk: int = 32) -> None:
        self.replies = list(replies)
        self.written: list[bytes] = []
        self.pending = bytearray()
        self.closed = False
        self.fail_on_write: int | None = None
        self.chunk = chunk

    def write(self, data: bytes) -> None:
        if self.fail_on_write is not None and len(self.written) + 1 >= self.fail_on_write:
            raise OSError("USB-Verbindung getrennt")
        self.written.append(bytes(data))
        if self.replies:
            self.pending += self.replies.pop(0)

    def read(self, length: int = 32) -> bytes:
        size = min(length, self.chunk)
        data = bytes(self.pending[:size])
        del self.pending[:size]
        return data

    def close(self) -> None:
        self.closed = True


def usb_driver(device: FakeUsb | Exception, **options) -> BrotherQLDriver:
    """Ein Treiber am nachgebildeten USB mit kurzen Fristen."""

    def opener(address: Address):
        assert address == Address(kind="usb", vendor=0x04F9, product=0x209B)
        if isinstance(device, Exception):
            raise device
        return device

    options.setdefault("status_timeout", 0.3)
    options.setdefault("print_timeout", 0.6)
    options.setdefault("settle_timeout", 0.2)
    return BrotherQLDriver(model="QL-800", address=USB, media="62", opener=opener, **options)


# --- Adresse und Modell ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("usb://04f9:209b", Address("usb", 0x04F9, 0x209B)),
        ("usb://0x04F9:0x209B", Address("usb", 0x04F9, 0x209B)),
        ("USB://04f9:209d/000A1B2C3", Address("usb", 0x04F9, 0x209D, "000A1B2C3")),
        ("usb://04f9", Address("usb", 0x04F9, None)),
        (" tcp://192.168.1.60:9100 ", Address("tcp", host="192.168.1.60", port=9100)),
        ("tcp://192.168.1.60", Address("tcp", host="192.168.1.60", port=9100)),
        ("tcp://drucker.lan:9101/", Address("tcp", host="drucker.lan", port=9101)),
        ("tcp://[fe80::1]:9100", Address("tcp", host="fe80::1", port=9100)),
    ],
)
def test_addresses_the_driver_understands(text, expected):
    assert parse_address(text) == expected


@pytest.mark.parametrize(
    "text",
    [None, "", "   ", "192.168.1.60", "http://192.168.1.60", "tcp://", "tcp://:9100", "tcp://host:port",
     "tcp://host:99999", "tcp://host/pfad", "tcp://nutzer@host", "usb://", "usb://04f9:", "usb://zzzz:209b",
     "usb://04f9:209b:1", "lp0", "file:///dev/usb/lp0", 5],
)  # fmt: skip
def test_addresses_the_driver_cannot_read(text):
    with pytest.raises(ConfigError):
        parse_address(text)


def test_model_names_are_matched_generously():
    assert normalise_model("QL-800") == "QL-800"
    assert normalise_model(" ql-820nwb ") == "QL-820NWB"
    assert normalise_model("QL820NWB") == "QL-820NWB"
    # Die c-Modelle (USB-C) sprechen dieselbe Sprache wie ihre Vorgänger.
    assert normalise_model("QL-820NWBc") == "QL-820NWB"
    assert normalise_model("QL-810Wc") == "QL-810W"
    for nothing in (None, "", "  "):
        with pytest.raises(ConfigError):
            normalise_model(nothing)


@needs_library
def test_library_knows_the_models_the_app_suggests():
    from brother_ql.labels import LabelsManager
    from brother_ql.models import ModelsManager

    known = ModelsManager().identifiers()
    assert {"QL-800", "QL-810W", "QL-820NWB"} <= set(known)
    roll = LabelsManager().get("62")
    assert (roll.tape_size, roll.dots_printable) == ((62, 0), (696, 0))


# --- Fähigkeiten und unbrauchbare Angaben ------------------------------------------------


@needs_library
def test_capabilities_do_not_touch_the_device():
    opened = []
    usb = BrotherQLDriver(model="QL-800", address=USB, opener=lambda address: opened.append(address))
    capabilities = usb.capabilities()
    assert (capabilities.dpi, capabilities.cutter, capabilities.colors) == (300, True, ["black"])
    assert (capabilities.media.width_mm, capabilities.media.length_mm, capabilities.media.printable_px) == (
        62.0,
        None,
        696,
    )
    # Über USB antwortet das Gerät: Zustand abfragbar, Druck wird bestätigt.
    assert (capabilities.status_query, capabilities.confirms_print) == (True, True)
    tcp = BrotherQLDriver(model="QL-820NWB", address="tcp://192.168.1.60:9100").capabilities()
    assert (tcp.status_query, tcp.confirms_print) == (False, False)
    assert opened == []
    assert usb.problem is None


@needs_library
@pytest.mark.parametrize(
    ("model", "address", "media", "reason"),
    [
        ("QL-9999", USB, "62", "Modell"),
        ("Zebra ZD421", USB, "62", "Modell"),
        (None, USB, "62", "Modell"),
        ("QL-800", "irgendwo", "62", "Adresse"),
        ("QL-800", None, "62", "Adresse"),
        ("QL-800", USB, "63", "Rolle"),
        ("QL-800", USB, "", "Rolle"),
        ("QL-800", USB, "62x29", "Endlosrolle"),  # gestanzte Etiketten: nicht in dieser Stufe
        ("QL-800", USB, "62red", "Endlosrolle"),  # zweifarbige Rolle
    ],
)
def test_unusable_settings_report_config_and_keep_the_printer_listed(model, address, media, reason):
    opened = []
    driver = BrotherQLDriver(
        model=model, address=address, media=media, opener=lambda address: opened.append(address)
    )
    status = driver.status()
    assert (status.reachable, status.ready, status.media_detected, status.errors) == (
        False,
        None,
        None,
        ["config"],
    )
    assert reason in driver.problem
    # Die Fähigkeiten gibt es trotzdem (Vorgabe), und ein Druck scheitert sicher, ohne das Gerät anzufassen.
    assert driver.capabilities().media.printable_px == 696
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "config"
    assert opened == []
    with pytest.raises(ConfigError):
        driver.raster(reference_label())


def test_missing_library_reports_config(monkeypatch):
    monkeypatch.setitem(sys.modules, "brother_ql", None)
    driver = BrotherQLDriver(model="QL-800", address=USB)
    assert driver.status().errors == ["config"]
    assert "brother_ql_next" in driver.problem
    assert driver.print(Image.new("1", (696, 342), 1)) == PrintOutcome.FAILED
    assert driver.last_error == "config"
    assert driver.capabilities().media.printable_px == 696


# --- Datenstrom --------------------------------------------------------------------------


def split_stream(data: bytes) -> dict:
    """Zerlegt den Rasterdatenstrom in seine Befehle (nur das, was der Treiber erzeugen soll)."""
    parts: dict = {"rows": [], "order": []}
    position = 0

    def take(count: int) -> bytes:
        nonlocal position
        chunk = data[position : position + count]
        assert len(chunk) == count, "Datenstrom endet mitten in einem Befehl"
        position += count
        return chunk

    def note(name: str) -> None:
        if not parts["order"] or parts["order"][-1] != name:
            parts["order"].append(name)

    while position < len(data):
        if data[position] == 0x00:
            start = position
            while position < len(data) and data[position] == 0x00:
                position += 1
            parts["invalidate"] = position - start
            note("invalidate")
        elif data.startswith(b"\x1b\x40", position):
            take(2)
            note("init")
        elif data.startswith(b"\x1b\x69\x61", position):
            parts["mode"] = take(4)[3]
            note("mode")
        elif data.startswith(b"\x1b\x69\x53", position):
            take(3)
            note("status request")
        elif data.startswith(b"\x1b\x69\x7a", position):
            parts["media"] = take(13)[3:]
            note("media")
        elif data.startswith(b"\x1b\x69\x4d", position):
            parts["autocut"] = take(4)[3]
            note("autocut")
        elif data.startswith(b"\x1b\x69\x41", position):
            parts["cut every"] = take(4)[3]
            note("cut every")
        elif data.startswith(b"\x1b\x69\x4b", position):
            parts["expanded"] = take(4)[3]
            note("expanded")
        elif data.startswith(b"\x1b\x69\x64", position):
            parts["margin"] = struct.unpack("<H", take(5)[3:])[0]
            note("margin")
        elif data[position] == 0x67:
            header = take(3)
            assert header[1] == 0x00
            parts["rows"].append(take(header[2]))
            note("raster")
        elif data[position] == 0x1A:
            take(1)
            note("print")
        else:
            raise AssertionError(f"unbekannter Befehl bei {position}: {data[position : position + 4].hex()}")
    return parts


def image_from_rows(rows: list[bytes]) -> Image.Image:
    """Macht aus den Rasterzeilen wieder das Etikett: 720 Punkte je Zeile, gespiegelt, 12 Punkte Rand."""
    full = Image.frombytes("1", (720, len(rows)), b"".join(rows)).transpose(Image.FLIP_LEFT_RIGHT)
    assert full.crop((0, 0, 12, len(rows))).getbbox() is None
    assert full.crop((708, 0, 720, len(rows))).getbbox() is None
    # Im Datenstrom heißt ein gesetztes Bit „schwarz", im Bild heißt 0 „schwarz".
    return full.crop((12, 0, 708, len(rows))).point(lambda value: 0 if value else 255, mode="1")


@needs_library
@pytest.mark.parametrize("model", ["QL-800", "QL-810W", "QL-820NWB", "QL-820NWBc"])
def test_raster_stream_has_the_expected_structure(model):
    label = reference_label()
    data = BrotherQLDriver(model=model, address=USB).raster(label)
    parts = split_stream(data)
    assert parts["order"] == [
        "mode", "invalidate", "init", "mode", "status request", "media", "autocut", "cut every",
        "expanded", "margin", "raster", "print",
    ]  # fmt: skip
    assert parts["mode"] == 0x01  # Rastermodus
    assert parts["invalidate"] == 400

    # Medienangabe: Endlosrolle (0x0A), 62 mm breit, Länge 0, 342 Rasterzeilen, erste Seite.
    flags, media_type, width, length = parts["media"][0:4]
    assert flags & 0x80 and flags & 0x02 and flags & 0x04 and flags & 0x40
    assert (media_type, width, length) == (0x0A, 62, 0)
    assert struct.unpack("<L", parts["media"][4:8])[0] == 342
    assert parts["media"][8:10] == b"\x00\x00"

    # Schnitt nach jedem Etikett, 3 mm Vorschub (35 Punkte), keine zweite Farbe, 300 dpi.
    assert parts["autocut"] == 0x40
    assert parts["cut every"] == 1
    assert parts["expanded"] == 0x08
    assert parts["margin"] == 35

    # 342 Rasterzeilen zu je 90 Byte, unkomprimiert; am Ende der Druckbefehl.
    assert len(parts["rows"]) == 342
    assert {len(row) for row in parts["rows"]} == {90}
    assert data.endswith(b"\x1a")
    assert len(data) == 4 + 400 + 2 + 4 + 3 + 13 + 4 + 4 + 4 + 5 + 342 * 93 + 1

    # Aus den Rasterzeilen entsteht wieder genau das Etikett.
    assert image_from_rows(parts["rows"]).tobytes() == label.tobytes()


@needs_library
def test_raster_stream_without_cut():
    parts = split_stream(BrotherQLDriver(model="QL-800", address=USB).raster(reference_label(), cut=False))
    assert "autocut" not in parts and "cut every" not in parts
    assert parts["expanded"] == 0x00
    assert len(parts["rows"]) == 342


@needs_library
def test_raster_stream_matches_the_stored_reference(update_references):
    data = BrotherQLDriver(model="QL-800", address=USB).raster(reference_label())
    path = REFERENCE_DIR / "package-62x29.QL-800.bin"
    if update_references:
        path.write_bytes(data)
    assert data == path.read_bytes()
    # Dasselbe für die Geräte mit Netzwerk: Ohne Komprimierung unterscheidet sich der Strom nicht.
    assert BrotherQLDriver(model="QL-820NWB", address="tcp://192.168.1.60").raster(reference_label()) == data


# --- Statusmeldung -----------------------------------------------------------------------


def test_status_bytes_ready():
    status = parse_status(READY)
    assert status.errors == ()
    assert (status.media_width_mm, status.media_type, status.media_length_mm) == (62, 0x0A, 0)
    assert (status.status_type, status.phase, status.model_code) == (STATUS_REPLY, 0, 0x38)
    assert status.media_detected and status.endless
    # Die QL-800-Reihe meldet die Endlosrolle als 0x4A.
    assert parse_status(frame(media_type=0x4A)).endless
    assert not parse_status(frame(media_type=0x4B, length=29)).endless


def test_status_bytes_errors():
    assert parse_status(NO_MEDIA).errors == ("no_media",)
    assert not parse_status(NO_MEDIA).media_detected
    assert parse_status(COVER_OPEN).errors == ("cover_open",)
    assert parse_status(frame(errors_1=0x04)).errors == ("cutter_jam",)
    assert parse_status(frame(errors_1=0x02)).errors == ("no_media",)  # Ende der Rolle
    assert parse_status(frame(errors_2=0x40)).errors == ("no_media",)  # lässt sich nicht einziehen
    assert parse_status(frame(errors_2=0x01)).errors == ("media_mismatch",)
    assert parse_status(frame(errors_1=0x10)).errors == ("busy",)
    assert parse_status(frame(errors_2=0x80)).errors == ("unknown",)
    # Mehrere Fehler zugleich, jeder Code nur einmal.
    assert parse_status(frame(errors_1=0x05, errors_2=0x50)).errors == (
        "no_media",
        "cutter_jam",
        "cover_open",
    )


@pytest.mark.parametrize("data", [b"", READY[:31], READY + b"\x00", b"\x81" + READY[1:], b"\x00" * 32])
def test_status_bytes_that_are_no_status(data):
    with pytest.raises(ValueError):
        parse_status(data)


@needs_library
@pytest.mark.parametrize(
    ("reply", "ready", "media", "errors"),
    [
        (READY, True, True, []),
        (frame(media_type=0x4A), True, True, []),
        (NO_MEDIA, False, False, ["no_media"]),
        (frame(width=0, media_type=0x00), False, False, ["no_media"]),
        (COVER_OPEN, False, True, ["cover_open"]),
        (frame(errors_1=0x04), False, True, ["cutter_jam"]),
        (frame(width=29), False, True, ["media_mismatch"]),  # andere Rolle eingelegt
        (frame(media_type=0x0B, length=29), False, True, ["media_mismatch"]),  # gestanzte Etiketten
        (frame(status_type=STATUS_PHASE_CHANGE, phase=1), False, True, []),  # druckt gerade
    ],
)
def test_status_over_usb(reply, ready, media, errors):
    device = FakeUsb(reply)
    status = usb_driver(device).status()
    assert (status.reachable, status.ready, status.media_detected, status.errors) == (
        True,
        ready,
        media,
        errors,
    )
    # Gefragt wird wie die Bibliothek: Puffer leeren, dann die Statusabfrage. Danach ist das Gerät wieder frei.
    assert device.written == [INVALIDATE + STATUS_REQUEST]
    assert device.closed


@needs_library
def test_status_over_usb_when_the_device_is_missing_silent_or_broken():
    status = usb_driver(Unreachable("nicht am USB")).status()
    assert (status.reachable, status.errors) == (False, ["offline"])
    status = usb_driver(ConfigError("libusb fehlt")).status()
    assert (status.reachable, status.errors) == (False, ["config"])
    # Gefunden, aber keine Antwort: erreichbar, sonst unbekannt.
    silent = FakeUsb()
    status = usb_driver(silent).status()
    assert (status.reachable, status.ready, status.errors) == (True, None, ["unknown"])
    assert silent.closed
    # status() wirft nie.
    status = usb_driver(RuntimeError("damit rechnet niemand")).status()
    assert (status.reachable, status.errors) == (False, ["unknown"])
    broken = FakeUsb()
    broken.fail_on_write = 1
    assert usb_driver(broken).status().errors == ["unknown"]


@needs_library
def test_status_arrives_in_pieces_and_after_other_bytes():
    device = FakeUsb(b"\x00\x00\x80\x20" + NO_MEDIA, chunk=5)
    status = usb_driver(device).status()
    assert status.errors == ["no_media"]


# --- Drucken über USB --------------------------------------------------------------------


@needs_library
def test_print_over_usb_is_confirmed_by_the_device():
    label = reference_label()
    device = FakeUsb(READY, READY + PRINTING + COMPLETED + WAITING)
    driver = usb_driver(device)
    assert driver.print(label) == PrintOutcome.PRINTED
    assert driver.last_error is None
    # Erst die Statusabfrage, dann der vollständige Datenstrom; danach ist das Gerät wieder frei.
    assert device.written == [INVALIDATE + STATUS_REQUEST, driver.raster(label)]
    assert device.closed
    assert device.pending == b""


@needs_library
def test_print_over_usb_counts_as_printed_once_completion_was_reported():
    # „Druck abgeschlossen" kam, „wieder bereit" bleibt aus: gedruckt ist trotzdem.
    device = FakeUsb(READY, PRINTING + COMPLETED)
    started = time.monotonic()
    assert usb_driver(device).print(reference_label()) == PrintOutcome.PRINTED
    assert time.monotonic() - started < 1.5


@needs_library
@pytest.mark.parametrize(
    ("before", "code"),
    [
        (NO_MEDIA, "no_media"),
        (frame(errors_2=0x10), "cover_open"),
        (frame(width=29), "media_mismatch"),
        (frame(errors_1=0x04), "cutter_jam"),
    ],
)
def test_print_over_usb_fails_safely_when_the_device_reports_a_problem_first(before, code):
    device = FakeUsb(before)
    driver = usb_driver(device)
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == code
    # Es ging nur die Statusabfrage hinaus, kein einziges Byte des Etiketts.
    assert device.written == [INVALIDATE + STATUS_REQUEST]
    assert device.closed


@needs_library
def test_print_over_usb_fails_safely_when_the_device_is_not_there():
    driver = usb_driver(Unreachable("nicht am USB"))
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "offline"
    driver = usb_driver(ConfigError("kein Zugriff"))
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "config"
    # Gerät da, aber stumm vor dem Senden: nichts gesendet, also sicher nicht gedruckt.
    silent = FakeUsb()
    driver = usb_driver(silent)
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "unknown"
    assert silent.written == [INVALIDATE + STATUS_REQUEST]
    # Schon die Statusabfrage lässt sich nicht schreiben.
    dead = FakeUsb()
    dead.fail_on_write = 1
    driver = usb_driver(dead)
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "offline"


@needs_library
def test_print_over_usb_raises_when_sending_breaks_off():
    device = FakeUsb(READY)
    device.fail_on_write = 2  # die Statusabfrage geht durch, das Etikett nicht
    driver = usb_driver(device)
    with pytest.raises(PrintInterrupted):
        driver.print(reference_label())
    assert device.closed


@needs_library
@pytest.mark.parametrize(
    ("after", "code"),
    [
        (PRINTING + frame(errors_1=0x01, status_type=STATUS_ERROR), "no_media"),
        (PRINTING + frame(errors_2=0x10, status_type=STATUS_ERROR), "cover_open"),
        (frame(errors_1=0x04, status_type=STATUS_ERROR), "cutter_jam"),
        (frame(status_type=STATUS_ERROR), "unknown"),
    ],
)
def test_print_over_usb_raises_when_the_device_reports_an_error_while_printing(after, code):
    device = FakeUsb(READY, after)
    with pytest.raises(PrintInterrupted) as caught:
        usb_driver(device).print(reference_label())
    assert caught.value.code == code
    assert device.closed


@needs_library
def test_print_over_usb_raises_when_no_confirmation_arrives():
    device = FakeUsb(READY, READY + PRINTING)
    started = time.monotonic()
    with pytest.raises(PrintInterrupted, match="nicht bestätigt"):
        usb_driver(device).print(reference_label())
    assert 0.5 <= time.monotonic() - started < 3


@needs_library
def test_status_during_a_print_says_busy_instead_of_disturbing_the_device():
    gate = threading.Event()

    class Slow(FakeUsb):
        def write(self, data: bytes) -> None:
            super().write(data)
            if len(self.written) == 2:
                gate.wait(5)

    device = Slow(READY, COMPLETED + WAITING)
    driver = usb_driver(device, print_timeout=5)
    outcome: list[PrintOutcome] = []
    worker = threading.Thread(target=lambda: outcome.append(driver.print(reference_label())))
    worker.start()
    while len(device.written) < 2:
        time.sleep(0.005)
    status = driver.status()
    assert (status.reachable, status.ready, status.errors) == (True, False, ["busy"])
    assert len(device.written) == 2  # die Abfrage hat nichts geschrieben
    gate.set()
    worker.join(timeout=5)
    assert outcome == [PrintOutcome.PRINTED]


@needs_library
def test_print_refuses_images_that_do_not_fit_the_roll():
    device = FakeUsb(READY)
    driver = usb_driver(device)
    for image in (
        Image.new("1", (600, 342), 1),  # zu schmal
        Image.new("L", (696, 342), 255),  # nicht 1 Bit
        Image.new("1", (696, 100), 1),  # kürzer, als das Gerät drucken kann (150 Punkte)
    ):
        assert driver.print(image) == PrintOutcome.FAILED
        assert driver.last_error == "config"
    assert device.written == []


# --- Drucken über TCP --------------------------------------------------------------------


def tcp_driver(port: int, **options) -> BrotherQLDriver:
    options.setdefault("connect_timeout", 3.0)
    options.setdefault("linger", 1.0)
    return BrotherQLDriver(model="QL-820NWB", address=f"tcp://127.0.0.1:{port}", **options)


def serve_once(listener: socket.socket, handle) -> threading.Thread:
    """Nimmt eine Verbindung an und übergibt sie ``handle``."""

    def run() -> None:
        connection, _peer = listener.accept()
        try:
            handle(connection)
        finally:
            connection.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


@needs_library
def test_print_over_tcp_is_sent_not_confirmed(listener):
    received = bytearray()

    def printer(connection: socket.socket) -> None:
        connection.settimeout(5)
        while chunk := connection.recv(65536):
            received.extend(chunk)

    thread = serve_once(listener, printer)
    driver = tcp_driver(listener.getsockname()[1])
    label = reference_label()
    assert driver.print(label) == PrintOutcome.SENT
    thread.join(timeout=5)
    assert bytes(received) == driver.raster(label)
    assert split_stream(bytes(received))["order"][-2:] == ["raster", "print"]


@needs_library
def test_print_over_tcp_to_a_printer_that_keeps_the_connection_open(listener):
    release = threading.Event()

    def printer(connection: socket.socket) -> None:
        connection.settimeout(5)
        while connection.recv(65536):
            pass
        release.wait(5)  # liest alles, schließt aber nicht

    thread = serve_once(listener, printer)
    driver = tcp_driver(listener.getsockname()[1], linger=0.3)
    started = time.monotonic()
    assert driver.print(reference_label()) == PrintOutcome.SENT
    assert time.monotonic() - started < 3
    release.set()
    thread.join(timeout=5)


@needs_library
def test_print_over_tcp_fails_safely_when_the_connection_is_refused(closed_port):
    driver = tcp_driver(closed_port)
    assert driver.print(reference_label()) == PrintOutcome.FAILED
    assert driver.last_error == "offline"
    status = driver.status()
    assert (status.reachable, status.ready, status.media_detected, status.errors) == (
        False,
        None,
        None,
        ["offline"],
    )


@needs_library
def test_print_over_tcp_raises_when_the_connection_drops_midway(listener):
    def printer(connection: socket.socket) -> None:
        connection.settimeout(5)
        connection.recv(100)  # nimmt den Anfang und reißt dann ab
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("hh", 1, 0))

    thread = serve_once(listener, printer)
    driver = tcp_driver(listener.getsockname()[1])
    with pytest.raises(PrintInterrupted):
        driver.print(reference_label())
    thread.join(timeout=5)


@needs_library
def test_status_over_tcp_only_knows_whether_the_printer_answers(listener):
    thread = serve_once(listener, lambda connection: connection.recv(1))
    status = tcp_driver(listener.getsockname()[1]).status()
    # Erreichbar ja; bereit, Rolle und Fehler lassen sich über das Netz nicht feststellen.
    assert (status.reachable, status.ready, status.media_detected, status.errors) == (True, None, None, [])
    thread.join(timeout=5)


# --- Im Auftragsdienst -------------------------------------------------------------------


@needs_library
def test_jobs_through_the_brother_driver_end_as_printed_failed_or_unknown():
    # Was das Gerät gerade antwortet: auf die Statusabfrage und auf das Etikett.
    answers = {"before": READY, "after": b""}

    def opener(_address: Address) -> FakeUsb:
        # Jeder Druck und jede Statusabfrage des Dienstes öffnet das Gerät neu.
        return FakeUsb(answers["before"], answers["after"])

    driver = BrotherQLDriver(
        model="QL-800", address=USB, opener=opener, status_timeout=0.3, print_timeout=0.5, settle_timeout=0.1
    )
    service = PrintService(
        StaticPrinters([PrinterEntry("keller", "brother_ql", "QL-800", driver)]), fonts=Fonts.builtin()
    )
    service.start()
    results = []
    for before, after in (
        (READY, COMPLETED + WAITING),  # klappt
        (NO_MEDIA, b""),  # Etiketten leer, vor dem Senden bemerkt
        (READY, PRINTING + frame(errors_2=0x10, status_type=STATUS_ERROR)),  # Deckel auf beim Drucken
    ):
        answers["before"], answers["after"] = before, after
        job_id = new_id()
        service.submit(job_id, package_request(f"Etikett {len(results)}"))
        job = service.wait(job_id, 5)
        results.append((job.state, None if job.error is None else job.error.code))
        # Nach jedem Auftrag fragt der Dienst den Zustand selbst ab; das abwarten.
        time.sleep(0.4)
    assert results == [
        (JobState.PRINTED, None),
        (JobState.FAILED, "no_media"),
        (JobState.UNKNOWN, "interrupted"),
    ]
    info = service.printers()[0]
    assert (info.driver, info.model, info.capabilities.confirms_print) == ("brother_ql", "QL-800", True)
    service.close()
