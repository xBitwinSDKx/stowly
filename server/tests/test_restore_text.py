"""Zurückspielen: Jeder Text einer Sicherung muss gültiges UTF-8 sein (Sicherheitsprüfung 0.5.0).

SQLite nimmt in einer Spalte TEXT auch ungültige Bytes an, und Python scheitert erst beim Lesen, etwa beim
Start nach dem Tausch (``off.reconcile``, ``db.seed_defaults``). Eine gefälschte Sicherung verhinderte so jeden
Start, auch das Rückgängigmachen. Die Prüfung (``restore.examine``, für beide Arten des Zurückspielens) liest
deshalb jeden Text als Bytes und lehnt ab, was kein strenges UTF-8 ist: ``damaged``.
"""

import logging
import sqlite3
from pathlib import Path

import pytest
from support import TEST_PASSWORD, Device
from test_restore import apply, armed, check, checked, fresh, reason, server, stowly_file, uploaded

from stowly import db, off, restore, scheduler
from stowly.app import prepare_database
from stowly.contract.api import RestoreState
from stowly.errors import ApiError

__all__ = ["fresh"]  # die Fixture aus test_restore: ein neuer Rechner ohne Passwort

NOW = "2026-01-01T00:00:00.000Z"
BAD = "CAST(X'41FF42' AS TEXT)"  # ungültiges UTF-8 in einer Spalte TEXT (STRICT lässt es zu)
SURROGATE = "CAST(X'EDA080' AS TEXT)"  # ein kodiertes Surrogat: für SQLite Text, für Python kein UTF-8
PRODUCT = "11111111-1111-4111-8111-111111111111"

# Die Fälle der Nachprüfung (exp13) und weitere Tabellen, die beim Start oder ersten Start gelesen werden.
FORGERIES = {
    "P1 products.id, wartet auf das Nachschlagen": [
        f"INSERT INTO products (id, name, lookup, created_at, updated_at, rev) "
        f"VALUES ({BAD}, 'P', 'pending', '{NOW}', '{NOW}', 1)"
    ],
    "P2 product_barcodes.barcode": [
        f"INSERT INTO products (id, name, lookup, created_at, updated_at, rev) "
        f"VALUES ('{PRODUCT}', 'P', 'none', '{NOW}', '{NOW}', 1)",
        f"INSERT INTO product_barcodes (barcode, product_id, created_at) VALUES ({BAD}, '{PRODUCT}', '{NOW}')",
    ],
    "Z zones.id, settings leer": [
        "DELETE FROM settings",
        f"INSERT INTO zones (id, name, icon, sort, created_at, updated_at, rev) "
        f"VALUES ({BAD}, 'Z', 'shelf', -5, '{NOW}', '{NOW}', 1)",
    ],
    "meta.value": [f"INSERT INTO meta (key, value) VALUES ('fremd', {BAD})"],
    "server_config.value": [
        f"INSERT INTO server_config (key, value, updated_at) VALUES ('fremd', {BAD}, '{NOW}')"
    ],
    "kodiertes Surrogat in events.data": [
        "INSERT INTO events (at, recorded_at, type, entity, entity_id, data) "
        f"VALUES ('{NOW}', '{NOW}', 'x', 'x', 'x', {SURROGATE})"
    ],
}


def forged(settings, tmp_path: Path, statements: list[str], name: str = "gefaelscht.sqlite3") -> Path:
    """Eine Sicherung des laufenden Stowly, danach gefälscht."""
    path = stowly_file(settings, tmp_path, name)
    con = sqlite3.connect(path, isolation_level=None)
    try:
        for statement in statements:
            con.execute(statement)
    finally:
        con.close()
    return path


@pytest.mark.parametrize("case", sorted(FORGERIES))
def test_text_that_is_not_utf_8_is_refused_as_damaged(client, settings, tmp_path, case, caplog):
    path = forged(settings, tmp_path, FORGERIES[case])
    with caplog.at_level(logging.WARNING, logger="stowly"), pytest.raises(ApiError) as caught:
        restore.examine(path)
    assert caught.value.status == 422
    assert (caught.value.details, caught.value.message) == ({"reason": "damaged"}, restore.INVALID_TEXT)
    assert restore.INVALID_TEXT in caplog.text


def test_a_running_stowly_refuses_such_a_backup(settings, clock, tmp_path):
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
        data = forged(
            settings, tmp_path, FORGERIES["P1 products.id, wartet auf das Nachschlagen"]
        ).read_bytes()
        up = uploaded(client, data, phone.headers)
        response = check(client, up["upload_id"], None, phone.headers)
        assert reason(response) == "damaged"
        assert response.json()["error"]["message"] == restore.INVALID_TEXT


def test_the_first_start_refuses_such_a_backup(settings, fresh, clock, tmp_path):
    """Beim ersten Start kommen auch ``meta`` und ``server_config`` aus der Sicherung."""
    with server(settings) as client:
        Device(client, "Handy", clock=clock)
    data = forged(settings, tmp_path, FORGERIES["meta.value"] + FORGERIES["Z zones.id, settings leer"])
    with server(fresh) as client:
        assert client.get("/api/health").json()["configured"] is False
        up = uploaded(client, data.read_bytes())
        response = check(client, up["upload_id"])
        assert reason(response) == "damaged"
        assert response.json()["error"]["message"] == restore.INVALID_TEXT
        assert client.get("/api/health").json()["configured"] is False


def test_a_text_too_large_is_refused_without_loading_it(client, settings, tmp_path, monkeypatch):
    limit = restore.MAX_TEXT_BYTES
    monkeypatch.setattr(restore, "MAX_TEXT_BYTES", 100)
    path = forged(
        settings,
        tmp_path,
        [
            "INSERT INTO events (at, recorded_at, type, entity, entity_id, data) "
            f"VALUES ('{NOW}', '{NOW}', 'x', 'x', 'x', printf('%.*c', 101, 'x'))"
        ],
    )
    with pytest.raises(ApiError) as caught:
        restore.examine(path)
    assert (caught.value.details, caught.value.message) == ({"reason": "damaged"}, restore.TEXT_TOO_LARGE)
    # Bilder sind BLOB und zählen nicht, auch mit Bytes, die kein UTF-8 sind.
    monkeypatch.setattr(restore, "MAX_TEXT_BYTES", limit)
    path = forged(
        settings,
        tmp_path,
        [
            "INSERT INTO images (id, content_type, data, source, created_at) "
            f"VALUES ('{'a' * 32}.jpg', 'image/jpeg', CAST(X'FFD8FF' || zeroblob(500) AS BLOB), 'openfoodfacts', '{NOW}')"
        ],
        "mit-bild.sqlite3",
    )
    assert restore.examine(path).schema_version == len(db.list_migrations())


def test_umlauts_emoji_and_cjk_come_back(settings, clock, tmp_path):
    """Eine gültige Sicherung geht weiter durch, mit allem, was UTF-8 kann."""
    names = ["Äpfel aus Österreich", "Spaghetti 🍝 al dente", "苹果 りんご 사과", "Grüße ß ẞ € ℮"]
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
        phone.sync()
        products = {phone.store(name)[0]: name for name in names}
        backup = stowly_file(settings, tmp_path, "gueltig.sqlite3")
        # Nach der Sicherung kommt noch etwas dazu; das Zurückspielen nimmt es wieder weg.
        phone.store("Nach der Sicherung")
        restarts = armed(client)
        up = uploaded(client, backup.read_bytes(), phone.headers)
        candidate = checked(client, up["upload_id"], None, phone.headers)
        assert candidate["counts"]["products"] == len(names)
        assert apply(client, candidate["restore_id"], TEST_PASSWORD, phone.headers).status_code == 202
        assert restarts.calls == 1
    assert restore.resume(settings) is RestoreState.DONE
    with server(settings) as client:
        phone.client = client
        assert phone.sync()["reset"] is True
        assert {product_id: phone.products[product_id]["name"] for product_id in products} == products
        assert len(phone.products) == len(names)


# --- Zweite Linie: der Start ------------------------------------------------------------------------------


def test_reconcile_never_stops_the_start(client, con, settings, monkeypatch, caplog):
    """Was die Prüfung übersähe (eine Datenbank, die nicht über das Zurückspielen kam), hält den Start nicht auf."""
    with db.transaction(con):
        con.execute(
            "INSERT INTO products (id, name, lookup, created_at, updated_at, rev) "
            f"VALUES ({BAD}, 'P', 'pending', '{NOW}', '{NOW}', 1)"
        )
    with caplog.at_level(logging.ERROR, logger="stowly"):
        prepare_database(settings)
    assert "Der Stand des Nachschlagens ließ sich beim Start nicht angleichen" in caplog.text

    def broken(connection, *, enabled: bool) -> None:
        raise RuntimeError("kaputt")

    monkeypatch.setattr(off, "reconcile", broken)
    prepare_database(settings)


# --- Tief verschachteltes JSON (gültiges UTF-8) -----------------------------------------------------------

DEEP = "[" * 100_000 + "]" * 100_000  # json.loads gibt mit RecursionError auf
DEEP_JSON = {
    "T1 server_config.tls_addresses": [
        f"INSERT INTO server_config (key, value, updated_at) VALUES ('tls_addresses', '{DEEP}', '{NOW}')"
    ],
    "T2 server_config.push_contact": [
        f"INSERT INTO server_config (key, value, updated_at) VALUES ('push_contact', '{DEEP}', '{NOW}')"
    ],
    "settings.value": [f"UPDATE settings SET value = '{DEEP}' WHERE key = 'warn_days'"],
    "mit Leerraum davor, als Objekt": [
        "UPDATE settings SET value = ' \n ' || printf('%.*c', 65, '{') || printf('%.*c', 65, '}') "
        "WHERE key = 'warn_days'"
    ],
}


@pytest.mark.parametrize("case", sorted(DEEP_JSON))
def test_deeply_nested_json_is_refused_as_damaged(client, settings, tmp_path, case):
    path = forged(settings, tmp_path, DEEP_JSON[case])
    with pytest.raises(ApiError) as caught:
        restore.examine(path)
    assert (caught.value.details, caught.value.message) == ({"reason": "damaged"}, restore.JSON_TOO_DEEP)


def test_the_first_start_refuses_deeply_nested_configuration(settings, fresh, clock, tmp_path):
    with server(settings) as client:
        Device(client, "Handy", clock=clock)
    data = forged(settings, tmp_path, DEEP_JSON["T1 server_config.tls_addresses"]).read_bytes()
    with server(fresh) as client:
        up = uploaded(client, data)
        response = check(client, up["upload_id"])
        assert reason(response) == "damaged"
        assert response.json()["error"]["message"] == restore.JSON_TOO_DEEP


def test_what_counts_as_too_deep():
    limit = restore.MAX_JSON_DEPTH
    assert not restore.too_deep(b"[" * limit + b"]" * limit)
    assert restore.too_deep(b"[" * (limit + 1) + b"]" * (limit + 1))
    assert restore.too_deep(b"{" + b'"a":{' * limit + b"}" * (limit + 1))
    # Klammern in Zeichenketten zählen nicht, auch nach Escapes; breite Listen sind nicht tief.
    assert not restore.too_deep(b'["' + b"[" * 1000 + b'"]')
    assert not restore.too_deep(b'["\\"' + b"[" * 1000 + b'"]')
    assert restore.too_deep(b'["\\\\", ' + b"[" * (limit + 1) + b"]" * (limit + 1) + b"]")
    assert not restore.too_deep(b"[" + b"[[1, 2], {}]," * 10_000 + b"[]]")
    # Nur, was wie JSON beginnt: ein Name voller Klammern ist kein JSON.
    assert not restore.too_deep(b"Mein Regal " + b"[" * 200)
    assert restore.json_depth(b'{"changes": {"name": {"old": "a", "new": "b"}}}') == 3


def test_json_at_the_limit_and_wide_json_pass(client, settings, tmp_path):
    limit = restore.MAX_JSON_DEPTH
    nested = "[" * limit + "]" * limit
    wide = "[" + ",".join(['{"a": [1, 2, {"b": "[[[["}]}'] * 5000) + "]"
    path = forged(
        settings,
        tmp_path,
        [
            f"INSERT INTO server_config (key, value, updated_at) VALUES ('fremd', '{nested}', '{NOW}')",
            "INSERT INTO events (at, recorded_at, type, entity, entity_id, data) "
            f"VALUES ('{NOW}', '{NOW}', 'x', 'x', 'x', '{wide}')",
        ],
    )
    assert restore.examine(path).schema_version == len(db.list_migrations())


def test_deep_configuration_never_stops_the_start(settings, clock, caplog):
    """Zweite Linie: Kommt so ein Wert doch in die Datenbank (nicht über das Zurückspielen), gilt er als nicht
    gesetzt, mit Eintrag im Log, und Stowly startet."""
    with server(settings) as client:
        Device(client, "Handy", clock=clock)
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            for key in ("tls_addresses", "push_contact"):
                con.execute(
                    "INSERT INTO server_config (key, value, updated_at) VALUES (?, ?, ?)", (key, DEEP, NOW)
                )
            con.execute(
                "INSERT INTO job_runs (job, state) VALUES ('push_daily', ?) "
                "ON CONFLICT (job) DO UPDATE SET state = excluded.state",
                (DEEP,),
            )
    finally:
        con.close()
    with caplog.at_level(logging.WARNING, logger="stowly"), server(settings) as client:
        assert client.get("/api/health").status_code == 200
    assert "server_config: Der Wert von tls_addresses ist kein lesbares JSON" in caplog.text
    assert "server_config: Der Wert von push_contact ist kein lesbares JSON" in caplog.text
    con = db.connect(settings.database_path)
    try:
        assert scheduler.load_run(con, "push_daily").state == {}
    finally:
        con.close()
