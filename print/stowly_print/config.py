"""Konfiguration des eigenständigen Druckdienstes (Raspberry Pi): eine TOML-Datei.

Das Format ist in ``pi/README.md`` beschrieben, ein Beispiel liegt in
``pi/stowly-print.example.toml``. Kurz:

    token = "…"                        # dasselbe Token wie in Stowly beim Drucker
    origins = ["https://stowly.home"]  # Ursprünge der App, die direkt drucken dürfen

    [http]                              # Vorgabe: 0.0.0.0, Port 8080
    [https]                             # Vorgabe: Port 8443; nur mit certificate und key
    certificate = "/etc/stowly-print/tls/pi.crt"
    key = "/etc/stowly-print/tls/pi.key"

    [[printers]]                        # der erste ist der Standarddrucker
    name = "keller"
    driver = "brother_ql"
    model = "QL-800"
    address = "usb://04f9:209b"
    media = "62"

Ein Fehler in der Datei beendet den Start mit einer Meldung, die sagt, was nicht stimmt.
Unbrauchbare Angaben zu einem einzelnen Drucker (unbekanntes Modell, falsche Adresse) sind kein
solcher Fehler: Der Drucker steht dann in der Liste und meldet ``config``.
"""

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from stowly_print.drivers import PrinterConfig

DEFAULT_HOST = "0.0.0.0"
DEFAULT_HTTP_PORT = 8080
DEFAULT_HTTPS_PORT = 8443
MIN_TOKEN_LENGTH = 16
# Steht so in der Beispiel-Konfiguration; damit startet der Dienst nicht.
PLACEHOLDER_TOKEN = "HIER-EIN-EIGENES-LANGES-TOKEN-EINTRAGEN"
LOG_LEVELS = ("critical", "error", "warning", "info", "debug")
_PRINTER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$")


class ConfigurationError(Exception):
    """Die Konfigurationsdatei ist nicht brauchbar. Die Meldung nennt die Stelle."""


@dataclass(frozen=True)
class Listener:
    host: str
    port: int
    certificate: Path | None = None
    key: Path | None = None

    @property
    def tls(self) -> bool:
        return self.certificate is not None


@dataclass(frozen=True)
class ServiceConfig:
    token: str
    origins: tuple[str, ...]
    http: Listener | None
    https: Listener | None
    printers: tuple[PrinterConfig, ...]
    log_level: str = "info"


def _table(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigurationError(f"{where} muss ein Abschnitt mit Schlüsseln sein.")
    return value


def _text(table: dict[str, Any], key: str, where: str, *, required: bool = False) -> str | None:
    value = table.get(key)
    if value is None:
        if required:
            raise ConfigurationError(f"{where}: '{key}' fehlt.")
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{where}: '{key}' muss ein nicht leerer Text sein.")
    return value.strip()


def _port(table: dict[str, Any], default: int, where: str) -> int:
    value = table.get("port", default)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ConfigurationError(f"{where}: 'port' muss eine Zahl von 1 bis 65535 sein.")
    return value


def _enabled(table: dict[str, Any], where: str) -> bool:
    value = table.get("enabled", True)
    if not isinstance(value, bool):
        raise ConfigurationError(f"{where}: 'enabled' muss true oder false sein.")
    return value


def _origin(value: Any) -> str:
    """Ein Ursprung wie ``https://stowly.home`` oder ``https://stowly.home:8443``, ohne Pfad."""
    if not isinstance(value, str):
        raise ConfigurationError('origins: Jeder Ursprung muss ein Text sein, etwa "https://stowly.home".')
    text = value.strip().rstrip("/")
    try:
        parts = urlsplit(text)
        _ = parts.port  # wirft bei einem unlesbaren Port
    except ValueError as exc:
        raise ConfigurationError(f"origins: '{value}' ist keine Adresse.") from exc
    plain = not (parts.path or parts.query or parts.fragment or parts.username)
    if parts.scheme not in ("http", "https") or not parts.hostname or not plain:
        raise ConfigurationError(
            f"origins: '{value}' ist kein Ursprung. Erwartet wird Schema und Rechner ohne Pfad, "
            'etwa "https://stowly.home".'
        )
    return text.lower()


def _path(base: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else base / path


def _printer(raw: Any, number: int, base: Path) -> PrinterConfig:
    where = f"printers[{number}]"
    table = _table(raw, where)
    name = _text(table, "name", where, required=True)
    assert name is not None
    if not _PRINTER_NAME.fullmatch(name):
        raise ConfigurationError(
            f"{where}: Der Name '{name}' darf nur aus Buchstaben, Ziffern, '-', '_' und '.' bestehen "
            "(höchstens 60 Zeichen)."
        )
    driver = _text(table, "driver", where, required=True)
    assert driver is not None
    directory = _text(table, "directory", where)
    if driver == "image" and directory is None:
        raise ConfigurationError(
            f"{where}: Der Bild-Treiber braucht 'directory' (wohin die PNG-Dateien kommen)."
        )
    return PrinterConfig(
        name=name,
        driver=driver,
        model=_text(table, "model", where),
        address=_text(table, "address", where),
        media=_text(table, "media", where),
        directory=None if directory is None else _path(base, directory),
        simulate=_text(table, "simulate", where),
    )


def parse_config(raw: dict[str, Any], base: Path) -> ServiceConfig:
    """Prüft den Inhalt einer Konfigurationsdatei. Pfade ohne Wurzel gelten ab ``base``."""
    token = _text(raw, "token", "Konfiguration", required=True)
    assert token is not None
    if token == PLACEHOLDER_TOKEN:
        raise ConfigurationError("token: Bitte den Platzhalter durch ein eigenes, langes Token ersetzen.")
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigurationError(f"token: Das Token muss mindestens {MIN_TOKEN_LENGTH} Zeichen lang sein.")

    origins_raw = raw.get("origins", [])
    if not isinstance(origins_raw, list):
        raise ConfigurationError('origins muss eine Liste sein, etwa ["https://stowly.home"].')
    origins = tuple(dict.fromkeys(_origin(value) for value in origins_raw))

    http_table = _table(raw.get("http", {}), "[http]")
    http = None
    if _enabled(http_table, "[http]"):
        http = Listener(
            host=_text(http_table, "host", "[http]") or DEFAULT_HOST,
            port=_port(http_table, DEFAULT_HTTP_PORT, "[http]"),
        )

    https = None
    if "https" in raw:
        https_table = _table(raw["https"], "[https]")
        if _enabled(https_table, "[https]"):
            certificate = _text(https_table, "certificate", "[https]", required=True)
            key = _text(https_table, "key", "[https]", required=True)
            assert certificate is not None and key is not None
            https = Listener(
                host=_text(https_table, "host", "[https]") or DEFAULT_HOST,
                port=_port(https_table, DEFAULT_HTTPS_PORT, "[https]"),
                certificate=_path(base, certificate),
                key=_path(base, key),
            )
    if http is None and https is None:
        raise ConfigurationError(
            "Weder [http] noch [https] ist eingeschaltet: Der Dienst wäre nicht erreichbar."
        )
    if http is not None and https is not None and (http.host, http.port) == (https.host, https.port):
        raise ConfigurationError("[http] und [https] brauchen verschiedene Ports.")

    printers_raw = raw.get("printers", [])
    if not isinstance(printers_raw, list) or not printers_raw:
        raise ConfigurationError("Es ist kein Drucker eingetragen ([[printers]]).")
    printers = tuple(_printer(entry, number, base) for number, entry in enumerate(printers_raw, start=1))
    names = [printer.name for printer in printers]
    if len(set(names)) != len(names):
        raise ConfigurationError("Zwei Drucker tragen denselben Namen.")

    log_level = (_text(raw, "log_level", "Konfiguration") or "info").lower()
    if log_level not in LOG_LEVELS:
        raise ConfigurationError(
            f"log_level: '{log_level}' ist keine Stufe (erwartet {', '.join(LOG_LEVELS)})."
        )

    return ServiceConfig(
        token=token, origins=origins, http=http, https=https, printers=printers, log_level=log_level
    )


def load_config(path: Path | str) -> ServiceConfig:
    """Liest und prüft die Konfigurationsdatei."""
    path = Path(path)
    try:
        with path.open("rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError as exc:
        raise ConfigurationError(f"Die Konfigurationsdatei {path} gibt es nicht.") from exc
    except OSError as exc:
        raise ConfigurationError(f"Die Konfigurationsdatei {path} ist nicht lesbar ({exc}).") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigurationError(f"Die Konfigurationsdatei {path} ist kein gültiges TOML: {exc}") from exc
    return parse_config(raw, path.resolve().parent)
