"""HTTP-Schnittstelle unter ``/api``.

Pfade, Methoden, Parameter und Modelle sind durch ``docs/openapi.json`` festgelegt
(Vertrag). Die Funktionen in diesem Paket dürfen beliebig umgebaut werden, solange
``tests/test_contract.py`` grün bleibt.
"""

from fastapi import APIRouter

from stowly.api import (
    auth,
    backup,
    devices,
    events,
    ha,
    images,
    integrations,
    lookup,
    pi,
    push,
    serverconfig,
    setup,
    stats,
    sync,
    system,
    update,
)

router = APIRouter()
router.include_router(system.router)
router.include_router(auth.router)
router.include_router(devices.router)
router.include_router(sync.router)
router.include_router(lookup.router)
router.include_router(images.router)
router.include_router(backup.router)
router.include_router(events.router)
router.include_router(stats.router)
router.include_router(push.router)
router.include_router(integrations.router)
router.include_router(ha.router)
router.include_router(update.router)
# Einrichtung: erstes Passwort, HTTPS, Einstellungen des Servers, Pi koppeln
router.include_router(setup.router)
router.include_router(serverconfig.router)
router.include_router(pi.router)

__all__ = ["router"]
