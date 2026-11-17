"""Baut das vollständige Vertragsdokument (OpenAPI) aus den Modellen.

FastAPI kennt nur Schemata, die an einem Endpunkt hängen. Der Vertrag umfasst mehr:
den Befehlskatalog, das Fehlerformat, die Etikett-Daten und das Protokoll des
Druckdienstes (Dataclasses aus ``stowly_print.model``). Diese kommen hier dazu.
"""

from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import TypeAdapter
from pydantic.json_schema import models_json_schema

from stowly.contract.api import ErrorBody
from stowly.contract.commands import Command
from stowly.contract.entities import Model
from stowly.contract.labels import PackageLabelData, ZoneLabelData
from stowly.contract.sync import SyncRequest
from stowly_print import model as print_model

REF_TEMPLATE = "#/components/schemas/{model}"
REF_PREFIX = "#/components/schemas/"


class _PrintProtocol(Model):
    """Hilfsmodell: sammelt die Typen des Druckdienstes ein, erscheint selbst nicht im Vertrag."""

    job_request: print_model.JobRequest
    job: print_model.Job
    health: print_model.Health


# Typen des Druckdienstes heißen im Vertrag anders als im Python-Paket, damit sie sich
# nicht mit den Datensätzen des Haushalts verwechseln lassen (PrintJob ist das Etikett
# des Haushalts, ServiceJob der Auftrag beim Druckdienst).
PRINT_RENAMES: dict[str, str] = {
    "JobRequest": "ServiceJobRequest",
    "Job": "ServiceJob",
    "JobState": "ServiceJobState",
    "JobError": "ServiceJobError",
    "Health": "ServiceHealth",
    "PrinterInfo": "ServicePrinter",
    "Capabilities": "PrinterCapabilities",
    "Media": "PrinterMedia",
    "Paper": "ServicePaper",
}


def _rename_refs(node: Any, renames: dict[str, str]) -> Any:
    if isinstance(node, dict):
        result = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str) and value.startswith(REF_PREFIX):
                name = value[len(REF_PREFIX) :]
                result[key] = REF_PREFIX + renames.get(name, name)
            else:
                result[key] = _rename_refs(value, renames)
        return result
    if isinstance(node, list):
        return [_rename_refs(item, renames) for item in node]
    return node


_SUBSCHEMA_KEYS = ("items", "additionalProperties", "not")
_SUBSCHEMA_LIST_KEYS = ("anyOf", "oneOf", "allOf", "prefixItems")
_SUBSCHEMA_MAP_KEYS = ("properties", "$defs")


def _clean(schema: Any) -> Any:
    """Entfernt Beiwerk, das je nach Erzeugungsweg schwankt und nichts aussagt:
    ``title`` (steht schon im Schlüssel) und ``default: null``.

    Läuft nur über Schema-Positionen, damit ein *Feld* namens ``title`` erhalten bleibt.
    """
    if not isinstance(schema, dict):
        return schema
    result: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "title":
            continue
        if key == "default" and value is None:
            continue
        if key in _SUBSCHEMA_MAP_KEYS and isinstance(value, dict):
            result[key] = {name: _clean(sub) for name, sub in value.items()}
        elif key in _SUBSCHEMA_LIST_KEYS and isinstance(value, list):
            result[key] = [_clean(sub) for sub in value]
        elif key in _SUBSCHEMA_KEYS:
            result[key] = _clean(value)
        else:
            result[key] = value
    return result


def _add(target: dict[str, Any], name: str, schema: dict[str, Any]) -> None:
    schema = _clean(schema)
    existing = target.get(name)
    if existing is not None and existing != schema:
        raise RuntimeError(f"Schema '{name}' ist zweimal mit unterschiedlichem Inhalt definiert.")
    target[name] = schema


def extra_schemas() -> dict[str, Any]:
    """Schemata, die an keinem Endpunkt hängen."""
    schemas: dict[str, Any] = {}

    _, definitions = models_json_schema(
        [
            (SyncRequest, "validation"),
            (ErrorBody, "validation"),
            (PackageLabelData, "validation"),
            (ZoneLabelData, "validation"),
        ],
        ref_template=REF_TEMPLATE,
    )
    for name, schema in definitions.get("$defs", {}).items():
        _add(schemas, name, schema)

    # Die Befehle als eigener, benannter Typ.
    command = TypeAdapter(Command).json_schema(ref_template=REF_TEMPLATE)
    for name, schema in command.pop("$defs", {}).items():
        _add(schemas, name, schema)
    _add(schemas, "Command", command)
    schemas["SyncRequest"]["properties"]["commands"]["items"] = {"$ref": REF_PREFIX + "Command"}

    # Protokoll des Druckdienstes: Dataclasses aus stowly_print, über ein Hilfsmodell
    # eingesammelt, damit sie genauso erzeugt werden wie in den Datensätzen des Servers.
    _, definitions = models_json_schema([(_PrintProtocol, "validation")], ref_template=REF_TEMPLATE)
    for name, schema in definitions.get("$defs", {}).items():
        if name == _PrintProtocol.__name__:
            continue
        _add(schemas, PRINT_RENAMES.get(name, name), _rename_refs(schema, PRINT_RENAMES))

    return schemas


def _strip_default_validation_errors(document: dict[str, Any]) -> None:
    """FastAPI trägt an jeden Endpunkt seine eigene 422-Antwort ein. Stowly antwortet
    stattdessen im Vertragsformat (ErrorBody), also raus damit.
    """
    for operations in document.get("paths", {}).values():
        for operation in operations.values():
            if isinstance(operation, dict):
                operation.get("responses", {}).pop("422", None)
    schemas = document.get("components", {}).get("schemas", {})
    schemas.pop("HTTPValidationError", None)
    schemas.pop("ValidationError", None)


def build_openapi(app: FastAPI) -> dict[str, Any]:
    """Das Vertragsdokument: Endpunkte der App plus alle zusätzlichen Schemata."""
    document = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
        separate_input_output_schemas=False,
    )
    _strip_default_validation_errors(document)
    schemas: dict[str, Any] = {}
    for name, schema in document.get("components", {}).get("schemas", {}).items():
        _add(schemas, name, schema)
    for name, schema in extra_schemas().items():
        _add(schemas, name, schema)
    document.setdefault("components", {})["schemas"] = dict(sorted(schemas.items()))
    return document
