"""Der Updater-Container: ``python -m stowly.updater`` (docs/integrationen.md, 10.3 bis 10.7).

Alle ``HEARTBEAT_S`` Sekunden ein Durchgang (``Updater.tick``):

1. **Herzschlag** in ``update/updater``: ``seen_at``, ``updater=2``, ``kind=container``, ``version`` (von
   Stowly, aus der er stammt) und ``target``, der Name des Ziels.
2. **Ziel** ist der andere Container mit derselben Quelle für ``/data`` wie der Updater selbst (er läuft mit
   ``--volumes-from``). So übersteht die Zuordnung neue Container-IDs.
3. **Journal** in ``update/journal``: Liegt eins da, brach ein Update mittendrin ab. Der Updater bringt es
   zu Ende (der neue Container ist ``healthy``) oder kehrt zur alten Version zurück. Den Ordner kann auch
   der Server beschreiben; deshalb gilt ein Journal nur, wenn es dem Updater selbst gehört und keinen
   zweiten harten Link hat, und vor jedem Docker-Aufruf damit prüft er den Inhalt: beide Container mit
   derselben Quelle für ``/data`` wie er selbst, das Repository des Ziels, ein Name der Sicherung wie
   ``before-<version>-<zeit>.sqlite3``. Sonst ``failed``, ohne einen Container anzufassen.
4. **Anforderung** in ``update/request``: das Update, Schritt für Schritt wie in 10.7, unter der Sperre
   ``update/lock/``, die auch der Host-Updater nimmt.

**Dateien:** In ``/data/update`` schreibt der Server ohne Rechte, der Updater als root. Deshalb folgt er dort
und bei der Datenbank keinem Symlink (``SafeFolder``): Ordner mit ``O_DIRECTORY|O_NOFOLLOW`` geöffnet, alles
weitere relativ dazu; Dateien lesen mit ``O_NOFOLLOW`` und nur als echte Datei; schreiben über eine eigene
Zwischendatei (``O_EXCL``) und Umbenennen; das Log über einen offenen Dateideskriptor. Liegt ein Link vor,
bricht das Update mit ``failed`` ab, ohne ihm zu folgen.
"""

import contextlib
import errno
import logging
import os
import re
import secrets
import signal
import stat
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

from stowly import __version__
from stowly.contract.api import VERSION_PATTERN
from stowly.contract.ids import exact
from stowly.updater import clone
from stowly.updater.command import own_container_id
from stowly.updater.docker import DockerError, Engine, PullFailed

log = logging.getLogger("stowly.updater")

UPDATER_PROTOCOL = 2
KIND = "container"
HEARTBEAT_S = 15.0
HEALTH_WAIT_S = 180.0
HEALTH_POLL_S = 5.0
STOP_TIMEOUT_S = 15
PULL_TRIES = 3
PULL_PAUSE_S = 10.0
KEEP_BACKUPS = 3
STALE_LOCK_S = 30 * 60
FILE_MAX = 64 * 1024
DATA_MOUNT = "/data"
DATABASE = "stowly.sqlite3"
DATABASE_SUFFIXES = ("-wal", "-shm")
PREVIOUS_SUFFIX = "-vorher"
COMPOSE_LABEL = "com.docker.compose.project"
OCI_VERSION_LABEL = "org.opencontainers.image.version"

# Dateien in /data/update (10.3)
UPDATE = "update"
REQUEST = "request"
STATE = "state"
HEARTBEAT = "updater"
LOG = "log"
LOCK = "lock"
JOURNAL = "journal"
_BACKUP = re.compile(r"before-.+\.sqlite3")
VERSION = exact(VERSION_PATTERN)
# Was in einem Journal stehen darf (Run.resume prüft es, bevor es einen Container anfasst).
PHASES = frozenset({"stopping", "renaming", "renamed", "created", "starting"})
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}")
_CONTAINER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
UNKNOWN_VERSION = "unbekannt"

INSTALLING, DONE, FAILED = "installing", "done", "failed"
COMPOSE_REFUSED = "Dieser Container gehört zu Docker Compose; dafür gibt es updater/stowly-update.sh."
NO_TARGET = (
    "Den Container von Stowly findet der Updater nicht (derselbe Ordner für /data). "
    "Bitte den Befehl aus der App erneut ausführen."
)
NO_REPOSITORY = "Woher das Image von Stowly stammt, ist unbekannt (STOWLY_IMAGE_REF)."
NOT_RUNNING_HINT = "Bitte auf dem Rechner nachsehen (update/log im Datenvolume)."
FOREIGN_JOURNAL = (
    "Das Journal in update/ passt nicht zu den Containern von Stowly; der Updater fasst nichts an. "
    + NOT_RUNNING_HINT
)

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_BINARY = getattr(os, "O_BINARY", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
# Unter Linux arbeitet SafeFolder mit einem offenen Ordner (dir_fd); sonst (Windows, nur in Tests) mit
# Pfaden und lstat.
_DIR_FD = os.open in os.supports_dir_fd and hasattr(os, "O_DIRECTORY") and bool(_NOFOLLOW)


class LinkFound(Exception):
    """Wo eine Datei oder ein Ordner hingehört, liegt ein Symlink (oder etwas anderes); ``name`` sagt wo."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name


def _root() -> bool:
    return hasattr(os, "geteuid") and os.geteuid() == 0


def _expected_uid() -> int | None:
    """Wem die Dateien des Updaters gehören: ihm selbst (im Container root). ``None`` ohne Besitzer (Windows)."""
    return os.geteuid() if hasattr(os, "geteuid") else None


def own_file(info: os.stat_result) -> bool:
    """Eine Datei, die der Updater selbst geschrieben hat: echte Datei, kein zweiter harter Link, sein Besitz."""
    expected = _expected_uid()
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (expected is None or info.st_uid == expected)


# --- Dateien, ohne einem Symlink zu folgen ----------------------------------------------------------


class SafeFolder:
    """Ein Ordner, in dem der Updater als root liest und schreibt, ohne je einem Symlink zu folgen.

    Alle Namen sind einfache Namen in diesem Ordner, ohne ``/``.
    """

    def __init__(self, path: Path, fd: int | None = None) -> None:
        self.path = path
        self.fd = fd
        if fd is not None:
            return
        if _DIR_FD:
            try:
                self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | _NOFOLLOW | _CLOEXEC)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise LinkFound(path.name) from None
                raise
        elif path.is_symlink() or (path.exists() and not path.is_dir()):
            raise LinkFound(path.name)
        elif not path.is_dir():
            raise FileNotFoundError(errno.ENOENT, "Ordner fehlt", str(path))

    def close(self) -> None:
        if self.fd is not None:
            with contextlib.suppress(OSError):
                os.close(self.fd)
            self.fd = None

    def __enter__(self) -> "SafeFolder":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ Grundlagen

    def _at(self, name: str) -> tuple[Any, dict[str, Any]]:
        if "/" in name or "\\" in name or name in ("", ".", ".."):
            raise ValueError(f"Kein einfacher Name: {name!r}")
        if self.fd is not None:
            return name, {"dir_fd": self.fd}
        return self.path / name, {}

    def lstat(self, name: str) -> os.stat_result | None:
        target, where = self._at(name)
        try:
            return os.stat(target, follow_symlinks=False, **where)
        except FileNotFoundError:
            return None

    def kind(self, name: str) -> str:
        """``missing``, ``file``, ``dir``, ``link`` oder ``other``."""
        info = self.lstat(name)
        if info is None:
            return "missing"
        if stat.S_ISLNK(info.st_mode):
            return "link"
        if stat.S_ISREG(info.st_mode):
            return "file"
        if stat.S_ISDIR(info.st_mode):
            return "dir"
        return "other"

    def child(self, name: str) -> "SafeFolder":
        """Ein Unterordner, ebenso ohne Symlink geöffnet."""
        target, where = self._at(name)
        if self.fd is None:
            return SafeFolder(Path(target))
        try:
            fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | _NOFOLLOW | _CLOEXEC, **where)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise LinkFound(name) from None
            raise
        return SafeFolder(self.path / name, fd)

    def open_read(self, name: str) -> int:
        """Ein Dateideskriptor zum Lesen, nur für eine echte Datei; ``LinkFound`` sonst."""
        target, where = self._at(name)
        if self.fd is None:
            # Ohne O_NOFOLLOW (Windows, nur in Tests): vorher nachsehen.
            kind = self.kind(name)
            if kind == "missing":
                raise FileNotFoundError(errno.ENOENT, "Datei fehlt", name)
            if kind != "file":
                raise LinkFound(name)
        try:
            fd = os.open(target, os.O_RDONLY | _NOFOLLOW | _NONBLOCK | _BINARY | _CLOEXEC, **where)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise LinkFound(name) from None
            raise
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise LinkFound(name)
        return fd

    def read(self, name: str, limit: int = FILE_MAX) -> bytes | None:
        """Der Inhalt einer echten Datei; ``None``, wenn es sie nicht gibt."""
        try:
            fd = self.open_read(name)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "rb") as stream:
            return stream.read(limit)

    def _new_temporary(self, name: str, mode: int) -> tuple[int, str]:
        """Eine neue Zwischendatei mit zufälligem Namen, angelegt mit ``O_EXCL``."""
        for _attempt in range(10):
            temporary = f".{name}.{secrets.token_hex(6)}.tmp"
            target, where = self._at(temporary)
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _BINARY | _CLOEXEC
                return os.open(target, flags, mode, **where), temporary
            except FileExistsError:
                continue
        raise OSError(errno.EEXIST, "Keine freie Zwischendatei", name)

    def _replace(self, temporary: str, name: str) -> None:
        source, where = self._at(temporary)
        target, _where = self._at(name)
        if self.fd is not None:
            os.replace(source, target, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        else:
            os.replace(source, target)

    @staticmethod
    def _finish(fd: int, mode: int, owner: tuple[int, int] | None) -> None:
        """Rechte und Besitzer über den Deskriptor (nie über einen Namen), dann auf die Platte."""
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        if owner is not None and _root():
            os.fchown(fd, *owner)
        os.fsync(fd)

    def write(
        self, name: str, data: bytes, *, mode: int = 0o644, owner: tuple[int, int] | None = None
    ) -> None:
        """Schreibt atomar: eigene Zwischendatei, dann umbenannt. Ein Symlink an ``name`` wird ersetzt, nie verfolgt."""
        fd, temporary = self._new_temporary(name, mode)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view) :]
            self._finish(fd, mode, owner)
            os.close(fd)
            fd = -1
            self._replace(temporary, name)
        except BaseException:
            if fd >= 0:
                os.close(fd)
            self.unlink(temporary)
            raise

    def new_log(self, name: str) -> BinaryIO:
        """Eine neue, leere Datei unter ``name``, offen zum Schreiben: Wer den Namen danach ersetzt, lenkt
        nichts mehr um."""
        fd, temporary = self._new_temporary(name, 0o644)
        try:
            self._finish(fd, 0o644, None)
            if self.fd is None:
                # Ohne dir_fd (Windows, nur in Tests) lässt sich eine offene Datei nicht umbenennen.
                os.close(fd)
                fd = -1
            self._replace(temporary, name)
        except BaseException:
            if fd >= 0:
                os.close(fd)
            self.unlink(temporary)
            raise
        if fd < 0:
            return (self.path / name).open("ab", buffering=0)
        return os.fdopen(fd, "ab", buffering=0)

    def append_log(self, name: str) -> BinaryIO:
        """Die vorhandene Datei zum Anhängen, wenn sie eine eigene ist (echte Datei ohne weiteren harten Link,
        root gehörend); sonst eine neue."""
        target, where = self._at(name)
        if self.fd is not None:
            try:
                fd = os.open(target, os.O_WRONLY | os.O_APPEND | _NOFOLLOW | _NONBLOCK | _CLOEXEC, **where)
            except OSError:
                return self.new_log(name)
            info = os.fstat(fd)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (not _root() or info.st_uid == 0):
                return os.fdopen(fd, "ab", buffering=0)
            os.close(fd)
        return self.new_log(name)

    def unlink(self, name: str) -> None:
        """Löscht einen Eintrag (bei einem Symlink den Link selbst); fehlt er, ist nichts zu tun."""
        target, where = self._at(name)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(target, **where)

    def mkdir(self, name: str, owner: tuple[int, int] | None = None) -> bool:
        """Legt einen Ordner an; ``False``, wenn dort schon etwas liegt (auch ein Symlink)."""
        target, where = self._at(name)
        try:
            os.mkdir(target, 0o755, **where)
        except FileExistsError:
            return False
        if owner is not None and _root():
            os.chown(target, *owner, follow_symlinks=False, **where)
        return True

    def rmdir(self, name: str) -> None:
        target, where = self._at(name)
        with contextlib.suppress(OSError):
            os.rmdir(target, **where)

    def names(self) -> list[str]:
        return os.listdir(self.fd if self.fd is not None else self.path)

    def owner(self) -> tuple[int, int]:
        info = os.fstat(self.fd) if self.fd is not None else os.stat(self.path)
        return info.st_uid, info.st_gid

    def copy_to(self, name: str, target: "SafeFolder", target_name: str) -> None:
        """Kopiert eine echte Datei samt Rechten und Besitzer; das Ziel wird atomar ersetzt."""
        source = self.open_read(name)
        try:
            info = os.fstat(source)
            mode = stat.S_IMODE(info.st_mode) & 0o777
            fd, temporary = target._new_temporary(target_name, mode)
            try:
                while chunk := os.read(source, 1024 * 1024):
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(fd, view) :]
                target._finish(fd, mode, (info.st_uid, info.st_gid))
                os.close(fd)
                fd = -1
                target._replace(temporary, target_name)
            except BaseException:
                if fd >= 0:
                    os.close(fd)
                target.unlink(temporary)
                raise
        finally:
            os.close(source)


def parse_fields(raw: bytes | None) -> dict[str, str] | None:
    """Zeilen ``key=value`` wie ``updates.read_fields``: der erste Wert eines Schlüssels gilt."""
    if raw is None:
        return None
    fields: dict[str, str] = {}
    for line in raw.decode("utf-8-sig", errors="replace").split("\n"):
        key, separator, value = line.partition("=")
        if separator and key.strip():
            fields.setdefault(key.strip(), value.strip())
    return fields


def _line(value: object) -> str:
    """Ein Wert für eine Zeile ``key=value``: ohne Zeilenumbruch und Steuerzeichen."""
    return "".join(char if char.isprintable() else " " for char in str(value)).strip()


def format_fields(fields: Mapping[str, object]) -> bytes:
    return "".join(f"{key}={_line(value)}\n" for key, value in fields.items()).encode("utf-8")


# --- Uhr -------------------------------------------------------------------------------------------


class Clock:
    """Echte Zeit; Tests setzen eine eigene ein, deren ``sleep`` nur vorstellt."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def stamp(moment: datetime) -> str:
    """So schreiben beide Updater Zeitpunkte (10.3)."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- Das Ziel --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    id: str
    name: str


def data_source(container: Mapping[str, Any]) -> tuple[str, str] | None:
    """Woher ``/data`` eines Containers kommt: ``(art, quelle)``, für ``inspect`` und für die Liste."""
    for mount in container.get("Mounts") or []:
        if isinstance(mount, Mapping) and mount.get("Destination") == DATA_MOUNT:
            kind = str(mount.get("Type") or "")
            source = mount.get("Name") if kind == "volume" else mount.get("Source")
            return (kind, str(source)) if source else None
    return None


def running_version(container: Mapping[str, Any], image: Mapping[str, Any] | None) -> str | None:
    """Die Version, mit der ein Container läuft: das Label ``org.opencontainers.image.version`` seines Images,
    sonst der Tag, sonst das Label am Container."""
    config = container.get("Config") or {}
    value = ((((image or {}).get("Config") or {}).get("Labels")) or {}).get(OCI_VERSION_LABEL)
    if isinstance(value, str) and VERSION.match(value):
        return value
    candidate = clone.tag(config.get("Image"))
    if candidate is not None and VERSION.match(candidate):
        return candidate
    value = (config.get("Labels") or {}).get(OCI_VERSION_LABEL)
    if isinstance(value, str) and VERSION.match(value):
        return value
    return None


def version_numbers(text: str) -> tuple[int, int, int] | None:
    """``X.Y.Z`` als drei Zahlen; sonst ``None``."""
    if not VERSION.match(text):
        return None
    major, minor, patch = text.split(".")
    return int(major), int(minor), int(patch)


def journal_problem(journal: Mapping[str, str]) -> str | None:
    """Was an einem Journal nicht stimmen kann, ohne Docker zu fragen; ``None``, wenn die Form passt."""
    version, old_version = journal.get("version", ""), journal.get("from", "")
    if not VERSION.match(version) or not (VERSION.match(old_version) or old_version == UNKNOWN_VERSION):
        return "Versionen"
    if not _CONTAINER_NAME.fullmatch(journal.get("name", "")):
        return "Name"
    if not _CONTAINER_ID.fullmatch(journal.get("old_id", "")):
        return "alter Container"
    if journal.get("new_id") and not _CONTAINER_ID.fullmatch(journal["new_id"]):
        return "neuer Container"
    if journal.get("phase") not in PHASES:
        return "Schritt"
    backup = re.compile(rf"before-{re.escape(old_version)}-[0-9]{{8}}T[0-9]{{6}}Z\.sqlite3")
    if not backup.fullmatch(journal.get("backup", "")):
        return "Sicherung"
    if journal.get("tty", "0") not in ("0", "1"):
        return "tty"
    return None


def _health(info: Mapping[str, Any] | None) -> str:
    """``healthy``, ``unhealthy``, ``starting`` oder der Zustand des Containers (``exited`` …)."""
    if info is None:
        return "missing"
    state = info.get("State") or {}
    if state.get("Status") in ("exited", "dead", "created", "removing") or state.get("Running") is False:
        return str(state.get("Status") or "exited")
    health = state.get("Health") or {}
    return str(health.get("Status") or state.get("Status") or "unknown")


# --- Der Updater -----------------------------------------------------------------------------------


class Updater:
    """Ein Updater-Container. ``engine`` und ``clock`` ersetzen in Tests Docker und die Zeit."""

    def __init__(
        self,
        engine: Engine,
        *,
        data_dir: Path = Path(DATA_MOUNT),
        own_id: str | None,
        image_ref: str | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.engine = engine
        self.data_dir = data_dir
        self.own_id = own_id
        self.image_ref = image_ref
        self.clock = clock or Clock()
        self.target: Target | None = None
        self._update: SafeFolder | None = None

    # ------------------------------------------------------------------ Durchgang

    def run_forever(self, *, stop: Callable[[], bool] = lambda: False) -> None:
        """Die Schleife: ein Durchgang, dann ``HEARTBEAT_S`` warten. Ein Fehler beendet sie nie."""
        while not stop():
            try:
                self.tick()
            except Exception:
                log.exception("Unerwarteter Fehler im Updater")
            self.clock.sleep(HEARTBEAT_S)

    def tick(self) -> None:
        try:
            data = SafeFolder(self.data_dir)
        except (LinkFound, OSError) as exc:
            log.error("Den Datenordner %s gibt es nicht oder er ist ein Symlink (%s).", self.data_dir, exc)
            return
        try:
            try:
                update = self._open_update(data)
            except LinkFound:
                log.error(
                    "%s/update ist kein echter Ordner; der Updater folgt keinem Symlink und tut nichts.",
                    self.data_dir,
                )
                return
            try:
                self._update = update
                try:
                    self.target = self.find_target()
                except DockerError as exc:
                    log.warning("Docker antwortet nicht: %s", exc)
                    self.target = None
                self.beat()
                journal = self._read_journal(update)
                if journal is not None:
                    self._guarded(update, data, journal, lambda run: run.resume(journal))
                elif update.kind(REQUEST) != "missing":
                    self._guarded(update, data, None, lambda run: run.execute())
            finally:
                self._update = None
                update.close()
        finally:
            data.close()

    def _open_update(self, data: SafeFolder) -> SafeFolder:
        if data.kind(UPDATE) == "missing":
            # Sonst legt ihn der Server an; so gehört er wie /data dem Server, nicht root.
            data.mkdir(UPDATE, owner=data.owner())
        return data.child(UPDATE)

    @staticmethod
    def _read_journal(update: SafeFolder) -> dict[str, str] | None:
        """``update/journal``, nur wenn der Updater es selbst geschrieben hat (``own_file``). Ein fremdes
        Journal (der Server kann in den Ordner schreiben) wird gelöscht, nie ausgeführt."""
        try:
            fd = update.open_read(JOURNAL)
        except (FileNotFoundError, LinkFound):
            return None
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            raw = stream.read(FILE_MAX) if own_file(info) else None
        if raw is None:
            log.warning(
                "update/journal stammt nicht vom Updater (Besitzer %s, %s harte Links); es wird gelöscht, nicht "
                "ausgeführt.",
                info.st_uid,
                info.st_nlink,
            )
            update.unlink(JOURNAL)
            return None
        return parse_fields(raw)

    @staticmethod
    def _read_or_none(folder: SafeFolder, name: str) -> bytes | None:
        try:
            return folder.read(name)
        except LinkFound:
            return None

    def _guarded(
        self,
        update: SafeFolder,
        data: SafeFolder,
        journal: dict[str, str] | None,
        action: Callable[["Run"], None],
    ) -> None:
        """Führt ein Update oder einen Wiederanlauf unter der Sperre ``lock/`` aus.

        Liegt in ``update/`` ein Symlink (oder etwas anderes als eine Datei, die Sperre ein Ordner), gibt es
        kein Update: ``failed``, ohne dem Link zu folgen.
        """
        odd = [
            name for name in (REQUEST, STATE, LOG, JOURNAL) if update.kind(name) not in ("missing", "file")
        ]
        if update.kind(LOCK) not in ("missing", "dir"):
            odd.append(LOCK)
        if odd:
            Run(self, update, data).refuse(odd)
            return
        if not self._take_lock(update, journal):
            return
        run = Run(self, update, data)
        try:
            action(run)
        except Exception:
            log.exception("Unerwarteter Fehler im Update")
            # Mit Journal geht es beim nächsten Durchgang weiter; ohne endet die Anforderung hier, damit
            # sie nicht alle 15 Sekunden von vorn beginnt.
            if update.kind(JOURNAL) == "missing":
                with contextlib.suppress(Exception):
                    run.finish(FAILED, f"Unerwarteter Fehler im Updater. {NOT_RUNNING_HINT}")
        finally:
            update.rmdir(LOCK)

    def _take_lock(self, update: SafeFolder, journal: dict[str, str] | None) -> bool:
        if update.mkdir(LOCK):
            return True
        if journal is not None and self.own_id is not None and journal.get("updater") == self.own_id:
            return True  # die Sperre des eigenen, abgebrochenen Laufs
        info = update.lstat(LOCK)
        if info is not None and time.time() - info.st_mtime > STALE_LOCK_S:
            update.rmdir(LOCK)
            return update.mkdir(LOCK)
        return False

    # ------------------------------------------------------------------ Herzschlag und Ziel

    def beat(self) -> None:
        """Schreibt ``update/updater`` (10.3), auch mitten in einem Update."""
        if self._update is None:
            return
        fields = {
            "seen_at": stamp(self.clock.now()),
            "updater": UPDATER_PROTOCOL,
            "kind": KIND,
            "version": __version__,
            "target": self.target.name if self.target is not None else "",
        }
        try:
            self._update.write(HEARTBEAT, format_fields(fields))
        except OSError as exc:
            log.warning("Der Herzschlag ließ sich nicht schreiben (%s).", exc)

    def find_target(self) -> Target | None:
        """Der andere Container mit derselben Quelle für ``/data``; ``None``, wenn keiner oder mehrere passen."""
        if self.own_id is None:
            return None
        own = self.engine.container(self.own_id)
        source = data_source(own) if own is not None else None
        if source is None:
            return None
        candidates: list[tuple[Mapping[str, Any], str]] = []
        for item in self.engine.containers():
            if item.get("Id") == self.own_id or data_source(item) != source:
                continue
            names = item.get("Names") or []
            name = str(names[0]).lstrip("/") if names else ""
            if name and not name.endswith(PREVIOUS_SUFFIX):
                candidates.append((item, name))
        if len(candidates) > 1:
            candidates = [entry for entry in candidates if entry[0].get("State") == "running"]
        if len(candidates) != 1:
            return None
        item, name = candidates[0]
        return Target(id=str(item["Id"]), name=name)


# --- Ein Update ------------------------------------------------------------------------------------


class Run:
    """Ein Update oder ein Wiederanlauf, Schritt für Schritt wie in 10.7."""

    def __init__(self, updater: Updater, update: SafeFolder, data: SafeFolder | None) -> None:
        self.updater = updater
        self.engine = updater.engine
        self.clock = updater.clock
        self.update = update
        self.data = data
        self.log: BinaryIO | None = None
        self.new = ""
        self.old = "unbekannt"
        self.journal: dict[str, str] = {}

    # ------------------------------------------------------------------ Melden

    def say(self, text: str) -> None:
        log.info("%s", text)
        if self.log is not None:
            with contextlib.suppress(OSError):
                self.log.write(f"{stamp(self.clock.now())} {_line(text)}\n".encode())

    def set_state(self, state: str, message: str) -> None:
        fields = {
            "state": state,
            "version": self.new,
            "from": self.old,
            "at": stamp(self.clock.now()),
            "message": message,
        }
        self.update.write(STATE, format_fields(fields))

    def finish(self, state: str, message: str) -> None:
        """Das Ende jedes Updates: Ergebnis festhalten, Anforderung und Journal löschen."""
        self.set_state(state, message)
        self.say(message)
        self.update.unlink(REQUEST)
        self.update.unlink(JOURNAL)
        if self.log is not None:
            self.log.close()
            self.log = None

    def refuse(self, names: list[str]) -> None:
        """Ein Symlink (oder keine echte Datei) in ``update/``: ``failed``, ohne ihm zu folgen. Die Links
        selbst fallen weg (bei einem Link wird nur er gelöscht, nie sein Ziel)."""
        request = parse_fields(Updater._read_or_none(self.update, REQUEST)) or {}
        version = request.get("version", "")
        self.new = version if VERSION.match(version) else ""
        message = (
            f"In update/ liegt ein Symlink oder keine echte Datei ({', '.join(names)}); der Updater folgt "
            "ihm nicht. Stowly läuft unverändert weiter."
        )
        log.error("%s", message)
        for name in names:
            if self.update.kind(name) == "dir":
                self.update.rmdir(name)
            else:
                self.update.unlink(name)
        self.set_state(FAILED, message)
        if self.update.kind(REQUEST) == "file":
            self.update.unlink(REQUEST)

    def write_journal(self, **changes: str) -> None:
        self.journal.update(changes)
        self.update.write(JOURNAL, format_fields(self.journal))

    # ------------------------------------------------------------------ Bausteine

    def wait_healthy(self, ref: str) -> bool:
        """Bis zu ``HEALTH_WAIT_S`` Sekunden auf ``healthy``; ``exited``, ``dead`` und ``unhealthy`` sind ein
        Fehlschlag. Der Herzschlag geht derweil weiter."""
        deadline = self.clock.monotonic() + HEALTH_WAIT_S
        while True:
            try:
                status = _health(self.engine.container(ref))
            except DockerError as exc:
                self.say(f"Docker antwortet nicht ({exc}).")
                status = "unknown"
            if status == "healthy":
                return True
            if status in ("unhealthy", "exited", "dead", "missing", "removing"):
                self.say(f"Der Container meldet {status}.")
                return False
            if self.clock.monotonic() >= deadline:
                self.say(f"Nach {int(HEALTH_WAIT_S)} Sekunden noch nicht healthy ({status}).")
                return False
            self.updater.beat()
            self.clock.sleep(HEALTH_POLL_S)

    def backup_name(self) -> str:
        return f"before-{self.old}-{self.clock.now().astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}.sqlite3"

    def backup_database(self, backup: str) -> None:
        """Kopiert die Datenbank samt ``-wal`` und ``-shm`` nach ``update/`` (nur echte Dateien)."""
        assert self.data is not None
        self.data.copy_to(DATABASE, self.update, backup)
        for suffix in DATABASE_SUFFIXES:
            kind = self.data.kind(DATABASE + suffix)
            if kind == "missing":
                continue
            if kind != "file":
                raise LinkFound(DATABASE + suffix)
            self.data.copy_to(DATABASE + suffix, self.update, backup + suffix)

    def restore_database(self, backup: str) -> None:
        """Spielt die Kopie zurück; ``-wal`` und ``-shm`` des Fehlversuchs fallen weg."""
        assert self.data is not None
        for suffix in DATABASE_SUFFIXES:
            self.data.unlink(DATABASE + suffix)
        self.update.copy_to(backup, self.data, DATABASE)
        for suffix in DATABASE_SUFFIXES:
            if self.update.kind(backup + suffix) == "file":
                self.update.copy_to(backup + suffix, self.data, DATABASE + suffix)

    def prune_backups(self) -> None:
        """Nur die drei neuesten Kopien bleiben."""
        copies = []
        for name in self.update.names():
            info = self.update.lstat(name)
            if _BACKUP.fullmatch(name) and info is not None:
                copies.append((info.st_mtime, name))
        for _mtime, name in sorted(copies, reverse=True)[KEEP_BACKUPS:]:
            for suffix in ("", *DATABASE_SUFFIXES):
                self.update.unlink(name + suffix)

    def cleanup_images(self, repository: str, keep: set[str]) -> None:
        """Alte Images derselben Herkunft; die neue und die vorige Version bleiben."""
        family = clone.familiar(repository)
        try:
            images = self.engine.images()
        except DockerError as exc:
            self.say(f"Die Liste der Images fehlt ({exc}).")
            return
        for image in images:
            for repo_tag in image.get("RepoTags") or []:
                name, _, version = str(repo_tag).rpartition(":")
                if clone.familiar(name) != family or not VERSION.match(version) or version in keep:
                    continue
                if self.engine.remove_image(repo_tag):
                    self.say(f"Image {repo_tag} entfernt.")

    # ------------------------------------------------------------------ Das Update

    def execute(self) -> None:
        self.log = self.update.new_log(LOG)
        request = parse_fields(self.update.read(REQUEST)) or {}
        version = request.get("version", "")
        self.say(f"Anforderung: Version '{_line(version)[:40]}'.")
        if not VERSION.match(version):
            return self.finish(FAILED, "Die Anforderung nennt keine gültige Version.")
        self.new = version
        try:
            api = self.engine.negotiate()
            target = self.updater.find_target()
            info = self.engine.container(target.id) if target is not None else None
        except DockerError as exc:
            return self.finish(FAILED, f"Docker antwortet nicht: {exc}")
        if target is None or info is None:
            return self.finish(FAILED, NO_TARGET)
        config = info.get("Config") or {}
        if COMPOSE_LABEL in (config.get("Labels") or {}):
            return self.finish(FAILED, COMPOSE_REFUSED)
        repository = clone.repository(config.get("Image")) or self.updater.image_ref
        if repository is None:
            return self.finish(FAILED, NO_REPOSITORY)
        try:
            old_image = self.engine.image(str(info.get("Image")))
        except DockerError:
            old_image = None
        self.old = running_version(info, old_image) or UNKNOWN_VERSION
        running, wanted = version_numbers(self.old), version_numbers(self.new)
        if running is not None and wanted is not None and wanted < running:
            return self.finish(
                FAILED,
                f"Die angeforderte Version {self.new} ist älter als {self.old}; der Updater geht nur vorwärts.",
            )
        if self.old == self.new:
            if self.wait_healthy(target.id):
                return self.finish(DONE, f"Stowly läuft mit {self.new}.")
            return self.finish(
                FAILED, f"Version {self.new} ist schon eingestellt, läuft aber nicht. {NOT_RUNNING_HINT}"
            )
        reference = f"{repository}:{self.new}"
        self.say(
            f"Ziel: Container {target.name} ({target.id[:12]}), {self.old} → {self.new}, Engine API {api[0]}.{api[1]}."
        )

        # 2. Laden
        self.set_state(INSTALLING, f"Lade {reference}.")
        for attempt in range(1, PULL_TRIES + 1):
            try:
                self.engine.pull(repository, self.new)
                break
            except PullFailed as exc:
                self.say(f"Laden, Versuch {attempt} von {PULL_TRIES}: {exc}")
                if attempt == PULL_TRIES:
                    return self.finish(
                        FAILED,
                        f"Das Image {reference} ließ sich nicht laden. Stowly läuft weiter mit {self.old}.",
                    )
                self.updater.beat()
                self.clock.sleep(PULL_PAUSE_S)

        # 3. Anhalten
        backup = self.backup_name()
        self.journal = {
            "updater": self.updater.own_id or "",
            "version": self.new,
            "from": self.old,
            "name": target.name,
            "old_id": target.id,
            "image": reference,
            "repository": repository,
            "backup": backup,
            "tty": "1" if config.get("Tty") else "0",
        }
        self.write_journal(phase="stopping")
        self.say(f"Halte {target.name} an.")
        try:
            self.engine.stop(target.id, STOP_TIMEOUT_S)
            after = self.engine.container(target.id)
            stopped = after is not None and (after.get("State") or {}).get("Running") is False
        except DockerError as exc:
            self.say(f"Anhalten: {exc}")
            stopped = False
        if not stopped:
            self.update.unlink(JOURNAL)
            return self.finish(FAILED, f"Stowly ließ sich nicht anhalten. Es läuft weiter mit {self.old}.")

        # 4. Sichern
        try:
            self.backup_database(backup)
        except LinkFound as exc:
            return self._abort_before_rename(
                target, f"Die Datenbank ist keine echte Datei ({exc.name}); der Updater folgt keinem Symlink."
            )
        except OSError as exc:
            return self._abort_before_rename(target, f"Die Datenbank ließ sich nicht kopieren ({exc}).")
        self.prune_backups()
        self.say(f"Datenbank gesichert: update/{backup}")

        # 5. Umbenennen
        previous = target.name + PREVIOUS_SUFFIX
        self.write_journal(phase="renaming")
        try:
            leftover = self.engine.container(previous)
            if leftover is not None and leftover.get("Id") != target.id:
                self.say(f"Ein alter Container {previous} ist noch da; er wird gelöscht.")
                self.engine.remove_container(str(leftover["Id"]))
            self.engine.rename(target.id, previous)
        except DockerError as exc:
            self.say(f"Umbenennen: {exc}")
            return self.rollback(target, None, restore=False, reason=None)
        self.write_journal(phase="renamed")

        # 6. Neu anlegen
        body, later = clone.create_body(info, (old_image or {}).get("Config"), reference, api)
        new_id: str | None = None
        try:
            new_id = self.engine.create(target.name, body)
            self.write_journal(phase="created", new_id=new_id)
            for network, endpoint in later:
                self.engine.connect(network, new_id, endpoint)
        except DockerError as exc:
            self.say(f"Anlegen: {exc}")
            return self.rollback(
                target,
                new_id,
                restore=False,
                reason=f"Der neue Container ließ sich nicht anlegen. Stowly läuft weiter mit {self.old}.",
            )

        # 7. Starten und warten
        self.write_journal(phase="starting")
        self.say(f"Starte Stowly {self.new}.")
        try:
            self.engine.start(new_id)
            healthy = self.wait_healthy(new_id)
        except DockerError as exc:
            self.say(f"Starten: {exc}")
            healthy = False
        if not healthy:
            return self.rollback(target, new_id, restore=True, reason=None)
        self.succeed(target, repository)

    def _abort_before_rename(self, target: Target, problem: str) -> None:
        """Vor dem Umbenennen gescheitert: den alten Container wieder starten."""
        self.say(problem)
        with contextlib.suppress(DockerError):
            self.engine.start(target.id)
        self.update.unlink(JOURNAL)
        self.finish(FAILED, f"Die Datenbank ließ sich nicht sichern. Stowly läuft weiter mit {self.old}.")

    def succeed(self, target: Target, repository: str) -> None:
        """8. Den alten Container löschen (nie samt Volumes), alte Images aufräumen, ``done``."""
        self.say("Die neue Version ist healthy.")
        try:
            self.engine.remove_container(target.id)
        except DockerError as exc:
            self.say(f"Der alte Container ließ sich nicht löschen ({exc}).")
        self.cleanup_images(repository, {self.new, self.old})
        self.finish(DONE, f"Aktualisiert von {self.old} auf {self.new}.")

    def rollback(self, target: Target, new_id: str | None, *, restore: bool, reason: str | None) -> None:
        """9. Zurück: Log des neuen Containers, ihn löschen, Datenbank zurück, alten zurückbenennen und starten."""
        if new_id is not None:
            try:
                tail = self.engine.logs(new_id, tail=50, tty=self.journal.get("tty") == "1")
                self.say("Die neue Version wurde nicht healthy. Letzte Zeilen ihres Logs:")
                if self.log is not None:
                    self.log.write(tail.encode("utf-8", "replace"))
            except DockerError:
                pass
            for step in (
                lambda: self.engine.stop(new_id, STOP_TIMEOUT_S),
                lambda: self.engine.remove_container(new_id, force=True),
            ):
                try:
                    step()
                except DockerError as exc:
                    self.say(f"Aufräumen: {exc}")
        if restore:
            try:
                self.restore_database(self.journal["backup"])
                self.say("Datenbank von vor dem Update zurückgespielt.")
            except (LinkFound, OSError, KeyError) as exc:
                self.say(f"Die Kopie der Datenbank ließ sich nicht zurückspielen ({exc}).")
        try:
            old = self.engine.container(target.id)
            if old is not None and clone.container_name(old) != target.name:
                self.engine.rename(target.id, target.name)
            self.engine.start(target.id)
            back = self.wait_healthy(target.id)
        except DockerError as exc:
            self.say(f"Zurück: {exc}")
            back = False
        if back:
            self.finish(FAILED, reason or f"Die neue Version startete nicht, zurück auf {self.old}.")
        else:
            self.finish(
                FAILED,
                f"Die neue Version startete nicht, und {self.old} startet auch nicht mehr. {NOT_RUNNING_HINT}",
            )

    # ------------------------------------------------------------------ Wiederanlauf

    def resume(self, journal: dict[str, str]) -> None:
        """Ein Update brach mittendrin ab (Absturz, Neustart des NAS): zu Ende bringen oder zurück.

        Zuerst wird das Journal geprüft (``journal_problem``, dann ``check_journal`` mit Docker, nur lesend);
        passt es nicht, endet der Wiederanlauf mit ``failed``, ohne einen Container anzufassen.
        """
        self.log = self.update.append_log(LOG)
        self.journal = dict(journal)
        self.new = journal.get("version", "")
        self.old = journal.get("from", UNKNOWN_VERSION)
        phase = journal.get("phase", "")
        self.say(
            f"Wiederanlauf: Das Update auf {_line(self.new)[:40]} brach ab (Schritt {_line(phase)[:20]})."
        )
        problem = journal_problem(journal)
        if problem is not None:
            if not VERSION.match(self.new):
                self.new = ""
            if not VERSION.match(self.old):
                self.old = UNKNOWN_VERSION
            self.say(f"Journal abgelehnt ({problem}).")
            return self.finish(FAILED, FOREIGN_JOURNAL)
        target = Target(id=journal["old_id"], name=journal["name"])
        try:
            checked = self.check_journal(journal)
            if isinstance(checked, str):
                self.say(f"Journal abgelehnt ({checked}).")
                return self.finish(FAILED, FOREIGN_JOURNAL)
            old, new, repository = checked
            new_id = str(new["Id"]) if new is not None else None
            if phase == "stopping":
                if old is None:
                    return self.finish(FAILED, f"Der Container von Stowly fehlt. {NOT_RUNNING_HINT}")
                if _health(old) in ("exited", "created", "dead"):
                    self.engine.start(target.id)
                    self.wait_healthy(target.id)
                return self.finish(
                    FAILED, f"Das Update auf {self.new} brach ab; Stowly läuft weiter mit {self.old}."
                )
            if new is not None and phase == "starting" and _health(new) in ("healthy", "starting"):
                if self.wait_healthy(str(new_id)):
                    return self.succeed(target, repository)
            ran = new is not None and not str((new.get("State") or {}).get("StartedAt", "")).startswith(
                "0001"
            )
        except DockerError as exc:
            self.say(f"Docker antwortet nicht ({exc}); neuer Versuch beim nächsten Durchgang.")
            if self.log is not None:
                self.log.close()
                self.log = None
            return None
        self.rollback(
            target,
            new_id,
            restore=ran,
            reason=f"Das Update auf {self.new} brach ab, zurück auf {self.old}.",
        )

    def check_journal(
        self, journal: Mapping[str, str]
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str] | str:
        """``(alter, neuer Container, Repository)``, wenn das Journal zu Stowly passt; sonst warum nicht.

        Nur lesende Aufrufe: Beide Container haben dieselbe Quelle für ``/data`` wie der Updater und sind
        nicht er selbst, der alte heißt ``<name>`` oder ``<name>-vorher``, und das Repository ist das eines
        der beiden Container oder ``STOWLY_IMAGE_REF``.
        """
        own_id = self.updater.own_id
        own = self.engine.container(own_id) if own_id else None
        source = data_source(own) if own is not None else None
        if source is None:
            return "die eigene Quelle für /data ist unbekannt"

        def ours(container: Mapping[str, Any] | None) -> bool:
            return (
                container is not None and container.get("Id") != own_id and data_source(container) == source
            )

        name, old_id = journal["name"], journal["old_id"]
        old = self.engine.container(old_id)
        if old is not None and (
            not ours(old) or clone.container_name(old) not in (name, name + PREVIOUS_SUFFIX)
        ):
            return "der alte Container gehört nicht zu Stowly"
        new_id = journal.get("new_id") or None
        new = self.engine.container(new_id) if new_id else None
        if new is None:
            candidate = self.engine.container(name)
            if candidate is not None and candidate.get("Id") != old_id:
                new = candidate
        if new is not None and (not ours(new) or new.get("Id") == old_id):
            return "der neue Container gehört nicht zu Stowly"
        if old is None and new is None:
            return "keiner der beiden Container ist da"
        allowed = {
            clone.repository((container.get("Config") or {}).get("Image"))
            for container in (old, new)
            if container is not None
        } | {self.updater.image_ref}
        allowed.discard(None)
        repository = journal.get("repository") or clone.repository(journal.get("image"))
        if repository not in allowed:
            return "das Repository passt nicht"
        return old, new, str(repository)


# --- Start -----------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """``python -m stowly.updater``: läuft, bis Docker den Container anhält."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    own = own_container_id()
    if own is None:
        log.error(
            "Die eigene Container-ID fehlt (/proc/self/mountinfo); so findet der Updater sein Ziel nicht."
        )
    data_dir = Path(os.environ.get("STOWLY_DATA_DIR") or DATA_MOUNT)
    image_ref = (os.environ.get("STOWLY_IMAGE_REF") or "").strip() or None

    def on_signal(_number: int, _frame: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, on_signal)
    log.info(
        "Updater %s (Protokoll %d) für %s, Container %s.",
        __version__,
        UPDATER_PROTOCOL,
        data_dir,
        own[:12] if own else "?",
    )
    Updater(Engine(), data_dir=data_dir, own_id=own, image_ref=image_ref).run_forever()
    return 0
