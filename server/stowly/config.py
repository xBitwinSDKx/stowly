"""Konfiguration über Umgebungsvariablen (siehe .env.example und docs/integrationen.md, Abschnitt 7).

Im Container setzt die Compose-Datei die Variablen. Beim Entwickeln genügt
``python -m stowly --dev``: Dann gelten die Entwicklungs-Vorgaben unten.

Alles wird beim Start gelesen und geprüft. Ein Fehler ist ein ``ValueError`` mit einer deutschen
Meldung, die die Variable nennt; ``python -m stowly`` endet dann mit Exit-Code 2. Der Wert eines
Tokens, eines Schlüssels oder einer Adresse mit Zugangsdaten steht nie in der Meldung. Leere Werte
gelten als nicht gesetzt, Leerraum am Rand fällt weg.
"""

import functools
import os
import re
import ssl
import zoneinfo
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import pyrage

from stowly.contract.timeutil import is_time_of_day

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


DEFAULT_TIMEZONE = "Europe/Berlin"
DEFAULT_BACKUP_TIME = "03:30"
# Die To-do-Liste in Home Assistant (docs/integrationen.md, 5.1).
HA_TODO_ENTITY = re.compile(r"^todo\.[a-z0-9_]+$")
# Kürzer darf der Token des Sensors nicht sein (docs/integrationen.md, 7).
HA_SUMMARY_TOKEN_MIN = 32
# Absender für Push (VAPID ``sub``): mailto mit einer Adresse ohne Leerraum und Klammern.
_MAILTO = re.compile(r"^mailto:[^\s@<>()\[\],;:\"]+@[^\s@<>()\[\],;:\"]+\.[^\s@<>()\[\],;:\"]+$")
# Ein Hostname aus Buchstaben, Ziffern, Bindestrich und Punkt (auch eine IPv4-Adresse).
_HOSTNAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$")


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


@functools.cache
def _known_timezones() -> frozenset[str]:
    """Die Namen aller Zeitzonen, die ``zoneinfo`` kennt (mit dem Paket ``tzdata`` überall dieselben)."""
    return frozenset(zoneinfo.available_timezones())


def _timezone(env: Mapping[str, str]) -> str:
    """``STOWLY_TIMEZONE``: ein IANA-Name, genau so geschrieben, wie ihn die Zeitzonendaten kennen."""
    name = _text(env, "STOWLY_TIMEZONE") or DEFAULT_TIMEZONE
    problem = f"STOWLY_TIMEZONE: '{name}' ist keine bekannte Zeitzone (IANA-Name wie {DEFAULT_TIMEZONE})."
    # Erst die Liste: Unter Windows fände zoneinfo sonst auch „europe/berlin", unter Linux nicht.
    if name not in _known_timezones():
        raise ValueError(problem)
    try:
        zoneinfo.ZoneInfo(name)
    except Exception as exc:  # unbekannt, kaputte Daten, ein Ordner statt einer Zone
        raise ValueError(problem) from exc
    return name


def _backup_dir(env: Mapping[str, str]) -> Path | None:
    raw = _text(env, "STOWLY_BACKUP_DIR")
    if raw is None:
        return None
    path = Path(raw)
    if not path.is_absolute():
        raise ValueError(f"STOWLY_BACKUP_DIR: '{raw}' ist kein absoluter Pfad (im Container: /backups).")
    return path


def _backup_recipients(env: Mapping[str, str]) -> tuple[str, ...]:
    """Öffentliche age-Schlüssel (X25519, ``age1…``), getrennt durch Komma oder Leerraum.

    Die Meldung nennt nur die Stelle, nie den Wert: Wer aus Versehen einen privaten Schlüssel
    einträgt, soll ihn nicht auch noch im Log wiederfinden.
    """
    raw = _text(env, "STOWLY_BACKUP_RECIPIENTS")
    if raw is None:
        return ()
    keys = [part for part in re.split(r"[\s,]+", raw) if part]
    for number, key in enumerate(keys, start=1):
        if key.upper().startswith("AGE-SECRET-KEY-"):
            raise ValueError(
                f"STOWLY_BACKUP_RECIPIENTS: Eintrag {number} ist ein privater Schlüssel. Hierher gehören nur "
                "öffentliche Schlüssel (age1…); der private gehört nicht auf den Server."
            )
        try:
            pyrage.x25519.Recipient.from_str(key)
        except Exception:
            raise ValueError(
                f"STOWLY_BACKUP_RECIPIENTS: Eintrag {number} ist kein öffentlicher age-Schlüssel "
                "(age1…, erzeugt mit age-keygen)."
            ) from None
    return tuple(dict.fromkeys(keys))


def _time_of_day(env: Mapping[str, str], name: str, default: str) -> str:
    raw = _text(env, name) or default
    if not (raw.isascii() and is_time_of_day(raw)):
        raise ValueError(f"{name}: '{raw}' ist keine Uhrzeit HH:MM (00:00 bis 23:59).")
    return raw


def _plain_ascii(text: str) -> bool:
    """Druckbares ASCII ohne Leerraum: Das gehört in Kopfzeilen und Adressen."""
    return text.isascii() and all(" " < char <= "~" for char in text)


def _ha_url(env: Mapping[str, str]) -> str | None:
    """``STOWLY_HA_URL``: ``http(s)://Host[:Port]``, ohne Pfad, Abfrage und Zugangsdaten.

    Ein ``/`` am Ende ist erlaubt und fällt weg. Die Meldung zitiert den Wert nicht: Er könnte
    Zugangsdaten enthalten.
    """
    raw = _text(env, "STOWLY_HA_URL")
    if raw is None:
        return None
    problem = ValueError(
        "STOWLY_HA_URL: erwartet ist eine Adresse wie http://192.168.1.20:8123 "
        "(http oder https, ohne Pfad, Abfrage und Benutzerangabe)."
    )
    if not _plain_ascii(raw) or "?" in raw or "#" in raw or "@" in raw:
        raise problem
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise problem from None
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.path not in ("", "/")
        or port == 0
    ):
        raise problem
    return f"{parts.scheme}://{parts.netloc}"


def _ha_todo_entity(env: Mapping[str, str]) -> str | None:
    entity = _text(env, "STOWLY_HA_TODO_ENTITY")
    if entity is not None and not HA_TODO_ENTITY.fullmatch(entity):
        raise ValueError(
            f"STOWLY_HA_TODO_ENTITY: '{entity}' ist keine To-do-Liste von Home Assistant "
            "(Muster todo.<name>, etwa todo.zuhause)."
        )
    return entity


def _ha_ca(env: Mapping[str, str]) -> Path | None:
    """``STOWLY_HA_CA``: eine lesbare PEM-Datei mit der eigenen Zertifizierungsstelle."""
    raw = _text(env, "STOWLY_HA_CA")
    if raw is None:
        return None
    path = Path(raw)
    try:
        with path.open("rb") as handle:
            handle.read(1)
    except OSError:
        raise ValueError(f"STOWLY_HA_CA: Die Datei '{raw}' lässt sich nicht lesen.") from None
    try:
        # Was sich hier nicht laden lässt, taugt später auch nicht für die Verbindung zu HA.
        ssl.create_default_context(cafile=str(path))
    except (ssl.SSLError, OSError, ValueError):
        raise ValueError(f"STOWLY_HA_CA: '{raw}' enthält kein Zertifikat im Format PEM.") from None
    return path


def _ha_summary_token(env: Mapping[str, str]) -> str | None:
    token = _text(env, "STOWLY_HA_SUMMARY_TOKEN")
    if token is None:
        return None
    if len(token) < HA_SUMMARY_TOKEN_MIN:
        raise ValueError(
            f"STOWLY_HA_SUMMARY_TOKEN: Der Token muss mindestens {HA_SUMMARY_TOKEN_MIN} Zeichen lang sein "
            "(etwa: openssl rand -hex 32)."
        )
    if not _plain_ascii(token):
        # Mit Leerraum oder anderen Zeichen käme er in keiner Kopfzeile Authorization unversehrt an.
        raise ValueError(
            "STOWLY_HA_SUMMARY_TOKEN: Erlaubt sind nur druckbare ASCII-Zeichen ohne Leerraum "
            "(etwa: openssl rand -hex 32)."
        )
    return token


_UPDATE_REPO = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}")


def _update_repo(env: Mapping[str, str]) -> str | None:
    """``STOWLY_UPDATE_REPO``: das GitHub-Repository der Releases, ``<konto>/<name>``."""
    repo = _text(env, "STOWLY_UPDATE_REPO")
    if repo is None:
        return None
    if not _UPDATE_REPO.fullmatch(repo) or repo.split("/", 1)[1] in {".", ".."}:
        raise ValueError(
            f"STOWLY_UPDATE_REPO: '{repo}' ist kein GitHub-Repository (erwartet <konto>/<name>, "
            "etwa beispiel/stowly)."
        )
    return repo


def _update_repo_default(env: Mapping[str, str]) -> str | None:
    """``STOWLY_UPDATE_REPO_DEFAULT``: Vorgabe des Images für den Schalter in der App, kein Zwang.

    Anders als ``STOWLY_UPDATE_REPO`` schaltet sie Updates nicht ein; sie nennt nur das Repository,
    das der Schalter in der App einschaltet (docs/integrationen.md, Abschnitt 12).
    """
    repo = _text(env, "STOWLY_UPDATE_REPO_DEFAULT")
    if repo is None:
        return None
    if not _UPDATE_REPO.fullmatch(repo) or repo.split("/", 1)[1] in {".", ".."}:
        raise ValueError(
            f"STOWLY_UPDATE_REPO_DEFAULT: '{repo}' ist kein GitHub-Repository (erwartet <konto>/<name>)."
        )
    return repo


def _https_port(env: Mapping[str, str], http_port: int) -> int | None:
    """``STOWLY_HTTPS_PORT``: Port des HTTPS-Listeners im Container; nicht gesetzt = kein HTTPS."""
    raw = _text(env, "STOWLY_HTTPS_PORT")
    if raw is None:
        return None
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"STOWLY_HTTPS_PORT: '{raw}' ist keine Zahl.") from None
    if not 1 <= port <= 65535:
        raise ValueError(f"STOWLY_HTTPS_PORT: {port} ist kein Port (1 bis 65535).")
    if port == http_port:
        raise ValueError(f"STOWLY_HTTPS_PORT: {port} ist schon der Port für HTTP (STOWLY_PORT).")
    return port


def _pi_bundle(env: Mapping[str, str]) -> Path | None:
    """``STOWLY_PI_BUNDLE``: das Paket für den Pi im Image (pi-bundle.tar.gz).

    Ohne Angabe baut ein Server aus dem Quell-Checkout das Paket selbst (server/stowly/pi_bundle.py),
    einer aus site-packages hat keines (docs/sync-protokoll.md, 11.8).
    """
    raw = _text(env, "STOWLY_PI_BUNDLE")
    if raw is None:
        return None
    path = Path(raw)
    if not path.is_absolute():
        raise ValueError(f"STOWLY_PI_BUNDLE: '{raw}' ist kein absoluter Pfad.")
    return path


# Ein Image ohne Tag und Digest: [registry[:port]/]pfad, alles klein (Docker-Referenz).
_IMAGE_REF = re.compile(
    r"(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*"
)


def _image_ref(env: Mapping[str, str]) -> str | None:
    """``STOWLY_IMAGE_REF``: woher das Image stammt, ohne Tag (etwa docker.io/beispiel/stowly).

    Damit setzt der Server den Befehl für den Updater-Container zusammen (docs/integrationen.md, 10.7).
    """
    ref = _text(env, "STOWLY_IMAGE_REF")
    if ref is None:
        return None
    if len(ref) > 200 or not _IMAGE_REF.fullmatch(ref):
        raise ValueError(
            f"STOWLY_IMAGE_REF: '{ref}' ist keine Image-Referenz ohne Tag (etwa docker.io/beispiel/stowly)."
        )
    return ref


def push_contact_valid(contact: str) -> bool:
    """Ein Kontakt für die Push-Dienste (VAPID ``sub``): ``mailto:`` mit einer Adresse samt Domäne oder
    ``https://`` mit Host, das Schema klein geschrieben, ohne Benutzerangabe.

    Dieselbe Prüfung gilt für ``STOWLY_PUSH_CONTACT`` und den Kontakt aus der App
    (docs/integrationen.md, Abschnitte 7 und 12).
    """
    if not _plain_ascii(contact):
        return False
    if contact.startswith("mailto:"):
        return _MAILTO.fullmatch(contact) is not None
    try:
        parts = urlsplit(contact)
        parts.port  # noqa: B018 - prüft den Port
    except ValueError:
        return False
    return (
        contact.startswith("https://")
        and bool(parts.hostname)
        and _HOSTNAME.fullmatch(parts.hostname or "") is not None
        and parts.username is None
        and parts.password is None
    )


def _push_contact(env: Mapping[str, str]) -> str | None:
    """``STOWLY_PUSH_CONTACT``: ``mailto:<Adresse>`` oder eine ``https://``-Adresse (VAPID ``sub``)."""
    contact = _text(env, "STOWLY_PUSH_CONTACT")
    if contact is None:
        return None
    if not push_contact_valid(contact):
        raise ValueError(
            "STOWLY_PUSH_CONTACT: erwartet ist mailto:<Adresse> oder eine https-Adresse "
            "(Apple lehnt Nachrichten ohne gültigen Absender ab)."
        )
    return contact


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
    # Haushalts-Passwort aus STOWLY_PASSWORD, im Entwicklungsmodus ohne Angabe der Rückfall „stowly";
    # None = keins aus der Umgebung, dann gilt der Hash aus der App (auth.py). Nie in einer Ausgabe (repr).
    password: str | None = field(repr=False)
    dev: bool
    off_enabled: bool  # Open Food Facts abfragen
    off_url: str
    off_contact: str | None  # optionaler Kontakt für den User-Agent, nie fest eingetragen
    log_level: str
    # Content-Security-Policy der Web-App; None = keine (STOWLY_CSP=off).
    csp: str | None = DEFAULT_CSP
    # Zeitzone für „heute" und alle Uhrzeiten (docs/integrationen.md, Abschnitt 2).
    timezone: str = DEFAULT_TIMEZONE
    # Automatische Sicherung (docs/integrationen.md, Abschnitt 3): Ordner, öffentliche age-Schlüssel, Uhrzeit.
    backup_dir: Path | None = None
    backup_recipients: tuple[str, ...] = ()
    backup_time: str = DEFAULT_BACKUP_TIME
    # Home Assistant und Bring! (Abschnitt 5) und der Sensor (Abschnitt 6). Tokens nie in einer Ausgabe.
    ha_url: str | None = None
    ha_token: str | None = field(default=None, repr=False)
    ha_todo_entity: str | None = None
    ha_ca: Path | None = None
    ha_summary_token: str | None = field(default=None, repr=False)
    # Absender für Web-Push (Abschnitt 4.1); None = kein Push.
    push_contact: str | None = None
    # Updates über GitHub (Abschnitt 10): Repository „<konto>/<name>"; None = keine Prüfung.
    update_repo: str | None = None
    # Vorgabe des Images für den Schalter „Nach Updates suchen" in der App (Abschnitt 12).
    update_repo_default: str | None = None
    # HTTPS durch Stowly selbst (Abschnitt 11): Port des Listeners im Container; None = kein HTTPS.
    https_port: int | None = None
    # Paket für den Pi (docs/sync-protokoll.md, 11.8); None = selbst bauen (Quell-Checkout) oder keins.
    pi_bundle: Path | None = None
    # Herkunft des Images ohne Tag, für den Befehl des Updater-Containers (Abschnitt 10.7).
    image_ref: str | None = None
    # True: ``password`` ist der Rückfall des Entwicklungsmodus (DEV_PASSWORD). Er gilt wie STOWLY_PASSWORD,
    # wird aber nie als Hash gespeichert (docs/sync-protokoll.md, Abschnitt 5).
    password_fallback: bool = False

    @property
    def database_path(self) -> Path:
        return self.data_dir / "stowly.sqlite3"

    @property
    def update_dir(self) -> Path:
        """Austausch mit dem Updater auf dem Rechner (docs/integrationen.md, 10.3)."""
        return self.data_dir / "update"

    @property
    def env_password(self) -> str | None:
        """Das Passwort aus ``STOWLY_PASSWORD``, das der Server beim Start als Hash übernimmt; nie der
        Rückfall des Entwicklungsmodus."""
        return None if self.password_fallback else self.password

    @property
    def update_configured(self) -> bool:
        """Nur die Umgebung: ``STOWLY_UPDATE_REPO`` ist gesetzt. Wirksam ist ``serverconfig.update_repo``,
        das auch den Schalter in der App kennt (Abschnitt 12)."""
        return self.update_repo is not None

    @property
    def tz(self) -> zoneinfo.ZoneInfo:
        """Die Zeitzone des Servers (``STOWLY_TIMEZONE``), beim Start geprüft."""
        return zoneinfo.ZoneInfo(self.timezone)

    # --- Sicherung -------------------------------------------------------------------------

    @property
    def backup_configured(self) -> bool:
        """Ordner und Empfänger gesetzt: Die automatische Sicherung läuft."""
        return self.backup_dir is not None and bool(self.backup_recipients)

    @property
    def backup_mentioned(self) -> bool:
        """Etwas von Ordner und Empfängern ist gesetzt (sonst: gar nicht eingerichtet, ohne Hinweis)."""
        return self.backup_dir is not None or bool(self.backup_recipients)

    @property
    def backup_problem(self) -> str | None:
        """Warum die Sicherung aus ist, obwohl etwas gesetzt ist (docs/integrationen.md, 3.1)."""
        if self.backup_dir is None and self.backup_recipients:
            return "STOWLY_BACKUP_DIR fehlt."
        if self.backup_dir is not None and not self.backup_recipients:
            return "STOWLY_BACKUP_RECIPIENTS fehlt."
        return None

    # --- Home Assistant --------------------------------------------------------------------

    @property
    def ha_configured(self) -> bool:
        """Adresse, Token und Liste gesetzt: Der Abgleich mit Bring! läuft."""
        return None not in (self.ha_url, self.ha_token, self.ha_todo_entity)

    @property
    def ha_problem(self) -> str | None:
        """Warum der Abgleich aus ist, obwohl etwas gesetzt ist (docs/integrationen.md, 5.1)."""
        parts = {
            "STOWLY_HA_URL": self.ha_url,
            "STOWLY_HA_TOKEN": self.ha_token,
            "STOWLY_HA_TODO_ENTITY": self.ha_todo_entity,
        }
        missing = [name for name, value in parts.items() if value is None]
        if not missing or (len(missing) == len(parts) and self.ha_ca is None):
            return None
        if len(missing) == 1:
            return f"{missing[0]} fehlt."
        return f"{', '.join(missing[:-1])} und {missing[-1]} fehlen."

    # --- Push ------------------------------------------------------------------------------

    @property
    def push_configured(self) -> bool:
        """Nur die Umgebung: ``STOWLY_PUSH_CONTACT`` ist gesetzt. Wirksam ist ``serverconfig.push_contact``,
        das auch den Kontakt aus der App kennt (Abschnitt 12)."""
        return self.push_contact is not None

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
        fallback = password is None and is_dev
        if fallback:
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
            timezone=_timezone(env),
            backup_dir=_backup_dir(env),
            backup_recipients=_backup_recipients(env),
            backup_time=_time_of_day(env, "STOWLY_BACKUP_TIME", DEFAULT_BACKUP_TIME),
            ha_url=_ha_url(env),
            ha_token=_text(env, "STOWLY_HA_TOKEN"),
            ha_todo_entity=_ha_todo_entity(env),
            ha_ca=_ha_ca(env),
            ha_summary_token=_ha_summary_token(env),
            push_contact=_push_contact(env),
            update_repo=_update_repo(env),
            update_repo_default=_update_repo_default(env),
            https_port=_https_port(env, port),
            pi_bundle=_pi_bundle(env),
            image_ref=_image_ref(env),
            password_fallback=fallback,
        )

    @property
    def tls_dir(self) -> Path:
        """CA, Schlüssel und Zertifikat des HTTPS-Listeners (docs/integrationen.md, Abschnitt 11)."""
        return self.data_dir / "tls"
