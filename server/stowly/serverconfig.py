"""Einstellungen des Servers aus der App und was der Server über sich lernt (docs/integrationen.md,
Abschnitt 12; docs/sync-protokoll.md, 11.6 und 11.7).

* **Tabelle** ``server_config`` (Migration 0004): je Schlüssel ein JSON-Wert mit ``updated_at`` und
  ``updated_by`` (das Gerät; NULL = vom Server selbst gelernt). Nie ein Geheimnis: Die Tabelle steht in
  jeder Sicherung. Nicht im Sync; die App liest sie über ``GET /api/server-config`` und ``GET /api/setup``.
* **Vorrang:** Die Umgebung geht vor. Was dort steht, ist in der App nur zu sehen (``source: env``),
  ``PATCH`` antwortet dann mit 409.

  - Push-Kontakt: ``STOWLY_PUSH_CONTACT``, sonst der Kontakt aus der App, sonst keiner.
  - Updates: ``STOWLY_UPDATE_REPO`` (immer an), sonst der Schalter in der App mit dem Repository aus
    ``STOWLY_UPDATE_REPO_DEFAULT``, sonst aus.
  - Sicherung (``backup_setup``, docs/plan-einrichtung-b.md, Abschnitt 1): Schlüssel aus
    ``STOWLY_BACKUP_RECIPIENTS`` vor der Liste aus der App; Uhrzeit ``STOWLY_BACKUP_TIME``, sonst App,
    sonst 03:30; fest an mit Schlüsseln aus der Umgebung, sonst der Schalter (Vorgabe an); Ordner
    ``STOWLY_BACKUP_DIR``, sonst ``/backups`` als eigener, beschreibbarer Ordner, sonst ``/data/backups``.
* **Ohne Neustart:** Wer einen Wert braucht (Versand von Push, Tagesnachricht, Abfrage bei GitHub,
  Sicherung), liest ihn erst beim Einsatz hier.

Die Schlüssel des Assistenten (Schritte, Adressen, Ports, Ursprünge) liest und schreibt ``wizard.py``.
"""

import json
import logging
import os
import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyrage

from stowly import db, events, safefile
from stowly.config import Settings, push_contact_valid
from stowly.contract.api import (
    BACKUP_TIME_DEFAULT,
    BackupFolderSource,
    ConfigSource,
    ErrorCode,
    ServerConfigChanges,
)
from stowly.contract.timeutil import is_time_of_day
from stowly.errors import ApiError

log = logging.getLogger("stowly.config")

# Einstellungen aus der App (docs/integrationen.md, 12).
PUSH_CONTACT = "push_contact"
UPDATE_ENABLED = "update_enabled"
# Sicherung aus der App: Schalter (bool), Uhrzeit ("HH:MM") und die öffentlichen Schlüssel als Liste von
# {"key": "age1…", "added_at": Zeitstempel}. Öffentliche Schlüssel sind kein Geheimnis.
BACKUP_ENABLED = "backup_enabled"
BACKUP_TIME = "backup_time"
BACKUP_RECIPIENTS = "backup_recipients"
BACKUP_KEYS = (BACKUP_ENABLED, BACKUP_TIME, BACKUP_RECIPIENTS)
# Fortschritt des Assistenten und Gelerntes (wizard.py; docs/sync-protokoll.md, 11.6).
SETUP_STEPS = "setup_steps"
SETUP_FINISHED_AT = "setup_finished_at"
TLS_ADDRESSES = "tls_addresses"
HTTPS_PORT = "https_port"
HTTP_PORT = "http_port"
HTTPS_SEEN_AT = "https_seen_at"
APP_ORIGINS_SEEN = "app_origins_seen"

PUSH_FROM_ENVIRONMENT = "Der Kontakt für die Push-Dienste steht in der Umgebung (STOWLY_PUSH_CONTACT) und lässt sich nur dort ändern."
UPDATES_FROM_ENVIRONMENT = (
    "Updates sind über STOWLY_UPDATE_REPO fest eingeschaltet; das lässt sich nur dort ändern."
)
UPDATES_UNAVAILABLE = "Dieses Image kennt kein Repository für Updates (STOWLY_UPDATE_REPO_DEFAULT); der Schalter wirkt hier nicht."
INVALID_CONTACT = "Erwartet ist eine E-Mail-Adresse (mailto:) oder eine https-Adresse."
BACKUP_RECIPIENTS_FROM_ENVIRONMENT = (
    "Die öffentlichen Schlüssel der Sicherung stehen in der Umgebung (STOWLY_BACKUP_RECIPIENTS) und lassen "
    "sich nur dort ändern."
)
BACKUP_ENABLED_FROM_ENVIRONMENT = (
    "Die Sicherung ist über STOWLY_BACKUP_RECIPIENTS fest eingeschaltet; das lässt sich nur dort ändern."
)
BACKUP_TIME_FROM_ENVIRONMENT = (
    "Die Uhrzeit der Sicherung steht in der Umgebung (STOWLY_BACKUP_TIME) und lässt sich nur dort ändern."
)
SECRET_KEY = (
    "Das ist ein geheimer Schlüssel. Hierher gehört nur der öffentliche (age1…); der geheime gehört nicht "
    "auf den Server."
)
NOT_A_RECIPIENT = "Das ist kein öffentlicher age-Schlüssel (age1…)."
PASSWORD_NEEDED = "Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort."
RECIPIENTS_CHANGED = (
    "Die Schlüssel der Sicherung haben sich inzwischen auf einem anderen Gerät geändert. Bitte neu laden und "
    "noch einmal versuchen."
)

# Ordner der Sicherungen (docs/plan-einrichtung-b.md, Abschnitt 1). Modulwerte, damit Tests sie ersetzen.
MOUNTINFO = Path("/proc/self/mountinfo")
MOUNTED_BACKUPS = Path("/backups")
DATA_BACKUPS = "backups"
_MOUNTINFO_MAX = 1024 * 1024
BACKUP_MISSING_DIR = "Der Ordner für Sicherungen fehlt."
BACKUP_NOT_WRITABLE = "Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)."
BACKUP_NO_KEY = "Es fehlt ein öffentlicher Schlüssel (in der App oder in STOWLY_BACKUP_RECIPIENTS)."
BACKUP_SWITCHED_OFF = "Die automatische Sicherung ist ausgeschaltet."
BACKUP_MOUNTED_UNUSABLE = (
    "Der eigene Ordner {folder} ist eingebunden, taugt aber nicht: {problem} Die Sicherungen gehen deshalb "
    "in den Datenordner."
)


# --- Lesen und Schreiben -----------------------------------------------------------------------


def get(con: sqlite3.Connection, key: str, default: Any = None) -> Any:
    """Der Wert eines Schlüssels; ``default``, wenn er fehlt oder kein JSON ist."""
    row = con.execute("SELECT value FROM server_config WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        log.warning("server_config: Der Wert von %s ist kein JSON und wird übergangen.", key)
        return default


def put(con: sqlite3.Connection, key: str, value: Any, *, now: str, by: str | None) -> None:
    """Schreibt einen Wert, in der Transaktion des Aufrufers. ``by`` ist das Gerät, ``None`` der Server."""
    con.execute(
        "INSERT INTO server_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, "
        "updated_by = excluded.updated_by",
        (key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), now, by),
    )


def delete(con: sqlite3.Connection, key: str) -> bool:
    """Entfernt einen Schlüssel, in der Transaktion des Aufrufers; liefert, ob es ihn gab."""
    return con.execute("DELETE FROM server_config WHERE key = ?", (key,)).rowcount > 0


def changed_event(con: sqlite3.Connection, keys: list[str], *, device_id: str | None, now: str) -> None:
    """``server.config_changed`` mit den geänderten Schlüsseln, nie ihren Werten."""
    events.record(
        con,
        at=now,
        recorded_at=now,
        device_id=device_id,
        type="server.config_changed",
        entity="server",
        entity_id="config",
        data={"keys": keys},
    )


# --- Wirksame Werte ----------------------------------------------------------------------------


def _app_contact(con: sqlite3.Connection) -> str | None:
    value = get(con, PUSH_CONTACT)
    return value if isinstance(value, str) and push_contact_valid(value) else None


def push_contact(settings: Settings, con: sqlite3.Connection) -> str | None:
    """Der wirksame Kontakt für die Push-Dienste (VAPID ``sub``); ``None`` = Push ist aus."""
    if settings.push_contact is not None:
        return settings.push_contact
    return _app_contact(con)


def _push(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    if settings.push_contact is not None:
        return {"contact": settings.push_contact, "source": ConfigSource.ENV}
    contact = _app_contact(con)
    return {"contact": contact, "source": ConfigSource.APP if contact is not None else ConfigSource.DEFAULT}


def _update(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    if settings.update_repo is not None:
        return {"enabled": True, "repo": settings.update_repo, "source": ConfigSource.ENV, "available": False}
    switch = get(con, UPDATE_ENABLED)
    available = settings.update_repo_default is not None
    return {
        "enabled": switch is True and available,
        "repo": settings.update_repo_default,
        "source": ConfigSource.APP if isinstance(switch, bool) else ConfigSource.DEFAULT,
        "available": available,
    }


def update_repo(settings: Settings, con: sqlite3.Connection) -> str | None:
    """Das wirksame Repository der Releases; ``None`` = Updates sind aus."""
    if settings.update_repo is not None:
        return settings.update_repo
    if settings.update_repo_default is not None and get(con, UPDATE_ENABLED) is True:
        return settings.update_repo_default
    return None


# --- Sicherung (docs/plan-einrichtung-b.md, Abschnitt 1) ---------------------------------------


def short_key(recipient: str) -> str:
    """Ein öffentlicher Schlüssel gekürzt: die ersten 8 Zeichen, „…", die letzten 4 (``age1ql3z…ac8p``)."""
    return f"{recipient[:8]}…{recipient[-4:]}"


def public_key(text: str) -> str | None:
    """Ein öffentlicher age-Schlüssel in seiner Normalform (klein geschrieben); ``None``, wenn es keiner ist."""
    try:
        return str(pyrage.x25519.Recipient.from_str(text))
    except Exception:
        return None


def is_secret_key(text: str) -> bool:
    """Sieht der Text aus wie ein geheimer age-Schlüssel? Dann wird er abgelehnt und nie wiederholt."""
    return text.strip().upper().startswith("AGE-SECRET-KEY-")


@dataclass(frozen=True)
class BackupFolder:
    """Der Ordner der Sicherungen, woher er kommt und warum er nicht taugt (``None``: Er taugt)."""

    path: Path
    source: BackupFolderSource
    problem: str | None
    # Ist /backups eingebunden, taugt aber nicht, gehen die Sicherungen in den Datenordner; das sagt hint.
    hint: str | None = None


@dataclass(frozen=True)
class RecipientEntry:
    key: str
    added_at: str | None  # wann er in der App hinzukam; None aus der Umgebung


@dataclass(frozen=True)
class BackupSetup:
    """Die wirksamen Einstellungen der Sicherung, je mit Quelle. Nie ein geheimer Schlüssel."""

    enabled: bool
    enabled_source: ConfigSource
    recipients: tuple[RecipientEntry, ...]
    recipients_source: ConfigSource
    time: str
    time_source: ConfigSource
    folder: BackupFolder
    # Etwas ist eingestellt (Ordner oder Uhrzeit aus der Umgebung, Schalter oder Uhrzeit aus der App):
    # Dann nennt ``problem`` auch einen fehlenden Schlüssel.
    mentioned: bool

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(entry.key for entry in self.recipients)

    @property
    def active(self) -> bool:
        """An und mit Schlüssel: Der tägliche Lauf versucht es (und meldet einen fehlenden Ordner)."""
        return self.enabled and bool(self.recipients)

    @property
    def usable(self) -> bool:
        """Schlüssel und Ordner taugen: „Jetzt sichern" geht, auch wenn der Schalter aus ist."""
        return bool(self.recipients) and self.folder.problem is None

    @property
    def configured(self) -> bool:
        """Wirksam (``BackupStatus.configured``): an, mit Schlüssel, und der Ordner taugt."""
        return self.active and self.folder.problem is None

    @property
    def problem(self) -> str | None:
        """Warum die Sicherung nicht wirkt, obwohl etwas eingestellt ist; sonst ``None``."""
        if self.configured:
            return None
        if self.recipients:
            return BACKUP_SWITCHED_OFF if not self.enabled else self.folder.problem
        return BACKUP_NO_KEY if self.mentioned else None


def folder_problem(path: Path) -> str | None:
    """Warum ein Ordner nicht für Sicherungen taugt (fehlt, nicht beschreibbar); ``None``, wenn er taugt."""
    if not path.is_dir():
        return BACKUP_MISSING_DIR
    if safefile.POSIX and not os.access(path, os.W_OK | os.X_OK):
        return BACKUP_NOT_WRITABLE
    return None


def _unescape(field: str) -> str:
    """Ein Pfad aus ``mountinfo``: Leerzeichen und andere Sonderzeichen stehen dort als ``\\ooo``."""
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), field)


def mount_points(mountinfo: Path) -> set[str]:
    """Die Einhängepunkte aus ``/proc/self/mountinfo`` (fünftes Feld je Zeile); leer, wenn es die Datei
    nicht gibt (etwa unter Windows)."""
    try:
        with mountinfo.open("rb") as handle:
            raw = handle.read(_MOUNTINFO_MAX)
    except OSError:
        return set()
    points: set[str] = set()
    for line in raw.decode("utf-8", errors="replace").splitlines():
        fields = line.split(" ")
        if len(fields) > 4:
            points.add(_unescape(fields[4]))
    return points


_warned: set[str] = set()


def _warn_once(message: str) -> None:
    """Ein Hinweis ins Log, nur einmal je Prozess: Der Ordner wird jede Minute neu gewählt."""
    if message not in _warned:
        _warned.add(message)
        log.warning("%s", message)


def backup_folder(settings: Settings, *, create: bool = False) -> BackupFolder:
    """Der Ordner der Sicherungen: ``STOWLY_BACKUP_DIR``; sonst ``/backups``, wenn er in ``mountinfo`` als
    Einhängepunkt steht und beschreibbar ist; sonst ``<data>/backups``.

    Den Ordner aus der Umgebung legt Stowly nie an (er läge sonst womöglich im Container statt auf dem
    Laufwerk), den im Datenordner schon (0700), aber erst mit ``create`` (vor einem Lauf); bis dahin gilt
    er als brauchbar, denn der Datenordner ist beschreibbar.
    """
    if settings.backup_dir is not None:
        return BackupFolder(settings.backup_dir, BackupFolderSource.ENV, folder_problem(settings.backup_dir))
    mounted = MOUNTED_BACKUPS
    hint = None
    if mounted.as_posix() in mount_points(MOUNTINFO):
        problem = folder_problem(mounted)
        if problem is None:
            return BackupFolder(mounted, BackupFolderSource.MOUNTED, None)
        hint = BACKUP_MOUNTED_UNUSABLE.format(folder=mounted.as_posix(), problem=problem)
        _warn_once(f"Sicherung: {hint}")
    data = settings.data_dir / DATA_BACKUPS
    if create:
        try:
            safefile.ensure_directory(data, 0o700, label="Sicherung")
        except OSError:
            log.warning("Sicherung: Der Ordner %s ließ sich nicht anlegen.", data, exc_info=True)
    elif not data.exists() and settings.data_dir.is_dir():
        return BackupFolder(data, BackupFolderSource.DATA, None, hint)
    return BackupFolder(data, BackupFolderSource.DATA, folder_problem(data), hint)


def _app_recipients(con: sqlite3.Connection) -> tuple[RecipientEntry, ...]:
    """Die öffentlichen Schlüssel aus der App; Unbrauchbares und Doppeltes fällt weg."""
    stored = get(con, BACKUP_RECIPIENTS, [])
    found: dict[str, RecipientEntry] = {}
    for entry in stored if isinstance(stored, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("key"), str):
            continue
        key = public_key(entry["key"])
        if key is None or key in found:
            continue
        added_at = entry.get("added_at")
        found[key] = RecipientEntry(key, added_at if isinstance(added_at, str) else None)
    return tuple(found.values())


def backup_setup(settings: Settings, con: sqlite3.Connection, *, create_folder: bool = False) -> BackupSetup:
    """Die wirksamen Einstellungen der Sicherung. Gelesen bei jedem Takt des Zeitplans, also ohne Neustart."""
    from_env = bool(settings.backup_recipients)
    if from_env:
        recipients = tuple(RecipientEntry(key, None) for key in settings.backup_recipients)
        recipients_source = ConfigSource.ENV
        enabled, enabled_source = True, ConfigSource.ENV
    else:
        recipients = _app_recipients(con)
        recipients_source = ConfigSource.APP if recipients else ConfigSource.DEFAULT
        switch = get(con, BACKUP_ENABLED)
        if isinstance(switch, bool):
            enabled, enabled_source = switch, ConfigSource.APP
        else:
            enabled, enabled_source = True, ConfigSource.DEFAULT
    if settings.backup_time is not None:
        time, time_source = settings.backup_time, ConfigSource.ENV
    else:
        stored = get(con, BACKUP_TIME)
        if isinstance(stored, str) and is_time_of_day(stored):
            time, time_source = stored, ConfigSource.APP
        else:
            time, time_source = BACKUP_TIME_DEFAULT, ConfigSource.DEFAULT
    return BackupSetup(
        enabled=enabled,
        enabled_source=enabled_source,
        recipients=recipients,
        recipients_source=recipients_source,
        time=time,
        time_source=time_source,
        folder=backup_folder(settings, create=create_folder),
        mentioned=settings.backup_dir is not None
        or settings.backup_time is not None
        or ConfigSource.APP in (enabled_source, time_source),
    )


def backup(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    """``BackupConfig``: die wirksamen Werte der Sicherung mit ihrer Quelle. Nie ein geheimer Schlüssel."""
    setup = backup_setup(settings, con)
    return {
        "enabled": setup.enabled,
        "enabled_source": setup.enabled_source,
        "recipients": [
            {"key": entry.key, "short": short_key(entry.key), "added_at": entry.added_at}
            for entry in setup.recipients
        ],
        "recipients_source": setup.recipients_source,
        "time": setup.time,
        "time_source": setup.time_source,
        "folder": str(setup.folder.path),
        "folder_source": setup.folder.source,
        "folder_problem": setup.folder.problem,
        "folder_hint": setup.folder.hint,
    }


def effective(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    """``ServerConfig``: die wirksamen Werte mit ihrer Quelle. Nie ein Geheimnis."""
    return {
        "push": _push(settings, con),
        "update": _update(settings, con),
        "backup": backup(settings, con),
    }


# --- Ändern (PATCH /api/server-config) ---------------------------------------------------------


def normalize_contact(text: str) -> str:
    """Leerraum am Rand fällt weg; eine Adresse ohne ``mailto:`` (und ohne ``://``) bekommt es davor."""
    contact = text.strip()
    if contact and not contact.startswith("mailto:") and "://" not in contact:
        contact = "mailto:" + contact
    return contact


def change(
    settings: Settings,
    con: sqlite3.Connection,
    changes: ServerConfigChanges,
    *,
    device_id: str,
    now: str,
    confirm: Callable[[str], None] | None = None,
) -> list[str]:
    """Übernimmt die vorhandenen Felder und liefert die Schlüssel, die sich wirklich geändert haben.

    ``ApiError`` 409, wenn ein Feld aus der Umgebung kommt oder das Image kein Repository für den Schalter
    kennt; 422, wenn der Kontakt oder ein Schlüssel der Sicherung nicht taugt. Dann ändert sich nichts.

    Kommt mit ``backup_recipients`` ein öffentlicher Schlüssel hinzu, braucht es das Haushalts-Passwort
    (``current_password``): Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung lesen, samt
    Passwort-Hash, VAPID-Schlüssel und Push-Abos. Ein Geräte-Token allein genügt dafür nicht. Fehlt es, 422 an
    ``["body", "current_password"]``; ``confirm`` prüft es (über die Bremse der Anmeldung: 401, dann 429) und
    wirft bei einem falschen. Entfernen braucht kein Passwort. Das Passwort steht nie im Log.
    """
    fields = changes.model_fields_set
    if PUSH_CONTACT in fields and settings.push_contact is not None:
        raise ApiError(409, ErrorCode.CONFLICT, PUSH_FROM_ENVIRONMENT)
    if UPDATE_ENABLED in fields:
        if settings.update_repo is not None:
            raise ApiError(409, ErrorCode.CONFLICT, UPDATES_FROM_ENVIRONMENT)
        if settings.update_repo_default is None:
            raise ApiError(409, ErrorCode.CONFLICT, UPDATES_UNAVAILABLE)
    if BACKUP_RECIPIENTS in fields and settings.backup_recipients:
        raise ApiError(409, ErrorCode.CONFLICT, BACKUP_RECIPIENTS_FROM_ENVIRONMENT)
    if BACKUP_ENABLED in fields and settings.backup_recipients:
        raise ApiError(409, ErrorCode.CONFLICT, BACKUP_ENABLED_FROM_ENVIRONMENT)
    if BACKUP_TIME in fields and settings.backup_time is not None:
        raise ApiError(409, ErrorCode.CONFLICT, BACKUP_TIME_FROM_ENVIRONMENT)
    recipients: list[str] | None = None
    if BACKUP_RECIPIENTS in fields:
        recipients = _checked_recipients(changes.backup_recipients or [])
    contact: str | None = None
    if PUSH_CONTACT in fields and changes.push_contact is not None:
        contact = normalize_contact(changes.push_contact)
        if not push_contact_valid(contact):
            raise ApiError(
                422,
                ErrorCode.INVALID_REQUEST,
                "Die Anfrage entspricht nicht dem Vertrag.",
                {"errors": [{"loc": ["body", PUSH_CONTACT], "msg": INVALID_CONTACT, "type": "push_contact"}]},
            )
    adding = recipients is not None and _adds_key(con, recipients)
    if adding:
        if changes.current_password is None:
            raise ApiError(
                422,
                ErrorCode.INVALID_REQUEST,
                PASSWORD_NEEDED,
                {
                    "errors": [
                        {"loc": ["body", "current_password"], "msg": PASSWORD_NEEDED, "type": "missing"}
                    ]
                },
            )
        if confirm is None:
            raise RuntimeError("Ein neuer Schlüssel braucht eine Prüfung des Passworts (confirm).")
        confirm(changes.current_password)

    changed: list[str] = []
    with db.transaction(con):
        if recipients is not None and not adding and _adds_key(con, recipients):
            # Ein anderes Gerät hat gerade einen Schlüssel entfernt, den diese Liste noch enthält: Ohne
            # Passwort käme er nicht zurück.
            raise ApiError(409, ErrorCode.CONFLICT, RECIPIENTS_CHANGED)
        if PUSH_CONTACT in fields:
            old = get(con, PUSH_CONTACT)
            if contact is None:
                if delete(con, PUSH_CONTACT):
                    changed.append(PUSH_CONTACT)
            elif old != contact:
                put(con, PUSH_CONTACT, contact, now=now, by=device_id)
                changed.append(PUSH_CONTACT)
        if UPDATE_ENABLED in fields and get(con, UPDATE_ENABLED) is not changes.update_enabled:
            put(con, UPDATE_ENABLED, bool(changes.update_enabled), now=now, by=device_id)
            changed.append(UPDATE_ENABLED)
        if BACKUP_ENABLED in fields and get(con, BACKUP_ENABLED) is not changes.backup_enabled:
            put(con, BACKUP_ENABLED, bool(changes.backup_enabled), now=now, by=device_id)
            changed.append(BACKUP_ENABLED)
        if BACKUP_TIME in fields:
            if changes.backup_time is None:
                if delete(con, BACKUP_TIME):
                    changed.append(BACKUP_TIME)
            elif get(con, BACKUP_TIME) != changes.backup_time:
                put(con, BACKUP_TIME, changes.backup_time, now=now, by=device_id)
                changed.append(BACKUP_TIME)
        if recipients is not None and _store_recipients(con, recipients, now=now, by=device_id):
            changed.append(BACKUP_RECIPIENTS)
        if changed:
            changed_event(con, changed, device_id=device_id, now=now)
    if changed:
        log.info("Einstellungen des Servers geändert: %s", ", ".join(changed))
    return changed


def _checked_recipients(given: list[str]) -> list[str]:
    """Prüft die öffentlichen Schlüssel aus der App; liefert sie in Normalform, ohne Doppelte.

    ``ApiError`` 422 mit ``details.errors[].loc = ["body", "backup_recipients", i]``. Ein geheimer Schlüssel
    wird abgelehnt und nie wiederholt, weder in der Antwort noch im Log.
    """
    problems: list[dict[str, Any]] = []
    keys: list[str] = []
    for index, text in enumerate(given):
        message = None
        if is_secret_key(text):
            message = SECRET_KEY
        else:
            key = public_key(text.strip())
            if key is None:
                message = NOT_A_RECIPIENT
            elif key not in keys:
                keys.append(key)
        if message is not None:
            problems.append(
                {"loc": ["body", BACKUP_RECIPIENTS, index], "msg": message, "type": "backup_recipient"}
            )
    if problems:
        raise ApiError(
            422, ErrorCode.INVALID_REQUEST, "Die Anfrage entspricht nicht dem Vertrag.", {"errors": problems}
        )
    return keys


def _adds_key(con: sqlite3.Connection, keys: list[str]) -> bool:
    """Bringt die Liste einen Schlüssel, den die App noch nicht hat?"""
    known = {entry.key for entry in _app_recipients(con)}
    return any(key not in known for key in keys)


def _store_recipients(con: sqlite3.Connection, keys: list[str], *, now: str, by: str) -> bool:
    """Ersetzt die Schlüssel aus der App; wer bleibt, behält seinen Zeitpunkt. Liefert, ob sich etwas änderte."""
    known = {entry.key: entry.added_at for entry in _app_recipients(con)}
    if not keys:
        return delete(con, BACKUP_RECIPIENTS)
    if list(known) == keys:
        return False
    put(
        con,
        BACKUP_RECIPIENTS,
        [{"key": key, "added_at": known.get(key) or now} for key in keys],
        now=now,
        by=by,
    )
    return True
