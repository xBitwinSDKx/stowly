"""Zustand der Integrationen für die App (docs/integrationen.md, Abschnitt 8; Protokoll 11.4).

Nie darin: ein Token, ein privater Schlüssel, die Adresse von Home Assistant, ``STOWLY_PUSH_CONTACT``.
"""

import dataclasses
import json
from datetime import UTC, datetime
from pathlib import Path

import pyrage
import pytest
from fastapi.testclient import TestClient
from support import Device

from stowly import db, push, scheduler
from stowly.api import integrations as endpoint
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import IntegrationStatus

HA_TOKEN = "ha-token-" + "x" * 40
SUMMARY_TOKEN = "sensor-token-" + "y" * 40
CONTACT = "mailto:betrieb@example.org"


def status(client: TestClient, device: Device) -> dict:
    response = client.get("/api/integrations", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    IntegrationStatus.model_validate(response.json())
    return response.json()


def test_nothing_set_up(client):
    device = Device(client, "Handy")
    assert status(client, device) == {
        "timezone": "Europe/Berlin",
        "backup": {
            "configured": False,
            "problem": None,
            "time": None,
            "recipients": [],
            "last_ok_at": None,
            "last_file": None,
            "last_size": None,
            "last_error": None,
            "last_error_at": None,
            "next_at": None,
            "warning": False,
        },
        "ha": {
            "configured": False,
            "problem": None,
            "entity": None,
            "state": "off",
            "last_ok_at": None,
            "last_error": None,
            "last_error_at": None,
            "linked": 0,
            "sensor": False,
        },
        "push": {
            "configured": False,
            "problem": None,
            "subscriptions": 0,
            "this_device": False,
            "last_run_at": None,
            "last_sent_at": None,
            "last_error": None,
        },
    }
    assert client.get("/api/integrations").status_code == 401


@pytest.fixture
def everything(settings, tmp_path) -> Settings:
    folder = tmp_path / "backups"
    folder.mkdir()
    keys = tuple(str(pyrage.x25519.Identity.generate().to_public()) for _ in range(2))
    return dataclasses.replace(
        settings,
        timezone="Europe/Vienna",
        backup_dir=folder,
        backup_recipients=keys,
        backup_time="04:15",
        ha_url="https://ha.example:8123",
        ha_token=HA_TOKEN,
        ha_todo_entity="todo.einkaufsliste",
        ha_summary_token=SUMMARY_TOKEN,
        push_contact=CONTACT,
    )


class Early:
    """Zeitplan auf 01:00 in Wien: Er macht in diesen Tests keine Sicherung."""

    def now(self) -> datetime:
        return datetime(2026, 11, 14, 0, 0, tzinfo=UTC)

    def monotonic(self) -> float:
        return 0.0

    async def sleep(self, seconds: float) -> None:
        return None


def test_everything_set_up_and_never_a_secret(everything, monkeypatch):
    monkeypatch.setattr(endpoint, "server_now", lambda: datetime(2026, 11, 14, 9, 0, tzinfo=UTC))
    with TestClient(create_app(everything, job_clock=Early())) as client:
        phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
        browser = push.b64url(b"\x04" + b"\x00" * 64)  # Form egal: direkt in die Datenbank
        con = db.connect(everything.database_path)
        try:
            with db.transaction(con):
                con.execute(
                    "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, origin, created_at, updated_at) "
                    "VALUES (?, 'https://fcm.googleapis.com/x', ?, 'AAAAAAAAAAAAAAAAAAAAAA', 'https://stowly.example', ?, ?)",
                    (phone.id, browser, "2026-11-14T08:00:00.000Z", "2026-11-14T08:00:00.000Z"),
                )
            vapid_private = db.get_meta(con, push.VAPID_PRIVATE)
        finally:
            con.close()
        response = client.get("/api/integrations", headers=phone.headers)
        mine, theirs = response.json(), status(client, tablet)

    assert mine["timezone"] == "Europe/Vienna"
    backup = mine["backup"]
    assert (backup["configured"], backup["problem"], backup["time"], backup["warning"]) == (
        True,
        None,
        "04:15",
        False,
    )
    assert backup["recipients"] == [f"{key[:8]}…{key[-4:]}" for key in everything.backup_recipients]
    assert backup["next_at"] == "2026-11-14T09:00:00.000Z"  # 04:15 ist vorbei, noch nichts gelaufen: jetzt
    assert mine["ha"] == {
        "configured": True,
        "problem": None,
        "entity": "todo.einkaufsliste",
        "state": "pending",
        "last_ok_at": None,
        "last_error": None,
        "last_error_at": None,
        "linked": 0,
        "sensor": True,
    }
    assert (mine["push"]["configured"], mine["push"]["subscriptions"], mine["push"]["this_device"]) == (
        True,
        1,
        True,
    )
    assert (theirs["push"]["subscriptions"], theirs["push"]["this_device"]) == (1, False)

    text = response.text
    for secret in (
        HA_TOKEN,
        SUMMARY_TOKEN,
        "ha.example",
        CONTACT,
        "betrieb@example.org",
        vapid_private,
        *everything.backup_recipients,
    ):
        assert secret not in text, secret
    assert str(everything.backup_dir) not in text and Path(everything.backup_dir).name not in text


def test_half_set_up_integrations_name_the_reason(settings, tmp_path):
    half = dataclasses.replace(
        settings, backup_dir=tmp_path, ha_url="http://ha.example", ha_summary_token=SUMMARY_TOKEN
    )
    with TestClient(create_app(half)) as client:
        device = Device(client, "Handy")
        result = status(client, device)
    assert (result["backup"]["configured"], result["backup"]["problem"], result["backup"]["time"]) == (
        False,
        "STOWLY_BACKUP_RECIPIENTS fehlt.",
        "03:30",
    )
    assert result["backup"]["next_at"] is None
    assert (
        result["ha"]["configured"],
        result["ha"]["state"],
        result["ha"]["problem"],
        result["ha"]["sensor"],
    ) == (
        False,
        "off",
        "STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY fehlen.",
        True,
    )


def test_the_last_runs_come_from_job_runs(client, settings, monkeypatch):
    monkeypatch.setattr(endpoint, "server_now", lambda: datetime(2026, 11, 14, 9, 0, tzinfo=UTC))
    device = Device(client, "Handy")
    con = db.connect(settings.database_path)
    try:
        scheduler.record_success(
            con,
            "push_daily",
            day="2026-11-13",
            at="2026-11-13T16:00:00.000Z",
            state={"sent_at": "2026-11-13T16:00:01.000Z", "packages": 2, "subscriptions": 1, "errors": 0},
        )
        scheduler.record_failure(con, "push_daily", at="2026-11-14T16:00:00.000Z", error="Kein Abo erreicht.")
        # Offene Einträge, die in Bring! stehen (ab Runde 2); erledigte zählen nicht.
        stamp = "2026-11-14T08:00:00.000Z"
        with db.transaction(con):
            for done in (None, stamp):
                con.execute(
                    "INSERT INTO shopping_items (id, text, origin, done_at, closed_by, bring_key, created_at, "
                    "updated_at, rev) VALUES (?, 'Kaffee', 'manual', ?, ?, 'kaffee', ?, ?, ?)",
                    (
                        ids.new_uuid(),
                        done,
                        None if done is None else "device",
                        stamp,
                        stamp,
                        db.next_rev(con),
                    ),
                )
    finally:
        con.close()
    result = status(client, device)
    assert result["push"]["last_run_at"] == "2026-11-13T16:00:00.000Z"
    assert result["push"]["last_sent_at"] == "2026-11-13T16:00:01.000Z"
    assert result["push"]["last_error"] == "Kein Abo erreicht."
    assert result["ha"]["linked"] == 1


def test_a_strange_state_in_job_runs_does_not_break_the_answer(client, settings):
    device = Device(client, "Handy")
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            con.execute(
                "INSERT INTO job_runs (job, last_date, last_at, state) VALUES ('backup', '2026-11-13', "
                "'2026-11-13T02:30:00.000Z', ?)",
                (json.dumps({"file": 7, "size": "groß"}),),
            )
            con.execute("INSERT INTO job_runs (job, state) VALUES ('push_daily', 'kein JSON')")
    finally:
        con.close()
    result = status(client, device)
    assert (result["backup"]["last_file"], result["backup"]["last_size"]) == (None, None)
    assert result["push"]["last_sent_at"] is None
