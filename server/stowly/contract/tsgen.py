"""Erzeugt aus dem Vertragsdokument die TypeScript-Typen der Web-App.

Bewusst ein eigener, kleiner Generator statt eines Node-Werkzeugs: Die Quelle der
Typen ist Python, also entsteht auch die abgeleitete Datei hier, und ein einziger
Test kann prüfen, ob beides zusammenpasst. Unterstützt wird genau der Teil von
JSON Schema, den pydantic für unsere Modelle erzeugt; alles andere ist ein Fehler.
"""

import json
from typing import Any

from stowly.contract import ID_POOL_TARGET, MAX_CHANGES_PER_SYNC, MAX_COMMANDS_PER_SYNC, PROTOCOL_VERSION, ids
from stowly.contract.commands import COMMAND_TYPES
from stowly.contract.limits import LIMITS
from stowly_print.model import PrinterError, ServiceError

REF_PREFIX = "#/components/schemas/"

HEADER = """\
// GENERIERT. Nicht von Hand ändern.
//
// Quelle sind die Modelle in server/stowly/contract und print/stowly_print/model.py.
// Neu erzeugen: python -m stowly.contract.export
// Der Test server/tests/test_contract.py schlägt fehl, wenn diese Datei veraltet ist.

/* eslint-disable */
"""

_PRIMITIVES = {
    "string": "string",
    "integer": "number",
    "number": "number",
    "boolean": "boolean",
    "null": "null",
}
_METHOD_ORDER = ("get", "post", "put", "patch", "delete")


class UnsupportedSchema(ValueError):
    pass


def _literal(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _is_identifier(name: str) -> bool:
    return name.isidentifier() and name.isascii()


def _union(parts: list[str]) -> str:
    unique: list[str] = []
    for part in parts:
        if part not in unique:
            unique.append(part)
    # null ans Ende: "string | null" liest sich besser als "null | string".
    unique.sort(key=lambda p: p == "null")
    return " | ".join(unique)


def _comment(description: str | None, indent: str) -> list[str]:
    if not description:
        return []
    # Python-Docstrings schreiben ``code``; in TypeScript genügt ein einfacher Backtick.
    text = description.strip().replace("``", "`").replace("*/", "*\\/")
    lines = [line.rstrip() for line in text.splitlines()]
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    return [f"{indent}/**", *[f"{indent} * {line}".rstrip() for line in lines], f"{indent} */"]


def _object_body(schema: dict[str, Any], indent: str) -> list[str]:
    required = set(schema.get("required", []))
    lines: list[str] = []
    for name, prop in schema.get("properties", {}).items():
        lines.extend(_comment(prop.get("description"), indent))
        key = name if _is_identifier(name) else _literal(name)
        optional = "" if name in required else "?"
        lines.append(f"{indent}{key}{optional}: {type_expr(prop, indent)};")
    return lines


def type_expr(schema: dict[str, Any], indent: str = "") -> str:
    """TypeScript-Ausdruck für ein (Teil-)Schema."""
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith(REF_PREFIX):
            raise UnsupportedSchema(f"Fremder Verweis: {ref}")
        return ref[len(REF_PREFIX) :]
    if "const" in schema:
        return _literal(schema["const"])
    if "enum" in schema:
        return _union([_literal(value) for value in schema["enum"]])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return _union([type_expr(sub, indent) for sub in schema[key]])
    if "allOf" in schema:
        parts = [type_expr(sub, indent) for sub in schema["allOf"]]
        return parts[0] if len(parts) == 1 else " & ".join(parts)

    kind = schema.get("type")
    if isinstance(kind, list):
        return _union([type_expr({**schema, "type": single}, indent) for single in kind])
    if kind in _PRIMITIVES:
        return _PRIMITIVES[kind]
    if kind == "array":
        items = schema.get("items")
        if not items:
            return "unknown[]"
        inner = type_expr(items, indent)
        return f"({inner})[]" if " | " in inner or " & " in inner else f"{inner}[]"
    if kind == "object":
        if "properties" in schema:
            body = _object_body(schema, indent + "  ")
            return "{\n" + "\n".join(body) + f"\n{indent}}}"
        additional = schema.get("additionalProperties", True)
        if additional is True or additional == {}:
            return "{ [key: string]: unknown }"
        if additional is False:
            return "{ [key: string]: never }"
        return f"{{ [key: string]: {type_expr(additional, indent)} }}"
    if kind is None and not ({"properties", "items"} & schema.keys()):
        return "unknown"
    raise UnsupportedSchema(f"Nicht unterstütztes Schema: {schema}")


def _declaration(name: str, schema: dict[str, Any]) -> list[str]:
    if not _is_identifier(name):
        raise UnsupportedSchema(f"Kein gültiger Typname: {name}")
    lines = _comment(schema.get("description"), "")
    if schema.get("type") == "object" and "properties" in schema:
        lines.append(f"export interface {name} {{")
        lines.extend(_object_body(schema, "  "))
        lines.append("}")
    else:
        expression = type_expr(schema)
        members = expression.split(" | ")
        if len(expression) > 90 and len(members) > 1 and "{" not in expression:
            lines.append(f"export type {name} =")
            lines.extend(f"  | {member}" for member in members[:-1])
            lines.append(f"  | {members[-1]};")
        else:
            lines.append(f"export type {name} = {expression};")
    return lines


def _endpoints(paths: dict[str, Any]) -> list[str]:
    entries: list[tuple[str, str, str]] = []
    for path, operations in paths.items():
        for method in _METHOD_ORDER:
            operation = operations.get(method)
            if operation and "operationId" in operation:
                entries.append((operation["operationId"], method.upper(), path))
    entries.sort()
    lines = [
        "/** Alle Endpunkte des Servers. Platzhalter wie {device_id} ersetzt der Aufrufer. */",
        "export const ENDPOINTS = {",
    ]
    for operation_id, method, path in entries:
        lines.append(f"  {operation_id}: {{ method: {_literal(method)}, path: {_literal(path)} }},")
    lines.append("} as const;")
    return lines


def _constants() -> list[str]:
    values: list[tuple[str, Any, str]] = [
        ("PROTOCOL_VERSION", PROTOCOL_VERSION, "Protokollversion des Sync."),
        ("ID_POOL_TARGET", ID_POOL_TARGET, "Sollgröße des ID-Vorrats je Gerät."),
        ("MAX_COMMANDS_PER_SYNC", MAX_COMMANDS_PER_SYNC, "Höchstzahl an Befehlen je Sync-Aufruf."),
        ("MAX_CHANGES_PER_SYNC", MAX_CHANGES_PER_SYNC, "Höchstzahl an Datensätzen je Sync-Antwort."),
        ("PACKAGE_ID_ALPHABET", ids.PACKAGE_ID_ALPHABET, "Zeichen einer Packungs-ID (kein I, L, O, U)."),
        ("PACKAGE_ID_LENGTH", ids.PACKAGE_ID_LENGTH, "Länge einer Packungs-ID."),
        ("QR_PACKAGE_PREFIX", ids.QR_PACKAGE_PREFIX, "Beginn des QR-Inhalts eines Packungs-Etiketts."),
        ("QR_ZONE_PREFIX", ids.QR_ZONE_PREFIX, "Beginn des QR-Inhalts eines Zonen-Etiketts."),
    ]
    lines: list[str] = []
    for name, value, description in values:
        lines.append(f"/** {description} */")
        lines.append(f"export const {name} = {_literal(value)};")
    lines.append("/**")
    lines.append(" * Eingabegrenzen des Vertrags: Zeichen bei Texten, Anzahl bei Listen, Tage bei Fristen.")
    lines.append(" * Kern und Attrappe prüfen damit, bevor ein Befehl entsteht (src/contract/input.ts).")
    lines.append(" */")
    lines.append("export const LIMITS = {")
    lines.extend(f"  {name}: {_literal(value)}," for name, value in LIMITS.items())
    lines.append("} as const;")
    lists: list[tuple[str, str, list[str], str]] = [
        (
            "SERVICE_ERROR_CODES",
            "ServiceErrorCode",
            [code.value for code in ServiceError],
            "Fehlercodes der HTTP-Antworten des Druckdienstes (docs/etiketten.md, 5.3).",
        ),
        (
            "PRINTER_ERROR_CODES",
            "PrinterErrorCode",
            [code.value for code in PrinterError],
            "Codes in `DriverStatus.errors` und als Fehler eines gescheiterten Auftrags (docs/etiketten.md, 5.5).",
        ),
    ]
    for name, type_name, items, description in lists:
        lines.append(f"/** {description} */")
        lines.append(f"export const {name} = [")
        lines.extend(f"  {_literal(item)}," for item in items)
        lines.append("] as const;")
        lines.append(f"export type {type_name} = (typeof {name})[number];")
    lines.append("/** Alle Befehlsarten des Sync. */")
    lines.append("export const COMMAND_TYPES = [")
    lines.extend(f"  {_literal(kind)}," for kind in COMMAND_TYPES)
    lines.append("] as const;")
    return lines


def generate_typescript(document: dict[str, Any]) -> str:
    """Erzeugt den Inhalt von ``web/src/contract/api.gen.ts``."""
    blocks: list[list[str]] = [_constants(), _endpoints(document.get("paths", {}))]
    schemas = document.get("components", {}).get("schemas", {})
    for name in sorted(schemas):
        blocks.append(_declaration(name, schemas[name]))
    body = "\n\n".join("\n".join(block) for block in blocks)
    return HEADER + "\n" + body + "\n"
