"""Kennungen, QR-Inhalte, Barcodes und Zeit gegen die gemeinsamen Beispiele.

Dieselbe Datei (docs/vectors.json) prüft auch die Web-App: web/src/contract/vectors.test.ts.
"""

from stowly.contract import ids, timeutil


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


def test_uuids():
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


def test_effective_time(vectors):
    for case in vectors["timestamps"]["effective"]:
        received = timeutil.parse_timestamp(case["received"])
        assert timeutil.effective_time(case["at"], case["sent_at"], received) == case["effective"], case[
            "_fall"
        ]
