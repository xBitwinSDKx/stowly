"""Geheimnisse außerhalb der Datenbank (docs/plan-einrichtung-b.md, Abschnitt 3).

Die Tokens aus der App liegen in ``/data/secrets`` (0700), je eine JSON-Datei mit 0600, atomar geschrieben
über ``safefile``. Die Datenbank, beide Sicherungen und das Log enthalten sie nie; in ``server_config``
stehen nur Merker ohne Geheimnis (``haconfig.py``). Nach einem Zurückspielen oder Umzug fehlen die Dateien
deshalb, und der Status sagt es.

* ``ha_token`` (``ha_token.json``): ``{"token", "url", "set_at"}``. Der Token gilt nur für die Adresse, für
  die er eingetragen wurde.
* ``ha_sensor_token`` (``ha_sensor_token.json``): ``{"token", "set_at"}``.
* ``anthropic_key`` (``anthropic_key.json``, seit 0.6.0): ``{"key", "set_at"}``, der API-Schlüssel für die
  KI-Vorschläge (``aiconfig.py``).

Lesen wirft nie: Eine fehlende, zu große oder kaputte Datei gilt als nicht da (zu groß oder kaputt mit
einer Warnung im Log, die den Inhalt nie nennt). Schreiben und Löschen gehen nur unter den festen Namen und
hinter einer Sperre. Rechte prüft und setzt der Server nur unter POSIX. Der Name ``secretstore`` verdeckt das
Modul ``secrets`` der Standardbibliothek nicht.
"""

import contextlib
import json
import logging
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from stowly import safefile

log = logging.getLogger("stowly.secrets")

HA_TOKEN = "ha_token"
HA_SENSOR_TOKEN = "ha_sensor_token"
ANTHROPIC_KEY = "anthropic_key"
NAMES = frozenset({HA_TOKEN, HA_SENSOR_TOKEN, ANTHROPIC_KEY})

DIR_MODE = 0o700
FILE_MODE = 0o600
# Mehr liest der Server von keiner Datei: Ein Token ist ein paar hundert Zeichen lang.
MAX_BYTES = 64 * 1024
LABEL = "Geheimnisse"
# Wie safefile: Unter Windows hält ein Leser die Datei kurz offen.
_UNLINK_TRIES = 5
_UNLINK_PAUSE_S = 0.05

NOT_PREPARED = (
    "Der Ordner für Tokens (/data/secrets) lässt sich nicht anlegen; Tokens aus der App lassen sich nicht "
    "speichern (Einzelheiten im Log des Servers)."
)
NOT_WRITTEN = "Der Token ließ sich nicht speichern (Einzelheiten im Log des Servers)."


class SecretStoreError(Exception):
    """Schreiben oder Löschen im Speicher scheiterte. Die Nachricht ist deutscher Klartext ohne Geheimnis."""


class SecretStore:
    """Der Speicher in ``directory`` (im Betrieb ``/data/secrets``).

    Lesen geht mit jeder Instanz für denselben Ordner; geschrieben wird über die eine in ``app.state.secrets``,
    deren Sperre Schreiben und Löschen ordnet.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        # Warum der Ordner nicht taugt (``prepare``); None = in Ordnung oder noch nicht geprüft.
        self.problem: str | None = None
        self._lock = threading.Lock()
        self._warned: set[tuple[str, str]] = set()

    def path(self, name: str) -> Path:
        """Die Datei eines Geheimnisses. ``ValueError`` bei einem unbekannten Namen (Fehler im Code)."""
        if name not in NAMES:
            raise ValueError(f"Unbekanntes Geheimnis: {name!r}")
        return self.directory / f"{name}.json"

    # ------------------------------------------------------------------ Start

    def prepare(self) -> str | None:
        """Beim Start: legt den Ordner mit 0700 an, setzt vorhandene Dateien auf 0600 und räumt
        Zwischendateien eines abgebrochenen Schreibens weg. Scheitert das, steht es in ``problem`` (auch
        der Rückgabewert); der Server startet trotzdem."""
        try:
            safefile.ensure_directory(self.directory, DIR_MODE, label=LABEL)
        except OSError as exc:
            log.warning(
                "Geheimnisse: Der Ordner %s ließ sich nicht anlegen (%s).", self.directory, type(exc).__name__
            )
            self.problem = NOT_PREPARED
            return self.problem
        self.problem = None
        for leftover in self._leftovers():
            try:
                leftover.unlink()
                log.info("Geheimnisse: Zwischendatei %s entfernt.", leftover.name)
            except OSError:
                log.warning("Geheimnisse: Zwischendatei %s ließ sich nicht entfernen.", leftover.name)
        for name in sorted(NAMES):
            path = self.path(name)
            if path.is_file():
                safefile.ensure_mode(path, FILE_MODE, label=LABEL)
        return None

    def _leftovers(self) -> list[Path]:
        """Zwischendateien von ``safefile.write_atomic`` (``.<name>.json.<hex>.tmp``)."""
        found: list[Path] = []
        prefixes = tuple(f".{name}.json." for name in NAMES)
        with contextlib.suppress(OSError):
            for entry in self.directory.iterdir():
                if entry.name.startswith(prefixes) and entry.name.endswith(".tmp"):
                    found.append(entry)
        return sorted(found)

    # ------------------------------------------------------------------ Lesen

    def get(self, name: str) -> dict[str, Any] | None:
        """Der Inhalt eines Geheimnisses; ``None``, wenn die Datei fehlt, zu groß oder kaputt ist. Wirft nie
        (außer bei einem unbekannten Namen)."""
        path = self.path(name)
        try:
            with path.open("rb") as handle:
                raw = handle.read(MAX_BYTES + 1)
        except FileNotFoundError:
            return None
        except OSError as exc:
            self._warn(name, "unreadable", "%s lässt sich nicht lesen (%s).", path.name, type(exc).__name__)
            return None
        if len(raw) > MAX_BYTES:
            self._warn(
                name, "large", "%s ist größer als %d KiB und wird übergangen.", path.name, MAX_BYTES // 1024
            )
            return None
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, RecursionError):
            # UnicodeDecodeError ist ein ValueError. Die Meldung des Parsers zitierte den Inhalt: nicht ins Log.
            self._warn(name, "broken", "%s ist kein gültiges JSON und wird übergangen.", path.name)
            return None
        if not isinstance(value, dict):
            self._warn(name, "shape", "%s enthält kein JSON-Objekt und wird übergangen.", path.name)
            return None
        return value

    def _warn(self, name: str, reason: str, message: str, *args: Any) -> None:
        """Eine Warnung je Datei und Grund, bis sie wieder geschrieben wird: Der Sensor liest bei jeder Anfrage."""
        if (name, reason) in self._warned:
            return
        self._warned.add((name, reason))
        log.warning("Geheimnisse: " + message, *args)

    def _forget_warnings(self, name: str) -> None:
        self._warned = {entry for entry in self._warned if entry[0] != name}

    # ------------------------------------------------------------------ Schreiben

    def put(self, name: str, value: Mapping[str, Any]) -> None:
        """Ersetzt ein Geheimnis atomar (0600). ``SecretStoreError``, wenn das scheitert; die alte Datei
        bleibt dann, wie sie war."""
        path = self.path(name)
        data = json.dumps(dict(value), ensure_ascii=True, separators=(",", ":")).encode("ascii")
        if len(data) > MAX_BYTES:
            raise ValueError(f"{name}: zu groß für den Speicher")
        with self._lock:
            try:
                safefile.ensure_directory(self.directory, DIR_MODE, label=LABEL)
                safefile.write_atomic(self.directory, path.name, data, FILE_MODE)
            except OSError as exc:
                log.error("Geheimnisse: %s ließ sich nicht schreiben (%s).", path.name, type(exc).__name__)
                raise SecretStoreError(NOT_WRITTEN) from None
            self.problem = None
            self._forget_warnings(name)

    def delete(self, name: str) -> bool:
        """Entfernt ein Geheimnis; liefert, ob es eine Datei gab. ``SecretStoreError``, wenn das scheitert."""
        path = self.path(name)
        with self._lock:
            for attempt in range(_UNLINK_TRIES):
                try:
                    path.unlink()
                    break
                except (FileNotFoundError, NotADirectoryError):
                    # Kein Ordner (Linux meldet dann NotADirectoryError, Windows FileNotFoundError): Dann gibt
                    # es auch keine Datei darin, also nichts zu entfernen.
                    self._forget_warnings(name)
                    return False
                except PermissionError:
                    if safefile.POSIX or attempt + 1 == _UNLINK_TRIES:
                        log.error("Geheimnisse: %s ließ sich nicht entfernen.", path.name)
                        raise SecretStoreError(NOT_WRITTEN) from None
                    time.sleep(_UNLINK_PAUSE_S)
                except OSError as exc:
                    log.error(
                        "Geheimnisse: %s ließ sich nicht entfernen (%s).", path.name, type(exc).__name__
                    )
                    raise SecretStoreError(NOT_WRITTEN) from None
            with contextlib.suppress(OSError):
                safefile.sync_directory(self.directory)
            self._forget_warnings(name)
        return True
