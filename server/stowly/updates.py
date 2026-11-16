"""Updates über GitHub (docs/integrationen.md, Abschnitt 10).

Der Server fragt GitHub nach dem neuesten Release, meldet eine neue Version einmal per Push und legt
auf Wunsch eine Anforderung für den Updater auf dem Rechner ab (``updater/stowly-update.sh``). Docker
bekommt er dabei nie in die Hand; er läuft weiter ohne Rechte.

* **Abfrage** (10.2): ``GET https://api.github.com/repos/{repo}/releases/latest`` ohne Token, höchstens
  10 Sekunden. Eine eigene Schleife nach dem Muster von ``bring.BringSync``: eine asyncio-Aufgabe im
  ``lifespan`` der App, mit eingereichter Uhr (``off.Clock``) und Transport für Tests. Sie läuft immer
  und schläft, solange Updates aus sind. Das wirksame Repository (``STOWLY_UPDATE_REPO``, sonst der
  Schalter in der App, ``serverconfig.update_repo``) liest sie vor jeder Abfrage; ``reconfigure`` weckt
  sie nach dem Umschalten. Die erste Abfrage kommt eine Minute nach dem Start bzw. dem Einschalten,
  jede weitere sechs Stunden nach der letzten, ob gelungen oder nicht. Dazu auf Knopfdruck
  (``check_now``), höchstens einmal je Minute für den ganzen Server; ein Knopfdruck beginnt den Takt neu.
* **Gespeichert** in ``job_runs`` (Aufgabe ``update_check``): So übersteht das Ergebnis einen Neustart.
  Nach einem Fehler bleiben die bisherigen Angaben zum neuesten Release stehen.
* **Push** einmal je Version, wenn das neueste Release neuer ist als dieser Server (``notified``), auch
  ohne eingerichteten Push: Ein späteres Einschalten meldet nichts nach.
* **Dateien** in ``/data/update`` (10.3): ``request`` schreibt der Server (über ``request.tmp``),
  ``state`` und ``updater`` der Updater. Gelesen wird tolerant: unbekannte Schlüssel und Zeilen ohne
  ``=`` fallen weg, Zeitpunkte gelten in beiden Formaten.
* **Zustand** (10.4) und **Anfordern** (10.5): ``status`` und ``install``.

Nie in einer Antwort: Pfade des Rechners und der Inhalt von ``log``. Tests gehen nie ins Netz; sie setzen
einen Ersatz-Transport ein (``httpx2.MockTransport``).
"""

import asyncio
import contextlib
import json
import logging
import math
import os
import sqlite3
import threading
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2

from stowly import __version__, db, localtime, push, scheduler, serverconfig, texts
from stowly.config import Settings
from stowly.contract.api import (
    PUSH_PATHS,
    UPDATE_CHECK_FIRST_S,
    UPDATE_CHECK_INTERVAL_S,
    UPDATE_CHECK_MIN_GAP_S,
    UPDATE_NOTES_MAX,
    UPDATE_REQUEST_STALE_S,
    UPDATER_READY_S,
    VERSION_PATTERN,
    ErrorCode,
    PushTestStatus,
    UpdateState,
)
from stowly.contract.ids import exact
from stowly.contract.timeutil import format_timestamp, is_timestamp, parse_timestamp
from stowly.off import Clock
from stowly.updater.command import updater_command

log = logging.getLogger("stowly.update")

JOB = "update_check"

# --- Abfrage bei GitHub (10.2) -----------------------------------------------------------------

API_BASE = "https://api.github.com"
API_VERSION = "2022-11-28"
TIMEOUT_S = 10.0
# Nur eine Seite auf GitHub wird zur ``url`` des Releases.
RELEASE_PAGES = "https://github.com/"
# So lange wartet das Herunterfahren auf eine laufende Abfrage.
SHUTDOWN_WAIT_S = 5.0
# Pause nach einem unerwarteten Fehler in der Schleife selbst (nicht bei GitHub).
ERROR_PAUSE_S = 30.0

RATE_LIMITED = "GitHub lehnt die Abfrage gerade ab (Ratenlimit). Der nächste Versuch kommt planmäßig."
UNREACHABLE = "GitHub ist nicht erreichbar."
# Nicht im Vertrag beschrieben: 200, aber kein Release als JSON-Objekt.
UNEXPECTED = "GitHub antwortet unerwartet."

# So viel vom Tag eines Releases zeigt die Meldung „keine Versionsnummer" höchstens.
TAG_SHOWN_MAX = 60
# Eine Version ist höchstens so lang wie ``UpdateInstallInput.version``: Sonst ließe sie sich nie anfordern.
VERSION_MAX = 40
_VERSION = exact(VERSION_PATTERN)

# --- Push (10.2; Kopfzeilen nach dem Muster der Tagesnachricht, 4.6) ---------------------------

PUSH_TITLE = "Neue Version"
PUSH_TAG = "stowly-update"
PUSH_TOPIC = "stowly-update"
PUSH_TTL_S = 86400
PUSH_URGENCY = "normal"

# --- Dateien in /data/update (10.3) ------------------------------------------------------------

REQUEST = "request"
REQUEST_TMP = "request.tmp"
STATE = "state"
UPDATER = "updater"
DEVICE_MAX = 60
# Mehr liest der Server von keiner dieser Dateien: Sie sind ein paar Zeilen lang.
FILE_MAX_BYTES = 64 * 1024
# So lang ist eine Meldung des Updaters in ``state_message`` höchstens.
MESSAGE_MAX = 500
# So schreibt der Updater Zeitpunkte (``date -u +%Y-%m-%dT%H:%M:%SZ``); der Server im Format des Vertrags.
_UPDATER_TIME = exact(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
# Zeichen, die weder in einer Datei noch in einer Meldung stehen dürfen: Steuerzeichen, Zeilen- und
# Absatztrenner (sie begännen eine neue Zeile) und halbe Ersatzzeichen (nicht als UTF-8 schreibbar).
_DROPPED = frozenset({"Cc", "Zl", "Zp", "Cs"})

# Was ``state`` meldet (10.3).
INSTALLING = "installing"
DONE = "done"
FAILED = "failed"

# --- Zustand (10.4) ----------------------------------------------------------------------------

READY_WITHIN = timedelta(seconds=UPDATER_READY_S)
REQUEST_STALE_AFTER = timedelta(seconds=UPDATE_REQUEST_STALE_S)
INSTALLING_QUIET_AFTER = timedelta(minutes=15)
REQUEST_NOT_PICKED_UP = (
    "Der Updater hat die Anforderung noch nicht abgeholt. Läuft die Aufgabe auf dem Rechner?"
)
UPDATER_QUIET = "Der Updater meldet sich seit 15 Minuten nicht. Bitte auf dem Rechner nachsehen."

# --- Anfordern (10.5) --------------------------------------------------------------------------

NOT_CONFIGURED = "Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung."
UPDATER_MISSING = "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9)."
ALREADY_REQUESTED = "Ein Update ist schon angefordert."
NOT_LATEST = "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen."
ALREADY_INSTALLED = "Diese Version ist schon installiert."
NOT_WRITTEN = "Die Anforderung ließ sich nicht ablegen (Einzelheiten im Log des Servers)."


# --- Versionen ---------------------------------------------------------------------------------


def parse_version(text: object) -> tuple[int, int, int] | None:
    """``X.Y.Z`` als drei Zahlen (``VERSION_PATTERN``, nur Ziffern 0 bis 9); sonst ``None``."""
    if not isinstance(text, str) or len(text) > VERSION_MAX or not _VERSION.match(text):
        return None
    major, minor, patch = text.split(".")
    return int(major), int(minor), int(patch)


def version_of(text: object) -> str | None:
    """Der Text, wenn er eine Version ``X.Y.Z`` ist; sonst ``None``."""
    return text if isinstance(text, str) and parse_version(text) is not None else None


def newer(candidate: str | None, than: str | None) -> bool:
    """Ist ``candidate`` neuer als ``than``? Verglichen werden die drei Zahlen."""
    new, old = parse_version(candidate), parse_version(than)
    return new is not None and old is not None and new > old


def same_version(first: str | None, second: str | None) -> bool:
    """Dieselbe Version, verglichen an den drei Zahlen."""
    one, other = parse_version(first), parse_version(second)
    return one is not None and one == other


def tag_version(tag: str) -> str | None:
    """Die Version aus dem Tag eines Releases: ein führendes „v" fällt weg, der Rest muss ``1.2.3`` sein."""
    return version_of(tag[1:] if tag.startswith("v") else tag)


# --- Texte aus fremder Quelle ------------------------------------------------------------------


def _plain(text: str, limit: int) -> str:
    """Zum Anzeigen: ohne Steuerzeichen, Leerraum zusammengefasst, höchstens ``limit`` Zeichen."""
    kept = "".join(" " if unicodedata.category(char) in _DROPPED else char for char in text)
    return texts.shorten(" ".join(kept.split()), limit)


def clean_device(name: str) -> str:
    """Der Gerätename für ``request``: ohne Steuerzeichen und „=", höchstens 60 Zeichen."""
    kept = "".join(char for char in name if char != "=" and unicodedata.category(char) not in _DROPPED)
    return kept.strip()[:DEVICE_MAX].rstrip()


def no_version(tag: object) -> str:
    """Die Meldung für ein Release, dessen Tag keine Version ``1.2.3`` ist."""
    shown = _plain(tag, TAG_SHOWN_MAX) if isinstance(tag, str) else ""
    return f"Das neueste Release hat keine Versionsnummer wie 1.2.3 (Tag {shown or 'fehlt'})."


# --- Antwort von GitHub ------------------------------------------------------------------------


@dataclass(frozen=True)
class Release:
    """Das neueste Release, wie es in ``job_runs.state`` steht. ``latest`` ist ``None``: Es gibt keins."""

    latest: str | None = None
    latest_name: str | None = None
    notes: str | None = None
    published_at: str | None = None
    url: str | None = None


NO_RELEASE = Release()


@dataclass(frozen=True)
class Failure:
    """Eine gescheiterte Abfrage: ``message`` für die App (``check_error``), ``detail`` fürs Log."""

    message: str
    detail: str


def _github_time(value: object) -> str | None:
    """``published_at`` von GitHub (ISO 8601, etwa ``2026-11-14T10:00:00Z``) im Format des Vertrags."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
        return None if moment.tzinfo is None else format_timestamp(moment)
    except (ValueError, OverflowError):
        return None


def _notes(body: object) -> str | None:
    """``body`` des Releases (Markdown), gekürzt auf ``UPDATE_NOTES_MAX`` Zeichen mit „…"; leer ergibt ``None``."""
    if not isinstance(body, str) or not body.strip():
        return None
    return texts.shorten(body, UPDATE_NOTES_MAX)


def read_release(payload: object) -> Release | Failure:
    """Das Release aus einer Antwort 200 (10.2)."""
    if not isinstance(payload, dict):
        return Failure(UNEXPECTED, "200 ohne Release")
    tag = payload.get("tag_name")
    latest = tag_version(tag) if isinstance(tag, str) else None
    if latest is None:
        return Failure(no_version(tag), f"Tag {tag!r}"[:200])
    name = payload.get("name")
    url = payload.get("html_url")
    return Release(
        latest=latest,
        latest_name=(name.strip() or None) if isinstance(name, str) else None,
        notes=_notes(payload.get("body")),
        published_at=_github_time(payload.get("published_at")),
        url=url if isinstance(url, str) and url.startswith(RELEASE_PAGES) else None,
    )


def evaluate(status_code: int, content: bytes) -> Release | Failure:
    """Deutet die Antwort von ``releases/latest`` (10.2). 404 heißt: noch kein Release, kein Fehler."""
    if status_code == 200:
        try:
            payload = json.loads(content)
        except (ValueError, RecursionError):
            return Failure(UNEXPECTED, "200 ohne JSON")
        return read_release(payload)
    if status_code == 404:
        return NO_RELEASE
    if status_code in (403, 429):
        return Failure(RATE_LIMITED, f"HTTP {status_code}")
    return Failure(f"GitHub antwortet mit {status_code}.", f"HTTP {status_code}")


def stored_release(run: scheduler.JobRun) -> Release:
    """Das neueste Release aus ``job_runs``; unbrauchbare Werte fallen weg."""
    state = run.state
    latest = version_of(state.get("latest"))
    if run.last_at is None or latest is None:
        return NO_RELEASE

    def text(key: str) -> str | None:
        value = state.get(key)
        return value if isinstance(value, str) else None

    published, url = text("published_at"), text("url")
    return Release(
        latest=latest,
        latest_name=text("latest_name"),
        notes=text("notes"),
        published_at=published if published is not None and is_timestamp(published) else None,
        url=url if url is not None and url.startswith(RELEASE_PAGES) else None,
    )


# --- Dateien in /data/update (10.3) ------------------------------------------------------------


def read_fields(path: Path) -> dict[str, str] | None:
    """Eine Datei aus Zeilen ``key=value``; ``None``, wenn sie fehlt oder sich nicht lesen lässt.

    Tolerant: UTF-8 mit oder ohne BOM, kaputte Bytes werden ersetzt, ``\\r`` und Leerraum am Rand
    fallen weg, Zeilen ohne ``=`` werden überlesen. Steht ein Schlüssel zweimal da, gilt der erste
    (wie beim Updater).
    """
    try:
        with path.open("rb") as handle:
            raw = handle.read(FILE_MAX_BYTES)
    except FileNotFoundError:
        return None
    except OSError as exc:
        log.warning("Updates: %s lässt sich nicht lesen (%s)", path.name, type(exc).__name__)
        return None
    fields: dict[str, str] = {}
    for line in raw.decode("utf-8-sig", errors="replace").split("\n"):
        key, separator, value = line.partition("=")
        key = key.strip()
        if separator and key:
            fields.setdefault(key, value.strip())
    return fields


def parse_time(text: str | None) -> datetime | None:
    """Ein Zeitpunkt aus einer Datei: ``YYYY-MM-DDTHH:MM:SSZ`` oder im Format des Vertrags; sonst ``None``."""
    if text is None:
        return None
    try:
        if is_timestamp(text):
            return parse_timestamp(text)
        if _UPDATER_TIME.match(text):
            return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None
    return None


@dataclass(frozen=True)
class Files:
    """Was in ``/data/update`` liegt; ``None``: Die Datei fehlt."""

    request: dict[str, str] | None
    state: dict[str, str] | None
    updater: dict[str, str] | None


def read_files(folder: Path) -> Files:
    return Files(
        request=read_fields(folder / REQUEST),
        state=read_fields(folder / STATE),
        updater=read_fields(folder / UPDATER),
    )


def write_request(folder: Path, *, version: str, requested_at: datetime, device: str) -> None:
    """Schreibt ``request`` (10.3): zuerst ``request.tmp`` (``fsync``), dann umbenannt.

    Darin steht nur die geprüfte Version, der Zeitpunkt und der bereinigte Gerätename.
    """
    lines = (
        f"version={version}",
        f"requested_at={format_timestamp(requested_at)}",
        f"device={clean_device(device)}",
    )
    content = "".join(f"{line}\n" for line in lines).encode()
    folder.mkdir(parents=True, exist_ok=True)
    temp = folder / REQUEST_TMP
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
    try:
        with os.fdopen(os.open(temp, flags, 0o644), "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, folder / REQUEST)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise


def prepare_folder(settings: Settings) -> None:
    """Legt ``/data/update`` beim Start an (10.3). Scheitert das, startet der Server trotzdem."""
    try:
        settings.update_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log.warning("Updates: Der Ordner %s ließ sich nicht anlegen.", settings.update_dir, exc_info=True)


# --- Zustand (10.4) ----------------------------------------------------------------------------


def _message(text: str | None) -> str | None:
    """Die Meldung des Updaters zum Anzeigen; leer ergibt ``None``."""
    return (_plain(text, MESSAGE_MAX) or None) if text is not None else None


def _described(
    state: UpdateState, version: str | None, at: datetime | None, message: str | None = None
) -> dict[str, Any]:
    return {
        "state": state,
        "state_version": version,
        "state_at": None if at is None else format_timestamp(at),
        "state_message": message,
    }


def update_state(files: Files, now: datetime, *, updater_ready: bool) -> dict[str, Any]:
    """``state``, ``state_version``, ``state_at`` und ``state_message``: Die erste passende Regel gilt."""
    reported = files.state or {}
    kind = reported.get("state")
    reported_version = version_of(reported.get("version"))
    reported_at = parse_time(reported.get("at"))
    if files.request is not None:
        wanted = version_of(files.request.get("version"))
        # 1. Der Updater arbeitet an genau dieser Anforderung.
        if kind == INSTALLING and same_version(wanted, reported_version):
            return _described(UpdateState.INSTALLING, reported_version, reported_at)
        # 2. Angefordert, noch nicht aufgenommen.
        requested_at = parse_time(files.request.get("requested_at"))
        stale = requested_at is not None and now - requested_at > REQUEST_STALE_AFTER and not updater_ready
        return _described(
            UpdateState.REQUESTED, wanted, requested_at, REQUEST_NOT_PICKED_UP if stale else None
        )
    if kind == INSTALLING:
        # 3. In Arbeit, aber ohne Anforderung: Meldet sich der Updater nicht mehr, sagt die App es.
        quiet = reported_at is not None and now - reported_at > INSTALLING_QUIET_AFTER
        return _described(
            UpdateState.INSTALLING, reported_version, reported_at, UPDATER_QUIET if quiet else None
        )
    if kind == DONE and same_version(reported_version, __version__):
        # 4. Dieser Server läuft mit der installierten Version.
        return _described(UpdateState.DONE, reported_version, reported_at)
    if kind == FAILED:
        # 5. Gescheitert; die vorige Version läuft.
        return _described(
            UpdateState.FAILED, reported_version, reported_at, _message(reported.get("message"))
        )
    # 6. Nichts angefordert, oder das Ergebnis betrifft eine andere Version (etwa nach einem
    #    Zurückspielen von Hand).
    return _described(UpdateState.IDLE, None, None)


def status(settings: Settings, con: sqlite3.Connection, now: datetime) -> dict[str, Any]:
    """``UpdateStatus`` (10.4) aus ``job_runs`` und den Dateien in ``/data/update``.

    Nie darin: Pfade des Rechners und der Inhalt von ``log``.
    """
    run = scheduler.load_run(con, JOB)
    release = stored_release(run)
    files = read_files(settings.update_dir)
    seen = parse_time((files.updater or {}).get("seen_at"))
    ready = seen is not None and now - seen <= READY_WITHIN
    checked_at = run.last_at if run.last_at is not None and is_timestamp(run.last_at) else None
    # Die wirksamen Werte: STOWLY_UPDATE_REPO, sonst der Schalter in der App (Abschnitt 12).
    repo = serverconfig.update_repo(settings, con)
    return {
        "configured": repo is not None,
        "repo": repo,
        "current": __version__,
        "latest": release.latest,
        "latest_name": release.latest_name,
        "notes": release.notes,
        "published_at": release.published_at,
        "url": release.url,
        "available": newer(release.latest, __version__),
        "checked_at": checked_at,
        "check_error": run.last_error,
        "updater_ready": ready,
        "updater_seen_at": None if seen is None else format_timestamp(seen),
        "updater_kind": None if seen is None else _updater_kind(files.updater),
        "updater_version": _updater_version(files.updater),
        "updater_command": updater_command(settings),
        **update_state(files, now, updater_ready=ready),
    }


def _updater_kind(heartbeat: dict[str, str] | None) -> str:
    """``kind`` aus der Datei ``updater``; der Host-Updater bis 0.2.x schreibt keines (``script``)."""
    kind = (heartbeat or {}).get("kind")
    return kind if kind in ("script", "container") else "script"


def _updater_version(heartbeat: dict[str, str] | None) -> str | None:
    """``version`` aus der Datei ``updater``, nur in der Form X.Y.Z."""
    version = (heartbeat or {}).get("version")
    return version if version is not None and _VERSION.fullmatch(version) else None


# --- Anfordern (10.5) --------------------------------------------------------------------------


class Refused(Exception):
    """Die Anforderung gilt nicht: ``status``, ``code`` und ``message`` für die Fehlerantwort."""

    def __init__(self, status: int, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# Prüfen und Ablegen am Stück: Zwei gleichzeitige Anforderungen ergeben eine und einen 409.
_INSTALL_LOCK = threading.Lock()


def install(
    settings: Settings, con: sqlite3.Connection, version: str, *, device: str, now: datetime
) -> dict[str, Any]:
    """Prüft in der Reihenfolge von 10.5 und legt ``request`` ab; liefert den neuen Zustand.

    ``Refused`` mit 503 (Updates aus, Updater fehlt) oder 409 (schon angefordert, nicht die neueste
    Version, nicht neuer als dieser Server).
    """
    if serverconfig.update_repo(settings, con) is None:
        raise Refused(503, ErrorCode.NOT_CONFIGURED, NOT_CONFIGURED)
    with _INSTALL_LOCK:
        current = status(settings, con, now)
        if not current["updater_ready"]:
            raise Refused(503, ErrorCode.NOT_CONFIGURED, UPDATER_MISSING)
        if current["state"] in (UpdateState.REQUESTED, UpdateState.INSTALLING):
            raise Refused(409, ErrorCode.CONFLICT, ALREADY_REQUESTED)
        latest = current["latest"]
        if latest is None or version != latest:
            raise Refused(409, ErrorCode.CONFLICT, NOT_LATEST)
        if not current["available"]:
            raise Refused(409, ErrorCode.CONFLICT, ALREADY_INSTALLED)
        name = clean_device(device)
        try:
            write_request(settings.update_dir, version=latest, requested_at=now, device=name)
        except OSError:
            log.exception("Updates: Die Anforderung ließ sich nicht in %s ablegen", settings.update_dir)
            raise Refused(500, ErrorCode.INTERNAL, NOT_WRITTEN) from None
    log.info("Update auf %s angefordert von %s", latest, name)
    return status(settings, con, now)


# --- Die Schleife ------------------------------------------------------------------------------


class TooSoon(Exception):
    """Mehr als ein Knopfdruck in ``UPDATE_CHECK_MIN_GAP_S`` Sekunden."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


class UpdateChecker:
    """Fragt GitHub nach dem neuesten Release. Läuft als asyncio-Aufgabe im ``lifespan`` der App, immer;
    solange Updates aus sind, schläft sie, bis ``reconfigure`` oder ``stop`` sie weckt.

    ``sender`` verschickt die Nachricht „Neue Version" (nur mit wirksamem Kontakt für die Push-Dienste).
    ``transport`` und ``clock`` sind der Ersatz für Tests; im Betrieb bleiben sie ``None``. Die Uhr
    bestimmt auch den Takt: Gewartet wird mit ``clock.sleep``.
    """

    def __init__(
        self,
        settings: Settings,
        sender: push.PushService | None = None,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.settings = settings
        self._sender = sender
        self._clock = clock or Clock()
        self._client = httpx2.AsyncClient(
            transport=transport,
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
                "User-Agent": f"Stowly/{__version__}",
            },
            timeout=httpx2.Timeout(TIMEOUT_S),
            follow_redirects=False,  # Eine Weiterleitung ist ein „anderer Status" (10.2)
        )
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False
        self._reconfigured = False  # der Schalter hat sich geändert: der Takt beginnt neu
        self._next: float | None = None  # monoton: die nächste Abfrage im Takt; None = neu beginnen
        self._pressed: float | None = None  # monoton: der letzte Knopfdruck, der abgefragt hat

    # ------------------------------------------------------------------ Lebenslauf

    async def run(self) -> None:
        """Läuft bis ``stop``: Mit Updates kommt die erste Abfrage eine Minute nach dem Start (oder dem
        Einschalten), dann im Takt; ohne schläft die Schleife. Ein Fehler beendet sie nie."""
        self._loop = asyncio.get_running_loop()
        while not self._stopping:
            try:
                if self._reconfigured:
                    self._reconfigured = False
                    self._next = None
                if await asyncio.to_thread(self.repo) is None:
                    self._next = None
                    await self._idle()
                    continue
                if self._next is None:
                    self._next = self._clock.monotonic() + UPDATE_CHECK_FIRST_S
                delay = self._next - self._clock.monotonic()
                if delay > 0:
                    await self._sleep(delay)
                else:
                    await self._due()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Updates: unerwarteter Fehler in der Schleife")
                self._next = self._clock.monotonic() + UPDATE_CHECK_INTERVAL_S
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), ERROR_PAUSE_S)
                self._wake.clear()

    def stop(self) -> None:
        """Die Schleife endet; eine laufende Abfrage wird fertig. Nur in der Ereignisschleife aufrufen."""
        self._stopping = True
        self._wake.set()

    def reconfigure(self) -> None:
        """Der Schalter „Nach Updates suchen" hat sich geändert: Die Schleife liest ihn neu. Eingeschaltet
        kommt die erste Abfrage nach ``UPDATE_CHECK_FIRST_S``, ausgeschaltet keine mehr. Darf aus jedem
        Thread gerufen werden."""
        self._reconfigured = True
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._wake.set)

    async def aclose(self) -> None:
        await self._client.aclose()

    def repo(self) -> str | None:
        """Das wirksame Repository (``serverconfig.update_repo``); ``None`` = Updates sind aus. Liest die
        Datenbank, also in einem Thread aufrufen."""
        if self.settings.update_repo is not None:
            return self.settings.update_repo
        con = db.connect(self.settings.database_path)
        try:
            return serverconfig.update_repo(self.settings, con)
        finally:
            con.close()

    async def _idle(self) -> None:
        """Updates sind aus: warten, bis ``reconfigure`` oder ``stop`` weckt."""
        await self._wake.wait()
        self._wake.clear()

    async def _sleep(self, delay: float) -> None:
        """Wartet ``delay`` Sekunden nach der Uhr, oder bis ``wake`` (Knopfdruck, Ende)."""
        timer = asyncio.ensure_future(self._clock.sleep(delay))
        woken = asyncio.ensure_future(self._wake.wait())
        try:
            await asyncio.wait((timer, woken), return_when=asyncio.FIRST_COMPLETED)
        finally:
            timer.cancel()
            woken.cancel()
            await asyncio.gather(timer, woken, return_exceptions=True)
        self._wake.clear()
        if timer.done() and not timer.cancelled():
            problem = timer.exception()
            if problem is not None:
                # Sonst wartete die Schleife gleich wieder und scheiterte gleich wieder.
                raise problem

    async def _due(self) -> None:
        """Die Abfrage im Takt. Ein Knopfdruck kann sie inzwischen vorweggenommen haben."""
        async with self._lock:
            if self._next is not None and self._next > self._clock.monotonic():
                return
            await self._check()

    # ------------------------------------------------------------------ Abfragen

    def _admit(self) -> None:
        """Höchstens ein Knopfdruck in ``UPDATE_CHECK_MIN_GAP_S`` Sekunden, für den ganzen Server."""
        now = self._clock.monotonic()
        if self._pressed is not None and now - self._pressed < UPDATE_CHECK_MIN_GAP_S:
            raise TooSoon(max(1, math.ceil(self._pressed + UPDATE_CHECK_MIN_GAP_S - now)))
        self._pressed = now

    async def check_now(self) -> None:
        """Knopfdruck (``POST /api/update/check``): sofort fragen, der Takt beginnt neu; ``TooSoon``,
        wenn der letzte Knopfdruck keine Minute her ist."""
        self._admit()
        await self.check()
        self._wake.set()  # Die Schleife rechnet ihren Takt von dieser Abfrage aus neu.

    async def check(self) -> None:
        """Eine Abfrage bei GitHub, gleich jetzt; die nächste im Takt sechs Stunden danach. Sind Updates
        inzwischen aus, fragt sie nicht."""
        async with self._lock:
            await self._check()

    async def _check(self) -> None:
        repo = await asyncio.to_thread(self.repo)
        if repo is None:
            self._next = None
            return
        self._next = self._clock.monotonic() + UPDATE_CHECK_INTERVAL_S
        now = self._clock.now()
        outcome = await self._fetch(repo)
        if isinstance(outcome, Failure):
            log.warning("Updates: %s (%s)", outcome.message, outcome.detail)
        announce = await asyncio.to_thread(self._record, outcome, now)
        if announce is not None:
            await self._announce(announce)

    async def _fetch(self, repo: str) -> Release | Failure:
        url = f"{API_BASE}/repos/{repo}/releases/latest"
        try:
            # Höchstens 10 Sekunden, auch wenn die Antwort tröpfchenweise kommt.
            response = await asyncio.wait_for(self._client.get(url), TIMEOUT_S)
        except (TimeoutError, httpx2.HTTPError) as exc:
            return Failure(UNREACHABLE, type(exc).__name__)
        return evaluate(response.status_code, response.content)

    def _record(self, outcome: Release | Failure, now: datetime) -> str | None:
        """Hält das Ergebnis in ``job_runs`` fest; liefert die Version, die jetzt per Push zu melden ist.

        Nach einem Fehler bleiben die bisherigen Angaben stehen. ``notified`` wird gesetzt, bevor die
        Nachricht hinausgeht: lieber einmal zu wenig als zweimal.
        """
        stamp = format_timestamp(now)
        con = db.connect(self.settings.database_path)
        try:
            if isinstance(outcome, Failure):
                scheduler.record_failure(con, JOB, at=stamp, error=outcome.message)
                return None
            with db.transaction(con):
                previous = scheduler.load_run(con, JOB).state.get("notified")
                notified = previous if isinstance(previous, str) else None
                announce = None
                if newer(outcome.latest, __version__) and notified != outcome.latest:
                    announce = notified = outcome.latest
                scheduler.save_success(
                    con,
                    JOB,
                    day=localtime.today(now, self.settings.tz).isoformat(),
                    at=stamp,
                    state={
                        "latest": outcome.latest,
                        "latest_name": outcome.latest_name,
                        "notes": outcome.notes,
                        "published_at": outcome.published_at,
                        "url": outcome.url,
                        "notified": notified,
                    },
                )
            return announce
        finally:
            con.close()

    # ------------------------------------------------------------------ Push

    async def _announce(self, version: str) -> None:
        """„Stowly X.Y.Z ist verfügbar." an alle Abos des Haushalts; ohne Push nur ins Log."""
        if self._sender is None or await asyncio.to_thread(self._push_contact) is None:
            log.info("Updates: Stowly %s ist verfügbar.", version)
            return
        subscriptions = await asyncio.to_thread(self._subscriptions)
        text = f"Stowly {version} ist verfügbar."
        deliveries = await asyncio.gather(*(self._send(item, text) for item in subscriptions))
        reached = sum(1 for item in deliveries if item is not None and item.status is PushTestStatus.SENT)
        log.info(
            "Updates: Stowly %s ist verfügbar; Nachricht angenommen bei %d von %d Abos.",
            version,
            reached,
            len(subscriptions),
        )

    def _push_contact(self) -> str | None:
        con = db.connect(self.settings.database_path)
        try:
            return serverconfig.push_contact(self.settings, con)
        finally:
            con.close()

    def _subscriptions(self) -> list[push.Subscription]:
        con = db.connect(self.settings.database_path)
        try:
            rows = con.execute(
                "SELECT device_id, endpoint, p256dh, auth, origin FROM push_subscriptions "
                "ORDER BY created_at, device_id"
            ).fetchall()
        finally:
            con.close()
        return [push.Subscription(**{key: row[key] for key in row.keys()}) for row in rows]

    async def _send(self, subscription: push.Subscription, text: str) -> push.Delivery | None:
        assert self._sender is not None
        payload = push.notification(
            PUSH_TITLE, text, origin=subscription.origin, path=PUSH_PATHS["update"], tag=PUSH_TAG
        )
        try:
            return await self._sender.deliver(
                subscription, payload, ttl=PUSH_TTL_S, topic=PUSH_TOPIC, urgency=PUSH_URGENCY
            )
        except push.NoContact:
            return None
        except Exception:
            # Etwa ein unbrauchbarer Schlüssel an einem Abo: Die anderen bekommen ihre Nachricht trotzdem.
            log.exception("Updates: Nachricht an %s ließ sich nicht schicken", subscription.host)
            return None
