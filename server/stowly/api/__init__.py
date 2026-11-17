"""HTTP-Schnittstelle unter ``/api``.

Pfade, Methoden, Parameter und Modelle sind durch ``docs/openapi.json`` festgelegt
(Vertrag). Die Funktionen in diesem Paket dürfen beliebig umgebaut werden, solange
``tests/test_contract.py`` grün bleibt.
"""

from fastapi import APIRouter

from stowly.api import (
    aiconfig,
    auth,
    backup,
    cook,
    devices,
    events,
    ha,
    haconfig,
    images,
    integrations,
    labels,
    lookup,
    pi,
    products,
    push,
    restore,
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
# Stufe B: Home Assistant aus der App, Zurückspielen einer Sicherung
router.include_router(haconfig.router)
router.include_router(restore.router)
# 0.5.0: Etiketten gestalten, Produktbild setzen
router.include_router(labels.router)
router.include_router(products.router)
# 0.6.0: Was koche ich? (KI-Vorschläge einrichten und abfragen)
router.include_router(aiconfig.router)
router.include_router(cook.router)

__all__ = ["router"]
