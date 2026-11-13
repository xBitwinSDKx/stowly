"""Manuelle Sicherung: vollständige Kopie der Datenbank als Download."""

from fastapi import APIRouter, Response

from stowly.errors import not_implemented

router = APIRouter(tags=["backup"])

_BACKUP_RESPONSES = {200: {"content": {"application/vnd.sqlite3": {}}}}


@router.get("/backup", operation_id="download_backup", response_class=Response, responses=_BACKUP_RESPONSES)
def download_backup() -> Response:
    """Liefert eine konsistente Kopie (``sqlite3.Connection.backup``) als Datei-Download.

    Die Kopie bekommt eine neue ``dataset_id``: Wird sie später eingespielt, holen
    alle Geräte den Bestand vollständig neu, statt mit einem veralteten Cursor zu arbeiten.
    """
    raise not_implemented("Die Sicherung")
