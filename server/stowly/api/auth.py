"""Anmeldung mit dem Haushalts-Passwort (docs/sync-protokoll.md, „Anmeldung und Geräte-Token")."""

from fastapi import APIRouter, Request, Response

from stowly import auth, records
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import ErrorCode, LoginRequest, LoginResponse
from stowly.errors import ApiError

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", operation_id="login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, response: Response, con: Db) -> dict:
    """Ohne Anmeldung. Legt ein Gerät an und liefert dessen Token genau einmal."""
    settings = get_settings(request)
    password = settings.password
    if password is None:
        raise ApiError(
            503,
            ErrorCode.NOT_CONFIGURED,
            "Auf dem Server ist kein Passwort gesetzt (STOWLY_PASSWORD). Anmelden ist nicht möglich.",
        )

    guard: auth.LoginGuard = request.app.state.login_guard
    matched, retry_after = guard.attempt(lambda: auth.password_matches(body.password, password))
    if retry_after is not None:
        raise ApiError(
            429,
            ErrorCode.RATE_LIMITED,
            f"Zu viele Fehlversuche. Bitte in {retry_after} Sekunden erneut versuchen.",
            {"retry_after_s": retry_after},
            {"Retry-After": str(retry_after)},
        )
    if not matched:
        raise ApiError(401, ErrorCode.INVALID_PASSWORD, "Das Passwort stimmt nicht.")

    token, device = auth.create_device(con, body.device_name)
    response.headers["Cache-Control"] = "no-store"
    return {"token": token, "device": records.device(device, device["id"])}


@router.post("/logout", operation_id="logout", status_code=204)
def logout(device: CurrentDevice, con: Db) -> None:
    """Sperrt das Token des aufrufenden Geräts."""
    auth.revoke_device(con, device["id"], by=device["id"])
