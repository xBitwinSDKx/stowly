"""Benachrichtigungen per Web-Push (docs/integrationen.md, Abschnitt 4).

Alles mit Geräte-Token. Ein Gerät hat höchstens ein Abo; es gehört zum Gerät und endet mit
dessen Abmeldung. Ohne ``STOWLY_PUSH_CONTACT`` antworten alle Aufrufe mit 503 ``not_configured``.
"""

from fastapi import APIRouter

from stowly.api.deps import CurrentDevice
from stowly.contract.api import ErrorCode, PushKey, PushSubscriptionInput, PushTestResult
from stowly.errors import ApiError

router = APIRouter(prefix="/push", tags=["push"])


def _later(what: str) -> ApiError:
    return ApiError(501, ErrorCode.NOT_IMPLEMENTED, f"{what} ist noch nicht umgesetzt.")


@router.get("/key", operation_id="get_push_key", response_model=PushKey)
def get_push_key(_device: CurrentDevice) -> PushKey:
    """Der öffentliche VAPID-Schlüssel des Servers für pushManager.subscribe."""
    raise _later("Push")


@router.put("/subscription", operation_id="put_push_subscription", status_code=204)
def put_push_subscription(body: PushSubscriptionInput, _device: CurrentDevice) -> None:
    """Legt das Push-Abo dieses Geräts an oder ersetzt es. Unbekannter Push-Dienst: 422."""
    raise _later("Push")


@router.delete("/subscription", operation_id="delete_push_subscription", status_code=204)
def delete_push_subscription(_device: CurrentDevice) -> None:
    """Löscht das Push-Abo dieses Geräts. Wiederholbar, auch ohne Abo."""
    raise _later("Push")


@router.post("/test", operation_id="send_push_test", response_model=PushTestResult)
def send_push_test(_device: CurrentDevice) -> PushTestResult:
    """Schickt eine Testnachricht an dieses Gerät und meldet, was der Push-Dienst geantwortet hat.

    404 ohne Abo dieses Geräts, 429 bei mehr als einer Testnachricht in 10 Sekunden.
    """
    raise _later("Push")
