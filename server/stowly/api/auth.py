"""Anmeldung mit dem Haushalts-Passwort (docs/sync-protokoll.md, „Anmeldung und Geräte-Token")."""

from fastapi import APIRouter

from stowly.contract.api import LoginRequest, LoginResponse
from stowly.errors import not_implemented

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", operation_id="login", response_model=LoginResponse)
def login(body: LoginRequest) -> LoginResponse:
    """Ohne Anmeldung. Legt ein Gerät an und liefert dessen Token genau einmal."""
    raise not_implemented("Die Anmeldung")


@router.post("/logout", operation_id="logout", status_code=204)
def logout() -> None:
    """Sperrt das Token des aufrufenden Geräts."""
    raise not_implemented("Die Abmeldung")
