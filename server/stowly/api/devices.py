"""Angemeldete Geräte anzeigen, umbenennen und einzeln sperren.

Jedes angemeldete Gerät darf jedes Gerät umbenennen und sperren, auch sich selbst.
"""

from fastapi import APIRouter, Response

from stowly import auth, records
from stowly.api.deps import CurrentDevice, Db
from stowly.contract.api import Device, DeviceList, DeviceUpdate, ErrorCode
from stowly.errors import ApiError

router = APIRouter(prefix="/devices", tags=["devices"])


def _unknown_device() -> ApiError:
    return ApiError(404, ErrorCode.NOT_FOUND, "Das Gerät gibt es nicht.")


@router.get("", operation_id="list_devices", response_model=DeviceList)
def list_devices(response: Response, device: CurrentDevice, con: Db) -> dict:
    # Kein Docstring: Er stünde als Beschreibung im Vertrag (docs/openapi.json).
    # Alle Geräte, auch gesperrte; das eigene mit current: true.
    rows = con.execute("SELECT * FROM devices ORDER BY created_at, id").fetchall()
    response.headers["Cache-Control"] = "no-store"
    return {"devices": [records.device(row, device["id"]) for row in rows]}


@router.patch("/{device_id}", operation_id="update_device", response_model=Device)
def update_device(device_id: str, body: DeviceUpdate, device: CurrentDevice, con: Db) -> dict:
    renamed = auth.rename_device(con, device_id, body.name, by=device["id"])
    if renamed is None:
        raise _unknown_device()
    return records.device(renamed, device["id"])


@router.delete("/{device_id}", operation_id="revoke_device", status_code=204)
def revoke_device(device_id: str, device: CurrentDevice, con: Db) -> None:
    """Sperrt das Token dieses Geräts. Ein Gerät darf auch sich selbst sperren."""
    if not auth.revoke_device(con, device_id, by=device["id"]):
        raise _unknown_device()
