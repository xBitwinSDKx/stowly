"""Der Vertrag als Code: Modelle, erzeugte Dateien, Fehlerformat.

Diese Datei gehört zum Vertrag und wird in den Runden nicht geändert.

``test_generated_files_are_current`` ist die Sperre gegen stilles Auseinanderlaufen:
Er schlägt fehl, sobald sich Endpunkte oder Modelle gegenüber ``docs/openapi.json``
und ``web/src/contract/api.gen.ts`` geändert haben. Dann wurde der Vertrag geändert.
"""

import json

import pytest
from pydantic import TypeAdapter, ValidationError

from stowly.contract import PROTOCOL_VERSION, export
from stowly.contract.commands import COMMAND_TYPES, Command
from stowly.contract.sync import SyncRequest, SyncResponse

COMMAND = TypeAdapter(Command)
ID = "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b"
OTHER = "9d1c7a52-0b3e-4f68-a1d4-5e6f7a8b9c0d"
AT = "2026-11-13T10:15:30.123Z"


def command(type_: str, /, **payload):
    return COMMAND.validate_python({"id": ID, "at": AT, "type": type_, **payload})


def test_generated_files_are_current():
    stale = [str(path.relative_to(export.REPO_ROOT)) for path in export.stale_files()]
    assert stale == [], (
        "Vertrag geändert: Modelle oder Endpunkte passen nicht mehr zu den erzeugten Dateien. "
        "Vertragsänderungen macht nur der Coordinator (python -m stowly.contract.export)."
    )


def test_openapi_lists_every_endpoint_and_command():
    document = json.loads(export.OPENAPI_PATH.read_text(encoding="utf-8"))
    operations = {
        (method.upper(), path)
        for path, item in document["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    assert operations == {
        ("GET", "/api/health"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/logout"),
        ("GET", "/api/devices"),
        ("PATCH", "/api/devices/{device_id}"),
        ("DELETE", "/api/devices/{device_id}"),
        ("POST", "/api/sync"),
        ("GET", "/api/lookup/{barcode}"),
        ("GET", "/api/images/{image_id}"),
        ("GET", "/api/backup"),
        ("GET", "/api/events"),
        # Stufe 2
        ("GET", "/api/stats"),
        ("GET", "/api/ha/summary"),
        ("GET", "/api/ha/stock"),
        ("GET", "/api/push/key"),
        ("PUT", "/api/push/subscription"),
        ("DELETE", "/api/push/subscription"),
        ("POST", "/api/push/test"),
        ("GET", "/api/integrations"),
        # Updates über GitHub
        ("POST", "/api/update/check"),
        ("POST", "/api/update/install"),
    }
    mapping = document["components"]["schemas"]["Command"]["discriminator"]["mapping"]
    assert sorted(mapping) == sorted(COMMAND_TYPES)
    assert "HTTPValidationError" not in document["components"]["schemas"]


def test_openapi_has_no_dangling_references():
    document = json.loads(export.OPENAPI_PATH.read_text(encoding="utf-8"))
    schemas = document["components"]["schemas"]
    references: set[str] = set()

    def collect(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "$ref":
                    references.add(value)
                else:
                    collect(value)
        elif isinstance(node, list):
            for item in node:
                collect(item)

    collect(document)
    assert references, "Das Dokument enthält keine Verweise?"
    for reference in references:
        assert reference.startswith("#/components/schemas/"), reference
        assert reference.rsplit("/", 1)[-1] in schemas, reference
    # Typen, die an keinem Endpunkt hängen, aber zum Vertrag gehören
    for name in (
        "Command",
        "ErrorBody",
        "PackageLabelData",
        "ZoneLabelData",
        "ServiceJobRequest",
        "ServiceJob",
        "ServiceHealth",
    ):
        assert name in schemas, name


def test_every_command_type_parses():
    samples = {
        "product.create": {"product_id": ID},
        "product.update": {"product_id": ID, "changes": {"name": "Basmati Reis"}},
        "product.add_barcode": {"product_id": ID, "barcode": "4006381333931"},
        "product.remove_barcode": {"product_id": ID, "barcode": "96385074"},
        "product.merge": {"source_id": ID, "target_id": OTHER},
        "package.create": {"package_id": "A2B3C", "product_id": ID, "zone_id": OTHER},
        "package.update": {"package_id": "A2B3C", "changes": {"best_before": "2027-03-25"}},
        "package.remove": {"package_id": "A2B3C", "reason": "consumed"},
        "package.restore": {"package_id": "A2B3C"},
        "zone.create": {"zone_id": ID, "name": "Keller"},
        "zone.update": {"zone_id": ID, "changes": {"sort": 3}},
        "zone.delete": {"zone_id": ID, "move_to": OTHER},
        "settings.update": {"changes": {"zone_mode": "equal"}},
        "printer.create": {
            "printer_id": ID,
            "name": "Keller",
            "connection": "direct",
            "direct": {"urls": ["https://10.71.83.1:8443"], "token": "t", "printer": None},
        },
        "printer.update": {"printer_id": ID, "changes": {"name": "Kellerdrucker"}},
        "printer.delete": {"printer_id": ID},
        "printer.report": {
            "printer_id": ID,
            "boot_id": "b1",
            "status": {"reachable": True, "ready": True, "media_detected": None, "errors": []},
            "host": {"temperature_c": 48.2},
        },
        "print.request": {"job_id": ID, "kind": "package", "package_id": "A2B3C"},
        "print.report": {"job_id": ID, "state": "printed"},
        "shopping_item.create": {"item_id": ID, "product_id": OTHER},
        "shopping_item.update": {"item_id": ID, "changes": {"done": True}},
        "shopping_item.delete": {"item_id": ID},
    }
    assert tuple(samples) == COMMAND_TYPES
    for kind, payload in samples.items():
        assert command(kind, **payload).type == kind


def test_changes_distinguish_absent_from_null():
    """Nur vorhandene Schlüssel werden geändert; null ist ein Wert."""
    cleared = command("package.update", package_id="A2B3C", changes={"best_before": None})
    assert cleared.changes.model_fields_set == {"best_before"}
    assert cleared.changes.best_before is None

    moved = command("package.update", package_id="A2B3C", changes={"zone_id": OTHER})
    assert moved.changes.model_fields_set == {"zone_id"}

    # Felder, die nie null sein dürfen, lehnen null ab, dürfen aber fehlen.
    for kind, key, payload in [
        ("package.update", "zone_id", {"package_id": "A2B3C"}),
        ("package.update", "product_id", {"package_id": "A2B3C"}),
        ("product.update", "name", {"product_id": ID}),
        ("zone.update", "name", {"zone_id": ID}),
        ("zone.update", "sort", {"zone_id": ID}),
        ("settings.update", "zone_mode", {}),
        ("settings.update", "warn_days", {}),
        ("settings.update", "notify_time", {}),
        ("printer.update", "name", {"printer_id": ID}),
        ("shopping_item.update", "text", {"item_id": ID}),
        ("shopping_item.update", "done", {"item_id": ID}),
    ]:
        with pytest.raises(ValidationError):
            command(kind, changes={key: None}, **payload)
        assert command(kind, changes={}, **payload).changes.model_fields_set == set()

    # Felder, bei denen null ein Wert ist.
    for kind, key, payload in [
        ("product.update", "warn_days", {"product_id": ID}),
        ("product.update", "min_stock", {"product_id": ID}),
        ("zone.update", "color", {"zone_id": ID}),
        ("zone.update", "printer_id", {"zone_id": ID}),
        ("settings.update", "primary_zone_id", {}),
        ("settings.update", "default_printer_id", {}),
        ("shopping_item.update", "quantity", {"item_id": ID}),
    ]:
        assert command(kind, changes={key: None}, **payload).changes.model_fields_set == {key}


def test_commands_of_protocol_1_stay_valid():
    """Eine alte App (Protokoll 1) schickt nach dem Aktualisieren ihre Outbox: Alles Neue ist optional."""
    created = command("product.create", product_id=ID, name="Reis", warn_days=None, barcodes=[])
    assert created.min_stock is None and "min_stock" not in created.model_fields_set
    updated = command("product.update", product_id=ID, changes={"warn_days": 3})
    assert updated.changes.model_fields_set == {"warn_days"}
    settings = command("settings.update", changes={"warn_days": 7})
    assert settings.changes.model_fields_set == {"warn_days"}


@pytest.mark.parametrize(
    "kind, payload",
    [
        ("package.create", {"package_id": "A2B3U", "product_id": ID, "zone_id": OTHER}),  # U gibt es nicht
        ("package.create", {"package_id": "a2b3c", "product_id": ID, "zone_id": OTHER}),
        ("package.create", {"package_id": "A2B3C", "product_id": "kein-uuid", "zone_id": OTHER}),
        (
            "package.create",
            {"package_id": "A2B3C", "product_id": ID, "zone_id": OTHER, "best_before": "25.03.2027"},
        ),
        (
            "package.create",
            {"package_id": "A2B3C", "product_id": ID, "zone_id": OTHER, "bestBefore": "2027-03-25"},
        ),
        ("package.remove", {"package_id": "A2B3C", "reason": "verschenkt"}),
        ("package.update", {"package_id": "A2B3C", "changes": {"menge": 3}}),
        ("product.add_barcode", {"product_id": ID, "barcode": "12345"}),
        ("zone.create", {"zone_id": ID, "name": ""}),
        ("printer.create", {"printer_id": ID, "name": "x", "connection": "direct"}),
        (
            "printer.create",
            {
                "printer_id": ID,
                "name": "x",
                "connection": "server",
                "direct": {"urls": ["http://a"], "token": "t", "printer": None},
            },
        ),
        ("print.request", {"job_id": ID, "kind": "package", "zone_id": OTHER}),
        ("print.request", {"job_id": ID, "kind": "zone"}),
        ("product.create", {"product_id": ID, "min_stock": 0}),
        ("product.update", {"product_id": ID, "changes": {"min_stock": 1000}}),
        ("settings.update", {"changes": {"notify_time": "7:00"}}),
        ("settings.update", {"changes": {"notify_time": "24:00"}}),
        ("settings.update", {"changes": {"notify_time": "17:00\n"}}),
        ("shopping_item.create", {"item_id": ID}),  # weder Produkt noch Text
        ("shopping_item.create", {"item_id": ID, "product_id": OTHER, "text": "Milch"}),  # beides
        ("shopping_item.create", {"item_id": ID, "text": "Milch", "origin": "min_stock"}),
        ("shopping_item.create", {"item_id": ID, "text": "Milch", "quantity": 0}),
        ("shopping_item.update", {"item_id": ID, "changes": {"text": ""}}),
        ("shopping_item.update", {"item_id": ID, "changes": {"done_at": AT}}),
        ("unbekannt.befehl", {}),
    ],
)
def test_invalid_commands_are_rejected(kind, payload):
    with pytest.raises(ValidationError):
        command(kind, **payload)


def test_command_envelope_is_strict():
    with pytest.raises(ValidationError):
        COMMAND.validate_python(
            {"id": ID, "at": "2026-11-13T10:15:30Z", "type": "package.restore", "package_id": "A2B3C"}
        )
    with pytest.raises(ValidationError):
        COMMAND.validate_python({"id": "x", "at": AT, "type": "package.restore", "package_id": "A2B3C"})


def test_sync_request_and_response_round_trip():
    request = SyncRequest.model_validate(
        {
            "protocol": PROTOCOL_VERSION,
            "dataset_id": None,
            "cursor": 0,
            "sent_at": AT,
            "commands": [
                {"id": ID, "at": AT, "type": "package.remove", "package_id": "A2B3C", "reason": "discarded"}
            ],
            "id_pool": {"have": 12},
        }
    )
    assert request.commands[0].type == "package.remove"

    response = SyncResponse.model_validate(
        {
            "protocol": PROTOCOL_VERSION,
            "dataset_id": ID,
            "server_time": AT,
            "results": [{"id": ID, "status": "applied", "code": None, "message": None, "duplicate": False}],
            "reset": True,
            "changes": {
                "products": [],
                "zones": [],
                "packages": [
                    {
                        "id": "A2B3C",
                        "product_id": ID,
                        "zone_id": OTHER,
                        "best_before": None,
                        "created_at": AT,
                        "updated_at": AT,
                        "removed_at": AT,
                        "removal_reason": "discarded",
                        "displaced": {"at": AT, "changes": [{"field": "best_before", "value": "2027-03-25"}]},
                    }
                ],
                "printers": [],
                "printer_status": [],
                "print_jobs": [],
                "label_templates": [],
                "shopping_items": [
                    {
                        "id": OTHER,
                        "product_id": ID,
                        "text": "",
                        "quantity": 2,
                        "origin": "min_stock",
                        "done_at": None,
                        "deleted_at": None,
                        "created_at": AT,
                        "updated_at": AT,
                    }
                ],
                "settings": None,
            },
            "cursor": 7,
            "has_more": False,
            "id_pool": {"grant": ["7K9QX"], "target": 300},
            "lookup_enabled": True,
        }
    )
    dumped = response.model_dump(mode="json")
    assert dumped["changes"]["packages"][0]["displaced"]["changes"][0] == {
        "field": "best_before",
        "value": "2027-03-25",
    }
    assert SyncResponse.model_validate(dumped) == response


def test_validation_errors_use_the_error_format(client):
    response = client.post("/api/auth/login", json={"password": ""})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert {tuple(problem["loc"]) for problem in error["details"]["errors"]} == {
        ("body", "password"),
        ("body", "device_name"),
    }


def test_wrong_method_uses_the_error_format(client):
    response = client.put("/api/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "method, path",
    [
        ("GET", "/api/stats"),
        ("GET", "/api/push/key"),
        ("DELETE", "/api/push/subscription"),
        ("POST", "/api/push/test"),
        ("GET", "/api/integrations"),
    ],
)
def test_the_endpoints_of_stage_2_need_a_device_token(client, method, path):
    """Alles außer dem Sensor gilt nur mit Geräte-Token (docs/sync-protokoll.md, Abschnitt 11)."""
    response = client.request(method, path)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert response.headers["www-authenticate"] == "Bearer"


def test_limits_are_one_place_for_models_and_web_app():
    """``LIMITS`` steht in ``limits.py``; die Modelle und ``api.gen.ts`` lesen es von dort."""
    from stowly.contract.entities import DirectPrinterConfig, Product, Zone
    from stowly.contract.limits import LIMITS
    from stowly.contract.tsgen import generate_typescript

    generated = generate_typescript({"paths": {}, "components": {"schemas": {}}})
    for name, value in LIMITS.items():
        assert f"  {name}: {value}," in generated

    def max_length(model, field):
        return next(m.max_length for m in model.model_fields[field].metadata if hasattr(m, "max_length"))

    assert max_length(Product, "name") == LIMITS["product_name"]
    assert max_length(Zone, "name") == LIMITS["zone_name"]
    assert max_length(DirectPrinterConfig, "urls") == LIMITS["printer_urls"]
    with pytest.raises(ValidationError):
        command("product.create", product_id=ID, barcodes=["4006381333931"] * (LIMITS["barcodes"] + 1))
    with pytest.raises(TypeError):
        LIMITS["product_name"] = 1  # type: ignore[index]
