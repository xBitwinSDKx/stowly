"""Angemeldete Geräte anzeigen, umbenennen und einzeln sperren."""

from fastapi import APIRouter

from stowly.contract.api import Device, DeviceList, DeviceUpdate
from stowly.errors import not_implemented

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("", operation_id="list_devices", response_model=DeviceList)
def list_devices() -> DeviceList:
    raise not_implemented("Die Geräteliste")


@router.patch("/{device_id}", operation_id="update_device", response_model=Device)
def update_device(device_id: str, body: DeviceUpdate) -> Device:
    raise not_implemented("Das Umbenennen eines Geräts")


@router.delete("/{device_id}", operation_id="revoke_device", status_code=204)
def revoke_device(device_id: str) -> None:
    """Sperrt das Token dieses Geräts. Ein Gerät darf auch sich selbst sperren."""
    raise not_implemented("Das Sperren eines Geräts")
