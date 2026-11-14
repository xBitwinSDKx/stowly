"""HTTP-Schnittstelle unter ``/api``.

Pfade, Methoden, Parameter und Modelle sind durch ``docs/openapi.json`` festgelegt
(Vertrag). Die Funktionen in diesem Paket dürfen beliebig umgebaut werden, solange
``tests/test_contract.py`` grün bleibt.
"""

from fastapi import APIRouter

from stowly.api import auth, backup, devices, events, images, lookup, sync, system

router = APIRouter()
router.include_router(system.router)
router.include_router(auth.router)
router.include_router(devices.router)
router.include_router(sync.router)
router.include_router(lookup.router)
router.include_router(images.router)
router.include_router(backup.router)
router.include_router(events.router)

__all__ = ["router"]
