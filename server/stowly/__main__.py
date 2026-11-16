"""Startet den Server: ``python -m stowly [--dev] [--host H] [--port P]``.

Ohne Angaben gelten die Umgebungsvariablen ``STOWLY_*`` (siehe .env.example).

Zwei Listener in einer Ereignisschleife, dieselbe App (docs/integrationen.md, 11.4): HTTP auf
``STOWLY_PORT`` und, mit ``STOWLY_HTTPS_PORT``, HTTPS mit der eigenen CA. Der Lebenszyklus der App
umschließt beide: Die Dienste stehen, bevor ein Port aufgeht, und enden erst nach beiden Listenern.
Ist ``/data`` nicht beschreibbar, zeigt statt des Servers eine Hilfeseite den Grund (``rescue.py``).

Vor ``create_app`` spielt ``restore.resume`` eine bereitgelegte Sicherung ein (docs/sync-protokoll.md,
11.9). Nach dem Anwenden ruft die App ``request_restart``: Beide Listener enden sauber, dann ersetzt sich
der Prozess mit ``os.execv`` selbst (unter Windows startet er im selben Prozess neu).
"""

import argparse
import asyncio
import contextlib
import dataclasses
import logging
import os
import signal
import socket
import ssl
import sys
import threading
from collections.abc import Callable
from types import FrameType

import uvicorn
from fastapi import FastAPI
from uvicorn.server import HANDLED_SIGNALS

from stowly import __version__, db, rescue, restore
from stowly.app import create_app, prepare_database, release_waiting
from stowly.config import DEV_PASSWORD, Settings
from stowly.tls import CaUnavailable, TlsManager

# Exit-Code, wenn der Server nicht starten konnte (wie bei uvicorn.run, etwa Port belegt); ebenso, wenn
# sich der Prozess nach einem Zurückspielen nicht ersetzen ließ: Dann startet Docker ihn neu.
STARTUP_FAILURE = 3
# Unter POSIX ersetzt sich der Prozess nach einem Zurückspielen selbst (os.execv, die PID bleibt);
# unter Windows (Entwicklung) gibt es kein echtes execv, dort beginnt main() im selben Prozess von vorn.
RESTART_IN_PROCESS = os.name != "posix"
# Beim Beenden höchstens so lange auf laufende Anfragen warten: Eine Abfrage mit ?wait=30 am
# Druckdienst hielte das Herunterfahren sonst auf, und Docker beendet nach 10 Sekunden hart.
GRACEFUL_SHUTDOWN_S = 5

log = logging.getLogger("stowly")


class Server(uvicorn.Server):
    """uvicorn für einen Listener von Stowly: ohne eigene Signale und mit einem Schritt vor dem Herunterfahren.

    Signale fängt ``Listeners`` für beide Listener zusammen. uvicorn wartet beim Beenden zuerst auf
    laufende Anfragen und fährt erst danach die App herunter. Wer gerade beim Nachschlagen wartet
    (``GET /api/lookup/…?wait=8``), bekommt deshalb vorher seine Antwort (``release_waiting``) und hält
    das Beenden nicht auf.
    """

    def __init__(
        self, config: uvicorn.Config, app: FastAPI, *, on_started: Callable[[], None] | None = None
    ) -> None:
        super().__init__(config)
        self.stowly_app = app
        self.on_started = on_started

    def capture_signals(self) -> contextlib.AbstractContextManager[None]:
        return contextlib.nullcontext()

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if self.started and self.on_started is not None:
            self.on_started()

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        release_waiting(self.stowly_app)
        await super().shutdown(sockets=sockets)


async def _serve(server: Server) -> BaseException | None:
    """Lässt einen Listener laufen; liefert, woran er scheiterte, statt es weiterzuwerfen.

    uvicorn beendet einen gescheiterten Start (Port belegt) mit ``sys.exit(3)``. Ein ``SystemExit`` in
    einer asyncio-Aufgabe risse die ganze Ereignisschleife mit, also auch den anderen Listener.
    """
    try:
        await server.serve()
    except (SystemExit, CaUnavailable) as exc:
        return exc
    except Exception as exc:
        log.exception("Der Listener auf Port %s ist unerwartet gescheitert.", server.config.port)
        return exc
    return None


class Listeners:
    """HTTP und, mit ``STOWLY_HTTPS_PORT``, HTTPS: zwei ``uvicorn.Server`` mit ``lifespan`` aus und ohne
    Proxy-Kopfzeilen (ob eine Anfrage über HTTPS kam, sagt ``scope["scheme"]``)."""

    def __init__(self, app: FastAPI, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self.tls: TlsManager = app.state.tls
        # Nach dem Anwenden einer Sicherung (api/restore.py): Die App bittet um einen Neustart.
        self.restart_requested = False
        self._loop: asyncio.AbstractEventLoop | None = None
        app.state.request_restart = self.request_restart
        self.http = Server(
            uvicorn.Config(
                app,
                host=settings.host,
                port=settings.port,
                lifespan="off",
                proxy_headers=False,
                log_level=settings.log_level,
                timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
            ),
            app,
        )
        self.https: Server | None = None
        if settings.https_port is not None:
            self.https = Server(
                uvicorn.Config(
                    app,
                    host=settings.host,
                    port=settings.https_port,
                    lifespan="off",
                    proxy_headers=False,
                    # Das Logging hat der HTTP-Listener schon eingerichtet.
                    log_config=None,
                    log_level=settings.log_level,
                    timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
                    ssl_context_factory=self._ssl_context,
                ),
                app,
                on_started=self.tls.started,
            )

    @property
    def servers(self) -> list[Server]:
        return [server for server in (self.http, self.https) if server is not None]

    def _ssl_context(self, _config: uvicorn.Config, _default: Callable[[], ssl.SSLContext]) -> ssl.SSLContext:
        """Der Kontext des ``TlsManager``: Ein neues Zertifikat lädt er später in denselben Kontext."""
        return self.tls.context()

    def stop(self, *, force: bool = False) -> None:
        """Beendet beide Listener; ``force`` wartet nicht mehr auf laufende Anfragen."""
        for server in self.servers:
            server.should_exit = True
            if force:
                server.force_exit = True

    def request_restart(self) -> None:
        """Beide Listener sauber beenden (laufende Anfragen werden fertig, der Lebenszyklus der App läuft ab);
        danach startet ``main`` Stowly neu. Darf aus jedem Thread gerufen werden."""
        self.restart_requested = True
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self.stop)
        else:
            self.stop()

    def _on_signal(self, signum: int, _frame: FrameType | None) -> None:
        # Ein zweites Strg+C wartet nicht mehr auf laufende Anfragen (wie bei uvicorn).
        self.stop(force=signum == signal.SIGINT and self.http.should_exit)

    def _capture_signals(self) -> Callable[[], None]:
        """SIGINT, SIGTERM (und unter Windows SIGBREAK) beenden beide Listener. Nur im Haupt-Thread."""
        if threading.current_thread() is not threading.main_thread():
            return lambda: None
        previous = {signum: signal.signal(signum, self._on_signal) for signum in HANDLED_SIGNALS}

        def restore() -> None:
            for signum, handler in previous.items():
                signal.signal(signum, handler)

        return restore

    async def serve(self) -> int:
        """Lebenszyklus der App um beide Listener; liefert den Exit-Code (0, oder 3 ohne HTTP)."""
        restore_signals = self._capture_signals()
        self._loop = asyncio.get_running_loop()
        self.tls.attach(self._loop)
        entered = False
        try:
            async with self.app.router.lifespan_context(self.app):
                entered = True
                return await self._listen()
        except Exception:
            if entered:
                raise
            log.exception("Stowly ließ sich nicht starten.")
            return STARTUP_FAILURE
        finally:
            self.tls.detach()
            restore_signals()
            self._loop = None

    async def _listen(self) -> int:
        http_task = asyncio.create_task(_serve(self.http), name="stowly-http")
        while not self.http.started and not http_task.done():
            await asyncio.sleep(0.02)
        if not self.http.started:
            # HTTP ließ sich nicht starten (etwa Port belegt): Exit 3, HTTPS startet gar nicht erst.
            await http_task
            return STARTUP_FAILURE
        https_task = None
        if self.https is not None:
            https_task = asyncio.create_task(self._serve_https(self.https), name="stowly-https")
        try:
            await http_task
        finally:
            if self.https is not None and https_task is not None:
                self.https.should_exit = True
                await https_task
        return 0

    async def _serve_https(self, server: Server) -> None:
        problem = await _serve(server)
        if server.started:
            self.tls.stopped()
            return
        port = self.settings.https_port
        if isinstance(problem, CaUnavailable):
            reason = str(problem)
        else:
            reason = f"Der Port {port} ist belegt oder nicht erlaubt (Einzelheiten im Log)."
        self.tls.failed(f"Der HTTPS-Listener auf Port {port} läuft nicht: {reason} HTTP läuft weiter.")


def configure_logging(level: str) -> None:
    """Meldungen des Servers (``stowly.*``) und des Druckdienstes (``stowly_print.*``) im Stil von
    uvicorn auf die Standardfehlerausgabe.

    uvicorn richtet nur seine eigenen Logger ein. Ohne das hier gingen Hinweise des
    Hintergrund-Ablaufs unter. Tokens und das Passwort werden nie protokolliert.
    """
    numeric = logging.DEBUG if level == "trace" else getattr(logging, level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    for name in ("stowly", "stowly_print"):
        logger = logging.getLogger(name)
        logger.handlers[:] = [handler]
        logger.setLevel(numeric)
        logger.propagate = False


def renew_dataset(settings: Settings) -> int:
    """``--new-dataset``: neue Kennung des Datenbestands, damit alle Geräte neu abziehen."""
    if not settings.database_path.is_file():
        print(f"Die Datenbank {settings.database_path} gibt es nicht.", file=sys.stderr)
        return 1
    prepare_database(settings)
    con = db.connect(settings.database_path)
    try:
        dataset_id = db.renew_dataset_id(con)
    finally:
        con.close()
    print(f"Neue Kennung des Datenbestands: {dataset_id}")
    print("Alle Geräte holen den Bestand beim nächsten Abgleich vollständig neu.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stowly", description="Stowly-Server")
    parser.add_argument(
        "--dev",
        action="store_true",
        help=f"Entwicklungsmodus: Passwort '{DEV_PASSWORD}', API-Dokumentation unter /api/docs",
    )
    parser.add_argument(
        "--host", help="Adresse, an die der Server bindet (Vorgabe: STOWLY_HOST oder 127.0.0.1)"
    )
    parser.add_argument("--port", type=int, help="Port (Vorgabe: STOWLY_PORT oder 8010)")
    parser.add_argument(
        "--new-dataset",
        action="store_true",
        help=(
            "Gibt dem Datenbestand eine neue Kennung und endet, ohne den Server zu starten. "
            "Nötig, nachdem eine Kopie der Datenbank zurückgespielt wurde, die nicht aus der "
            "Sicherung der App stammt: Erst dann holen alle Geräte den Bestand vollständig neu."
        ),
    )
    parser.add_argument("--version", action="version", version=f"stowly {__version__}")
    args = parser.parse_args(argv)

    try:
        settings = Settings.from_env(dev=True if args.dev else None)
    except ValueError as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2
    if args.host:
        settings = dataclasses.replace(settings, host=args.host)
    if args.port:
        settings = dataclasses.replace(settings, port=args.port)

    if args.new_dataset:
        return renew_dataset(settings)

    configure_logging(settings.log_level)
    # Vor allem anderen: Lässt sich /data nicht beschreiben, gibt es statt eines Absturzes (und einer
    # Neustart-Schleife des Containers) eine Hilfeseite, bis der Ordner beschreibbar ist.
    problem = rescue.data_dir_problem(settings.data_dir)
    if problem is not None:
        return rescue.run(settings, problem)
    if settings.web_dir is None or not (settings.web_dir / "index.html").is_file():
        print(
            "Hinweis: Die Web-App ist nicht gebaut; es antwortet nur die Schnittstelle unter /api.",
            file=sys.stderr,
        )

    while True:
        # Bevor irgendetwas die Datenbank öffnet: eine bereitgelegte Sicherung einspielen (wirft nie).
        restore.resume(settings)
        app = create_app(settings)
        listeners = Listeners(app, settings)
        try:
            code = asyncio.run(listeners.serve(), loop_factory=listeners.http.config.get_loop_factory())
        except KeyboardInterrupt:
            return 0 if listeners.http.started else STARTUP_FAILURE
        if not listeners.restart_requested:
            return code
        if not RESTART_IN_PROCESS:
            return replace_process()
        log.info("Stowly startet im selben Prozess neu.")


def replace_process() -> int:
    """Ersetzt den Prozess durch einen frischen mit denselben Argumenten (``os.execv``). Die PID bleibt, der
    Container läuft weiter, und Docker braucht keine Neustart-Regel. Kehrt nur zurück, wenn das scheitert:
    mit Exit-Code 3, dann startet Docker den Container neu und der Tausch geschieht dort."""
    argv = [sys.executable, *sys.orig_argv[1:]]
    log.info("Stowly startet neu.")
    for name in ("stowly", "stowly_print"):
        for handler in logging.getLogger(name).handlers:
            with contextlib.suppress(Exception):
                handler.flush()
    with contextlib.suppress(Exception):
        sys.stdout.flush()
        sys.stderr.flush()
    try:
        os.execv(sys.executable, argv)
    except OSError:
        log.exception("Stowly ließ sich nicht neu starten.")
    return STARTUP_FAILURE


if __name__ == "__main__":
    sys.exit(main())
