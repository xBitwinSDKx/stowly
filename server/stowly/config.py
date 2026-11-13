"""Konfiguration über Umgebungsvariablen (siehe .env.example).

Im Container setzt die Compose-Datei die Variablen. Beim Entwickeln genügt
``python -m stowly --dev``: Dann gelten die Entwicklungs-Vorgaben unten.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# server/stowly/config.py -> Wurzel des Repositorys (nur in einem Quell-Checkout sinnvoll)
_REPO_ROOT = Path(__file__).resolve().parents[2]

DEV_PASSWORD = "stowly"
DEFAULT_PORT = 8010
# Obergrenze für den Rumpf einer Anfrage. 500 Befehle eines Sync bleiben weit darunter.
MAX_REQUEST_BYTES = 4 * 1024 * 1024

_TRUE = {"1", "true", "yes", "on", "ja"}
_FALSE = {"0", "false", "no", "off", "nein", ""}
# Die Stufen, die uvicorn kennt.
LOG_LEVELS = ("critical", "error", "warning", "info", "debug", "trace")

# Content-Security-Policy der ausgelieferten Web-App (STOWLY_CSP: leer = diese Vorgabe, "off" = keine).
# Vorsichtig gewählt, sie darf nichts brechen:
# - script-src: nur eigene Dateien (es gibt kein Inline-Skript), dazu WebAssembly für die
#   Barcode-Erkennung ('wasm-unsafe-eval'; ältere Safari vor 16 kennen das nicht und verweigern
#   dann das WebAssembly, siehe docs/betrieb.md).
# - style-src 'unsafe-inline': Die App setzt Stil-Attribute.
# - img-src: Bilder aus /api/images, dazu blob: (Etikett-Vorschau) und data:.
# - connect-src http: https:: Der Direktdruck spricht frei eingetragene Adressen im Heimnetz an.
# - worker-src: der Erkennungs-Worker und der Service Worker aus eigener Datei.
DEFAULT_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; "
    "font-src 'self' data:; "
    "connect-src 'self' http: https:; "
    "media-src 'self' blob: data:; "
    "worker-src 'self' blob:; "
    "manifest-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


def _in_source_checkout() -> bool:
    """Wahr, wenn das Paket aus dem Repository läuft (pip install -e), nicht aus site-packages."""
    return (_REPO_ROOT / "server" / "pyproject.toml").is_file() and (_REPO_ROOT / "web").is_dir()


def _flag(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ValueError(f"{name}: '{raw}' ist kein Wahrheitswert (erwartet 1/0, true/false, ja/nein).")


def _text(env: Mapping[str, str], name: str) -> str | None:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return None
    return raw.strip()


def _csp(env: Mapping[str, str]) -> str | None:
    """``STOWLY_CSP``: nicht gesetzt oder leer = Vorgabe, ``off`` = kein Kopf, sonst der Wert selbst."""
    raw = _text(env, "STOWLY_CSP")
    if raw is None:
        return DEFAULT_CSP
    if raw.lower() == "off":
        return None
    # Zeilenumbrüche und Tabulatoren werden zu Leerzeichen: Eine Kopfzeile ist eine Zeile.
    value = " ".join(raw.split())
    if not value.isascii() or not value.isprintable():
        raise ValueError("STOWLY_CSP: Erlaubt sind nur druckbare ASCII-Zeichen.")
    return value


@dataclass(frozen=True)
class Settings:
    """Alle Einstellungen des Servers. Unveränderlich, einmal beim Start gelesen."""

    host: str
    port: int
    data_dir: Path
    web_dir: Path | None  # gebaute Web-App; None = nur die API ausliefern
    password: str | None  # Haushalts-Passwort; None = Anmelden nicht möglich
    dev: bool
    off_enabled: bool  # Open Food Facts abfragen
    off_url: str
    off_contact: str | None  # optionaler Kontakt für den User-Agent, nie fest eingetragen
    log_level: str
    # Content-Security-Policy der Web-App; None = keine (STOWLY_CSP=off).
    csp: str | None = DEFAULT_CSP

    @property
    def database_path(self) -> Path:
        return self.data_dir / "stowly.sqlite3"

    @property
    def configured(self) -> bool:
        return self.password is not None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, *, dev: bool | None = None) -> "Settings":
        """Liest ``STOWLY_*``. ``dev`` übersteuert ``STOWLY_DEV``."""
        env = os.environ if env is None else env
        is_dev = _flag(env, "STOWLY_DEV", False) if dev is None else dev
        source = _in_source_checkout()

        data_dir = _text(env, "STOWLY_DATA_DIR")
        if data_dir is not None:
            data_path = Path(data_dir)
        elif source:
            # Nie vom Arbeitsverzeichnis abhängen: Die Vorschau startet den Server von außerhalb.
            data_path = _REPO_ROOT / "data"
        else:
            data_path = Path("/data")

        web_dir = _text(env, "STOWLY_WEB_DIR")
        if web_dir is not None:
            web_path: Path | None = Path(web_dir)
        elif source:
            web_path = _REPO_ROOT / "web" / "dist"
        else:
            web_path = None

        password = _text(env, "STOWLY_PASSWORD")
        if password is None and is_dev:
            password = DEV_PASSWORD

        port_raw = _text(env, "STOWLY_PORT")
        try:
            port = int(port_raw) if port_raw is not None else DEFAULT_PORT
        except ValueError as exc:
            raise ValueError(f"STOWLY_PORT: '{port_raw}' ist keine Zahl.") from exc

        log_level = (_text(env, "STOWLY_LOG_LEVEL") or "info").lower()
        if log_level not in LOG_LEVELS:
            raise ValueError(
                f"STOWLY_LOG_LEVEL: '{log_level}' ist keine Stufe (erwartet {', '.join(LOG_LEVELS)})."
            )

        return cls(
            host=_text(env, "STOWLY_HOST") or "127.0.0.1",
            port=port,
            data_dir=data_path,
            web_dir=web_path,
            password=password,
            dev=is_dev,
            off_enabled=_flag(env, "STOWLY_OFF_ENABLED", True),
            off_url=(_text(env, "STOWLY_OFF_URL") or "https://world.openfoodfacts.org").rstrip("/"),
            off_contact=_text(env, "STOWLY_OFF_CONTACT"),
            log_level=log_level,
            csp=_csp(env),
        )
