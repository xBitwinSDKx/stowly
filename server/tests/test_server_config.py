"""Einstellungen des Servers aus der App (docs/integrationen.md, Abschnitt 12; Protokoll 11.7).

Die Umgebung geht vor; was die App setzt, wirkt ohne Neustart: Push liest den Kontakt bei jeder
Zustellung, die Tagesnachricht bei jeder Prüfung, die Abfrage bei GitHub wacht nach dem Umschalten auf.
"""

import asyncio
import base64
import dataclasses
import json
from collections.abc import Iterator
from datetime import UTC, datetime

import httpx2
import pytest
from fastapi.testclient import TestClient
from support import Device, events_of
from test_push import Browser, PushClock, PushService
from test_updates import SIX_HOURS, GitHub, StepClock

from stowly import daily, db, scheduler, serverconfig, updates
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract.api import UPDATE_CHECK_FIRST_S, IntegrationStatus, ServerConfig, UpdateStatus

CONTACT = "mailto:betrieb@example.org"
OTHER = "https://stowly.example/kontakt"
REPO = "beispiel/stowly"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
FCM = "https://fcm.googleapis.com/fcm/send/abc123"
# Die Tagesnachricht am 14.11.2026 um 17:00 in Berlin (16:00 UTC), in ihrem Fenster.
RUN = datetime(2026, 11, 14, 16, 0, tzinfo=UTC)


def read(client: TestClient, device: Device) -> dict:
    response = client.get("/api/server-config", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    ServerConfig.model_validate(response.json())
    return response.json()


def patch(client: TestClient, device: Device, **body):
    return client.patch("/api/server-config", json=body, headers=device.headers)


def stored(settings: Settings) -> dict[str, tuple[object, str | None]]:
    con = db.connect(settings.database_path)
    try:
        return {
            row["key"]: (json.loads(row["value"]), row["updated_by"])
            for row in con.execute(
                "SELECT * FROM server_config WHERE key IN ('push_contact', 'update_enabled')"
            )
        }
    finally:
        con.close()


def no_backup(settings: Settings) -> dict:
    """Die Sicherung ohne Einstellungen: an (Vorgabe), ohne Schlüssel, 03:30, im Datenordner
    (Einzelheiten: test_backup_config.py)."""
    return {
        "enabled": True,
        "enabled_source": "default",
        "recipients": [],
        "recipients_source": "default",
        "time": "03:30",
        "time_source": "default",
        "folder": str(settings.data_dir / "backups"),
        "folder_source": "data",
        "folder_problem": None,
        "folder_hint": None,
    }


@pytest.fixture
def with_default(settings) -> Settings:
    """Wie das veröffentlichte Image: Es kennt das Repository für den Schalter."""
    return dataclasses.replace(settings, update_repo_default=REPO)


@pytest.fixture
def bench(with_default) -> Iterator[tuple[TestClient, Device]]:
    with TestClient(create_app(with_default)) as client:
        yield client, Device(client, "Handy")


# --- Vorgaben und Vorrang -----------------------------------------------------------------------


def test_the_defaults(client, settings):
    device = Device(client, "Handy")
    assert read(client, device) == {
        "push": {"contact": None, "source": "default"},
        "update": {"enabled": False, "repo": None, "source": "default", "available": False},
        "backup": no_backup(settings),
    }
    assert client.get("/api/server-config").status_code == 401
    assert client.patch("/api/server-config", json={"update_enabled": True}).status_code == 401


def test_an_image_with_a_repository_offers_the_switch(bench):
    client, device = bench
    assert read(client, device)["update"] == {
        "enabled": False,
        "repo": REPO,
        "source": "default",
        "available": True,
    }


def test_the_environment_goes_first_and_cannot_be_changed(settings):
    fixed = dataclasses.replace(
        settings, push_contact=CONTACT, update_repo=REPO, update_repo_default="beispiel/anderes"
    )
    with TestClient(create_app(fixed)) as client:
        device = Device(client, "Handy")
        assert read(client, device) == {
            "push": {"contact": CONTACT, "source": "env"},
            "update": {"enabled": True, "repo": REPO, "source": "env", "available": False},
            "backup": no_backup(fixed),
        }
        for body in ({"push_contact": OTHER}, {"push_contact": None}, {"update_enabled": False}):
            response = patch(client, device, **body)
            assert response.status_code == 409, body
            assert response.json()["error"]["code"] == "conflict"
    assert stored(fixed) == {}


# --- Kontakt für die Push-Dienste ---------------------------------------------------------------


def test_a_contact_from_the_app(client, settings):
    device = Device(client, "Handy")
    response = patch(client, device, push_contact=" betrieb@example.org ")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["push"] == {"contact": CONTACT, "source": "app"}
    assert stored(settings) == {"push_contact": (CONTACT, device.id)}

    assert patch(client, device, push_contact=OTHER).json()["push"] == {"contact": OTHER, "source": "app"}
    assert patch(client, device, push_contact=OTHER).status_code == 200  # gleicher Wert: keine Änderung
    removed = patch(client, device, push_contact=None)
    assert removed.json()["push"] == {"contact": None, "source": "default"}
    assert stored(settings) == {}

    events = events_of(client, device, entity="server")
    assert [
        (e["type"], e["entity_id"], e["device_id"], e["data"]) for e in events if e["entity_id"] == "config"
    ] == [("server.config_changed", "config", device.id, {"keys": ["push_contact"]})] * 3
    text = json.dumps(events)
    assert "betrieb@example.org" not in text and "stowly.example" not in text


@pytest.mark.parametrize(
    "contact",
    [
        "kein Kontakt",
        "betrieb@example",
        "mailto:betrieb",
        "MAILTO:betrieb@example.org",
        "http://example.org",
        "https://",
        "https://benutzer:geheim@example.org",
        "mailto:a b@example.org",
        "   ",
    ],
)
def test_an_invalid_contact_is_422(client, settings, contact):
    device = Device(client, "Handy")
    response = patch(client, device, push_contact=contact)
    assert response.status_code == 422, contact
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert error["details"]["errors"][0]["loc"] == ["body", "push_contact"]
    assert stored(settings) == {}


def test_a_contact_has_at_most_200_characters(client):
    device = Device(client, "Handy")
    response = patch(client, device, push_contact="a" * 190 + "@example.org")
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "push_contact"]


def test_a_broken_value_in_the_table_counts_as_none(client, settings):
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(
                con, serverconfig.PUSH_CONTACT, "kein Kontakt", now="2026-11-16T09:00:00.000Z", by=None
            )
            con.execute(
                "INSERT INTO server_config (key, value, updated_at) VALUES ('update_enabled', 'kein JSON', ?)",
                ("2026-11-16T09:00:00.000Z",),
            )
    finally:
        con.close()
    device = Device(client, "Handy")
    assert read(client, device) == {
        "push": {"contact": None, "source": "default"},
        "update": {"enabled": False, "repo": None, "source": "default", "available": False},
        "backup": no_backup(settings),
    }


# --- Der Schalter „Nach Updates suchen" ---------------------------------------------------------


def test_the_switch_needs_a_repository_of_the_image(client, settings):
    device = Device(client, "Handy")
    response = patch(client, device, update_enabled=True)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    assert stored(settings) == {}


def test_switching_updates_on_and_off(bench, with_default):
    client, device = bench
    response = patch(client, device, update_enabled=True)
    assert response.status_code == 200, response.text
    assert response.json()["update"] == {"enabled": True, "repo": REPO, "source": "app", "available": True}
    assert stored(with_default) == {"update_enabled": (True, device.id)}
    update = client.get("/api/integrations", headers=device.headers).json()["update"]
    UpdateStatus.model_validate(update)
    assert (update["configured"], update["repo"]) == (True, REPO)

    off = patch(client, device, update_enabled=False).json()["update"]
    assert off == {"enabled": False, "repo": REPO, "source": "app", "available": True}
    update = client.get("/api/integrations", headers=device.headers).json()["update"]
    assert (update["configured"], update["repo"]) == (False, None)
    for path, body in (("/api/update/check", None), ("/api/update/install", {"version": "9.9.9"})):
        assert client.post(path, json=body, headers=device.headers).status_code == 503


def test_a_rejected_field_changes_nothing(bench, with_default):
    client, device = bench
    response = patch(client, device, push_contact="kein Kontakt", update_enabled=True)
    assert response.status_code == 422
    assert stored(with_default) == {}


def test_only_a_change_of_the_switch_wakes_the_checker(bench, monkeypatch):
    client, device = bench
    calls: list[str] = []
    monkeypatch.setattr(updates.UpdateChecker, "reconfigure", lambda self: calls.append("geweckt"))
    patch(client, device, update_enabled=True)
    patch(client, device, update_enabled=True)
    patch(client, device, push_contact=CONTACT)
    assert calls == ["geweckt"]
    patch(client, device, update_enabled=False)
    assert calls == ["geweckt"] * 2


def test_the_checker_asks_github_after_switching_on_and_never_while_off(with_default):
    """Die Schleife schläft ohne Updates; ``reconfigure`` weckt sie, und die erste Abfrage kommt nach
    ``UPDATE_CHECK_FIRST_S``. Ausgeschaltet fragt sie nie, auch nicht nach Stunden."""
    create_app(with_default)  # legt die Datenbank an
    github, clock = GitHub(), StepClock()
    checker = updates.UpdateChecker(with_default, transport=httpx2.MockTransport(github.handle), clock=clock)

    def switch(on: bool) -> None:
        con = db.connect(with_default.database_path)
        try:
            with db.transaction(con):
                serverconfig.put(
                    con, serverconfig.UPDATE_ENABLED, on, now="2026-11-16T09:00:00.000Z", by=None
                )
        finally:
            con.close()
        checker.reconfigure()

    async def until(condition, what: str) -> None:
        for _ in range(500):
            if condition():
                return
            await asyncio.sleep(0.01)
        raise AssertionError(what)

    async def scenario() -> None:
        task = asyncio.create_task(checker.run())
        try:
            await asyncio.sleep(0.1)
            assert (clock.sleeps, github.requests) == (0, [])  # aus: kein Takt, keine Abfrage
            clock.advance(UPDATE_CHECK_FIRST_S + SIX_HOURS)
            await asyncio.sleep(0.05)
            assert github.requests == []

            switch(True)
            await until(lambda: clock.wakeups() == [clock.mono + UPDATE_CHECK_FIRST_S], "kein Takt")
            clock.advance(UPDATE_CHECK_FIRST_S - 1)
            await asyncio.sleep(0.05)
            assert github.requests == []
            clock.advance(1)
            await until(lambda: len(github.requests) == 1, "keine Abfrage")
            assert str(github.requests[0].url) == API
            await until(lambda: clock.wakeups() == [clock.mono + SIX_HOURS], "kein neuer Takt")

            switch(False)
            await until(lambda: clock.wakeups() == [], "die Schleife wartet noch auf die Uhr")
            clock.advance(3 * SIX_HOURS)
            await asyncio.sleep(0.05)
            assert len(github.requests) == 1

            switch(True)  # wieder an: wieder die erste Abfrage nach einer Minute
            await until(lambda: clock.wakeups() == [clock.mono + UPDATE_CHECK_FIRST_S], "kein Takt")
        finally:
            checker.stop()
            await asyncio.wait_for(task, 5)
            await checker.aclose()

    asyncio.run(scenario())


# --- Push ohne Neustart -------------------------------------------------------------------------


def jwt_subject(request: httpx2.Request) -> str:
    """``sub`` aus dem VAPID-JWT einer Zustellung."""
    token = request.headers["authorization"].removeprefix("vapid t=").split(",")[0]
    claims = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))["sub"]


def test_push_takes_the_contact_from_the_app_without_a_restart(settings):
    service, push_clock = PushService(), PushClock()
    app = create_app(settings, push_transport=httpx2.MockTransport(service.handle), push_clock=push_clock)
    with TestClient(app) as client:
        device = Device(client, "Handy")
        browser = Browser()

        def subscribe() -> int:
            return client.put(
                "/api/push/subscription", json=browser.subscription(FCM), headers=device.headers
            ).status_code

        assert subscribe() == 503
        assert client.get("/api/push/key", headers=device.headers).status_code == 503
        assert client.get("/api/integrations", headers=device.headers).json()["push"]["configured"] is False

        assert patch(client, device, push_contact=CONTACT).status_code == 200
        assert subscribe() == 204
        assert client.post("/api/push/test", headers=device.headers).json()["status"] == "sent"
        assert jwt_subject(service.requests[-1]) == CONTACT
        status = client.get("/api/integrations", headers=device.headers)
        assert status.json()["push"]["configured"] is True
        IntegrationStatus.model_validate(status.json())
        assert "betrieb@example.org" not in status.text  # der Kontakt steht nie im Zustand

        # Ein neuer Kontakt gilt ab der nächsten Nachricht, mit eigenem JWT.
        assert patch(client, device, push_contact=OTHER).status_code == 200
        push_clock.advance(11)
        assert client.post("/api/push/test", headers=device.headers).json()["status"] == "sent"
        assert jwt_subject(service.requests[-1]) == OTHER

        # Ohne Kontakt ist Push wieder aus.
        assert patch(client, device, push_contact=None).status_code == 200
        push_clock.advance(11)
        response = client.post("/api/push/test", headers=device.headers)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "not_configured"
        assert len(service.requests) == 2


def test_the_daily_message_reads_the_contact_when_it_is_due(client, settings):
    job = daily.PushDailyJob(settings, sender=None)  # type: ignore[arg-type]
    assert not job.due(scheduler.JobRun(daily.JOB), RUN)
    device = Device(client, "Handy")
    assert patch(client, device, push_contact=CONTACT).status_code == 200
    assert job.due(scheduler.JobRun(daily.JOB), RUN)


def test_the_app_always_schedules_the_daily_message(client):
    """Ohne Kontakt beim Start: Die Aufgabe steht trotzdem im Zeitplan und wird fällig, sobald es einen gibt.
    Ebenso die Sicherung: Sie ruht ohne Schlüssel (test_backup_config.py)."""
    assert client.app.state.scheduler.jobs == ["backup", "push_daily"]
