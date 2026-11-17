"""Was koche ich? Vorschläge von Claude als Auftrag (docs/plan-0.6.md, 2; docs/sync-protokoll.md, 11.13).

``POST /api/cook/ideas`` startet einen Auftrag und antwortet sofort mit 202; ``GET /api/cook/ideas/{id}``
holt seinen Stand. So bleibt jeder Aufruf weit unter den Fristen der App und eines Reverse Proxys, auch
wenn Claude eine Minute braucht. Ein Auftrag gehört dem Gerät, das ihn startete; nach
``COOK_JOB_TTL_S`` oder einem Neustart ist er weg.

Fehler von Anthropic stehen im fertigen Auftrag (``CookJob.problem``), nicht als HTTP-Fehler; Stowly
antwortet nur für das, was es selbst entscheidet, mit einem Fehler. Die Such-Links zu Cookidoo und
Chefkoch baut die App allein. Pfade, Modelle und Beschreibungen sind Vertrag; umsetzen heißt, die Rümpfe
zu füllen. Die Regeln gehören nach ``stowly/cook.py``.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Request, Response

from stowly.api.aiconfig import NO_STORE, NOT_RUNNING
from stowly.api.deps import CurrentDevice, Db
from stowly.contract.api import CookIdeasInput, CookJob, ErrorCode
from stowly.cook import CookService
from stowly.errors import ApiError

router = APIRouter(prefix="/cook", tags=["cook"])


def _service(request: Request) -> CookService:
    """Die Aufträge (``app.state.cook``); es gibt sie nur, solange die App bedient wird."""
    service: CookService | None = getattr(request.app.state, "cook", None)
    if service is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, NOT_RUNNING)
    return service


@router.post("/ideas", operation_id="start_cook_ideas", response_model=CookJob, status_code=202)
def start_cook_ideas(
    device: CurrentDevice, body: CookIdeasInput, request: Request, response: Response, con: Db
) -> CookJob:
    """Startet einen Auftrag (202), ``Cache-Control: no-store``.

    Reihenfolge der Prüfungen: 422 bei falscher Eingabe; 503 ``not_configured`` ohne wirksamen Schlüssel
    (``details.reason``: ``missing`` oder ``lost``); 409 ``conflict``, wenn kein Produkt mit Namen im Bestand
    ist; 429 ``rate_limited`` mit ``details.reason`` ``busy`` (schon ein Auftrag am Server), ``too_soon``
    (dieses Gerät vor weniger als ``AI_DEVICE_GAP_S``) oder ``daily_limit`` (``AI_DAILY_MAX`` erreicht),
    jeweils mit ``retry_after_s``. Erst dann zählt die Anfrage für heute.
    """
    job = _service(request).begin(con, device_id=device["id"], wish=body.wish, focus=body.focus)
    response.headers["Cache-Control"] = NO_STORE
    return CookJob.model_validate(job)


@router.get("/ideas/{job_id}", operation_id="get_cook_ideas", response_model=CookJob)
def get_cook_ideas(
    job_id: Annotated[str, Path(pattern=r"^[0-9a-f]{32}$", description="Kennung aus CookJob.id.")],
    device: CurrentDevice,
    request: Request,
    response: Response,
    con: Db,
) -> CookJob:
    """Stand eines Auftrags, ``Cache-Control: no-store``. 404, wenn es ihn nicht (mehr) gibt oder er einem
    anderen Gerät gehört."""
    job = _service(request).get(con, job_id, device_id=device["id"])
    response.headers["Cache-Control"] = NO_STORE
    return CookJob.model_validate(job)
