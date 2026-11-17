"""KI-Vorschläge einrichten: API-Schlüssel und Modell (docs/plan-0.6.md, 2; docs/integrationen.md, 13).

Der Schlüssel liegt wie der Token von Home Assistant in einem eigenen Speicher außerhalb der Datenbank und
jeder Sicherung (``/data/secrets``); ``STOWLY_ANTHROPIC_API_KEY`` geht vor und sperrt ihn hier (409). Das
Modell und der Tageszähler stehen in ``server_config``. Keine Antwort enthält den Schlüssel, auch keinen
Teil davon; jede trägt ``Cache-Control: no-store``, auch jeder Fehler (``app.NoStore``).

Pfade, Modelle und Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
Die Regeln gehören nach ``stowly/aiconfig.py``, der Aufruf von Anthropic nach ``stowly/claude.py``.
"""

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import aiconfig, hacheck, localtime
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.claude import Claude
from stowly.contract import timeutil
from stowly.contract.api import AiCheck, AiCheckInput, AiConfig, AiConfigChanges, ErrorCode
from stowly.errors import ApiError
from stowly.secretstore import SecretStore

router = APIRouter(prefix="/server-config/ai", tags=["server-config"])

NO_STORE = "no-store"
NOT_RUNNING = "Die KI-Vorschläge stehen gerade nicht bereit (der Server startet oder fährt herunter)."


def _store(request: Request) -> SecretStore:
    """Der Speicher der Geheimnisse (``app.state.secrets``); seine Sperre ordnet Schreiben und Löschen."""
    return request.app.state.secrets


def _config(request: Request, con: Db) -> AiConfig:
    settings = get_settings(request)
    current = aiconfig.effective(settings, con, _store(request))
    today = localtime.today(request.app.state.ai_clock.now(), settings.tz).isoformat()
    return AiConfig.model_validate(aiconfig.view(current, aiconfig.used(con, today)))


@router.get("", operation_id="get_ai_config", response_model=AiConfig)
def get_ai_config(device: CurrentDevice, request: Request, response: Response, con: Db) -> AiConfig:
    """Wirksame Einrichtung mit Quelle, Modell und Tageszähler, ``Cache-Control: no-store``. Nie der
    Schlüssel."""
    response.headers["Cache-Control"] = NO_STORE
    return _config(request, con)


@router.patch("", operation_id="update_ai_config", response_model=AiConfig)
def update_ai_config(
    device: CurrentDevice, body: AiConfigChanges, request: Request, response: Response, con: Db
) -> AiConfig:
    """Ändert die vorhandenen Felder; wirkt ohne Neustart.

    409 ``conflict``, wenn ``key`` geändert werden soll, der Schlüssel aber aus der Umgebung kommt; 422 mit
    ``details.errors[].loc = ["body","key"]`` bei einem Schlüssel in falscher Form (nie mit seinem Wert);
    500, wenn er sich nicht speichern lässt.
    """
    aiconfig.change(
        get_settings(request), con, _store(request), body, device_id=device["id"], now=timeutil.now()
    )
    response.headers["Cache-Control"] = NO_STORE
    return _config(request, con)


@router.post("/check", operation_id="check_ai", response_model=AiCheck)
async def check_ai(
    device: CurrentDevice, body: AiCheckInput, request: Request, response: Response, con: Db
) -> AiCheck:
    """Prüft Schlüssel und Modell bei Anthropic (``GET /v1/models/{id}``; kostet keine Tokens).

    Ohne Felder die wirksamen Werte. 409, wenn ``key`` angegeben ist, der Schlüssel aber aus der Umgebung
    kommt; 422 bei einem Schlüssel in falscher Form; 429 ``rate_limited``, wenn schon eine Prüfung läuft
    oder die letzte weniger als 3 s her ist; 503 ``not_configured`` ohne Schlüssel.
    """
    settings = get_settings(request)
    current = await run_in_threadpool(aiconfig.effective, settings, con, _store(request))
    key, model = aiconfig.check_target(current, body)
    client: Claude | None = getattr(request.app.state, "claude", None)
    if client is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, NOT_RUNNING)
    guard: hacheck.CheckGuard = request.app.state.ai_check
    try:
        guard.admit()
    except hacheck.TooSoon as exc:
        wait = exc.retry_after_s
        raise ApiError(
            429,
            ErrorCode.RATE_LIMITED,
            f"Höchstens eine Prüfung zugleich und eine in {hacheck.GAP_S:.0f} Sekunden. "
            f"Bitte in {wait} Sekunden erneut versuchen.",
            {"retry_after_s": wait},
            {"Retry-After": str(wait)},
        ) from None
    try:
        result = await client.check(key, model)
    finally:
        guard.release()
    response.headers["Cache-Control"] = NO_STORE
    return AiCheck.model_validate(result)
