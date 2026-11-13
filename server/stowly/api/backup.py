"""Manuelle Sicherung: vollständige Kopie der Datenbank als Download."""

from datetime import datetime

from fastapi import APIRouter, Request, Response
from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from stowly import backup
from stowly.api.deps import CurrentDevice, get_settings

router = APIRouter(tags=["backup"])

_BACKUP_RESPONSES = {200: {"content": {"application/vnd.sqlite3": {}}}}

MEDIA_TYPE = "application/vnd.sqlite3"


@router.get("/backup", operation_id="download_backup", response_class=Response, responses=_BACKUP_RESPONSES)
def download_backup(request: Request, _device: CurrentDevice) -> Response:
    """Liefert eine konsistente Kopie (``sqlite3.Connection.backup``) als Datei-Download.

    Die Kopie bekommt eine neue ``dataset_id``: Wird sie später eingespielt, holen
    alle Geräte den Bestand vollständig neu, statt mit einem veralteten Cursor zu arbeiten.
    """
    path = backup.create(get_settings(request).database_path)
    # Tag in der Zeitzone des Servers (im Container UTC, sofern TZ nicht gesetzt ist).
    filename = f"stowly-{datetime.now().astimezone():%Y-%m-%d}.sqlite3"
    return FileResponse(
        path,
        media_type=MEDIA_TYPE,
        filename=filename,
        headers={"Cache-Control": "no-store"},
        # Erst nach dem Senden löschen: Dann ist die Datei geschlossen (nötig unter Windows).
        background=BackgroundTask(backup.remove_file, path),
    )
