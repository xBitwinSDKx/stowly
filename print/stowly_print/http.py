"""HTTP-Schicht des Druckdienstes (docs/etiketten.md, 5.1 bis 5.7).

Eine Starlette-App, die sich in den Stowly-Server einbinden und auf dem Raspberry Pi
eigenständig starten lässt. Verwendet wird nur, was es in Starlette 0.46 (Raspberry Pi OS)
und in Starlette 1.x (Server) gleichermaßen gibt.

* Der Rumpf wird immer als JSON gelesen, gleich welcher ``Content-Type`` gesetzt ist: So kommt
  ein Browser ohne CORS-Vorabanfrage aus (``POST`` mit ``text/plain``).
* Das Token steht im Kopf (``Authorization: Bearer``) oder im Rumpf (``"token"``). Wer es
  prüft, ist austauschbar: am Pi ein festes Token, am Server das Geräte-Token.
* Fehler haben immer den Rumpf ``{"error": {"code", "message", "details"}}``.
* Seit 0.5.0 nennt ``/v1/health`` die Formate der Vorlage, die der Dienst rendert
  (``template_schemas``), und je Drucker die eingelegte Rolle (``loaded``); ``?media=<Papier>``
  vergleicht die Rolle mit diesem Papier. ``/v1/render`` liefert das Etikett in der Größe des
  Papiers der Vorlage, so wie man es liest. Protokoll 1 bleibt: Es kommt nur etwas hinzu.
"""

import base64
import hashlib
import hmac
import json
import logging
import re
from collections.abc import Callable, Sequence
from importlib import resources
from typing import Any, Protocol

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from stowly_print import __version__
from stowly_print.model import (
    APP_NAME,
    MAX_PNG_BYTES,
    PROTOCOL_VERSION,
    TEMPLATE_SCHEMAS,
    Health,
    HostHealth,
    JobRequest,
    ServiceError,
    to_dict,
)
from stowly_print.service import PrintService, ServiceFault

log = logging.getLogger("stowly_print.http")

# Ein PNG-Auftrag ist höchstens MAX_PNG_BYTES groß, als Base64 ein Drittel mehr; dazu Vorlage und Daten.
MAX_BODY_BYTES = MAX_PNG_BYTES * 4 // 3 + 64 * 1024
MAX_WAIT_S = 30.0
NONCE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS"
ALLOW_HEADERS = "authorization, content-type"
PREFLIGHT_MAX_AGE = "7200"
NO_STORE = {"Cache-Control": "no-store"}


class Authorizer(Protocol):
    """Entscheidet, ob ein Aufruf erlaubt ist."""

    def __call__(self, token: str | None, *, write: bool) -> str | None:
        """Prüft das Token. Wirft ``ServiceFault`` (``unauthorized``), wenn der Aufruf nicht erlaubt ist.

        Liefert den Schlüssel für den Nachweis in ``/v1/health`` (``proof``) oder ``None``.
        """
        ...


class TokenAuthorizer:
    """Ein festes Token (Raspberry Pi): Lesen ist offen, Schreiben braucht das Token."""

    def __init__(self, token: str) -> None:
        if not token:
            raise ValueError("Das Token des Druckdienstes darf nicht leer sein.")
        self._token = token.encode("utf-8")
        self._proof_key = token

    def __call__(self, token: str | None, *, write: bool) -> str | None:
        if write:
            # Vergleich in konstanter Zeit: Die Dauer verrät nichts über das richtige Token.
            given = b"" if token is None else token.encode("utf-8")
            if not hmac.compare_digest(given, self._token):
                raise unauthorized()
        return self._proof_key


def unauthorized() -> ServiceFault:
    return ServiceFault(ServiceError.UNAUTHORIZED, "Das Token fehlt oder ist falsch.")


def invalid(message: str, details: dict[str, Any] | None = None) -> ServiceFault:
    return ServiceFault(ServiceError.INVALID_REQUEST, message, details)


def json_response(payload: Any, status: int = 200, headers: dict[str, str] | None = None) -> Response:
    # Reines ASCII: Fehlermeldungen zitieren Eingaben, und die können halbe Zeichen enthalten.
    content = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str)
    return Response(
        content, status_code=status, media_type="application/json", headers={**NO_STORE, **(headers or {})}
    )


def error_response(
    status: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    return json_response({"error": {"code": code, "message": message, "details": details}}, status, headers)


def fault_response(fault: ServiceFault) -> Response:
    headers = {"WWW-Authenticate": "Bearer"} if fault.code == ServiceError.UNAUTHORIZED else None
    return error_response(fault.status, fault.code.value, fault.message, fault.details, headers)


def bearer_token(header: str | None) -> str | None:
    """Das Token aus ``Authorization: Bearer <token>``; ``None``, wenn der Kopf fehlt oder anders lautet."""
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    value = value.strip()
    return value if scheme.lower() == "bearer" and value else None


def page_html() -> str:
    """Die Seite ``/p``: eine einzelne HTML-Datei ohne fremde Dateien (docs/etiketten.md, 5.7)."""
    return resources.files("stowly_print").joinpath("pages").joinpath("p.html").read_text(encoding="utf-8")


def _inline_hash(html: str, tag: str) -> str:
    """Quelle für die Content-Security-Policy: Hash des einen eingebetteten Skripts oder Stils."""
    blocks = re.findall(rf"<{tag}>(.*?)</{tag}>", html, flags=re.S)
    if len(blocks) != 1:
        return "'unsafe-inline'"
    digest = hashlib.sha256(blocks[0].encode("utf-8")).digest()
    return f"'sha256-{base64.b64encode(digest).decode('ascii')}'"


def page_headers(html: str) -> dict[str, str]:
    """Die Seite darf nur ihr eigenes Skript ausführen und nur ihren eigenen Ursprung ansprechen."""
    policy = (
        "default-src 'none'; "
        f"script-src {_inline_hash(html, 'script')}; "
        f"style-src {_inline_hash(html, 'style')}; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    return {
        "Content-Security-Policy": policy,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
    }


def normalise_origin(origin: str) -> str:
    """Ein Ursprung, wie ihn der Browser schickt: Schema, Rechner, Port, klein und ohne Schrägstrich."""
    return origin.strip().rstrip("/").lower()


class Cors:
    """CORS für den Direktdruck aus dem Browser (docs/etiketten.md, 5.2).

    * ``Access-Control-Allow-Origin`` genau für die konfigurierten Ursprünge, dazu ``Vary: Origin``.
    * Vorabanfragen (``OPTIONS``) werden hier beantwortet, mit ``Access-Control-Allow-Private-Network``.
    * Eine Anfrage ohne ``Origin`` oder von einem fremden Ursprung wird ganz normal bedient; nur
      darf ein fremder Ursprung die Antwort im Browser nicht lesen. Schreiben kann er ohnehin nicht:
      Dafür braucht es das Token.
    """

    def __init__(self, app: ASGIApp, origins: Sequence[str]) -> None:
        self.app = app
        self.origins = frozenset(normalise_origin(origin) for origin in origins if origin.strip())

    def allowed(self, origin: str | None) -> bool:
        return origin is not None and normalise_origin(origin) in self.origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_headers = {name: value for name, value in scope.get("headers", ())}
        raw_origin = request_headers.get(b"origin")
        origin = None if raw_origin is None else raw_origin.decode("latin-1")
        allow_origin = (
            [(b"access-control-allow-origin", raw_origin)] if self.allowed(origin) and raw_origin else []
        )

        if scope["method"] == "OPTIONS":
            # Die Vorabanfrage des Browsers. Für einen fremden Ursprung fehlen die Erlaubnisse:
            # Der Browser schickt die eigentliche Anfrage dann gar nicht erst.
            headers = [
                (
                    b"vary",
                    b"Origin, Access-Control-Request-Method, Access-Control-Request-Headers, "
                    b"Access-Control-Request-Private-Network",
                ),
                (b"allow", ALLOW_METHODS.encode()),
                (b"content-length", b"0"),
            ]
            if allow_origin:
                headers += [
                    *allow_origin,
                    (b"access-control-allow-methods", ALLOW_METHODS.encode()),
                    (b"access-control-allow-headers", ALLOW_HEADERS.encode()),
                    (b"access-control-max-age", PREFLIGHT_MAX_AGE.encode()),
                    (b"access-control-allow-private-network", b"true"),
                ]
            await send({"type": "http.response.start", "status": 204, "headers": headers})
            await send({"type": "http.response.body", "body": b""})
            return

        extra = [(b"vary", b"Origin"), *allow_origin]

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", ()), *extra]}
            await send(message)

        await self.app(scope, receive, send_with_cors)


def create_app(
    service: PrintService,
    *,
    authorize: Authorizer,
    origins: Sequence[str] = (),
    standalone: bool = False,
    host_health: Callable[[], HostHealth | None] | None = None,
) -> ASGIApp:
    """Baut die HTTP-Schnittstelle zu einem laufenden ``PrintService``.

    ``standalone`` (Raspberry Pi): mit CORS für ``origins`` und mit der Seite ``/p``.
    Eingebunden im Server gibt es beides nicht; ``authorize`` prüft dort das Geräte-Token.
    ``host_health`` liefert den Zustand des Rechners für ``/v1/health``; ohne ist ``host`` null.
    """

    async def read_body(request: Request) -> tuple[dict[str, Any], ServiceFault | None]:
        """Der Rumpf als JSON-Objekt, gleich welcher ``Content-Type``. Ein leerer Rumpf ist ``{}``.

        Ein zu großer Rumpf wird sofort abgewiesen. Ein unlesbarer liefert ``({}, fehler)``: Den
        Fehler meldet der Aufruf erst nach der Anmeldung, damit ein Aufrufer ohne Token nur
        „unauthorized" erfährt. Das Token kann dann nur noch im Kopf stehen.
        """
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise invalid("Der Auftrag ist zu groß.", {"max_bytes": MAX_BODY_BYTES})
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                raise invalid("Der Auftrag ist zu groß.", {"max_bytes": MAX_BODY_BYTES})
            chunks.append(chunk)
        raw = b"".join(chunks)
        if not raw.strip():
            return {}, None
        try:
            body = json.loads(raw)
        except RecursionError:
            return {}, invalid("Der Rumpf ist zu tief verschachtelt.")
        except ValueError:  # auch UnicodeDecodeError
            return {}, invalid("Der Rumpf ist kein gültiges JSON.")
        if not isinstance(body, dict):
            return {}, invalid("Der Rumpf muss ein JSON-Objekt sein.")
        return body, None

    def token_of(request: Request, body: dict[str, Any] | None = None) -> str | None:
        token = bearer_token(request.headers.get("authorization"))
        if token is None and body is not None:
            candidate = body.get("token")
            if isinstance(candidate, str) and candidate:
                token = candidate
        return token

    def wait_of(request: Request) -> float:
        raw = request.query_params.get("wait")
        if raw is None or raw == "":
            return 0.0
        try:
            value = float(raw)
        except ValueError as exc:
            raise invalid("'wait' muss eine Zahl von 0 bis 30 sein.") from exc
        if not 0 <= value <= MAX_WAIT_S:  # schließt auch nan aus
            raise invalid("'wait' muss eine Zahl von 0 bis 30 sein.")
        return value

    def job_id_of(request: Request) -> str:
        return str(request.path_params["job_id"])

    def job_response(job: Any, status: int = 200) -> Response:
        return json_response(to_dict(job), status)

    # --- Aufrufe ---------------------------------------------------------------------
    # Jeder Aufruf prüft zuerst die Anmeldung (am Server braucht jeder ein Token), dann die Angaben.

    async def health(request: Request) -> Response:
        nonce = request.query_params.get("nonce")
        # Seit 0.5.0: das Papier des Haushalts. Die eingelegte Rolle wird damit verglichen statt mit
        # der Konfiguration. Eine Kennung, die der Katalog nicht kennt, zählt wie keine (kein 400):
        # Eine neuere App kann ein Papier kennen, das dieser Dienst noch nicht hat.
        paper = request.query_params.get("media")

        def build() -> Health:
            key = authorize(token_of(request), write=False)
            if nonce is not None and not NONCE.fullmatch(nonce):
                raise invalid("'nonce' muss aus 16 bis 64 Zeichen A–Z, a–z, 0–9, _ und - bestehen.")
            proof = None
            if nonce is not None and key:
                proof = hmac.new(key.encode("utf-8"), nonce.encode("ascii"), hashlib.sha256).hexdigest()
            return Health(
                app=APP_NAME,
                version=__version__,
                protocol=PROTOCOL_VERSION,
                boot_id=service.boot_id,
                uptime_s=round(service.uptime_s, 3),
                proof=proof,
                host=None if host_health is None else host_health(),
                printers=service.printers(paper=paper),
                template_schemas=list(TEMPLATE_SCHEMAS),
            )

        return json_response(to_dict(await run_in_threadpool(build)))

    async def printers(request: Request) -> Response:
        def build() -> dict[str, Any]:
            authorize(token_of(request), write=False)
            return {"printers": to_dict(service.printers())}

        return json_response(await run_in_threadpool(build))

    async def submit(request: Request) -> Response:
        body, unreadable = await read_body(request)
        job_id = job_id_of(request)

        def run() -> tuple[Any, bool]:
            authorize(token_of(request, body), write=True)
            if unreadable is not None:
                raise unreadable
            wait = wait_of(request)
            if not JOB_ID.fullmatch(job_id):
                raise invalid("Die Kennung des Auftrags darf nur aus A–Z, a–z, 0–9, _ und - bestehen.")
            try:
                job_request = JobRequest.from_dict(body)
            except ValueError as exc:
                raise invalid(str(exc)) from exc
            job, created = service.submit(job_id, job_request)
            if wait > 0:
                job = service.wait(job_id, wait)
            return job, created

        job, created = await run_in_threadpool(run)
        return job_response(job, 201 if created else 200)

    async def job_status(request: Request) -> Response:
        job_id = job_id_of(request)

        def run() -> Any:
            authorize(token_of(request), write=False)
            wait = wait_of(request)
            return service.wait(job_id, wait) if wait > 0 else service.get(job_id)

        return job_response(await run_in_threadpool(run))

    async def cancel(request: Request) -> Response:
        body, unreadable = await read_body(request)
        job_id = job_id_of(request)

        def run() -> Any:
            authorize(token_of(request, body), write=True)
            if unreadable is not None:
                raise unreadable
            return service.cancel(job_id)

        return job_response(await run_in_threadpool(run))

    async def render(request: Request) -> Response:
        body, unreadable = await read_body(request)

        def run() -> bytes:
            authorize(token_of(request, body), write=True)
            if unreadable is not None:
                raise unreadable
            try:
                job_request = JobRequest.from_dict(
                    {
                        "template": body.get("template"),
                        "data": body.get("data"),
                        "printer": body.get("printer"),
                    }
                )
            except ValueError as exc:
                raise invalid(str(exc)) from exc
            return service.render(job_request.template, job_request.data, job_request.printer)

        png = await run_in_threadpool(run)
        return Response(png, media_type="image/png", headers=NO_STORE)

    async def job_image(request: Request) -> Response:
        job_id = job_id_of(request)

        def run() -> bytes:
            authorize(token_of(request), write=False)
            path = service.image_path(job_id)
            if path is None:
                raise ServiceFault(ServiceError.NOT_FOUND, "Zu diesem Auftrag gibt es kein Bild.")
            try:
                return path.read_bytes()
            except OSError as exc:
                raise ServiceFault(ServiceError.NOT_FOUND, "Zu diesem Auftrag gibt es kein Bild.") from exc

        png = await run_in_threadpool(run)
        return Response(png, media_type="image/png", headers=NO_STORE)

    html = page_html() if standalone else ""
    html_headers = page_headers(html) if standalone else {}

    async def page(_request: Request) -> Response:
        return Response(html, media_type="text/html; charset=utf-8", headers=html_headers)

    # --- Fehler ----------------------------------------------------------------------

    async def on_fault(_request: Request, exc: Exception) -> Response:
        assert isinstance(exc, ServiceFault)
        return fault_response(exc)

    async def on_http_error(_request: Request, exc: Exception) -> Response:
        assert isinstance(exc, HTTPException)
        headers = getattr(exc, "headers", None)
        if exc.status_code == 404:
            return error_response(404, ServiceError.NOT_FOUND.value, "Nicht gefunden.", None, headers)
        if exc.status_code == 405:
            message = "Diese Methode ist hier nicht erlaubt."
            return error_response(405, ServiceError.INVALID_REQUEST.value, message, None, headers)
        return error_response(
            exc.status_code, ServiceError.INVALID_REQUEST.value, str(exc.detail), None, headers
        )

    async def on_unexpected(_request: Request, exc: Exception) -> Response:
        log.error("Unerwarteter Fehler im Druckdienst", exc_info=exc)
        return error_response(500, "internal", "Interner Fehler des Druckdienstes.")

    async def job(request: Request) -> Response:
        """Ein Pfad, drei Bedeutungen: einreichen (POST, PUT), abfragen (GET), verwerfen (DELETE)."""
        if request.method in ("POST", "PUT"):
            return await submit(request)
        if request.method == "DELETE":
            return await cancel(request)
        return await job_status(request)

    routes = [
        Route("/v1/health", health, methods=["GET"]),
        Route("/v1/printers", printers, methods=["GET"]),
        Route("/v1/render", render, methods=["POST"]),
        Route("/v1/jobs/{job_id}/cancel", cancel, methods=["POST"]),
        Route("/v1/jobs/{job_id}/image", job_image, methods=["GET"]),
        Route("/v1/jobs/{job_id}", job, methods=["GET", "POST", "PUT", "DELETE"]),
    ]
    if standalone:
        routes.append(Route("/p", page, methods=["GET"]))
    app: ASGIApp = Starlette(
        routes=routes,
        exception_handlers={ServiceFault: on_fault, HTTPException: on_http_error, Exception: on_unexpected},
    )
    return Cors(app, origins) if standalone else app
