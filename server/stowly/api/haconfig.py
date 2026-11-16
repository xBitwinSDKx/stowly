"""Home Assistant aus der App (docs/integrationen.md, Abschnitt 5 und 12; docs/plan-einrichtung-b.md, 3).

Adresse und Liste stehen in ``server_config``, die Tokens in einem eigenen Speicher außerhalb der Datenbank
und jeder Sicherung (``/data/secrets``). Kommt eine der Variablen STOWLY_HA_URL, STOWLY_HA_TOKEN oder
STOWLY_HA_TODO_ENTITY aus der Umgebung, kommt die ganze Verbindung von dort und ist hier gesperrt (409).
Pfade, Modelle und Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.

Die Regeln stehen in ``stowly/haconfig.py`` (wirksame Werte, Ändern, Sensor-Token) und ``stowly/hacheck.py``
(Prüfung). Jede Antwort hier trägt ``Cache-Control: no-store``.
"""

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import hacheck, haconfig
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract import timeutil
from stowly.contract.api import ErrorCode, HaCheck, HaCheckInput, HaConfig, HaConfigChanges, HaSensorToken
from stowly.errors import ApiError
from stowly.secretstore import SecretStore

router = APIRouter(prefix="/server-config/ha", tags=["server-config"])

NO_STORE = "no-store"


def _store(request: Request) -> SecretStore:
    """Der Speicher der Tokens (``app.state.secrets``); seine Sperre ordnet Schreiben und Löschen."""
    return request.app.state.secrets


def _config(request: Request, con: Db) -> HaConfig:
    settings = get_settings(request)
    return HaConfig.model_validate(
        haconfig.view(settings, haconfig.effective(settings, con, _store(request)))
    )


@router.get("", operation_id="get_ha_config", response_model=HaConfig)
def get_ha_config(device: CurrentDevice, request: Request, response: Response, con: Db) -> HaConfig:
    """Wirksame Einrichtung mit Quelle, ``Cache-Control: no-store``. Nie ein Token."""
    response.headers["Cache-Control"] = NO_STORE
    return _config(request, con)


@router.patch("", operation_id="update_ha_config", response_model=HaConfig)
def update_ha_config(
    device: CurrentDevice, body: HaConfigChanges, request: Request, response: Response, con: Db
) -> HaConfig:
    """Ändert die vorhandenen Felder; der Abgleich übernimmt sie ohne Neustart.

    409 ``conflict``, wenn die Verbindung aus der Umgebung kommt; 422 mit ``details.errors[].loc`` bei
    einer ungültigen Adresse, Liste oder einem Token ohne Adresse; 500, wenn sich der Token nicht speichern
    lässt. Eine neue Adresse ohne Token im selben Aufruf löscht den Token; dieselbe Adresse behält ihn.
    """
    changed = haconfig.change(
        get_settings(request), con, _store(request), body, device_id=device["id"], now=timeutil.now()
    )
    if changed:
        # Der Abgleich liest die Einrichtung neu, nach der Anfrage, die er gerade stellt.
        sync = getattr(request.app.state, "bring", None)
        if sync is not None:
            sync.reconfigure()
    response.headers["Cache-Control"] = NO_STORE
    return _config(request, con)


@router.post("/check", operation_id="check_ha", response_model=HaCheck)
async def check_ha(
    device: CurrentDevice, body: HaCheckInput, request: Request, response: Response, con: Db
) -> HaCheck:
    """Prüft Adresse und Token (ohne Felder: die wirksamen) und liefert die To-do-Listen von HA.

    Speichert nichts. Feste Fristen, eine Prüfung zugleich, mindestens 3 Sekunden Abstand; sonst 429 mit
    ``Retry-After``. 409, wenn die Verbindung aus der Umgebung kommt und trotzdem Felder angegeben sind;
    422 an ``["body", "url"]``, wenn es keine Adresse gibt. Der gespeicherte Token geht nur an seine
    Adresse. Antworten von HA gehen nie roh zurück.
    """
    settings = get_settings(request)
    current = await run_in_threadpool(haconfig.effective, settings, con, _store(request))
    goal = hacheck.target(current, body)
    guard: hacheck.CheckGuard = request.app.state.ha_check
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
        result = await hacheck.check(goal, transport=getattr(request.app.state, "ha_transport", None))
    finally:
        guard.release()
    response.headers["Cache-Control"] = NO_STORE
    return HaCheck.model_validate(result)


@router.post(
    "/sensor-token", operation_id="create_ha_sensor_token", status_code=201, response_model=HaSensorToken
)
def create_ha_sensor_token(
    device: CurrentDevice, request: Request, response: Response, con: Db
) -> HaSensorToken:
    """Erzeugt einen neuen Sensor-Token (64 Hex-Zeichen) und ersetzt den bisherigen; 409 aus der Umgebung."""
    token = haconfig.create_sensor_token(
        get_settings(request), con, _store(request), device_id=device["id"], now=timeutil.now()
    )
    response.headers["Cache-Control"] = NO_STORE
    return HaSensorToken(token=token)


@router.get("/sensor-token", operation_id="get_ha_sensor_token", response_model=HaSensorToken)
def get_ha_sensor_token(
    device: CurrentDevice, request: Request, response: Response, con: Db
) -> HaSensorToken:
    """Zeigt den Sensor-Token aus der App; 404, wenn es keinen gibt; 409, wenn er aus der Umgebung kommt."""
    token = haconfig.stored_sensor_token(get_settings(request), con, _store(request))
    response.headers["Cache-Control"] = NO_STORE
    return HaSensorToken(token=token)


@router.delete("/sensor-token", operation_id="delete_ha_sensor_token", status_code=204)
def delete_ha_sensor_token(device: CurrentDevice, request: Request, response: Response, con: Db) -> None:
    """Entfernt den Sensor-Token aus der App (immer 204, auch ohne); danach antwortet der Sensor mit 503. 409 aus der Umgebung."""
    haconfig.delete_sensor_token(
        get_settings(request), con, _store(request), device_id=device["id"], now=timeutil.now()
    )
    response.headers["Cache-Control"] = NO_STORE
