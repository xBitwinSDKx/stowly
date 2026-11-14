"""Kennungen, QR-Inhalte, Barcodes und Zeit gegen die gemeinsamen Beispiele.

Dieselbe Datei (docs/vectors.json) prüft auch die Web-App: web/src/contract/vectors.test.ts.
"""

from datetime import UTC, date, datetime, timedelta

import pytest
from pydantic import TypeAdapter, ValidationError

from stowly.contract import api, entities, ids, mhd, timeutil
from stowly.contract.commands import COMMAND_TYPES


def test_package_ids(vectors):
    data = vectors["package_ids"]
    for value in data["valid"]:
        assert ids.is_package_id(value), value
    for value in data["invalid"]:
        assert not ids.is_package_id(value), value
    for case in data["normalize"]:
        assert ids.normalize_package_id(case["input"]) == case["output"], case


def test_random_package_ids_use_the_alphabet():
    assert len(ids.PACKAGE_ID_ALPHABET) == 32
    assert len(set(ids.PACKAGE_ID_ALPHABET)) == 32
    assert not set("ILOU") & set(ids.PACKAGE_ID_ALPHABET)
    seen = {ids.random_package_id() for _ in range(500)}
    assert all(ids.is_package_id(value) for value in seen)
    assert len(seen) > 490


def test_uuids(vectors):
    data = vectors["uuids"]
    for value in data["valid"]:
        assert ids.is_uuid(value), value
    for value in data["invalid"]:
        assert not ids.is_uuid(value), value
    value = ids.new_uuid()
    assert ids.is_uuid(value)
    assert not ids.is_uuid(value.upper())
    assert not ids.is_uuid(value.replace("-", ""))


def test_qr_contents(vectors):
    data = vectors["qr"]
    for case in data["package"]:
        assert ids.package_qr(case["id"]) == case["text"]
        assert ids.parse_qr(case["text"]) == ("package", case["id"])
    for case in data["zone"]:
        assert ids.zone_qr(case["id"]) == case["text"]
        assert ids.parse_qr(case["text"]) == ("zone", case["id"])
    for case in data["parse"]:
        expected = None if case["kind"] is None else (case["kind"], case["id"])
        assert ids.parse_qr(case["text"]) == expected, case


def test_package_qr_fits_version_1_at_level_q(vectors):
    """16 alphanumerische Zeichen sind die Grenze für QR-Version 1 mit Fehlerkorrektur Q."""
    alphanumeric = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")
    for case in vectors["qr"]["package"]:
        assert len(case["text"]) <= 16
        assert set(case["text"]) <= alphanumeric
    for case in vectors["qr"]["zone"]:
        assert len(case["text"]) <= 47  # Version 3, Fehlerkorrektur Q
        assert set(case["text"]) <= alphanumeric


def test_barcodes(vectors):
    data = vectors["barcodes"]
    for value in data["valid"]:
        assert ids.is_valid_barcode(value), value
    for value in data["invalid"]:
        assert not ids.is_valid_barcode(value), value
    for case in data["normalize"]:
        assert ids.normalize_barcode(case["input"]) == case["output"], case
    for case in data["store_internal"]:
        assert ids.is_store_internal_barcode(case["code"]) is case["internal"], case


def test_timestamps(vectors):
    data = vectors["timestamps"]
    for value in data["valid"]:
        assert timeutil.is_timestamp(value), value
        assert timeutil.format_timestamp(timeutil.parse_timestamp(value)) == value
    for value in data["invalid"]:
        assert not timeutil.is_timestamp(value), value
    for value in data["dates_valid"]:
        assert timeutil.is_date(value), value
    for value in data["dates_invalid"]:
        assert not timeutil.is_date(value), value
    assert timeutil.is_timestamp(timeutil.now())
    for value in data["times_of_day_valid"]:
        assert timeutil.is_time_of_day(value), value
    for value in data["times_of_day_invalid"]:
        assert not timeutil.is_time_of_day(value), value
    for value in data["months_valid"]:
        assert timeutil.is_month(value), value
    for value in data["months_invalid"]:
        assert not timeutil.is_month(value), value


def test_effective_time(vectors):
    for case in vectors["timestamps"]["effective"]:
        received = timeutil.parse_timestamp(case["received"])
        assert timeutil.effective_time(case["at"], case["sent_at"], received) == case["effective"], case[
            "_fall"
        ]


@pytest.mark.parametrize(
    ("kind", "section", "key"),
    [
        (entities.PackageId, "package_ids", "valid"),
        (entities.Uuid, "uuids", "valid"),
        (entities.Barcode, "barcodes", "valid"),
        (entities.Timestamp, "timestamps", "valid"),
        (entities.DateStr, "timestamps", "dates_valid"),
        (entities.TimeOfDay, "timestamps", "times_of_day_valid"),
        (api.Month, "timestamps", "months_valid"),
    ],
)
def test_the_patterns_of_the_models_are_as_strict_as_the_functions(vectors, kind, section, key):
    """Die Muster stehen im Vertrag (docs/openapi.json) und prüfen in den Modellen die Form.

    Sie nehmen jedes gültige Beispiel an und lehnen dasselbe Beispiel ab, sobald ein
    Zeilenende dazukommt oder eine Ziffer vollbreit geschrieben ist.
    """
    adapter = TypeAdapter(kind)

    def accepted(value: str) -> bool:
        try:
            adapter.validate_python(value)
        except ValidationError:
            return False
        return True

    for value in vectors[section][key]:
        assert accepted(value), value
        assert not accepted(value + "\n"), value
        assert not accepted("\n" + value), value
        digit = next((char for char in value if char in "0123456789"), None)
        if digit is not None:
            wide = value.replace(digit, chr(0xFF10 + int(digit)), 1)
            assert not accepted(wide), wide


def test_checks_answer_false_instead_of_raising():
    """Auch Unsinn ergibt ``False``, keinen Fehler."""
    wide_four, arabic_four = chr(0xFF14), chr(0x0664)
    strange = [
        "4006381333931\n",
        "\n",
        wide_four * 13,
        arabic_four * 8,
        "",
        " ",
        "x" * 13,
        "9638507" + wide_four,
    ]
    for value in strange:
        assert ids.is_valid_barcode(value) is False, value
        assert ids.is_package_id(value) is False, value
        assert ids.is_uuid(value) is False, value
        assert timeutil.is_timestamp(value) is False, value
        assert timeutil.is_date(value) is False, value
        assert ids.parse_qr(value) is None, value


def test_timestamps_always_have_a_four_digit_year():
    """``strftime("%Y")`` schriebe Jahre vor 1000 je nach System ohne führende Nullen."""
    early = datetime(999, 1, 2, 3, 4, 5, 6000, tzinfo=UTC)
    assert timeutil.format_timestamp(early) == "0999-01-02T03:04:05.006Z"
    assert timeutil.format_timestamp(datetime(1, 1, 1, tzinfo=UTC)) == "0001-01-01T00:00:00.000Z"
    assert timeutil.parse_timestamp("0999-01-02T03:04:05.006Z") == early


# --- MHD (Protokoll 3.2): dieselben Fälle prüft web/src/contract/vectors.test.ts ------------


def test_days_until(vectors):
    data = vectors["mhd"]
    for case in data["days_until"]:
        assert mhd.days_until(case["best_before"], case["today"]) == case["days"], case
    for case in data["days_until_invalid"]:
        with pytest.raises(ValueError):
            mhd.days_until(case["best_before"], case["today"])


def test_expiry_state(vectors):
    for case in vectors["mhd"]["expiry_state"]:
        assert mhd.expiry_state(case["best_before"], case["warn_days"], case["today"]) == case["state"], case


def test_warn_days_for(vectors):
    for case in vectors["mhd"]["warn_days_for"]:
        assert mhd.warn_days_for(case["product"], case["settings"]) == case["warn_days"], case


def test_entry_into_soon_and_expired(vectors):
    """Eintritt in „bald" = MHD − Vorlaufzeit, in „abgelaufen" = MHD + 1 Tag, passend zu expiry_state."""
    for case in vectors["mhd"]["entry"]:
        best_before, warn_days = case["best_before"], case["warn_days"]
        soon, expired = mhd.soon_from(best_before, warn_days), mhd.expired_from(best_before)
        assert (soon, expired) == (case["soon_from"], case["expired_from"]), case
        if best_before is None:
            continue
        assert mhd.expiry_state(best_before, warn_days, soon) == "soon", case
        if soon != "0001-01-01":
            before = (date.fromisoformat(soon) - timedelta(days=1)).isoformat()
            assert mhd.expiry_state(best_before, warn_days, before) == "ok", case
        if expired is not None:
            assert mhd.expiry_state(best_before, warn_days, expired) == "expired", case
            assert mhd.expiry_state(best_before, warn_days, best_before) == "soon", case


# --- Automatische Einträge (Protokoll 7.6): die Form der Fälle ------------------------------
# Das Verhalten prüft der Server gegen dieselben Fälle (Runde 1); hier nur, dass die Fälle in
# sich stimmen und nur Befehle des Katalogs benutzen.

_STEP_KEYS = {
    "product.create": {"product", "name", "min_stock"},
    "product.update": {"product", "changes"},
    "product.merge": {"source", "target"},
    "package.create": {"package", "product", "best_before"},
    "package.remove": {"package", "reason"},
    "package.restore": {"package"},
    "package.update": {"package", "changes"},
    "shopping_item.create": {"item", "product", "text", "quantity"},
    "shopping_item.update": {"item", "auto", "pick", "changes"},
    "shopping_item.delete": {"item", "auto", "pick"},
}


def test_the_cases_for_automatic_entries_are_well_formed(vectors):
    cases = vectors["shopping_auto"]["cases"]
    assert len(cases) >= 15
    names = [case["name"] for case in cases]
    assert len(set(names)) == len(names)
    for case in cases:
        received, last_at = -1, {}
        for step in case["steps"]:
            if "expect" in step:
                assert set(step) == {"expect"}, case["name"]
                for entry in step["expect"]:
                    assert ("product" in entry) != ("text" in entry), case["name"]
                    assert entry["origin"] in {"manual", "min_stock"}, case["name"]
                    assert entry["state"] in {"open", "done", "deleted"}, case["name"]
                    assert entry["quantity"] is None or entry["quantity"] >= 1, case["name"]
                continue
            command = step["cmd"]
            assert command in COMMAND_TYPES and command in _STEP_KEYS, (case["name"], command)
            assert set(step) - {"at", "cmd", "device", "received", "_fall"} <= _STEP_KEYS[command], step
            arrives = step.get("received", step["at"])
            assert arrives >= received and arrives >= step["at"], (case["name"], step)
            received = arrives
            device = step.get("device", "A")
            assert step["at"] > last_at.get(device, -1), (case["name"], step)
            last_at[device] = step["at"]
