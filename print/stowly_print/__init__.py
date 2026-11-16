"""Stowly-Druckdienst.

Dieses Paket läuft an zwei Stellen mit derselben Schnittstelle: eingebunden im
Stowly-Server (Drucker im Heimnetz) und eigenständig auf dem Raspberry Pi im
Keller. Es darf deshalb weder FastAPI noch pydantic voraussetzen und muss unter
Python 3.12 und 3.13 laufen (docs/recherche.md, Abschnitt 6).

Verbindlich beschrieben in docs/etiketten.md.
"""

from stowly_print.model import (
    APP_NAME,
    FINAL_STATES,
    PROTOCOL_VERSION,
    Capabilities,
    DriverStatus,
    Health,
    HostHealth,
    Job,
    JobError,
    JobRequest,
    JobState,
    Media,
    PrinterError,
    PrinterInfo,
    PrintOutcome,
    ServiceError,
    to_dict,
)

# Setzt scripts/release.py zusammen mit den anderen Versionsnummern; der Pi schickt sie beim Koppeln mit.
__version__ = "0.3.1"

__all__ = [
    "APP_NAME",
    "FINAL_STATES",
    "PROTOCOL_VERSION",
    "Capabilities",
    "DriverStatus",
    "Health",
    "HostHealth",
    "Job",
    "JobError",
    "JobRequest",
    "JobState",
    "Media",
    "PrintOutcome",
    "PrinterError",
    "PrinterInfo",
    "ServiceError",
    "__version__",
    "to_dict",
]
