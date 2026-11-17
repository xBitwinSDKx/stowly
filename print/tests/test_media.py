"""Papier (docs/etiketten.md, 3.1 und 3.4): der Katalog, Papier je Auftrag und die eingelegte Rolle.

Der Katalog (``stowly_print.media``) ist eine eigene Abschrift der Tabelle von brother_ql_next, weil
der Server die Bibliothek nicht hat. Wo sie installiert ist, vergleicht ein Test beide.

Ohne Gerät und ohne Bibliothek: Der Dienst wird mit dem Bild-Treiber und mit ``RollDriver`` geprüft,
einem Treiber mit eingelegter Rolle, der sich wie der Brother-Treiber über USB verhält. Den
Brother-Treiber selbst prüft ``test_brother_ql.py``.
"""

import base64
import importlib.util
import io

import pytest
from PIL import Image
from print_support import (
    PACKAGE,
    RollDriver,
    format2,
    make_service,
    new_id,
    package_request,
    roll,
    wait_until,
)
from starlette.testclient import TestClient

from stowly_print import media as catalog
from stowly_print.drivers import BrokenDriver, PrinterConfig, build_driver
from stowly_print.drivers.base import fits, mismatch_message, paper_name, reported_paper
from stowly_print.drivers.image import ImageDriver
from stowly_print.http import TokenAuthorizer, create_app
from stowly_print.model import TEMPLATE_SCHEMAS, JobRequest, JobState, Paper, to_dict
from stowly_print.render import DEFAULT_WIDTH_PX, Fonts, for_print, mm_to_px, render
from stowly_print.service import PrinterEntry, PrintService, StaticPrinters
from stowly_print.templates import load_builtin

needs_library = pytest.mark.skipif(
    importlib.util.find_spec("brother_ql") is None,
    reason="Die Bibliothek brother_ql_next ist nicht installiert.",
)

TOKEN = "pi-geheim-0123456789"
BUILTIN = Fonts.builtin()


def finished(service: PrintService, job_id: str):
    return service.wait(job_id, 5)


# --- Katalog -----------------------------------------------------------------------------


@needs_library
def test_catalog_matches_the_label_table_of_the_library():
    from brother_ql.labels import ALL_LABELS, Color, FormFactor

    labels = {label.identifier: label for label in ALL_LABELS}
    for paper in catalog.PAPERS:
        label = labels[paper.id]
        assert label.color == Color.BLACK_WHITE, paper.id
        assert not label.restricted_to_models, paper.id
        if paper.kind == catalog.ENDLESS:
            assert label.form_factor == FormFactor.ENDLESS, paper.id
            assert label.tape_size == (paper.width_mm, 0), paper.id
            assert label.dots_printable == (paper.printable_width_px, 0), paper.id
            assert (paper.length_mm, paper.printable_length_px) == (None, None)
        else:
            assert label.form_factor == FormFactor.DIE_CUT, paper.id
            assert label.tape_size == (paper.width_mm, paper.length_mm), paper.id
            assert label.dots_printable == (paper.printable_width_px, paper.printable_length_px), paper.id

    # Vollständig: jede einfarbige, rechteckige Rolle bis 62 mm, die jedes Modell kann, außer 12 mm
    # (darauf passt kein QR-Code mit 6 Punkten je Modul).
    expected = {
        label.identifier
        for label in ALL_LABELS
        if label.color == Color.BLACK_WHITE
        and label.form_factor != FormFactor.ROUND_DIE_CUT
        and not label.restricted_to_models
        and label.tape_size[0] <= 62
    } - {"12"}
    assert {paper.id for paper in catalog.PAPERS} == expected


def test_catalog_is_consistent_in_itself():
    ids = [paper.id for paper in catalog.PAPERS]
    assert len(ids) == len(set(ids))
    assert catalog.BY_ID[catalog.DEFAULT_PAPER_ID].printable_width_px == DEFAULT_WIDTH_PX
    for paper in catalog.PAPERS:
        assert paper.kind in catalog.KINDS
        assert (paper.length_mm is None) == (paper.kind == catalog.ENDLESS)
        assert (paper.printable_length_px is None) == (paper.kind == catalog.ENDLESS)
        if paper.length_mm is not None and paper.printable_length_px is not None:
            # Gestanzt: in Laufrichtung kürzer bedruckbar, als das Etikett lang ist.
            assert paper.printable_length_px < mm_to_px(paper.length_mm, 300)
        # Was ein Drucker meldet, findet zurück zu seinem Papier.
        assert catalog.find(paper.kind, paper.width_mm, paper.length_mm) == paper
        assert catalog.mm_to_px(paper.width_mm) == mm_to_px(paper.width_mm, 300)
    assert catalog.paper("62x29").printable_length_px == 271
    assert catalog.paper("12") is None
    assert catalog.paper(None) is None


@pytest.mark.parametrize(
    ("paper_id", "length_mm", "rotated"),
    [
        ("62", 29, False),
        ("62", 62, False),
        ("62", 63, True),
        ("29", 25, False),
        ("29", 62, True),
        ("62x29", None, False),
        ("23x23", None, False),
        ("29x90", None, True),
        ("62x100", None, True),
    ],
)
def test_label_lies_across_the_roll_unless_it_is_longer_than_the_roll_is_wide(paper_id, length_mm, rotated):
    assert catalog.rotated(catalog.paper(paper_id), length_mm) is rotated
    assert format2(paper_id, length_mm)["rotate"] == (90 if rotated else 0)


def test_reported_rolls_are_mapped_to_the_catalog_or_stay_unknown():
    assert reported_paper("endless", 62, None) == Paper("62", "endless", 62.0, None)
    assert reported_paper("die_cut", 62, 29) == Paper("62x29", "die_cut", 62.0, 29.0)
    # Brother nennt manche Rollen anders, als sie messen.
    assert reported_paper("die_cut", 38, 90).id == "39x90"
    assert reported_paper("die_cut", 60, 86).id == "60x86"
    assert reported_paper("endless", 12, None) == Paper(None, "endless", 12.0, None)
    assert reported_paper("die_cut", 62, None) == Paper(None, "die_cut", 62.0, None)

    assert paper_name(roll("62")) == "62 mm endlos"
    assert paper_name(catalog.paper("29x90")) == "29 × 90 mm gestanzt"
    assert paper_name(Paper(None, "endless", 12, None)) == "12 mm endlos"
    assert paper_name(Paper(None, "die_cut", 62, None)) == "62 mm gestanzt"
    assert paper_name(Paper(None, "die_cut", 62, 50.5)) == "62 × 50,5 mm gestanzt"

    # Nur eine Rolle aus dem Katalog mit derselben Kennung passt.
    assert fits(roll("62"), catalog.paper("62"))
    assert not fits(roll("62"), catalog.paper("62x29"))
    assert not fits(Paper(None, "die_cut", 62, None), catalog.paper("62x29"))
    assert not fits(None, catalog.paper("62"))
    assert (
        mismatch_message(roll("62"), catalog.paper("29x90"))
        == "Eingelegt: 62 mm endlos; das Etikett braucht 29 × 90 mm gestanzt."
    )


# --- Papier je Auftrag -------------------------------------------------------------------


def test_job_prints_on_the_paper_its_template_names():
    driver = RollDriver(roll("29"))
    service, recorder = make_service(driver)
    job_id = new_id()
    template = format2("29", 62)
    service.submit(job_id, package_request(template=template))
    assert finished(service, job_id).state == JobState.PRINTED
    # Gedruckt für 29 mm endlos, gedreht: quer × längs, wie es der Treiber erwartet.
    assert driver.papers == ["29"]
    expected = for_print(render(template, package_request().data, fonts=BUILTIN), template)
    assert driver.printed[0].size == (306, 732)
    assert driver.printed[0].tobytes() == expected.tobytes()
    # Nach dem Auftrag wird der Zustand frisch abgefragt und weitergesagt, verglichen mit dem Papier
    # der Konfiguration (62 mm endlos), nicht mit dem des Auftrags: Dazu passt die 29-mm-Rolle nicht.
    wait_until(lambda: len(recorder.statuses) >= 1)
    assert recorder.statuses[-1][1].errors == ["media_mismatch"]
    service.close()


def test_loaded_roll_that_does_not_fit_the_job_fails_with_a_sentence():
    driver = RollDriver(roll("62"))
    service, recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request(template=format2("29x90")))
    job = finished(service, job_id)
    assert (job.state, job.error.code) == (JobState.FAILED, "media_mismatch")
    assert job.error.message == "Eingelegt: 62 mm endlos; das Etikett braucht 29 × 90 mm gestanzt."
    assert driver.printed == []
    # Der Zustand danach: verglichen mit dem Papier der Konfiguration, und dazu passt die Rolle.
    wait_until(lambda: len(recorder.statuses) >= 1)
    assert recorder.statuses[-1][1].errors == []

    # Eine Rolle, die der Katalog nicht kennt, passt zu keinem Papier.
    driver.loaded = Paper(None, "endless", 12.0, None)
    other = new_id()
    service.submit(other, package_request("zwei", template=format2("62", 29)))
    job = finished(service, other)
    assert job.error.message == "Eingelegt: 12 mm endlos; das Etikett braucht 62 mm endlos."
    service.close()


def test_template_without_paper_prints_on_the_paper_of_the_configuration():
    # Vorgabe 62 × 29 mm gestanzt: Die mitgelieferte Vorlage wird für 696 × 271 Punkte gerendert.
    driver = RollDriver(roll("62x29"), media="62x29")
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    assert finished(service, job_id).state == JobState.PRINTED
    assert driver.papers == ["62x29"]
    assert driver.printed[0].size == (696, 271)
    # Ein Format 1 mit Papier-Kennung gilt mehr als die Vorgabe: 62 mm endlos passt nicht zur Rolle.
    named = load_builtin("package")
    named["media"].update({"id": "62", "kind": "endless"})
    other = new_id()
    service.submit(other, package_request("mit Papier", template=named))
    job = finished(service, other)
    assert (job.state, job.error.code) == (JobState.FAILED, "media_mismatch")
    assert "das Etikett braucht 62 mm endlos" in job.error.message
    # Ein fertiges PNG gilt immer für die Vorgabe.
    png = io.BytesIO()
    Image.new("1", (696, 271), 1).save(png, format="PNG")
    third = new_id()
    service.submit(third, JobRequest.from_dict({"png": base64.b64encode(png.getvalue()).decode("ascii")}))
    assert finished(service, third).state == JobState.PRINTED
    assert driver.papers == ["62x29", "62x29"]
    service.close()


def test_image_driver_writes_the_png_in_the_size_of_the_paper(tmp_path):
    driver = ImageDriver(tmp_path)
    service = PrintService(StaticPrinters([PrinterEntry("bild", "image", None, driver)]), fonts=BUILTIN)
    service.start()
    for template, expected in (
        (format2("29", 62), (306, 732)),  # gedreht: quer × längs
        (format2("62x29"), (696, 271)),
        (format2("29x90"), (306, 991)),
        (format2("62", 50), (696, 590)),
        (load_builtin("package"), (696, 342)),  # ohne Papier: die Vorgabe der Konfiguration
    ):
        job_id = new_id()
        service.submit(job_id, package_request(template=template))
        assert finished(service, job_id).state == JobState.PRINTED
        with Image.open(tmp_path / f"{job_id}.png") as stored:
            assert (stored.size, stored.mode) == (expected, "1"), template["media"]
            rendered = render(template, package_request().data, fonts=BUILTIN)
            assert stored.tobytes() == for_print(rendered, template).tobytes()
    # Der Bild-Treiber hat keine Rolle: kein Abgleich, kein media_mismatch.
    info = service.printers(paper="29x90")[0]
    assert (info.loaded, info.status.errors) == (None, [])
    service.close()


def test_image_driver_with_another_paper_as_the_default(tmp_path):
    driver = build_driver(PrinterConfig(name="bild", driver="image", directory=tmp_path, media="29"))
    assert isinstance(driver, ImageDriver)
    media = driver.capabilities().media
    assert (media.id, media.kind, media.width_mm, media.printable_px) == ("29", "endless", 29.0, 306)
    service = PrintService(StaticPrinters([PrinterEntry("bild", "image", None, driver)]), fonts=BUILTIN)
    service.start()
    job_id = new_id()
    # Die mitgelieferte Vorlage (62 × 29) auf der Vorgabe 29 mm: verkleinert, nicht gedreht. Der
    # QR-Code passt dann nicht mehr mit 6 Punkten je Modul: abgelehnt statt unlesbar gedruckt.
    with pytest.raises(Exception, match="QR-Code"):
        service.submit(job_id, package_request())
    service.submit(job_id, package_request(template=format2("62x29")))
    assert finished(service, job_id).state == JobState.PRINTED
    with Image.open(tmp_path / f"{job_id}.png") as stored:
        assert stored.size == (696, 271)
    service.close()
    # Ein Papier, das der Katalog nicht kennt: Der Drucker bleibt in der Liste und meldet config.
    broken = build_driver(PrinterConfig(name="bild", driver="image", directory=tmp_path, media="63"))
    assert isinstance(broken, BrokenDriver)
    assert broken.status().errors == ["config"]


# --- Zustand: media, loaded, template_schemas --------------------------------------------


@pytest.fixture
def pi(tmp_path):
    """Der Dienst wie auf dem Pi: ein Drucker mit 62-mm-Rolle (Standard) und ein Bild-Treiber."""
    rolled = RollDriver(roll("62"))
    service = PrintService(
        StaticPrinters(
            [
                PrinterEntry("keller", "brother_ql", "QL-570", rolled),
                PrinterEntry("bild", "image", None, ImageDriver(tmp_path / "etiketten")),
            ]
        ),
        fonts=BUILTIN,
        status_ttl_s=60,
    )
    service.start()
    app = create_app(service, authorize=TokenAuthorizer(TOKEN), standalone=True)
    with TestClient(app) as client:
        client.rolled = rolled
        client.service = service
        yield client
    service.close()


def test_health_names_formats_media_and_loaded_roll(pi):
    body = pi.get("/v1/health").json()
    assert body["template_schemas"] == list(TEMPLATE_SCHEMAS) == [1, 2]
    keller, bild = body["printers"]
    assert keller["capabilities"]["media"] == {
        "width_mm": 62.0,
        "length_mm": None,
        "printable_px": 696,
        "id": "62",
        "kind": "endless",
        "printable_length_px": None,
    }
    assert keller["loaded"] == {"id": "62", "kind": "endless", "width_mm": 62.0, "length_mm": None}
    assert keller["status"]["errors"] == []
    assert bild["loaded"] is None
    assert bild["capabilities"]["media"]["id"] == "62"
    # Dasselbe in /v1/printers.
    assert pi.get("/v1/printers").json()["printers"] == body["printers"]


def test_health_compares_the_loaded_roll_with_the_paper_of_the_household(pi):
    other = pi.get("/v1/health", params={"media": "29x90"}).json()["printers"][0]
    assert other["status"] == {
        "reachable": True,
        "ready": False,
        "media_detected": True,
        "errors": ["media_mismatch"],
    }
    assert other["loaded"]["id"] == "62"
    # Das Papier der Rolle: alles gut, und ohne Angabe gilt wieder die Konfiguration (62 mm endlos).
    same = pi.get("/v1/health", params={"media": "62"}).json()["printers"][0]
    assert same["status"]["errors"] == []
    plain = pi.get("/v1/health").json()["printers"][0]
    assert plain["status"]["errors"] == []
    # Das Gerät wurde dafür einmal gefragt; verglichen wurde dieselbe Antwort.
    assert pi.rolled.probes == 1
    assert pi.rolled.compared == ["62", "29x90", "62"]


@pytest.mark.parametrize("media", ["", "63x29", "62red", "d24", "x" * 80, "62 ", "../62"])
def test_health_ignores_a_paper_it_does_not_know(pi, media):
    pi.rolled.loaded = roll("62x29")
    response = pi.get("/v1/health", params={"media": media})
    assert response.status_code == 200
    # Verglichen mit der Konfiguration, wie ohne Angabe: Die Rolle 62 × 29 passt nicht zu 62 endlos.
    assert response.json()["printers"][0]["status"]["errors"] == ["media_mismatch"]
    assert set(pi.rolled.compared) == {"62"}


def test_device_is_asked_once_whatever_paper_is_compared(pi):
    """Ein Aufrufer ohne Token (am Pi ist ``/v1/health`` offen) löst mit vielen Papieren nicht viele
    USB-Abfragen aus: je Drucker eine je Frist, der Vergleich kommt aus derselben Antwort."""
    pi.service.printers()
    assert pi.rolled.probes == 1
    for paper in [None, *(paper.id for paper in catalog.PAPERS), "unbekannt"]:
        pi.service.printers(paper=paper)
        response = pi.get("/v1/health", params={} if paper is None else {"media": paper})
        assert response.status_code == 200
    assert pi.rolled.probes == 1
    assert pi.service.printers(paper="29x90")[0].status.errors == ["media_mismatch"]
    assert pi.service.printers()[0].status.errors == []
    # Frisch gefragt wird erst wieder nach der Frist oder ausdrücklich.
    pi.service.printers(fresh=True)
    assert pi.rolled.probes == 2


def test_observer_only_learns_the_status_for_the_paper_of_the_configuration():
    """Was der Server als Zustand des Druckers festhält (PrinterStatus), springt nicht, weil jemand
    mit einem anderen Papier fragt (``?media=``) oder ein Auftrag ein anderes Papier nennt."""
    driver = RollDriver(roll("62"))
    service, recorder = make_service(driver, status_ttl_s=0)
    for paper in ("29x90", "62x29", "62", None):
        service.printers(paper=paper)
    assert [status.errors for _name, status in recorder.statuses] == [[], [], [], []]
    # Auch nach einem Auftrag für ein anderes Papier (der an der Rolle scheitert).
    job_id = new_id()
    service.submit(job_id, package_request(template=format2("29x90")))
    assert finished(service, job_id).error.code == "media_mismatch"
    wait_until(lambda: len(recorder.statuses) >= 5)
    assert recorder.statuses[-1][1].errors == []
    # Ändert sich die Rolle, erfährt er das, verglichen mit der Konfiguration.
    driver.loaded = roll("29x90")
    service.printers(paper="29x90")
    assert recorder.statuses[-1][1].errors == ["media_mismatch"]
    service.close()


def test_render_shows_the_label_as_it_is_read_in_the_size_of_its_paper(pi):
    for template, size in ((format2("29", 62), (732, 306)), (format2("62x29"), (696, 271))):
        for printer in (None, "keller", "bild"):
            response = pi.post(
                "/v1/render",
                json={"template": template, "data": PACKAGE, "printer": printer},
                headers={"Authorization": f"Bearer {TOKEN}"},
            )
            assert response.status_code == 200, response.text
            with Image.open(io.BytesIO(response.content)) as image:
                assert (image.size, image.mode) == (size, "1")
    # Ein Papier, das der Dienst nicht kennt: 422.
    template = format2("62x29")
    template["media"]["id"] = "63x29"
    response = pi.post(
        "/v1/render",
        json={"template": template, "data": PACKAGE},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert (response.status_code, response.json()["error"]["code"]) == (422, "render_failed")
    assert "63x29" in response.json()["error"]["message"]


def test_job_with_an_unknown_paper_is_not_accepted(pi):
    template = format2("62x29")
    template["rotate"] = 90
    job_id = new_id()
    response = pi.post(
        f"/v1/jobs/{job_id}",
        json={"template": template, "data": PACKAGE},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert (response.status_code, response.json()["error"]["code"]) == (422, "render_failed")
    assert pi.get(f"/v1/jobs/{job_id}").status_code == 404


def test_loaded_roll_is_part_of_the_contract_shape():
    shaped = to_dict(roll("62x29"))
    assert shaped == {"id": "62x29", "kind": "die_cut", "width_mm": 62.0, "length_mm": 29.0}
