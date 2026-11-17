"""Etiketten gestalten (seit 0.5.0; docs/plan-0.5.md, 1; docs/etiketten.md, 3.2 und 3.4).

Eine Gestaltung gilt für den ganzen Haushalt: ein Papier für alle Drucker, je eine Gestaltung für
Packungs- und Zonen-Etiketten. Gespeichert wird sie in ``label_design`` (eine Zeile, nicht im Sync,
in jeder Sicherung). Beim Speichern und beim Start erzeugt ``label_templates.install()`` daraus die
Vorlagen (``labels.build_template``), und der Sync verteilt sie wie bisher. Pfade, Modelle und
Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.

Speichern und Vorschau prüfen dasselbe (``labels.check``): erzeugen und mit Grenzdaten rendern. Passt
es nicht, kommt 422 mit einem Satz in ``message`` und der Stelle in ``details.errors[].loc``, etwa
``["body", "package", "fields", "2"]`` (Vorschau: ``["body", "layout", …]``, Papier: ``["body", "paper"]``).
Die Vorschau rendert im Threadpool, höchstens ``LABEL_PREVIEWS_AT_ONCE`` zugleich, und nimmt Daten nur so
lang, wie die App sie schickt (``labels.DATA_LIMITS``; sonst 422 an ``["body", "data", schlüssel]``):
Rendern kostet Rechenzeit, und der Server läuft auf einem NAS.
"""

import sqlite3
import threading

from fastapi import APIRouter, FastAPI, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import db, events, label_templates, labels
from stowly.api.deps import CurrentDevice, Db
from stowly.contract import timeutil
from stowly.contract.api import (
    LABEL_PREVIEWS_AT_ONCE,
    ErrorCode,
    LabelDesign,
    LabelDesignState,
    LabelPaper,
    LabelPreview,
    LabelPreviewInput,
    LabelTemplateHashes,
)
from stowly.errors import ApiError
from stowly_print import media as catalog

router = APIRouter(prefix="/labels", tags=["labels"])

NO_STORE = "no-store"
BUSY = f"Höchstens {LABEL_PREVIEWS_AT_ONCE} Vorschauen zugleich. Bitte gleich noch einmal versuchen."


def _invalid(error: labels.LabelDesignError, layout_key: str) -> ApiError:
    """422 mit dem Satz; die Stelle beginnt mit ``body`` und der Gestaltung (``package``, ``zone`` oder
    ``layout``), beim Papier mit ``body, paper``, bei den Daten der Vorschau mit ``body, data``."""
    loc: list[str | int] = ["body", *error.loc]
    if error.loc[:1] not in (("paper",), ("data",)) and layout_key:
        loc = ["body", layout_key, *error.loc]
    problem = {"loc": [str(part) for part in loc], "msg": error.message, "type": "label_design"}
    return ApiError(422, ErrorCode.INVALID_REQUEST, error.message, {"errors": [problem]})


def _state(con: sqlite3.Connection) -> LabelDesignState:
    design, updated_at = label_templates.effective_design(con)
    stored = label_templates.hashes(con)
    return LabelDesignState(
        design=design,
        is_default=updated_at is None,
        updated_at=updated_at,
        templates=LabelTemplateHashes(package=stored.get("package", ""), zone=stored.get("zone", "")),
        papers=[
            LabelPaper(
                id=paper.id,
                kind=paper.kind,
                name=paper.name,
                width_mm=paper.width_mm,
                length_mm=paper.length_mm,
                printable_width_px=paper.printable_width_px,
                printable_length_px=paper.printable_length_px,
            )
            for paper in catalog.PAPERS
        ],
    )


def _changed(
    con: sqlite3.Connection, device_id: str, now: str, *, paper: str, default: bool, templates: list[str]
) -> None:
    events.record(
        con,
        at=now,
        recorded_at=now,
        device_id=device_id,
        type="labels.changed",
        entity="labels",
        entity_id="design",
        data={"paper": paper, "default": default, "templates": templates},
    )


@router.get("/design", operation_id="get_label_design", response_model=LabelDesignState)
def get_label_design(device: CurrentDevice, response: Response, con: Db) -> LabelDesignState:
    """Papier und beide Gestaltungen, ob es die Vorgabe ist, die ``hash`` der gültigen Vorlagen und
    der Papier-Katalog. Der Katalog kommt vom Server, nicht aus ``api.gen.ts``: Das schont das Bündel."""
    response.headers["Cache-Control"] = NO_STORE
    return _state(con)


@router.put("/design", operation_id="put_label_design", response_model=LabelDesignState)
def put_label_design(
    design: LabelDesign, device: CurrentDevice, response: Response, con: Db
) -> LabelDesignState:
    """Speichert Papier und beide Gestaltungen zusammen und erzeugt die Vorlagen neu; alle Geräte
    bekommen sie über den Sync. Vorher rendert der Server jede Vorlage mit Beispiel- und Grenzdaten
    (langer Name, alle Felder voll). Passt das nicht, oder ist das Papier unbekannt, ein Feld bei Zonen
    nicht erlaubt, doppelt oder ``lines`` außerhalb des Namens gesetzt, antwortet er 422 mit einem Satz,
    etwa „Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger
    machen." Ereignis ``labels.changed``."""
    response.headers["Cache-Control"] = NO_STORE
    try:
        labels.check_design(design)
    except labels.LabelDesignError as exc:
        raise _invalid(exc, "") from None
    now = timeutil.now()
    default = design == labels.DEFAULT_DESIGN
    with db.transaction(con):
        stored = label_templates.stored_design(con)
        if default:
            # Die Vorgabe zu speichern heißt: keine eigene Gestaltung. Es gelten die mitgelieferten Vorlagen.
            removed = con.execute("DELETE FROM label_design").rowcount
            changed = label_templates.install_in(con)
            if removed or changed:
                _changed(con, device["id"], now, paper=design.paper, default=True, templates=changed)
        elif stored is None or stored[0] != design:
            con.execute(
                "INSERT INTO label_design (id, body, updated_at, updated_by) VALUES (1, ?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, "
                "updated_by = excluded.updated_by",
                (design.model_dump_json(), now, device["id"]),
            )
            changed = label_templates.install_in(con)
            _changed(con, device["id"], now, paper=design.paper, default=False, templates=changed)
    return _state(con)


@router.delete("/design", operation_id="reset_label_design", response_model=LabelDesignState)
def reset_label_design(device: CurrentDevice, response: Response, con: Db) -> LabelDesignState:
    """Zurück zur Vorgabe: Es gelten wieder die mitgelieferten Vorlagen mit ihrem ``hash``. Ohne eigene
    Gestaltung ändert sich nichts. Ereignis ``labels.changed``."""
    response.headers["Cache-Control"] = NO_STORE
    now = timeutil.now()
    with db.transaction(con):
        removed = con.execute("DELETE FROM label_design").rowcount
        changed = label_templates.install_in(con)
        if removed or changed:
            _changed(con, device["id"], now, paper=labels.DEFAULT_PAPER_ID, default=True, templates=changed)
    return _state(con)


class PreviewGate:
    """Höchstens ``LABEL_PREVIEWS_AT_ONCE`` Vorschauen zugleich, für den ganzen Server."""

    def __init__(self, limit: int = LABEL_PREVIEWS_AT_ONCE) -> None:
        self._limit = limit
        self._running = 0
        self._lock = threading.Lock()

    def enter(self) -> bool:
        with self._lock:
            if self._running >= self._limit:
                return False
            self._running += 1
            return True

    def leave(self) -> None:
        with self._lock:
            self._running -= 1


_gate_lock = threading.Lock()


def preview_gate(app: FastAPI) -> PreviewGate:
    """Die Bremse der Vorschau, eine je App (``app.state.label_previews``)."""
    with _gate_lock:
        gate = getattr(app.state, "label_previews", None)
        if gate is None:
            gate = app.state.label_previews = PreviewGate()
        return gate


@router.post("/preview", operation_id="preview_label", response_model=LabelPreview)
async def preview_label(
    body: LabelPreviewInput, device: CurrentDevice, request: Request, response: Response
) -> LabelPreview:
    """Rendert ein Etikett, ohne etwas zu speichern, so wie man es liest (ungedreht), dazu Hinweise,
    was nur verkleinert oder gekürzt passt. Höchstens ``LABEL_PREVIEWS_AT_ONCE`` zugleich, sonst 429;
    passt die Gestaltung gar nicht, 422 mit demselben Satz wie beim Speichern."""
    response.headers["Cache-Control"] = NO_STORE
    gate = preview_gate(request.app)
    if not gate.enter():
        raise ApiError(429, ErrorCode.RATE_LIMITED, BUSY, {"retry_after_s": 1}, {"Retry-After": "1"})
    try:
        result = await run_in_threadpool(labels.preview, body.kind, body.paper, body.layout, body.data)
    except labels.LabelDesignError as exc:
        raise _invalid(exc, "layout") from None
    finally:
        gate.leave()
    return LabelPreview(
        png=result.png_base64(), width_px=result.width_px, height_px=result.height_px, notes=result.notes
    )
