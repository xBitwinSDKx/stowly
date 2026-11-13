"""Abhängigkeiten der Endpunkte: Einstellungen, Datenbankverbindung, angemeldetes Gerät.

Keine dieser Funktionen deklariert Parameter über ``Header()``, ``Query()`` oder ein
Sicherheitsschema: Das trüge sich in die Beschreibung der Schnittstelle ein, und die
ist Vertrag (``docs/openapi.json``). Kopfzeilen werden aus ``request.headers`` gelesen.
"""

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request

from stowly import auth, db
from stowly.config import Settings
from stowly.contract.api import ErrorCode
from stowly.errors import ApiError


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """Eine Verbindung je Anfrage. Schreibende Abläufe nutzen ``db.transaction(con)``."""
    con = db.connect(get_settings(request).database_path)
    try:
        yield con
    finally:
        con.close()


Db = Annotated[sqlite3.Connection, Depends(get_db)]


def unauthorized() -> ApiError:
    return ApiError(401, ErrorCode.UNAUTHORIZED, "Nicht angemeldet.", headers={"WWW-Authenticate": "Bearer"})


def current_device(request: Request, con: Db) -> sqlite3.Row:
    """Das Gerät hinter ``Authorization: Bearer <token>``.

    401 ``unauthorized``, wenn das Token fehlt, unbekannt oder gesperrt ist. Schützt
    alle Endpunkte außer Health, Anmeldung und Bildern.
    """
    token = auth.bearer_token(request.headers.get("authorization"))
    device = None if token is None else auth.device_for_token(con, token)
    if device is None:
        raise unauthorized()
    return device


CurrentDevice = Annotated[sqlite3.Row, Depends(current_device)]
