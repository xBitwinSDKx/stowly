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
    PrinterInfo,
    PrintOutcome,
    to_dict,
)

__version__ = "0.1.0"

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
    "PrinterInfo",
    "__version__",
    "to_dict",
]
