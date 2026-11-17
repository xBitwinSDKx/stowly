"""Einheitliches Fehlerformat der HTTP-Schnittstelle (docs/sync-protokoll.md, „Fehlerformat").

Jede Fehlerantwort unter ``/api`` hat den Rumpf ``{"error": {"code", "message", "details"}}``.
Im Code genügt ``raise ApiError(status, ErrorCode.X, "deutsche Meldung")``.
"""

import json
import logging
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from stowly.contract.api import ErrorCode

log = logging.getLogger("stowly")

_STATUS_CODES: dict[int, ErrorCode] = {
    400: ErrorCode.INVALID_REQUEST,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.UNAUTHORIZED,
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.INVALID_REQUEST,
    409: ErrorCode.CONFLICT,
    413: ErrorCode.PAYLOAD_TOO_LARGE,
    422: ErrorCode.INVALID_REQUEST,
    429: ErrorCode.RATE_LIMITED,
    501: ErrorCode.NOT_IMPLEMENTED,
}

_STATUS_MESSAGES: dict[int, str] = {
    401: "Nicht angemeldet.",
    403: "Nicht erlaubt.",
    404: "Nicht gefunden.",
    405: "Diese Methode ist hier nicht erlaubt.",
    413: "Die Anfrage ist zu groß.",
    429: "Zu viele Anfragen.",
}

# Unter diesen Pfaden trägt jede Antwort ``Cache-Control: no-store``, auch jeder Fehler (KI-Vorschläge,
# docs/plan-0.6.md 2.3): ``app.NoStore`` setzt den Kopf, den 500 setzt der Handler unten selbst, denn den
# schickt Starlette außerhalb jeder Middleware.
NO_STORE_PATHS = ("/api/server-config/ai", "/api/cook")


def no_store(path: str) -> bool:
    """Gehört die Antwort auf ``path`` zu ``NO_STORE_PATHS`` (der Pfad selbst oder darunter)?"""
    return any(path == prefix or path.startswith(prefix + "/") for prefix in NO_STORE_PATHS)


class ApiError(Exception):
    """Fehler, der als Antwort im Vertragsformat beim Aufrufer ankommt."""

    def __init__(
        self,
        status: int,
        code: ErrorCode,
        message: str,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def error_response(
    status: int,
    code: ErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    body = {"error": {"code": code.value, "message": message, "details": details}}
    # Als reines ASCII (Umlaute als \uXXXX): Die Einzelheiten zitieren Eingaben, und die können
    # halbe Zeichen enthalten, die sich als UTF-8 nicht senden ließen. Ein Fehler beim
    # Melden eines Fehlers wäre ein 500 ohne Fehlerformat.
    content = json.dumps(body, ensure_ascii=True, separators=(",", ":"), default=str)
    return Response(content, status_code=status, headers=headers, media_type="application/json")


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> Response:
        return error_response(exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> Response:
        problems = [
            {
                "loc": [str(part) for part in error.get("loc", ())],
                "msg": str(error.get("msg", "")),
                "type": str(error.get("type", "")),
            }
            for error in exc.errors()
        ]
        return error_response(
            422, ErrorCode.INVALID_REQUEST, "Die Anfrage entspricht nicht dem Vertrag.", {"errors": problems}
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> Response:
        code = _STATUS_CODES.get(exc.status_code, ErrorCode.INTERNAL)
        message = _STATUS_MESSAGES.get(exc.status_code) or str(exc.detail)
        return error_response(exc.status_code, code, message, None, getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> Response:
        log.exception("Unerwarteter Fehler", exc_info=exc)
        headers = {"Cache-Control": "no-store"} if no_store(request.scope.get("path", "")) else None
        return error_response(500, ErrorCode.INTERNAL, "Interner Fehler des Servers.", headers=headers)
