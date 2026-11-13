"""Die FastAPI-Anwendung: ein Prozess liefert API und Web-App.

Reihenfolge beim Aufbau:

1. Fehlerformat
2. Schnittstelle unter ``/api``
3. (Runde 2) Druckdienst unter ``/print``
4. Web-App als Letztes: Ihre Route fängt jeden übrigen Pfad
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx2
from fastapi import FastAPI
from starlette.types import ASGIApp, Receive, Scope, Send

from stowly import __version__, db, label_templates, off
from stowly.api import router as api_router
from stowly.auth import LoginGuard
from stowly.config import MAX_REQUEST_BYTES, Settings
from stowly.contract.api import ErrorCode
from stowly.contract.schema import build_openapi
from stowly.errors import error_response, install_error_handlers
from stowly.web import install_web

log = logging.getLogger("stowly")


class BodyLimit:
    """Weist Anfragen ab, die einen zu großen Rumpf ankündigen (413 im Fehlerformat).

    Kein Aufruf der Schnittstelle braucht mehr als ein paar hundert Kilobyte. Ohne die
    Grenze läse der Server auch ein Gigabyte „Anmeldung" erst einmal in den Speicher.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            for name, value in scope.get("headers", ()):
                if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                    response = error_response(
                        413,
                        ErrorCode.PAYLOAD_TOO_LARGE,
                        "Die Anfrage ist zu groß.",
                        {"max_bytes": self.max_bytes},
                    )
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


def build_app(settings: Settings, *, off_transport: httpx2.AsyncBaseTransport | None = None) -> FastAPI:
    """Baut die Anwendung, ohne Dateien oder die Datenbank anzufassen.

    ``off_transport`` ersetzt in Tests die Verbindung zu Open Food Facts.
    """

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Läuft erst, wenn die App wirklich bedient wird; der Vertrags-Export kommt nie hierher.
        worker: off.OffWorker | None = None
        task: asyncio.Task[None] | None = None
        if settings.off_enabled:
            worker = off.OffWorker(settings, transport=off_transport)
            task = asyncio.create_task(worker.run(), name="stowly-off")
            app.state.off_worker = worker
        try:
            yield
        finally:
            app.state.off_worker = None
            if task is not None:
                task.cancel()
                # Wie auch immer der Ablauf endet: Das Herunterfahren geht weiter.
                await asyncio.gather(task, return_exceptions=True)
            if worker is not None:
                await worker.aclose()

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
    # Hintergrund-Ablauf für Open Food Facts; läuft nur, solange die App bedient wird.
    app.state.off_worker = None

    install_error_handlers(app)
    app.add_middleware(BodyLimit)
    app.include_router(api_router, prefix="/api")

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]

    # Muss der letzte Schritt bleiben (siehe stowly/web.py).
    install_web(app, settings.web_dir)
    return app


def prepare_database(settings: Settings) -> None:
    """Legt die Datenbank an, migriert sie und bringt sie auf den Stand dieses Servers.

    * Grundausstattung (erste Zone, Einstellungen, ``dataset_id``)
    * Etikett-Vorlagen aus ``stowly_print`` (kommen über den Sync auf die Geräte)
    * ``lookup`` der Produkte passend zu ``STOWLY_OFF_ENABLED``
    """
    db.initialise(settings.database_path)
    con = db.connect(settings.database_path)
    try:
        changed = label_templates.install(con)
        if changed:
            log.info("Etikett-Vorlagen übernommen: %s", ", ".join(changed))
        off.reconcile(con, enabled=settings.off_enabled)
    finally:
        con.close()


def create_app(
    settings: Settings | None = None, *, off_transport: httpx2.AsyncBaseTransport | None = None
) -> FastAPI:
    """Anwendung für den Betrieb: legt die Datenbank an und migriert sie."""
    settings = settings or Settings.from_env()
    prepare_database(settings)
    return build_app(settings, off_transport=off_transport)
