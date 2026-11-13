import base64
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from stowly_print import (
    FINAL_STATES,
    Capabilities,
    DriverStatus,
    Health,
    HostHealth,
    Job,
    JobError,
    JobRequest,
    JobState,
    Media,
    PrinterError,
    PrinterInfo,
    ServiceError,
    to_dict,
)
from stowly_print.drivers import Driver

TEMPLATE = {"schema": 1, "name": "t", "elements": []}


def _png_1x1() -> str:
    buffer = io.BytesIO()
    Image.new("1", (1, 1), 1).save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


PNG_1X1 = _png_1x1()


def test_package_needs_neither_pydantic_nor_fastapi():
    """Auf dem Pi gibt es beides nicht (docs/recherche.md, Abschnitt 6)."""
    code = (
        "import sys, stowly_print, stowly_print.drivers, stowly_print.templates;"
        "bad = [m for m in ('pydantic', 'fastapi', 'starlette') if m in sys.modules];"
        "print(','.join(bad))"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert result.stdout.strip() == ""


def test_job_states():
    assert [s.value for s in JobState] == ["queued", "printing", "printed", "sent", "failed", "unknown"]
    assert JobState.QUEUED not in FINAL_STATES
    assert JobState.PRINTING not in FINAL_STATES
    assert {s.value for s in FINAL_STATES} == {"printed", "sent", "failed", "unknown"}


def test_job_request_with_template():
    request = JobRequest.from_dict(
        {"template": TEMPLATE, "data": {"id": "A2B3C"}, "token": "wird ignoriert", "expect_boot_id": "b1"}
    )
    assert request.printer is None
    assert request.copies == 1
    assert request.cut is True
    assert request.expect_boot_id == "b1"
    assert request.data == {"id": "A2B3C"}


def test_job_request_with_png():
    request = JobRequest.from_dict({"png": PNG_1X1, "printer": "ql800", "copies": 2})
    assert request.template is None
    assert request.printer == "ql800"
    assert request.copies == 2


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        {},
        {"template": TEMPLATE},
        {"data": {"id": "A2B3C"}},
        {"template": TEMPLATE, "data": {"id": 5}},
        {"template": TEMPLATE, "data": {"id": "x" * 501}},
        {"template": TEMPLATE, "data": {}, "png": PNG_1X1},
        {"png": "kein base64!"},
        {"png": base64.b64encode(b"kein png").decode("ascii")},
        {"template": TEMPLATE, "data": {}, "copies": 0},
        {"template": TEMPLATE, "data": {}, "copies": 21},
        {"template": TEMPLATE, "data": {}, "copies": True},
        {"template": TEMPLATE, "data": {}, "cut": "ja"},
        {"template": TEMPLATE, "data": {}, "printer": ""},
        {"template": TEMPLATE, "data": {}, "expect_boot_id": 7},
    ],
)
def test_job_request_rejects_invalid_payloads(raw):
    with pytest.raises(ValueError):
        JobRequest.from_dict(raw)


def test_content_hash_ignores_boot_id_and_key_order():
    a = JobRequest.from_dict({"template": TEMPLATE, "data": {"a": "1", "b": "2"}})
    b = JobRequest.from_dict({"data": {"b": "2", "a": "1"}, "template": TEMPLATE, "expect_boot_id": "x"})
    c = JobRequest.from_dict({"template": TEMPLATE, "data": {"a": "1", "b": "3"}})
    assert a.content_hash() == b.content_hash()
    assert a.content_hash() != c.content_hash()


def test_to_dict_is_json_serialisable():
    health = Health(
        app="stowly-print",
        version="0.1.0",
        protocol=1,
        boot_id="b1",
        uptime_s=12.5,
        proof=None,
        host=HostHealth(temperature_c=48.2),
        printers=[
            PrinterInfo(
                name="ql800",
                driver="brother_ql",
                model="QL-800",
                capabilities=Capabilities(
                    dpi=300,
                    media=Media(width_mm=62, length_mm=None, printable_px=696),
                    cutter=True,
                    colors=["black"],
                    status_query=True,
                    confirms_print=True,
                ),
                status=DriverStatus(reachable=True, ready=True, media_detected=True, errors=[]),
            )
        ],
    )
    plain = to_dict(health)
    assert json.loads(json.dumps(plain)) == plain
    assert plain["host"]["undervoltage"] is None
    assert plain["printers"][0]["capabilities"]["media"]["printable_px"] == 696
    assert plain["printers"][0]["status"]["errors"] == []

    job = Job(
        id="j1",
        state=JobState.FAILED,
        printer="ql800",
        boot_id="b1",
        error=JobError("no_media", "leer"),
        position=None,
    )
    assert to_dict(job) == {
        "id": "j1",
        "state": "failed",
        "printer": "ql800",
        "boot_id": "b1",
        "error": {"code": "no_media", "message": "leer"},
        "position": None,
    }


def test_driver_protocol_is_structural():
    class Fake:
        def capabilities(self):
            raise NotImplementedError

        def status(self):
            raise NotImplementedError

        def print(self, image, cut=True):
            raise NotImplementedError

    assert isinstance(Fake(), Driver)
    assert not isinstance(object(), Driver)


def test_error_codes_match_the_contract_document():
    """Die Codes im Code und in docs/etiketten.md sind dieselben (Abschnitte 5.3 und 5.5)."""
    document = (Path(__file__).resolve().parents[2] / "docs" / "etiketten.md").read_text(encoding="utf-8")
    after_head = document.split("| HTTP | `code` | Wann |", 1)[1].splitlines()
    rows = [line for line in after_head[: after_head.index("", 1)] if line.startswith(("| 4", "| 5"))]
    in_table = {line.split("|")[2].strip().strip("`") for line in rows}
    assert in_table == {code.value for code in ServiceError}

    status_line = next(
        line for line in document.splitlines() if line.startswith("Zustand eines Druckers (`DriverStatus`)")
    )
    listed = status_line.split("mit diesen Codes:", 1)[1].split(".", 1)[0]
    assert [part.strip().strip("`") for part in listed.split(",")] == [code.value for code in PrinterError]
