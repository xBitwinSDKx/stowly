"""Auslieferung der gebauten Web-App durch denselben Prozess wie die API.

* Vorhandene Dateien aus ``web_dir`` werden ausgeliefert.
* Jeder andere Pfad liefert ``index.html``: Die App hat eigene Routen (``/zonen``, ``/scan`` …).
* ``/api/…`` und ``/print/…`` gehören der Schnittstelle und landen nie bei der App.
* ``/favicon.ico`` fragt der Browser von sich aus ab, obwohl die Seite ihr Symbol nennt: Es
  kommt das Symbol der App (``icons/favicon-32.png``), sonst 204. Nie ``index.html``.
* Jede Antwort der Web-App trägt die Content-Security-Policy (``STOWLY_CSP``), auch Worker und
  Service Worker: Für sie gilt die Kopfzeile ihrer eigenen Datei.

Zwischenspeichern: Dateien unter ``/assets/`` tragen einen Hash im Namen und dürfen
ewig liegen. Alles andere (``index.html``, ``sw.js``, Manifest) wird bei jedem Abruf
geprüft, sonst käme eine neue Version der App nie auf die Geräte.
"""

from pathlib import Path

from fastapi import FastAPI
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, Response
from starlette.routing import Match, Route

from stowly.contract.api import ErrorCode
from stowly.errors import error_response

RESERVED_PREFIXES = ("api", "print")
ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

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
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
}

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"
# Was auf /favicon.ico antwortet, in dieser Reihenfolge; sonst 204.
FAVICON_FILES = ("favicon.ico", "icons/favicon-32.png")

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


def _method_not_allowed(allowed: list[str]) -> Response:
    return error_response(
        405,
        ErrorCode.INVALID_REQUEST,
        "Diese Methode ist hier nicht erlaubt.",
        headers={"Allow": ", ".join(allowed)},
    )


def _favicon(web_dir: Path | None) -> Response:
    """Das Symbol der App für Browser, die von sich aus ``/favicon.ico`` abfragen; sonst 204."""
    if web_dir is not None:
        for name in FAVICON_FILES:
            found = _resolve(web_dir, name)
            if found is not None:
                return _file_response(found, REVALIDATE)
    return Response(status_code=204, headers={"Cache-Control": REVALIDATE})


def install_web(app: FastAPI, web_dir: Path | None, *, csp: str | None = None) -> None:
    """Hängt die Auslieferung der Web-App an. **Muss der letzte Schritt beim Aufbau der App sein:**
    Die Route fängt alle Pfade, die vor ihr niemand beantwortet hat.

    Sie fängt jede Methode: Unbekannte Pfade unter ``/api`` und ``/print`` antworten so immer
    mit 404 im Fehlerformat, nicht nur bei GET. Die Web-App selbst kennt nur GET und HEAD.
    ``csp`` ist die Content-Security-Policy jeder Antwort der Web-App (``None`` = keine).
    """

    def methods_of_known_path(request: Request) -> list[str]:
        """Die erlaubten Methoden, falls es den Pfad gibt und nur die Methode nicht passt.

        Gefragt wird jede Route davor, ob sie den Pfad mit einer anderen Methode nähme.
        Das braucht nur ``matches`` und hängt nicht davon ab, wie FastAPI eingebundene
        Router intern ablegt.
        """
        others = [route for route in app.router.routes if route is not catch_all]
        allowed = []
        for method in ALL_METHODS:
            scope = {**request.scope, "method": method}
            if any(route.matches(scope)[0] == Match.FULL for route in others):
                allowed.append(method)
        return sorted(allowed)

    async def serve(request: Request) -> Response:
        path = request.path_params.get("path", "")
        if _is_reserved(path):
            allowed = methods_of_known_path(request)
            if allowed:
                return _method_not_allowed(allowed)
            return error_response(404, ErrorCode.NOT_FOUND, "Nicht gefunden.")
        response = serve_app(request, path)
        if csp is not None:
            response.headers["Content-Security-Policy"] = csp
        return response

    def serve_app(request: Request, path: str) -> Response:
        if request.method not in ("GET", "HEAD"):
            return _method_not_allowed(["GET", "HEAD"])
        if path == "favicon.ico":
            return _favicon(web_dir)

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

    catch_all = Route("/{path:path}", endpoint=serve, methods=ALL_METHODS, include_in_schema=False)
    app.router.routes.append(catch_all)
