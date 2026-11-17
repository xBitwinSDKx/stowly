"""Die FastAPI-Anwendung: ein Prozess liefert API, Druckdienst und Web-App.

Reihenfolge beim Aufbau:

1. Fehlerformat
2. Schnittstelle unter ``/api``
3. Druckdienst unter ``/print`` (eingebunden, nicht als Endpunkte: Er gehört nicht zu
   ``docs/openapi.json``; der Dienst selbst entsteht erst im ``lifespan``)
4. Web-App als Letztes: Ihre Route fängt jeden übrigen Pfad
"""

import asyncio
import contextlib
import logging
import sqlite3
from collections.abc import AsyncIterator, Mapping
from types import MappingProxyType
from typing import Any

import httpx2
from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from stowly import (
    __version__,
    aiconfig,
    auth,
    autobackup,
    bring,
    claude,
    cook,
    daily,
    db,
    hacheck,
    haconfig,
    label_templates,
    off,
    push,
    restore,
    scheduler,
    secretstore,
    serverconfig,
    tls,
    updates,
    wizard,
)
from stowly.api import router as api_router
from stowly.auth import LoginGuard
from stowly.config import MAX_REQUEST_BYTES, Settings
from stowly.contract.api import RESTORE_MAX_BYTES, ErrorCode
from stowly.contract.schema import build_openapi
from stowly.errors import error_response, install_error_handlers, no_store
from stowly.printing import PrintGateway, ServerPrinting
from stowly.web import install_web

log = logging.getLogger("stowly")


class BodyLimit:
    """Weist Anfragen ab, deren Rumpf zu groß ist (413 im Fehlerformat): angekündigt (``Content-Length``) oder
    beim Lesen gezählt (chunked, ohne ``Content-Length``).

    Kein Aufruf der Schnittstelle braucht mehr als ein paar hundert Kilobyte. Ohne die
    Grenze läse der Server auch ein Gigabyte „Anmeldung" erst einmal in den Speicher, auch ohne
    Anmeldung (Anmelden, erster Start). Darum liest die Middleware den Rumpf selbst, zählt jedes Byte
    aus ``receive`` und reicht ihn erst danach weiter; über der Grenze antwortet sie gleich mit 413.
    Ausnahme: Das Hochladen einer Sicherung (``PUT /api/restore/upload``) darf bis
    ``RESTORE_MAX_BYTES`` groß sein; der Endpunkt liest den Rumpf in Teilen und zählt selbst mit,
    auch ohne ``Content-Length``. Ihn reicht die Middleware ungelesen weiter.
    """

    LARGER: Mapping[str, int] = MappingProxyType({"/api/restore/upload": RESTORE_MAX_BYTES})

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = self.LARGER.get(path, self.max_bytes)
        for name, value in scope.get("headers", ()):
            if name == b"content-length" and value.isdigit() and int(value) > limit:
                await self._too_large(limit, scope, receive, send)
                return
        if path in self.LARGER:
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                # Der Aufrufer ist gegangen (http.disconnect): Niemand wartet mehr auf eine Antwort.
                return
            body += message.get("body", b"")
            if len(body) > limit:
                await self._too_large(limit, scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        replay: list[Message] = [{"type": "http.request", "body": bytes(body), "more_body": False}]

        async def replayed() -> Message:
            # Erst der gelesene Rumpf, danach wie gewohnt (etwa http.disconnect).
            return replay.pop() if replay else await receive()

        await self.app(scope, replayed, send)

    @staticmethod
    async def _too_large(limit: int, scope: Scope, receive: Receive, send: Send) -> None:
        response = error_response(
            413, ErrorCode.PAYLOAD_TOO_LARGE, "Die Anfrage ist zu groß.", {"max_bytes": limit}
        )
        await response(scope, receive, send)


class NoStore:
    """Setzt ``Cache-Control: no-store`` auf jede Antwort unter ``errors.NO_STORE_PATHS`` (KI-Vorschläge), auch
    auf Fehler der Anmeldung, des Vertrags und der Größe (401, 405, 413, 422); ein anderer Wert weicht. Liegt
    außen um ``BodyLimit``. Den 500 schickt Starlette außerhalb jeder Middleware; dort setzt ihn der Handler in
    ``errors.py``. Andere Pfade bleiben, wie sie sind (``/api/images`` etwa mit ``immutable``)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not no_store(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        async def sending(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (name, value)
                    for name, value in message.get("headers", ())
                    if name.lower() != b"cache-control"
                ]
                message = {**message, "headers": [*headers, (b"cache-control", b"no-store")]}
            await send(message)

        await self.app(scope, receive, sending)


def report_configuration(settings: Settings) -> None:
    """Schreibt beim Start ins Log, was eingerichtet ist und was nur halb (nie einen Token, nie einen Schlüssel,
    nie das Passwort).

    Passwort, Push, Updates und KI-Vorschläge nach ihren wirksamen Werten: aus der Umgebung oder aus der App.
    """
    con = db.connect(settings.database_path)
    try:
        has_password = auth.has_password(settings, con)
        contact = serverconfig.push_contact(settings, con)
        repo = serverconfig.update_repo(settings, con)
        # Home Assistant aus der Umgebung oder der App, die Tokens im eigenen Speicher.
        ha = haconfig.effective(settings, con)
        # Die Sicherung ebenso (Umgebung, App, Vorgabe; der Ordner nach serverconfig.backup_folder).
        backup = serverconfig.backup_setup(settings, con)
        # KI-Vorschläge: Quelle des Schlüssels und Modell (der Schlüssel im eigenen Speicher).
        ai = aiconfig.effective(settings, con)
    finally:
        con.close()
    if not has_password:
        log.warning("Noch kein Passwort: Wer Stowly jetzt öffnet, vergibt es.")
    log.info("Zeitzone des Servers: %s", settings.timezone)
    if backup.configured:
        log.info(
            "Automatische Sicherung täglich um %s nach %s an %d Schlüssel.",
            backup.time,
            backup.folder.path,
            len(backup.keys),
        )
    elif backup.problem is not None:
        log.warning("Keine automatische Sicherung: %s", backup.problem)
    if ha.configured:
        log.info(
            "Einkaufsliste nach Bring! über Home Assistant, Liste %s (%s).",
            ha.entity,
            "aus der Umgebung" if ha.source == "env" else "aus der App",
        )
    elif ha.problem is not None:
        log.warning("Kein Abgleich mit Home Assistant: %s", ha.problem)
    if ha.sensor_token is not None:
        log.info("Sensor für Home Assistant unter /api/ha/summary eingerichtet.")
    elif ha.sensor_problem is not None:
        log.warning("Sensor für Home Assistant: %s", ha.sensor_problem)
    if contact is None:
        log.info("Push ist aus: Es gibt keinen Kontakt für die Push-Dienste (App oder STOWLY_PUSH_CONTACT).")
    if ai.configured:
        log.info(
            "KI-Vorschläge mit %s, Schlüssel %s.",
            ai.model.value,
            "aus der Umgebung" if ai.source == "env" else "aus der App",
        )
    elif ai.problem is not None:
        log.warning("KI-Vorschläge: %s", ai.problem)
    if settings.anthropic_base_url is not None:
        log.warning(
            "KI-Vorschläge gehen an %s statt an Anthropic (STOWLY_ANTHROPIC_BASE_URL, nur zum Entwickeln).",
            settings.anthropic_base_url,
        )
    if repo is not None:
        log.info("Updates: Releases von %s auf GitHub.", repo)
    if settings.https_port is not None:
        log.info(
            "HTTPS auf Port %d mit der eigenen CA (docs/integrationen.md, Abschnitt 11).", settings.https_port
        )


def build_app(
    settings: Settings,
    *,
    off_transport: httpx2.AsyncBaseTransport | None = None,
    off_clock: off.Clock | None = None,
    push_transport: httpx2.AsyncBaseTransport | None = None,
    push_clock: off.Clock | None = None,
    job_clock: off.Clock | None = None,
    ha_transport: httpx2.AsyncBaseTransport | None = None,
    ha_clock: off.Clock | None = None,
    update_transport: httpx2.AsyncBaseTransport | None = None,
    update_clock: off.Clock | None = None,
    ai_transport: httpx2.AsyncBaseTransport | None = None,
    ai_clock: off.Clock | None = None,
) -> FastAPI:
    """Baut die Anwendung, ohne Dateien oder die Datenbank anzufassen.

    ``off_transport`` und ``off_clock`` ersetzen in Tests die Verbindung zu Open Food Facts
    und die Uhr des Hintergrund-Ablaufs, ``push_transport`` und ``push_clock`` die Verbindung zu
    den Push-Diensten und deren Uhr, ``job_clock`` die Uhr des Zeitplans, ``ha_transport`` und
    ``ha_clock`` die Verbindung zu Home Assistant und die Uhr des Abgleichs mit Bring!,
    ``update_transport`` und ``update_clock`` die Verbindung zu GitHub und die Uhr der Updates (Takt
    der Abfragen, Bremse des Knopfs, Alter der Dateien des Updaters), ``ai_transport`` und ``ai_clock``
    die Verbindung zu Anthropic und die Uhr der KI-Vorschläge (Bremsen, Tageszähler, Aufträge).
    """

    gateway = PrintGateway()
    update_timer = update_clock or off.Clock()
    ai_timer = ai_clock or off.Clock()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Läuft erst, wenn die App wirklich bedient wird; der Vertrags-Export kommt nie hierher.
        await run_in_threadpool(report_configuration, settings)
        # Push, Tagesnachricht und die Abfrage bei GitHub entstehen immer: Sie lesen den wirksamen Wert
        # (Umgebung oder App) erst beim Einsatz, so wirkt eine Änderung in der App ohne Neustart.
        sender = push.PushService(settings, transport=push_transport, clock=push_clock)
        app.state.push = sender
        # Aufgaben des Zeitplans (docs/integrationen.md, 1.1), in dieser Reihenfolge: die Sicherung (immer;
        # sie liest ihre Einstellungen bei jedem Takt und ruht ohne Schlüssel), die Tagesnachricht (sie prüft
        # den Kontakt selbst) und mit HTTPS die Erneuerung des Zertifikats.
        tasks: list[scheduler.Job] = [autobackup.BackupJob(settings)]
        tasks.append(daily.PushDailyJob(settings, sender, clock=job_clock))
        if settings.https_port is not None:
            tasks.append(
                tls.TlsRenewJob(
                    settings, app.state.tls, lambda: wizard.stored_certificate_addresses(settings)
                )
            )
        jobs = scheduler.Scheduler(settings.database_path, tasks, clock=job_clock)
        app.state.scheduler = jobs
        schedule = asyncio.create_task(jobs.run(), name="stowly-scheduler")
        # Der Abgleich mit Home Assistant und Bring! hat seine eigene Schleife (5.4). Sie läuft immer, liest
        # die Einrichtung (Umgebung oder App) vor jedem Lauf und ruht ohne sie, bis reconfigure sie weckt.
        ha = bring.BringSync(settings, app.state.secrets, transport=ha_transport, clock=ha_clock)
        app.state.bring = ha
        ha_task = asyncio.create_task(ha.run(), name="stowly-ha")
        # Die Abfrage bei GitHub hat ebenfalls ihre eigene Schleife (10.2); sie schläft, solange Updates
        # aus sind, und wacht auf, wenn der Schalter in der App sie einschaltet (reconfigure).
        checker = updates.UpdateChecker(settings, sender, transport=update_transport, clock=update_timer)
        app.state.updates = checker
        checker_task = asyncio.create_task(checker.run(), name="stowly-updates")
        # Zurückspielen: Abgelaufenes (hochgeladene Dateien, Kandidaten, die alte Datenbank nach 7 Tagen) räumt
        # diese Schleife weg, auch wenn niemand mehr fragt.
        sweeper = asyncio.create_task(_sweep_restore(app.state.restore), name="stowly-restore")
        # KI-Vorschläge (docs/plan-0.6.md, 2): der Draht zu Anthropic (das SDK lädt erst der erste Aufruf) und
        # die Aufträge mit ihrem Worker; beide gibt es nur, solange die App bedient wird.
        wire = claude.Claude(base_url=settings.anthropic_base_url, transport=ai_transport)
        kitchen = cook.CookService(settings, app.state.secrets, app.state.cook_guard, wire)
        kitchen.start()
        app.state.claude = wire
        app.state.cook = kitchen
        try:
            async with _serving(app):
                yield
        finally:
            sweeper.cancel()
            await asyncio.gather(sweeper, return_exceptions=True)
            app.state.cook = None
            app.state.claude = None
            await kitchen.aclose()
            await wire.aclose()
            # Nicht abbrechen: Ein Takt, der gerade die Datenbank liest, wird fertig; ein laufender
            # Lauf bekommt ein paar Sekunden (Scheduler.aclose), der Abgleich mit HA und die Abfrage
            # bei GitHub ebenso.
            jobs.stop()
            ha.stop()
            checker.stop()
            await asyncio.gather(schedule, return_exceptions=True)
            await asyncio.gather(
                jobs.aclose(),
                _stop(ha_task, bring.SHUTDOWN_WAIT_S),
                _stop(checker_task, updates.SHUTDOWN_WAIT_S),
            )
            app.state.scheduler = None
            app.state.bring = None
            app.state.updates = None
            app.state.push = None
            await sender.aclose()
            await ha.aclose()
            await checker.aclose()

    @contextlib.asynccontextmanager
    async def _serving(app: FastAPI) -> AsyncIterator[None]:
        printing: ServerPrinting | None = None
        try:
            printing = await run_in_threadpool(ServerPrinting.open, settings)
        except Exception:
            # Bestand und Abgleich gehen auch ohne Druck. /print antwortet dann mit 503.
            log.exception("Der Druckdienst des Servers ließ sich nicht starten.")
            gateway.reason = (
                "Der Druckdienst des Servers ist nicht verfügbar (Einzelheiten im Log des Servers)."
            )
        else:
            gateway.app = printing.app
            app.state.printing = printing

        try:
            worker: off.OffWorker | None = None
            task: asyncio.Task[None] | None = None
            if settings.off_enabled:
                worker = off.OffWorker(settings, transport=off_transport, clock=off_clock)
                task = asyncio.create_task(worker.run(), name="stowly-off")
                app.state.off_worker = worker
            try:
                yield
            finally:
                app.state.off_worker = None
                if worker is not None:
                    # Wer beim Nachschlagen wartet, bekommt seine Antwort jetzt (siehe release_waiting).
                    worker.release()
                if task is not None:
                    task.cancel()
                    # Wie auch immer der Ablauf endet: Das Herunterfahren geht weiter.
                    await asyncio.gather(task, return_exceptions=True)
                if worker is not None:
                    await worker.aclose()
        finally:
            # Ein laufender Druck wird weder abgebrochen noch abgewartet (nach dem Neustart: unknown).
            gateway.app = None
            app.state.printing = None
            if printing is not None:
                await run_in_threadpool(printing.close)

    app = FastAPI(
        title="Stowly",
        version=__version__,
        description="Selbst gehostete Lagerverwaltung für Lebensmittel. Vertrag: docs/sync-protokoll.md.",
        # Die Swagger-Oberfläche lädt Skripte von einem fremden Server: nur beim Entwickeln.
        docs_url="/api/docs" if settings.dev else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.dev else None,
        separate_input_output_schemas=False,
        lifespan=lifespan,
    )
    app.state.settings = settings
    # Bremse gegen das Durchprobieren des Passworts, gemeinsam für alle Aufrufer.
    app.state.login_guard = LoginGuard()
    # CA und Zertifikat des HTTPS-Listeners (stowly/tls.py); Dateien fasst erst create_app an (prepare).
    app.state.tls = tls.TlsManager(settings)
    # Hintergrund-Ablauf für Open Food Facts; läuft nur, solange die App bedient wird.
    app.state.off_worker = None
    # Druckdienst (stowly/printing.py); läuft ebenfalls nur, solange die App bedient wird.
    app.state.printing = None
    # Versand an die Push-Dienste, der Zeitplan (Sicherung, Tagesnachricht), der Abgleich mit
    # Home Assistant und die Abfrage bei GitHub; ebenso nur, solange die App läuft.
    app.state.push = None
    app.state.scheduler = None
    app.state.bring = None
    app.state.updates = None
    # Die Uhr der Updates gilt auch ohne laufende Schleife: Die Endpunkte messen damit das Alter der
    # Dateien des Updaters.
    app.state.update_clock = update_timer
    # Tokens aus der App außerhalb der Datenbank (stowly/secretstore.py; den Ordner legt create_app an) und
    # die Prüfung der Verbindung zu HA (stowly/hacheck.py: Transport wie der Abgleich, eine zugleich).
    app.state.secrets = secretstore.SecretStore(settings.secrets_dir)
    app.state.ha_transport = ha_transport
    app.state.ha_check = hacheck.CheckGuard(ha_clock)
    # KI-Vorschläge: die Uhr (Tageszähler, Bremsen, Alter der Aufträge), die Prüfung des Schlüssels (eine
    # zugleich, 3 Sekunden Abstand) und die Bremsen der Vorschläge; der Draht zu Anthropic und die Aufträge
    # entstehen erst im lifespan.
    app.state.ai_clock = ai_timer
    app.state.ai_check = hacheck.CheckGuard(ai_timer)
    app.state.cook_guard = cook.CookGuard(ai_timer)
    app.state.claude = None
    app.state.cook = None
    # Zurückspielen (stowly/restore.py): Hochgeladenes und Geprüftes im Arbeitsspeicher, dazu der Neustart,
    # den die Listener bereitstellen (__main__.Listeners.request_restart); ohne sie gibt es keinen.
    app.state.restore = restore.RestoreManager(settings)
    app.state.request_restart = None

    install_error_handlers(app)
    app.add_middleware(BodyLimit)
    # Nach BodyLimit hinzugefügt, liegt also außen herum: Auch dessen 413 trägt den Kopf.
    app.add_middleware(NoStore)
    app.include_router(api_router, prefix="/api")
    # Eingebunden, nicht als FastAPI-Endpunkte: docs/openapi.json bleibt, wie es ist.
    app.mount("/print", gateway)

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]

    # Muss der letzte Schritt bleiben (siehe stowly/web.py).
    install_web(app, settings.web_dir, csp=settings.csp)
    return app


async def _sweep_restore(manager: restore.RestoreManager) -> None:
    """Alle ``restore.SWEEP_EVERY_S`` Sekunden ``RestoreManager.sweep``; ein Fehler steht im Log, die Schleife
    läuft weiter."""
    while True:
        await asyncio.sleep(restore.SWEEP_EVERY_S)
        try:
            await run_in_threadpool(manager.sweep)
        except Exception:
            log.exception("Zurückspielen: Das Aufräumen ist fehlgeschlagen.")


async def _stop(task: "asyncio.Task[None] | None", timeout_s: float) -> None:
    """Wartet höchstens ``timeout_s`` Sekunden auf eine Aufgabe, die schon gebeten wurde aufzuhören; dann
    bricht es sie ab."""
    if task is None:
        return
    _done, pending = await asyncio.wait({task}, timeout=timeout_s)
    if pending:
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def release_waiting(app: FastAPI) -> None:
    """Beim Beenden, bevor uvicorn auf laufende Anfragen wartet: Wer beim Nachschlagen wartet
    (``GET /api/lookup/…?wait=8``), bekommt sofort, was bekannt ist, sonst ``pending``.

    uvicorn fährt die App erst herunter, wenn die laufenden Anfragen beantwortet sind. Ohne
    diesen Schritt hielte eine wartende Anfrage das Beenden bis zum Ende ihrer Wartezeit auf.
    """
    worker = getattr(app.state, "off_worker", None)
    if worker is not None:
        worker.release()


def prepare_database(settings: Settings) -> None:
    """Legt die Datenbank an, migriert sie und bringt sie auf den Stand dieses Servers.

    * Grundausstattung (erste Zone, Einstellungen, ``dataset_id``)
    * Etikett-Vorlagen aus der Gestaltung des Haushalts, ohne eine aus ``stowly_print`` (kommen über den Sync
      auf die Geräte). Scheitert das, gelten die mitgelieferten: Stowly startet immer, auch mit einer
      kaputten Gestaltung aus einer Sicherung; sonst wäre auch „Rückgängig" unerreichbar.
    * ``lookup`` der Produkte passend zu ``STOWLY_OFF_ENABLED``; scheitert das, steht es im Log, und Stowly
      startet trotzdem (die Prüfung beim Zurückspielen lässt ohnehin nur gültigen Text herein)
    * das VAPID-Schlüsselpaar für Push, auch ohne ``STOWLY_PUSH_CONTACT`` (docs/integrationen.md, 4.1)
    """
    db.initialise(settings.database_path)
    con = db.connect(settings.database_path)
    try:
        changed = _install_label_templates(con)
        if changed:
            log.info("Etikett-Vorlagen übernommen: %s", ", ".join(changed))
        try:
            off.reconcile(con, enabled=settings.off_enabled)
        except Exception:
            # Wie die Vorlagen: Was eine Sicherung an Unlesbarem mitbrachte, verhindert den Start nicht.
            log.exception(
                "Der Stand des Nachschlagens ließ sich beim Start nicht angleichen; Stowly startet trotzdem."
            )
        push.ensure_vapid_keys(con)
    finally:
        con.close()


def _install_label_templates(con: sqlite3.Connection) -> list[str]:
    """``label_templates.install`` beim Start, mit Rückfall auf die mitgelieferten Vorlagen."""
    try:
        return label_templates.install(con)
    except Exception:
        log.exception(
            "Die Etikett-Vorlagen ließen sich nicht aus der Gestaltung erzeugen; es gelten die mitgelieferten."
        )
    try:
        return label_templates.install(con, use_design=False)
    except Exception:
        log.exception("Auch die mitgelieferten Etikett-Vorlagen ließen sich nicht übernehmen.")
        return []


def create_app(
    settings: Settings | None = None,
    *,
    off_transport: httpx2.AsyncBaseTransport | None = None,
    off_clock: off.Clock | None = None,
    push_transport: httpx2.AsyncBaseTransport | None = None,
    push_clock: off.Clock | None = None,
    job_clock: off.Clock | None = None,
    ha_transport: httpx2.AsyncBaseTransport | None = None,
    ha_clock: off.Clock | None = None,
    update_transport: httpx2.AsyncBaseTransport | None = None,
    update_clock: off.Clock | None = None,
    ai_transport: httpx2.AsyncBaseTransport | None = None,
    ai_clock: off.Clock | None = None,
) -> FastAPI:
    """Anwendung für den Betrieb: legt die Datenbank an und migriert sie, übernimmt ``STOWLY_PASSWORD``
    als Hash, legt den Ordner für den Austausch mit dem Updater an (``/data/update``,
    docs/integrationen.md, 10.3) und lädt oder erzeugt die CA samt Zertifikat (Abschnitt 11)."""
    settings = settings or Settings.from_env()
    prepare_database(settings)
    adopt_env_password(settings)
    updates.prepare_folder(settings)
    app = build_app(
        settings,
        off_transport=off_transport,
        off_clock=off_clock,
        push_transport=push_transport,
        push_clock=push_clock,
        job_clock=job_clock,
        ha_transport=ha_transport,
        ha_clock=ha_clock,
        update_transport=update_transport,
        update_clock=update_clock,
        ai_transport=ai_transport,
        ai_clock=ai_clock,
    )
    app.state.tls.prepare(wizard.stored_certificate_addresses(settings))
    # /data/secrets (0700); scheitert das, steht es im Zustand von HA und der KI-Vorschläge, und der Server
    # startet trotzdem.
    app.state.secrets.prepare()
    return app


def adopt_env_password(settings: Settings) -> None:
    """Übernimmt ``STOWLY_PASSWORD`` beim Start als Hash (``auth.adopt_env_password``); nie den Rückfall
    des Entwicklungsmodus."""
    con = db.connect(settings.database_path)
    try:
        auth.adopt_env_password(settings, con)
    finally:
        con.close()
