"""Einen Raspberry Pi als Druckdienst koppeln (docs/sync-protokoll.md, 11.8).

Die App erzeugt einen Code; der Pi lädt mit einem Befehl Startskript und Paket von hier, meldet sich
mit dem Code, schickt nach der Installation einen Zertifikatsantrag und bekommt Zertifikat, CA und
erlaubte Ursprünge. Den Drucker legt der Server selbst an. Pfade, Modelle und Beschreibungen sind
Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen. Die Abläufe stehen in
``stowly/pairing.py``, das Paket und das Startskript in ``stowly/pi_bundle.py``.
"""

from typing import Any

from fastapi import APIRouter, Request, Response

from stowly import pairing
from stowly import pi_bundle as bundles
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.config import Settings
from stowly.contract.api import (
    ErrorCode,
    PiPairing,
    PiPairingInput,
    PiPairInput,
    PiPairResult,
    PiPairStartInput,
)
from stowly.contract.entities import Uuid
from stowly.errors import ApiError

router = APIRouter(prefix="/pi", tags=["pi"])

_SCRIPT_RESPONSES = {200: {"content": {"text/x-shellscript": {}}}}
_BUNDLE_RESPONSES = {200: {"content": {"application/gzip": {}}}}
NO_STORE = {"Cache-Control": "no-store"}

NO_BUNDLE = "Für den Pi gibt es auf diesem Server kein Paket (STOWLY_PI_BUNDLE, docs/betrieb.md)."
BAD_HOST = "Die Kopfzeile Host ist kein Name und keine IP-Adresse mit Port."


def _api(exc: pairing.Refused) -> ApiError:
    return ApiError(exc.status, exc.code, exc.message, exc.details, exc.headers)


def _bundle(settings: Settings) -> bundles.Bundle:
    bundle = bundles.load(settings.pi_bundle)
    if bundle is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, NO_BUNDLE)
    return bundle


def _tls(request: Request) -> Any:
    """``app.state.tls`` (``stowly.tls.TlsManager``, in Tests ein Ersatz); ``None``, solange es keinen gibt."""
    return getattr(request.app.state, "tls", None)


def _ca_ready(request: Request) -> bool:
    manager = _tls(request)
    return manager is not None and manager.ca_pem() is not None


@router.post("/pairings", operation_id="create_pi_pairing", status_code=201, response_model=PiPairing)
def create_pi_pairing(
    device: CurrentDevice, body: PiPairingInput, request: Request, response: Response, con: Db
) -> PiPairing:
    """Erzeugt einen Kopplungscode (30 Minuten, einmalig) und macht ältere ungültig; 201 mit Code und
    fertigem Befehl, ``Cache-Control: no-store``. Code und Befehl gibt es nur in dieser Antwort.

    422 ``invalid_request``, wenn ``origin`` kein Ursprung ist oder ``printer_id`` kein vorhandener,
    nicht gelöschter direkter Drucker; 503 ``not_configured`` ohne nutzbare CA oder ohne Paket für den Pi.
    """
    settings = get_settings(request)
    problem = pairing.origin_problem(body.origin)
    if problem is not None:
        raise _api(pairing.invalid([{"loc": ["body", "origin"], "msg": problem, "type": "pi_pairing"}]))
    try:
        pairing.check_printer(con, body.printer_id)
    except pairing.Refused as exc:
        raise _api(exc) from None
    _bundle(settings)
    if not _ca_ready(request):
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, pairing.NO_CA)
    base = pairing.command_base(settings, con, body.origin)
    moment = pairing.now()
    row, code = pairing.create(
        con, device_id=device["id"], origin=body.origin, printer_id=body.printer_id, moment=moment
    )
    response.headers["Cache-Control"] = "no-store"
    return PiPairing.model_validate(
        pairing.describe(row, moment, code=code, command_text=pairing.command(base, code))
    )


@router.get("/pairings/{pairing_id}", operation_id="get_pi_pairing", response_model=PiPairing)
def get_pi_pairing(
    device: CurrentDevice, pairing_id: Uuid, request: Request, response: Response, con: Db
) -> PiPairing:
    """Stand einer Kopplung, ``Cache-Control: no-store``; ``code`` und ``command`` sind hier null.
    404 ``not_found``."""
    row = pairing.find(con, pairing_id)
    if row is None:
        raise ApiError(404, ErrorCode.NOT_FOUND, pairing.UNKNOWN_PAIRING)
    response.headers["Cache-Control"] = "no-store"
    return PiPairing.model_validate(pairing.describe(row, pairing.now()))


@router.delete("/pairings/{pairing_id}", operation_id="cancel_pi_pairing", status_code=204)
def cancel_pi_pairing(device: CurrentDevice, pairing_id: Uuid, con: Db) -> None:
    """Bricht eine wartende Kopplung ab; wiederholbar. Eine fertige bleibt, wie sie ist. 404 ``not_found``."""
    if not pairing.cancel(con, pairing_id, device_id=device["id"], moment=pairing.now()):
        raise ApiError(404, ErrorCode.NOT_FOUND, pairing.UNKNOWN_PAIRING)


@router.post("/pair/start", operation_id="pi_pair_start", status_code=204)
def pi_pair_start(body: PiPairStartInput, request: Request, con: Db) -> None:
    """Ohne Anmeldung, nur mit Code: Der Pi meldet sich gleich nach dem Laden des Pakets. Die
    Kopplung steht dann auf ``installing`` und gilt ab jetzt noch einmal 30 Minuten.

    404 ``not_found`` bei unbekanntem Code; 409 ``conflict``, wenn er abgelaufen, abgebrochen oder
    schon benutzt ist; 429 ``rate_limited`` mit ``Retry-After`` nach zu vielen Fehlversuchen.
    """
    try:
        pairing.guarded(request.app.state, lambda: pairing.start(con, body, pairing.now()))
    except pairing.Refused as exc:
        raise _api(exc) from None


@router.post("/pair", operation_id="pi_pair", response_model=PiPairResult)
def pi_pair(body: PiPairInput, request: Request, response: Response, con: Db) -> PiPairResult:
    """Ohne Anmeldung, nur mit Code: signiert den Antrag des Pi mit der CA von Stowly, legt den
    Drucker an oder übernimmt den gewählten und liefert Zertifikat, CA, Ursprünge und Adressen,
    ``Cache-Control: no-store``. Dieselbe CSR noch einmal (Netzaussetzer) bekommt dieselbe Antwort.

    404 ``not_found`` bei unbekanntem Code; 409 ``conflict``, wenn er abgelaufen, abgebrochen oder
    mit einer anderen CSR benutzt ist; 422 ``invalid_request`` bei unbrauchbarem Antrag, Hostnamen
    oder Adressen (nur private IPv4, keine Adresse der App); 429 ``rate_limited``; 503
    ``not_configured`` ohne nutzbare CA.
    """
    settings = get_settings(request)
    manager = _tls(request)
    host = request.headers.get("host")
    # Die Adresse, von der die Anfrage kommt (Proxy-Kopfzeilen sind aus). Ist sie die erste gemeldete,
    # kommt sie ins Zertifikat; sonst nur eine Adresse, unter der der Pi die Rückprüfung besteht.
    client = request.client.host if request.client is not None else None
    state = request.app.state
    try:
        # 1. Unter der Bremse und ohne Netz: Code und Angaben; braucht es eine Rückprüfung?
        planned = pairing.guarded(
            state,
            lambda: pairing.prepare(
                con, settings, manager, body, request_host=host, client_host=client, moment=pairing.now()
            ),
        )
        if isinstance(planned, pairing.CheckBack):
            # 2. Ohne die Bremse (ein Lock), mit fester Frist: den Pi zurückfragen.
            proven = pairing.check_back(planned, body.token)
            # 3. Wieder unter der Bremse: noch einmal prüfen, signieren, den Drucker schreiben.
            result = pairing.guarded(
                state,
                lambda: pairing.pair(
                    con,
                    settings,
                    manager,
                    body,
                    request_host=host,
                    client_host=client,
                    moment=pairing.now(),
                    proven=proven,
                ),
            )
        else:
            result = planned  # derselbe Antrag noch einmal: die gespeicherte Antwort
    except pairing.Refused as exc:
        raise _api(exc) from None
    response.headers["Cache-Control"] = "no-store"
    return PiPairResult.model_validate(result)


@router.get(
    "/install.sh", operation_id="pi_install_script", response_class=Response, responses=_SCRIPT_RESPONSES
)
def pi_install_script(request: Request) -> Response:
    """Ohne Anmeldung: das Startskript für ``curl -fsSL …/api/pi/install.sh | sudo sh -s -- CODE``,
    ``Cache-Control: no-store``. Es kennt die Adresse dieses Servers (aus Host) und die SHA-256 des
    Pakets. 400 ``invalid_request`` bei einer Kopfzeile Host, die kein Name oder keine IP mit Port
    ist; 503 ``not_configured`` ohne Paket."""
    server = pairing.script_server(request.headers.get("host"), request.url.scheme)
    if server is None:
        raise ApiError(400, ErrorCode.INVALID_REQUEST, BAD_HOST)
    bundle = _bundle(get_settings(request))
    script = bundles.install_script(server, bundle.sha256)
    return Response(script, media_type="text/x-shellscript", headers=NO_STORE)


@router.get("/bundle.tar.gz", operation_id="pi_bundle", response_class=Response, responses=_BUNDLE_RESPONSES)
def pi_bundle(request: Request) -> Response:
    """Ohne Anmeldung: das Paket für den Pi (``pi/`` und der Druckdienst aus ``print/``) als tar.gz.
    503 ``not_configured`` ohne Paket."""
    bundle = _bundle(get_settings(request))
    return Response(bundle.data, media_type="application/gzip", headers=NO_STORE)
