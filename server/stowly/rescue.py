"""Hilfeseite, wenn sich ``/data`` nicht beschreiben lässt (docs/plan-einrichtung.md, Abschnitt 5).

Das Image läuft als uid 10001. Gehört der Ordner des Volumes jemand anderem und ist er nicht für alle
beschreibbar (etwa ein Ordner mit Windows-ACL auf einem NAS), schriebe Stowly beim Start ins Leere,
bräche ab, und Docker startete den Container wieder und wieder. Stattdessen prüft ``main`` vor allem
anderen, ob der Ordner beschreibbar ist (``data_dir_problem``). Wenn nicht, zeigt ein kleiner Server auf
dem HTTP-Port eine deutsche Seite mit Ursache und Abhilfe:

* ``/api/health`` (und alles unter ``/api`` und ``/print``) antwortet 503 im Fehlerformat. Der Container
  bleibt unhealthy, und ein Updater kehrt zur vorigen Version zurück.
* Alle 10 Sekunden prüft der Server neu. Ist ``/data`` beschreibbar, endet er mit Exit-Code 3, und Docker
  startet den Container neu, diesmal richtig.
"""

import asyncio
import contextlib
import html
import logging
import os
import secrets
import stat
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response
from starlette.routing import Route

from stowly.config import Settings
from stowly.contract.api import ErrorCode
from stowly.errors import error_response

log = logging.getLogger("stowly.rescue")

CHECK_INTERVAL_S = 10.0
# Exit-Code, sobald /data beschreibbar ist oder der Port nicht aufgeht: Docker startet neu (auch bei
# restart: on-failure).
RESTART = 3
# Die uid des Images (Dockerfile, USER 10001).
IMAGE_UID = 10001


def _reason(exc: OSError) -> str:
    return exc.strerror or type(exc).__name__


def data_dir_problem(path: Path) -> str | None:
    """Warum sich ``path`` nicht beschreiben lässt; ``None``, wenn es geht.

    Legt den Ordner an, wenn er fehlt, schreibt eine Probedatei und löscht sie wieder. Gibt es die
    Datenbank schon, muss auch sie sich beschreiben lassen.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"Der Ordner {path} lässt sich nicht anlegen ({_reason(exc)})."
    probe = path / f".stowly-schreibprobe-{secrets.token_hex(4)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        handle = os.open(probe, flags, 0o600)
        try:
            os.write(handle, b"stowly")
        finally:
            os.close(handle)
        os.unlink(probe)
    except OSError as exc:
        with contextlib.suppress(OSError):
            os.unlink(probe)
        return f"In den Ordner {path} lässt sich nicht schreiben ({_reason(exc)})."
    database = path / "stowly.sqlite3"
    if database.exists():
        try:
            with database.open("ab"):
                pass
        except OSError as exc:
            return f"Die Datenbank {database} lässt sich nicht beschreiben ({_reason(exc)})."
    return None


def _process() -> str:
    """uid und gid dieses Prozesses (nur unter POSIX bekannt)."""
    if not hasattr(os, "getuid"):
        return "unbekannt (kein Linux)"
    return f"Benutzer {os.getuid()}, Gruppe {os.getgid()}"


def _owner(path: Path) -> str:
    """Eigentümer und Rechte des Ordners oder, wenn es ihn nicht gibt, des nächsten vorhandenen darüber."""
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    try:
        info = current.stat()
    except OSError as exc:
        return f"{current}: nicht lesbar ({_reason(exc)})"
    mode = stat.S_IMODE(info.st_mode)
    where = str(current) if current == path else f"{current} (den Ordner {path} gibt es nicht)"
    return f"{where}: Benutzer {info.st_uid}, Gruppe {info.st_gid}, Rechte {stat.filemode(info.st_mode)} ({mode:04o})"


def page(settings: Settings, problem: str) -> str:
    """Die Hilfeseite (HTML, deutsch)."""
    folder = html.escape(str(settings.data_dir))
    return f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Stowly: Datenordner nicht beschreibbar</title>
<style>
body {{ font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem;
  line-height: 1.5; color: #1d1d1f; background: #fafafa; }}
code {{ background: #eee; padding: 0.1rem 0.3rem; border-radius: 0.2rem; }}
.problem {{ background: #fff3f0; border-left: 4px solid #c0392b; padding: 0.5rem 1rem; }}
</style>
</head>
<body>
<h1>Stowly kann nicht in seinen Datenordner schreiben</h1>
<p class="problem">{html.escape(problem)}</p>
<p>Stowly speichert alles in <code>{folder}</code>, dem Ordner, den Docker als Volume einbindet.
Solange Stowly dort nicht schreiben darf, startet es nicht und zeigt diese Seite.</p>
<h2>Was Stowly sieht</h2>
<ul>
<li>Stowly läuft als {html.escape(_process())}.</li>
<li>Der Ordner: {html.escape(_owner(settings.data_dir))}.</li>
</ul>
<h2>Abhilfe</h2>
<h3>Synology DSM</h3>
<ol>
<li>In der File Station den Ordner des Volumes suchen (etwa <code>docker/stowly</code>).</li>
<li>Rechte Maustaste → Eigenschaften → Berechtigung → Erstellen.</li>
<li>Benutzer oder Gruppe: <strong>Jeder</strong>, Berechtigung: <strong>Lesen/Schreiben</strong>; mit OK bestätigen.</li>
</ol>
<h3>Docker Compose oder Kommandozeile</h3>
<p>Den Ordner des Volumes dem Benutzer des Images geben:
<code>sudo chown -R {IMAGE_UID}:{IMAGE_UID} &lt;Ordner&gt;</code></p>
<p>Stowly prüft alle {int(CHECK_INTERVAL_S)} Sekunden neu. Sobald der Ordner beschreibbar ist, startet
der Container neu, und diese Seite lädt Stowly von selbst. Mehr in <code>docs/betrieb.md</code>.</p>
</body>
</html>
"""


def build_app(settings: Settings, problem: str) -> Starlette:
    """Eine minimale App: die Hilfeseite, unter ``/api`` und ``/print`` 503 im Fehlerformat."""
    text = page(settings, problem)
    message = f"Stowly kann nicht in seinen Datenordner schreiben: {problem}"

    async def answer(request: Request) -> Response:
        headers = {"Cache-Control": "no-store", "Retry-After": str(int(CHECK_INTERVAL_S))}
        path = request.url.path
        if path == "/api" or path.startswith(("/api/", "/print/")) or path == "/print":
            return error_response(503, ErrorCode.NOT_CONFIGURED, message, None, headers)
        return HTMLResponse(text, status_code=503, headers=headers)

    return Starlette(
        routes=[Route("/{path:path}", answer, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])]
    )


class RescueServer:
    """Der kleine Server der Hilfeseite auf dem HTTP-Port, mit der Prüfung alle ``interval_s`` Sekunden."""

    def __init__(self, settings: Settings, problem: str, *, interval_s: float = CHECK_INTERVAL_S) -> None:
        self.settings = settings
        self.interval_s = interval_s
        self.recovered = False
        config = uvicorn.Config(
            build_app(settings, problem),
            host=settings.host,
            port=settings.port,
            lifespan="off",
            proxy_headers=False,
            log_level=settings.log_level,
        )
        self.server = uvicorn.Server(config)

    async def _watch(self) -> None:
        while not self.server.should_exit:
            await asyncio.sleep(self.interval_s)
            if await asyncio.to_thread(data_dir_problem, self.settings.data_dir) is None:
                log.warning(
                    "Der Datenordner ist jetzt beschreibbar; Stowly beendet die Hilfeseite und startet neu."
                )
                self.recovered = True
                self.server.should_exit = True

    async def serve(self) -> int:
        """Läuft, bis ``/data`` beschreibbar ist (Exit-Code 3) oder ein Signal kommt (0)."""
        watch = asyncio.create_task(self._watch(), name="stowly-rescue")
        try:
            await self.server.serve()
        except SystemExit:
            return RESTART  # Der Port ist belegt.
        finally:
            watch.cancel()
            await asyncio.gather(watch, return_exceptions=True)
        return RESTART if self.recovered else 0


def run(settings: Settings, problem: str) -> int:
    """Zeigt die Hilfeseite, bis ``/data`` beschreibbar ist; liefert den Exit-Code."""
    log.error("%s Stowly startet nicht und zeigt eine Hilfeseite auf Port %d.", problem, settings.port)
    server = RescueServer(settings, problem)
    try:
        return asyncio.run(server.serve(), loop_factory=server.server.config.get_loop_factory())
    except KeyboardInterrupt:
        return 0
