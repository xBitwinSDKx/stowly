"""Anmeldung mit dem Haushalts-Passwort (docs/sync-protokoll.md, „Anmeldung und Geräte-Token")."""

from fastapi import APIRouter, Request, Response

from stowly import auth, records
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import ErrorCode, LoginRequest, LoginResponse, PasswordChangeInput
from stowly.errors import ApiError

router = APIRouter(prefix="/auth", tags=["auth"])

FROM_ENVIRONMENT = "Das Passwort steht in der Umgebung (STOWLY_PASSWORD) und lässt sich nur dort ändern."
CHANGED_MEANWHILE = "Das Passwort wurde gerade auf einem anderen Gerät geändert. Bitte noch einmal versuchen."


def rate_limited(retry_after: int) -> ApiError:
    """429 der Bremse mit ``Retry-After``: gleich für Anmelden, erstes Passwort und Ändern."""
    return ApiError(
        429,
        ErrorCode.RATE_LIMITED,
        f"Zu viele Fehlversuche. Bitte in {retry_after} Sekunden erneut versuchen.",
        {"retry_after_s": retry_after},
        {"Retry-After": str(retry_after)},
    )


@router.post("/login", operation_id="login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, response: Response, con: Db) -> dict:
    """Ohne Anmeldung. Legt ein Gerät an und liefert dessen Token genau einmal."""
    check = auth.password_check(get_settings(request), con, body.password)
    if check is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, auth.NO_PASSWORD)

    guard: auth.LoginGuard = request.app.state.login_guard
    matched, retry_after = guard.attempt(check)
    if retry_after is not None:
        raise rate_limited(retry_after)
    if not matched:
        raise ApiError(401, ErrorCode.INVALID_PASSWORD, "Das Passwort stimmt nicht.")

    token, device = auth.create_device(con, body.device_name)
    response.headers["Cache-Control"] = "no-store"
    return {"token": token, "device": records.device(device, device["id"])}


@router.post("/logout", operation_id="logout", status_code=204)
def logout(device: CurrentDevice, con: Db) -> None:
    """Sperrt das Token des aufrufenden Geräts."""
    auth.revoke_device(con, device["id"], by=device["id"])


@router.post("/password", operation_id="change_password", status_code=204)
def change_password(device: CurrentDevice, body: PasswordChangeInput, request: Request, con: Db) -> None:
    """Ändert das Haushalts-Passwort; andere Geräte bleiben angemeldet.

    401 ``invalid_password``, wenn ``current_password`` nicht stimmt (zählt in der Bremse der
    Anmeldung; das Gerät bleibt angemeldet); 429 ``rate_limited`` mit ``Retry-After``; 409
    ``conflict``, wenn das Passwort aus STOWLY_PASSWORD kommt; 422 bei zu kurzem neuen Passwort.
    """
    settings = get_settings(request)
    if settings.password is not None:
        raise ApiError(409, ErrorCode.CONFLICT, FROM_ENVIRONMENT)
    stored = auth.stored_hash(con)
    if stored is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, auth.NO_PASSWORD)

    def check() -> bool:
        # Unter dem Lock der Bremse: Prüfen und neu Rechnen sind beides scrypt.
        if not auth.verify_password(body.current_password, stored):
            return False
        auth.replace_password(con, old=stored, new_password=body.new_password, device_id=device["id"])
        return True

    guard: auth.LoginGuard = request.app.state.login_guard
    try:
        matched, retry_after = guard.attempt(check)
    except auth.PasswordChanged:
        raise ApiError(409, ErrorCode.CONFLICT, CHANGED_MEANWHILE) from None
    if retry_after is not None:
        raise rate_limited(retry_after)
    if not matched:
        # invalid_password, nie unauthorized: Der Kern der App meldet das Gerät deshalb nicht ab.
        raise ApiError(401, ErrorCode.INVALID_PASSWORD, "Das bisherige Passwort stimmt nicht.")
