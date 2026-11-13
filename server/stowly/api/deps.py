"""Abhängigkeiten der Endpunkte: Einstellungen und Datenbankverbindung."""

import sqlite3
from collections.abc import Iterator

from fastapi import Request

from stowly import db
from stowly.config import Settings


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """Eine Verbindung je Anfrage. Schreibende Abläufe nutzen ``db.transaction(con)``."""
    con = db.connect(get_settings(request).database_path)
    try:
        yield con
    finally:
        con.close()
