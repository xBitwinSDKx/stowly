"""Auslieferung der gebauten Web-App durch denselben Prozess wie die API.

* Vorhandene Dateien aus ``web_dir`` werden ausgeliefert.
* Jeder andere Pfad liefert ``index.html``: Die App hat eigene Routen (``/zonen``, ``/scan`` …).
* ``/api/…`` und ``/print/…`` gehören der Schnittstelle und landen nie bei der App.

Zwischenspeichern: Dateien unter ``/assets/`` tragen einen Hash im Namen und dürfen
ewig liegen. Alles andere (``index.html``, ``sw.js``, Manifest) wird bei jedem Abruf
geprüft, sonst käme eine neue Version der App nie auf die Geräte.
"""

from pathlib import Path

from fastapi import FastAPI
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, Response
from starlette.routing import Route

from stowly.contract.api import ErrorCode
from stowly.errors import error_response

RESERVED_PREFIXES = ("api", "print")

# Nicht mimetypes: Unter Windows liest das Modul die Registry und liefert für .js
# mitunter text/plain. Dann lädt der Browser keine Module.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"

_NOT_BUILT = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Stowly</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5">
<h1>Stowly</h1>
<p>Der Server läuft, aber die Web-App ist noch nicht gebaut.</p>
<p>Im Ordner <code>web</code>: <code>npm ci</code>, dann <code>npm run build</code>.</p>
<p>Die Schnittstelle antwortet unter <a href="/api/health">/api/health</a>.</p>
</body></html>
"""


def _is_reserved(path: str) -> bool:
    first = path.split("/", 1)[0]
    return first in RESERVED_PREFIXES


def _resolve(web_dir: Path, path: str) -> Path | None:
    """Datei innerhalb von ``web_dir`` oder ``None``. Verhindert Ausbrüche über ``..``."""
    if not path:
        return None
    root = web_dir.resolve()
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def _file_response(path: Path, cache_control: str) -> Response:
    media_type = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": cache_control})


def install_web(app: FastAPI, web_dir: Path | None) -> None:
    """Hängt die Auslieferung der Web-App an. **Muss der letzte Schritt beim Aufbau der App sein:**
    Die Route fängt alle Pfade, die vor ihr niemand beantwortet hat.
    """

    async def serve(request: Request) -> Response:
        path = request.path_params.get("path", "")
        if _is_reserved(path):
            return error_response(404, ErrorCode.NOT_FOUND, "Nicht gefunden.")

        index = None if web_dir is None else web_dir / "index.html"
        if web_dir is None or index is None or not index.is_file():
            return HTMLResponse(_NOT_BUILT, status_code=503, headers={"Cache-Control": "no-store"})

        found = _resolve(web_dir, path)
        if found is not None:
            immutable = path.startswith("assets/")
            return _file_response(found, IMMUTABLE if immutable else REVALIDATE)

        # Fehlende Dateien mit Endung (Bilder, Skripte) sind ein echtes 404,
        # sonst bekäme der Browser HTML, wo er JavaScript erwartet.
        if Path(path).suffix and not path.endswith(".html"):
            return Response(status_code=404, headers={"Cache-Control": "no-store"})

        return _file_response(index, REVALIDATE)

    app.router.routes.append(
        Route("/{path:path}", endpoint=serve, methods=["GET", "HEAD"], include_in_schema=False)
    )
