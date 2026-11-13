"""Die FastAPI-Anwendung: ein Prozess liefert API und Web-App.

Reihenfolge beim Aufbau:

1. Fehlerformat
2. Schnittstelle unter ``/api``
3. (Runde 2) Druckdienst unter ``/print``
4. Web-App als Letztes: Ihre Route fängt jeden übrigen Pfad
"""

from typing import Any

from fastapi import FastAPI

from stowly import __version__, db
from stowly.api import router as api_router
from stowly.config import Settings
from stowly.contract.schema import build_openapi
from stowly.errors import install_error_handlers
from stowly.web import install_web


def build_app(settings: Settings) -> FastAPI:
    """Baut die Anwendung, ohne Dateien oder die Datenbank anzufassen."""
    app = FastAPI(
        title="Stowly",
        version=__version__,
        description="Selbst gehostete Lagerverwaltung für Lebensmittel. Vertrag: docs/sync-protokoll.md.",
        # Die Swagger-Oberfläche lädt Skripte von einem fremden Server: nur beim Entwickeln.
        docs_url="/api/docs" if settings.dev else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.dev else None,
        separate_input_output_schemas=False,
    )
    app.state.settings = settings

    install_error_handlers(app)
    app.include_router(api_router, prefix="/api")

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]

    # Muss der letzte Schritt bleiben (siehe stowly/web.py).
    install_web(app, settings.web_dir)
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    """Anwendung für den Betrieb: legt die Datenbank an und migriert sie."""
    settings = settings or Settings.from_env()
    db.initialise(settings.database_path)
    return build_app(settings)
