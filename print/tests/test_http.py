"""Die HTTP-Schnittstelle des Druckdienstes (docs/etiketten.md, 5.1 bis 5.7).

Geprüft wird die App, wie sie auf dem Raspberry Pi läuft (festes Token, CORS, Seite ``/p``),
und wie der Server sie einbindet (jeder Aufruf braucht ein Token, kein CORS, keine Seite).
"""

import base64
import hashlib
import hmac
import io
import json
import logging
import re

import pytest
from PIL import Image
from print_support import PACKAGE, FakeDriver, new_id, wait_until
from starlette.testclient import TestClient

from stowly_print import __version__
from stowly_print.drivers.image import ImageDriver
from stowly_print.http import MAX_BODY_BYTES, TokenAuthorizer, create_app, page_html, unauthorized
from stowly_print.model import MAX_PNG_BYTES, PrintOutcome
from stowly_print.render import Fonts
from stowly_print.service import PrinterEntry, PrintService, StaticPrinters
from stowly_print.templates import load_builtin

TOKEN = "pi-geheim-0123456789"
ORIGIN = "https://stowly.home"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def payload(title: str = "Basmati Reis", **more) -> dict:
    return {"template": load_builtin("package"), "data": {**PACKAGE, "title": title}, **more}


def as_text(body: dict) -> dict:
    """So schickt es der Browser: ``text/plain``, der Rumpf ist JSON und enthält das Token."""
    return {
        "content": json.dumps({"token": TOKEN, **body}).encode("utf-8"),
        "headers": {"Content-Type": "text/plain"},
    }


def error_code(response) -> str:
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["message"]
    return body["error"]["code"]


@pytest.fixture
def bench(tmp_path):
    """Der Dienst wie auf dem Pi: ein Bild-Treiber (Standard) und ein steuerbarer Treiber."""
    fake = FakeDriver()
    image = ImageDriver(tmp_path / "etiketten")
    service = PrintService(
        StaticPrinters(
            [PrinterEntry("bild", "image", None, image), PrinterEntry("keller", "brother_ql", "QL-800", fake)]
        ),
        fonts=Fonts.builtin(),
    )
    service.start()
    app = create_app(
        service, authorize=TokenAuthorizer(TOKEN), origins=[ORIGIN + "/", "http://LOCALHOST:5173"], standalone=True
    )
    with TestClient(app) as client:
        client.fake = fake
        client.service = service
        client.images = tmp_path / "etiketten"
        yield client
    fake.gate.set()
    service.close()


# --- Zustand und Drucker -----------------------------------------------------------------


def test_health_is_a_plain_get_without_token(bench):
    response = bench.get("/v1/health")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"app", "version", "protocol", "boot_id", "uptime_s", "proof", "host", "printers"}
    assert (body["app"], body["version"], body["protocol"]) == ("stowly-print", __version__, 1)
    assert body["boot_id"] == bench.service.boot_id
    assert body["uptime_s"] >= 0
    assert body["proof"] is None
    assert body["host"] is None  # hier ohne Angaben zum Rechner gebaut
    # Feste Reihenfolge; der erste ist der Standarddrucker.
    assert [printer["name"] for printer in body["printers"]] == ["bild", "keller"]


def test_health_proves_that_the_service_knows_the_token(bench):
    nonce = "Zufall_0123456789-abcdefXYZ"
    body = bench.get("/v1/health", params={"nonce": nonce}).json()
    expected = hmac.new(TOKEN.encode(), nonce.encode(), hashlib.sha256).hexdigest()
    assert body["proof"] == expected
    assert re.fullmatch(r"[0-9a-f]{64}", body["proof"])
    # Eine andere Zufallsfolge, ein anderer Nachweis.
    other = bench.get("/v1/health", params={"nonce": "x" * 16}).json()["proof"]
    assert other == hmac.new(TOKEN.encode(), b"x" * 16, hashlib.sha256).hexdigest() != expected
    assert bench.get("/v1/health", params={"nonce": "y" * 64}).status_code == 200


@pytest.mark.parametrize("nonce", ["", "zu-kurz-15-zeic", "z" * 65, "mit leerzeichen 1234", "umlaut-äöü-12345678", "a/b+c=1234567890", "%00" * 16])
def test_health_rejects_an_unusable_nonce(bench, nonce):
    response = bench.get("/v1/health", params={"nonce": nonce})
    assert response.status_code == 400
    assert error_code(response) == "invalid_request"


def test_printers_list_capabilities_and_status(bench):
    response = bench.get("/v1/printers")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"printers"}
    image, keller = body["printers"]
    assert image == {
        "name": "bild",
        "driver": "image",
        "model": None,
        "capabilities": {
            "dpi": 300,
            "media": {"width_mm": 62.0, "length_mm": None, "printable_px": 696},
            "cutter": True,
            "colors": ["black"],
            "status_query": True,
            "confirms_print": True,
        },
        "status": {"reachable": True, "ready": True, "media_detected": True, "errors": []},
    }
    assert (keller["name"], keller["driver"], keller["model"]) == ("keller", "brother_ql", "QL-800")
    assert bench.get("/v1/health").json()["printers"] == body["printers"]


# --- Einreichen --------------------------------------------------------------------------


def test_submit_as_the_browser_does_it_without_preflight(bench):
    job_id = new_id()
    response = bench.post(f"/v1/jobs/{job_id}", params={"wait": 10}, **as_text(payload()))
    assert response.status_code == 201
    assert response.headers["content-type"] == "application/json"
    job = response.json()
    assert job == {
        "id": job_id,
        "state": "printed",
        "printer": "bild",
        "boot_id": bench.service.boot_id,
        "error": None,
        "position": None,
    }
    assert (bench.images / f"{job_id}.png").is_file()

    # Derselbe Auftrag noch einmal: 200 statt 201, derselbe Zustand, kein zweites Bild.
    again = bench.post(f"/v1/jobs/{job_id}", **as_text(payload()))
    assert again.status_code == 200
    assert again.json() == job
    assert [entry.name for entry in bench.images.iterdir()] == [f"{job_id}.png"]


def test_submit_with_put_and_bearer_header(bench):
    job_id = new_id()
    response = bench.put(f"/v1/jobs/{job_id}?wait=5", json=payload(), headers=AUTH)
    assert response.status_code == 201
    assert response.json()["state"] == "printed"
    assert bench.put(f"/v1/jobs/{job_id}", json=payload(), headers=AUTH).status_code == 200


@pytest.mark.parametrize("content_type", ["text/plain", "application/json", "application/octet-stream", "quatsch", None])
def test_body_is_read_as_json_whatever_the_content_type_says(bench, content_type):
    headers = {} if content_type is None else {"Content-Type": content_type}
    body = json.dumps({"token": TOKEN, **payload()}).encode("utf-8")
    response = bench.post(f"/v1/jobs/{new_id()}?wait=5", content=body, headers=headers)
    assert response.status_code == 201, response.text
    assert response.json()["state"] == "printed"


def test_submit_without_wait_answers_at_once(bench):
    bench.fake.gate.clear()
    first, second = new_id(), new_id()
    response = bench.post(f"/v1/jobs/{first}", **as_text(payload(printer="keller")))
    assert response.status_code == 201
    assert response.json()["state"] in ("queued", "printing")
    wait_until(bench.fake.entered.is_set)
    queued = bench.post(f"/v1/jobs/{second}", **as_text(payload("zwei", printer="keller"))).json()
    assert (queued["state"], queued["position"], queued["printer"]) == ("queued", 0, "keller")
    assert bench.get(f"/v1/jobs/{first}").json()["state"] == "printing"
    # wait hält die Antwort nur so lange wie gewünscht.
    assert bench.get(f"/v1/jobs/{second}", params={"wait": 0.2}).json()["state"] == "queued"
    bench.fake.gate.set()
    assert bench.get(f"/v1/jobs/{second}", params={"wait": 10}).json()["state"] == "printed"
    assert bench.get(f"/v1/jobs/{first}?wait=10").json()["state"] == "printed"


@pytest.mark.parametrize("request_kwargs", [{}, {"headers": {"Authorization": "Bearer falsch"}}, {"headers": {"Authorization": f"Basic {TOKEN}"}}, {"headers": {"Authorization": "Bearer"}}])
def test_writing_needs_the_token(bench, request_kwargs):
    job_id = new_id()
    response = bench.post(f"/v1/jobs/{job_id}", json=payload(), **request_kwargs)
    assert response.status_code == 401
    assert error_code(response) == "unauthorized"
    assert response.headers["www-authenticate"] == "Bearer"
    assert bench.get(f"/v1/jobs/{job_id}").status_code == 404
    assert not bench.images.exists()


def test_wrong_token_in_the_body_and_header_beats_body(bench):
    job_id = new_id()
    wrong = json.dumps({"token": TOKEN + "x", **payload()})
    assert bench.post(f"/v1/jobs/{job_id}", content=wrong).status_code == 401
    assert bench.post(f"/v1/jobs/{job_id}", content=json.dumps({"token": 5, **payload()})).status_code == 401
    # Steht ein Token im Kopf, gilt dieses, auch wenn im Rumpf das richtige stünde.
    response = bench.post(
        f"/v1/jobs/{job_id}", headers={"Authorization": "Bearer falsch"}, content=json.dumps({"token": TOKEN, **payload()})
    )
    assert response.status_code == 401
    assert bench.get(f"/v1/jobs/{job_id}").status_code == 404
    assert bench.post(f"/v1/jobs/{job_id}", content=json.dumps({"token": TOKEN, **payload()})).status_code == 201


@pytest.mark.parametrize(
    "body",
    [
        b"kein json",
        b"[1, 2, 3]",
        b'"nur text"',
        b"\xff\xfe\x00",
        b"[" * 100_000,
        json.dumps({"token": TOKEN, "data": {}}).encode(),  # template fehlt
        json.dumps({"token": TOKEN, "template": {}, "data": {"a": 1}}).encode(),
        json.dumps({"token": TOKEN, **{"template": {}, "data": {}, "copies": 21}}).encode(),
        json.dumps({"token": TOKEN, **{"template": {}, "data": {}, "cut": "ja"}}).encode(),
        json.dumps({"token": TOKEN, **{"template": {}, "data": {}, "printer": 7}}).encode(),
        json.dumps({"token": TOKEN, **{"template": {}, "data": {}, "png": "eA=="}}).encode(),
    ],
)
def test_payload_that_breaks_the_contract_is_rejected(bench, body):
    job_id = new_id()
    response = bench.post(f"/v1/jobs/{job_id}", content=body, headers=AUTH)
    assert response.status_code == 400, response.text
    assert error_code(response) == "invalid_request"
    assert bench.get(f"/v1/jobs/{job_id}").status_code == 404


def test_job_ids_must_be_plain(bench):
    for bad in ("mit leerzeichen", "punkt.png", "a" * 65, "ümlaut", "semi;kolon"):
        response = bench.post(f"/v1/jobs/{bad}", **as_text(payload()))
        assert response.status_code == 400, bad
        assert error_code(response) == "invalid_request"
    assert bench.post("/v1/jobs/A-b_9", **as_text(payload())).status_code == 201
    assert bench.post("/v1/jobs/" + "a" * 64, **as_text(payload("lang"))).status_code == 201
    # Nichts davon landet außerhalb des Verzeichnisses für die Bilder.
    assert bench.get("/v1/jobs/..%2F..%2Fgeheim/image").status_code == 404


def test_body_size_is_limited(bench):
    assert MAX_BODY_BYTES > MAX_PNG_BYTES * 4 // 3
    too_big = json.dumps({"token": TOKEN, "template": {}, "data": {}, "x": "a" * MAX_BODY_BYTES}).encode()
    response = bench.post(f"/v1/jobs/{new_id()}", content=too_big, headers={"Content-Type": "text/plain"})
    assert response.status_code == 400
    assert error_code(response) == "invalid_request"
    assert response.json()["error"]["details"] == {"max_bytes": MAX_BODY_BYTES}

    # Ein PNG in voller erlaubter Größe passt hindurch (und scheitert dann erst am Inhalt).
    filler = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * (MAX_PNG_BYTES - 8)).decode("ascii")
    response = bench.post(f"/v1/jobs/{new_id()}", content=json.dumps({"token": TOKEN, "png": filler}))
    assert response.status_code == 422
    assert error_code(response) == "render_failed"


@pytest.mark.parametrize("wait", ["-1", "31", "abc", "nan", "inf", "1e9"])
def test_wait_must_be_between_zero_and_thirty(bench, wait):
    response = bench.get(f"/v1/jobs/{new_id()}", params={"wait": wait})
    assert response.status_code == 400
    assert error_code(response) == "invalid_request"
    assert bench.post(f"/v1/jobs/{new_id()}", params={"wait": wait}, **as_text(payload())).status_code == 400


# --- Fehlercodes der Tabelle -------------------------------------------------------------


def test_unknown_job_and_unknown_printer(bench):
    response = bench.get(f"/v1/jobs/{new_id()}")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    response = bench.post(f"/v1/jobs/{new_id()}", **as_text(payload(printer="dachboden")))
    assert (response.status_code, error_code(response)) == (404, "unknown_printer")


def test_same_id_with_other_content_is_a_conflict(bench):
    job_id = new_id()
    assert bench.post(f"/v1/jobs/{job_id}?wait=5", **as_text(payload("eins"))).status_code == 201
    response = bench.post(f"/v1/jobs/{job_id}", **as_text(payload("zwei")))
    assert (response.status_code, error_code(response)) == (409, "job_conflict")
    assert len(list(bench.images.glob("*.png"))) == 1


def test_wrong_boot_id_names_the_current_one(bench):
    job_id = new_id()
    response = bench.post(f"/v1/jobs/{job_id}", **as_text(payload(expect_boot_id="c0ffee00-alt")))
    assert (response.status_code, error_code(response)) == (409, "boot_mismatch")
    assert response.json()["error"]["details"] == {"boot_id": bench.service.boot_id}
    assert bench.get(f"/v1/jobs/{job_id}").status_code == 404
    seen = bench.get("/v1/health").json()["boot_id"]
    assert bench.post(f"/v1/jobs/{job_id}", **as_text(payload(expect_boot_id=seen))).status_code == 201


def test_what_cannot_be_rendered_is_rejected_with_422(bench):
    template = load_builtin("package")
    template["elements"][0]["size"] = 5  # QR-Feld zu klein
    job_id = new_id()
    response = bench.post(f"/v1/jobs/{job_id}", **as_text({"template": template, "data": PACKAGE}))
    assert (response.status_code, error_code(response)) == (422, "render_failed")
    assert "QR-Code" in response.json()["error"]["message"]
    assert bench.get(f"/v1/jobs/{job_id}").status_code == 404


def test_queue_full_is_503(tmp_path):
    driver = FakeDriver()
    driver.gate.clear()
    service = PrintService(
        StaticPrinters([PrinterEntry("p", "fake", None, driver)]), fonts=Fonts.builtin(), max_queued=1
    )
    service.start()
    with TestClient(create_app(service, authorize=TokenAuthorizer(TOKEN), standalone=True)) as client:
        assert client.post(f"/v1/jobs/{new_id()}", **as_text(payload("druckt"))).status_code == 201
        wait_until(driver.entered.is_set)
        assert client.post(f"/v1/jobs/{new_id()}", **as_text(payload("wartet"))).status_code == 201
        response = client.post(f"/v1/jobs/{new_id()}", **as_text(payload("zu viel")))
        assert (response.status_code, error_code(response)) == (503, "queue_full")
    driver.gate.set()
    service.close()


# --- Verwerfen ---------------------------------------------------------------------------


def test_cancel_with_post_and_with_delete(bench):
    bench.fake.gate.clear()
    printing, by_post, by_delete = new_id(), new_id(), new_id()
    for job_id, title in ((printing, "eins"), (by_post, "zwei"), (by_delete, "drei")):
        assert bench.post(f"/v1/jobs/{job_id}", **as_text(payload(title, printer="keller"))).status_code == 201
    wait_until(bench.fake.entered.is_set)

    # Wie der Browser: POST mit dem Token im Rumpf.
    response = bench.post(f"/v1/jobs/{by_post}/cancel", **as_text({}))
    assert response.status_code == 200
    job = response.json()
    assert (job["state"], job["error"]["code"], job["position"]) == ("failed", "cancelled", None)
    assert job["error"]["message"]
    # Wie curl: DELETE mit dem Token im Kopf.
    response = bench.delete(f"/v1/jobs/{by_delete}", headers=AUTH)
    assert response.status_code == 200
    assert response.json()["error"]["code"] == "cancelled"

    # Ohne Token nicht; was druckt, nicht mehr; was es nicht gibt, auch nicht.
    assert bench.post(f"/v1/jobs/{printing}/cancel").status_code == 401
    assert bench.delete(f"/v1/jobs/{printing}").status_code == 401
    response = bench.post(f"/v1/jobs/{printing}/cancel", **as_text({}))
    assert (response.status_code, error_code(response)) == (409, "not_cancellable")
    response = bench.delete(f"/v1/jobs/{new_id()}", headers=AUTH)
    assert (response.status_code, error_code(response)) == (404, "not_found")

    bench.fake.gate.set()
    assert bench.get(f"/v1/jobs/{printing}?wait=10").json()["state"] == "printed"
    assert bench.fake.calls == 1
    assert bench.get(f"/v1/jobs/{by_post}").json()["state"] == "failed"


def test_failed_and_unknown_jobs_carry_their_error(bench):
    bench.fake.outcome, bench.fake.error = PrintOutcome.FAILED, "no_media"
    failed = bench.post(f"/v1/jobs/{new_id()}?wait=10", **as_text(payload("leer", printer="keller"))).json()
    assert (failed["state"], failed["error"]["code"]) == ("failed", "no_media")
    bench.fake.outcome = PrintOutcome.PRINTED
    bench.fake.raises = OSError("Strom weg")
    unknown = bench.post(f"/v1/jobs/{new_id()}?wait=10", **as_text(payload("offen", printer="keller"))).json()
    assert (unknown["state"], unknown["error"]["code"]) == ("unknown", "interrupted")


# --- Vorschau und Bild -------------------------------------------------------------------


def test_render_returns_a_png_in_the_size_of_the_printer(tmp_path):
    narrow = FakeDriver(printable_px=472, dpi=203)
    service = PrintService(
        StaticPrinters(
            [PrinterEntry("breit", "fake", None, FakeDriver()), PrinterEntry("schmal", "fake", None, narrow)]
        ),
        fonts=Fonts.builtin(),
    )
    service.start()
    with TestClient(create_app(service, authorize=TokenAuthorizer(TOKEN), standalone=True)) as client:
        # Ohne Drucker: für den Standarddrucker des Dienstes.
        response = client.post("/v1/render", **as_text(payload()))
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        with Image.open(io.BytesIO(response.content)) as image:
            assert (image.size, image.mode) == ((696, 342), "1")
        response = client.post("/v1/render", json=payload(printer="schmal"), headers=AUTH)
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.size == (472, 231)

        # Gerendert, nicht gedruckt.
        assert narrow.calls == 0
        assert client.post("/v1/render", json=payload()).status_code == 401
        response = client.post("/v1/render", **as_text(payload(printer="dachboden")))
        assert (response.status_code, error_code(response)) == (404, "unknown_printer")
        response = client.post("/v1/render", **as_text({"template": {"schema": 9}, "data": {}}))
        assert (response.status_code, error_code(response)) == (422, "render_failed")
        response = client.post("/v1/render", **as_text({"template": load_builtin("package")}))
        assert (response.status_code, error_code(response)) == (400, "invalid_request")
        assert client.get("/v1/render").status_code == 405
    service.close()


def test_image_of_a_job_is_served_only_by_the_image_driver(bench):
    job_id = new_id()
    bench.post(f"/v1/jobs/{job_id}?wait=10", **as_text(payload()))
    response = bench.get(f"/v1/jobs/{job_id}/image")  # lesend: ohne Token
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert response.content == (bench.images / f"{job_id}.png").read_bytes()
    with Image.open(io.BytesIO(response.content)) as image:
        assert (image.size, image.mode) == ((696, 342), "1")

    other = new_id()
    bench.post(f"/v1/jobs/{other}?wait=10", **as_text(payload("am Drucker", printer="keller")))
    response = bench.get(f"/v1/jobs/{other}/image")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert bench.get(f"/v1/jobs/{new_id()}/image").status_code == 404


# --- Direktdruck aus dem Browser: CORS ---------------------------------------------------


def test_allowed_origin_may_read_the_answers(bench):
    response = bench.get("/v1/health", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["vary"] == "Origin"
    assert "access-control-allow-credentials" not in response.headers
    # Auch auf Fehlern, sonst sähe die App statt des Fehlercodes nur einen Netzfehler.
    response = bench.post(f"/v1/jobs/{new_id()}", content=b"{}", headers={"Origin": ORIGIN})
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == ORIGIN
    # Groß- und Kleinschreibung und ein Schrägstrich am Ende der Konfiguration spielen keine Rolle.
    response = bench.get("/v1/printers", headers={"Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


@pytest.mark.parametrize("origin", ["https://fremd.example", "http://stowly.home", "https://stowly.home:8443", "null"])
def test_foreign_origin_gets_an_answer_it_cannot_read(bench, origin):
    response = bench.get("/v1/health", headers={"Origin": origin})
    # Der Dienst antwortet (so erkennt die App „da, aber nicht für mich"), erlaubt das Lesen aber nicht.
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["vary"] == "Origin"


def test_request_without_origin_always_works(bench):
    response = bench.get("/v1/health")
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
    assert bench.post(f"/v1/jobs/{new_id()}?wait=5", json=payload(), headers=AUTH).status_code == 201


def test_preflight_is_answered_including_private_network_access(bench):
    response = bench.options(
        f"/v1/jobs/{new_id()}",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization, content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["access-control-allow-origin"] == ORIGIN
    methods = {method.strip() for method in response.headers["access-control-allow-methods"].split(",")}
    assert {"GET", "POST", "PUT", "DELETE"} <= methods
    allowed = {header.strip().lower() for header in response.headers["access-control-allow-headers"].split(",")}
    assert {"authorization", "content-type"} <= allowed
    assert int(response.headers["access-control-max-age"]) >= 600
    assert response.headers["access-control-allow-private-network"] == "true"
    assert "Origin" in response.headers["vary"]
    # Die Vorabanfrage braucht kein Token und reicht nichts ein.
    assert bench.service.waiting() == 0

    # Für jeden Pfad, auch für die lesenden.
    response = bench.options("/v1/health", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"})
    assert (response.status_code, response.headers["access-control-allow-origin"]) == (204, ORIGIN)


def test_preflight_from_a_foreign_origin_grants_nothing(bench):
    response = bench.options(
        "/v1/printers",
        headers={"Origin": "https://fremd.example", "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 204
    for header in (
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-allow-private-network",
    ):
        assert header not in response.headers
    # Ohne Origin (curl -X OPTIONS): eine schlichte Antwort mit den erlaubten Methoden.
    plain = bench.options("/v1/printers")
    assert plain.status_code == 204
    assert "GET" in plain.headers["allow"]


# --- Die Seite /p ------------------------------------------------------------------------


def test_page_is_served_as_one_self_contained_file(bench):
    response = bench.get("/p")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    html = response.text
    assert html == page_html()
    assert "Drucken" in html
    assert 'lang="de"' in html
    # Keine fremden Dateien: kein src, kein Stylesheet, keine Schrift, keine Adresse außer den eigenen Pfaden.
    assert not re.search(r"<(script|img|iframe|link)[^>]+(src|href)=", html)
    assert not re.search(r"https?://(?!\")", html.replace("https?:\\/\\/", ""))
    assert "/v1/health" in html and "/v1/jobs/" in html
    assert "innerHTML" not in html and "document.write" not in html and "eval(" not in html
    assert "location.href =" not in html and "location.assign" not in html and "location.replace" not in html

    # Die Seite darf nur ihr eigenes Skript ausführen und nur ihren eigenen Ursprung ansprechen.
    policy = response.headers["content-security-policy"]
    script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
    style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    for directive, source in (("script-src", script), ("style-src", style)):
        digest = base64.b64encode(hashlib.sha256(source.encode("utf-8")).digest()).decode("ascii")
        assert f"{directive} 'sha256-{digest}'" in policy
    assert "default-src 'none'" in policy
    assert "connect-src 'self'" in policy
    assert "unsafe" not in policy
    assert response.headers["referrer-policy"] == "no-referrer"
    assert bench.post("/p").status_code == 405


# --- Fehlerformat, unbekannte Pfade ------------------------------------------------------


def test_unknown_paths_and_methods_answer_in_the_error_format(bench):
    response = bench.get("/v1/gibt-es-nicht")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert response.headers["content-type"] == "application/json"
    response = bench.get("/")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    response = bench.patch(f"/v1/jobs/{new_id()}", headers=AUTH)
    assert (response.status_code, error_code(response)) == (405, "invalid_request")
    assert {"GET", "POST", "PUT", "DELETE"} <= {method.strip() for method in response.headers["allow"].split(",")}
    assert bench.post("/v1/health").status_code == 405


def test_the_token_never_appears_in_the_log(bench, caplog):
    with caplog.at_level(logging.DEBUG):
        bench.post(f"/v1/jobs/{new_id()}?wait=5", **as_text(payload()))
        bench.post(f"/v1/jobs/{new_id()}", content=b"kaputt " + TOKEN.encode(), headers=AUTH)
        bench.post(f"/v1/jobs/{new_id()}", json=payload(), headers={"Authorization": "Bearer falsch-geheim"})
        bench.get("/v1/health", params={"nonce": "n" * 20})
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert TOKEN not in logged
    assert "falsch-geheim" not in logged


# --- Eingebunden im Server ---------------------------------------------------------------


class DeviceTokens:
    """Wie der Server prüft: Jeder Aufruf braucht ein gültiges Geräte-Token, auch der lesende."""

    def __call__(self, token: str | None, *, write: bool) -> str | None:
        if token != "geraet-token":
            raise unauthorized()
        return token


@pytest.fixture
def mounted(tmp_path):
    service = PrintService(
        StaticPrinters([PrinterEntry("bild", "image", None, ImageDriver(tmp_path))]), fonts=Fonts.builtin()
    )
    service.start()
    with TestClient(create_app(service, authorize=DeviceTokens())) as client:
        yield client
    service.close()


def test_mounted_service_needs_a_token_for_every_call(mounted):
    device = {"Authorization": "Bearer geraet-token"}
    job_id = new_id()
    for method, path in (
        ("GET", "/v1/health"),
        ("GET", "/v1/printers"),
        ("GET", f"/v1/jobs/{job_id}"),
        ("GET", f"/v1/jobs/{job_id}/image"),
        ("POST", f"/v1/jobs/{job_id}"),
        ("PUT", f"/v1/jobs/{job_id}"),
        ("DELETE", f"/v1/jobs/{job_id}"),
        ("POST", f"/v1/jobs/{job_id}/cancel"),
        ("POST", "/v1/render"),
    ):
        response = mounted.request(method, path, json=payload() if method != "GET" else None)
        assert response.status_code == 401, (method, path)
        assert error_code(response) == "unauthorized"
        assert response.headers["www-authenticate"] == "Bearer"
        wrong = mounted.request(method, path, headers={"Authorization": "Bearer falsch"})
        assert wrong.status_code == 401, (method, path)

    assert mounted.get("/v1/health", headers=device).status_code == 200
    assert mounted.put(f"/v1/jobs/{job_id}?wait=5", json=payload(), headers=device).json()["state"] == "printed"
    assert mounted.get(f"/v1/jobs/{job_id}/image", headers=device).status_code == 200
    # Der Nachweis rechnet am Server mit dem Geräte-Token.
    proof = mounted.get("/v1/health", params={"nonce": "n" * 16}, headers=device).json()["proof"]
    assert proof == hmac.new(b"geraet-token", b"n" * 16, hashlib.sha256).hexdigest()


def test_mounted_service_has_neither_cors_nor_the_page(mounted):
    device = {"Authorization": "Bearer geraet-token", "Origin": ORIGIN}
    response = mounted.get("/v1/health", headers=device)
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
    assert response.json()["host"] is None
    assert mounted.get("/p", headers=device).status_code == 404
    response = mounted.options("/v1/health", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"})
    assert response.status_code == 405
    assert "access-control-allow-origin" not in response.headers


def test_token_authorizer_needs_a_token():
    with pytest.raises(ValueError):
        TokenAuthorizer("")
    check = TokenAuthorizer("richtig")
    assert check(None, write=False) == "richtig"
    assert check("richtig", write=True) == "richtig"
    for wrong in (None, "", "falsch", "richtig ", "Richtig", "richti"):
        with pytest.raises(Exception, match="Token"):
            check(wrong, write=True)
