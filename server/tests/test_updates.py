"""Updates über GitHub (docs/integrationen.md, Abschnitt 10; docs/sync-protokoll.md, 11.5).

GitHub bildet ``httpx2.MockTransport`` nach; kein Test geht ins Netz. Die Uhr der Updates steht still
(``FrozenClock``): Die Schleife fragt dann nie von selbst, und der Test stellt Zeitpunkte und die Bremse
des Knopfs von Hand vor. Den Takt der Schleife prüft ``StepClock``, deren ``sleep`` erst endet, wenn der
Test die Uhr vorstellt. Die Dateien des Updaters schreibt der Test so, wie das Skript sie schreibt.

Die Versionen leiten sich von der des Servers ab: Die Tests gelten auch nach dem nächsten Release.
"""

import asyncio
import dataclasses
import json
import logging
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from support import Device
from test_push import Browser, decrypt

from stowly import __version__, db, off, scheduler, updates
from stowly.api import integrations as integrations_endpoint
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract.api import (
    UPDATE_CHECK_FIRST_S,
    UPDATE_CHECK_INTERVAL_S,
    UPDATE_CHECK_MIN_GAP_S,
    UPDATE_NOTES_MAX,
    IntegrationStatus,
    UpdateStatus,
)
from stowly.contract.timeutil import format_timestamp

REPO = "beispiel/stowly"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
START = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
SIX_HOURS = UPDATE_CHECK_INTERVAL_S

CURRENT = __version__
_MAJOR, _MINOR, _PATCH = (int(part) for part in CURRENT.split("."))
NEWER = f"{_MAJOR}.{_MINOR + 1}.0"
NEWEST = f"{_MAJOR}.{_MINOR + 2}.0"
OLDER = "0.0.0"

CONTACT = "mailto:betrieb@example.org"
FCM = "https://fcm.googleapis.com/fcm/send/handy"
APPLE = "https://web.push.apple.com/tablet"

# Was über das neueste Release bekannt ist; bei einem Fehler bleibt es stehen.
KNOWN = ("latest", "latest_name", "notes", "published_at", "url", "available", "checked_at")
STATE = ("state", "state_version", "state_at", "state_message")


def release(tag: str = f"v{NEWER}", **fields: Any) -> dict[str, Any]:
    """Eine Antwort von ``releases/latest``, wie GitHub sie schickt (auf das gekürzt, was zählt)."""
    version = tag.removeprefix("v")
    return {
        "tag_name": tag,
        "name": f"Stowly {version}",
        "body": "## Neu\n\n- Updates aus der App",
        "published_at": "2026-11-15T18:30:00Z",
        "html_url": f"https://github.com/{REPO}/releases/tag/{tag}",
        "draft": False,
        "prerelease": False,
        **fields,
    }


class GitHub:
    """Nachgebildetes GitHub: merkt sich jede Anfrage und antwortet, wie der Test es will."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []
        self.answer: int | Exception = 200
        self.release: dict[str, Any] | bytes = release()

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if isinstance(self.answer, Exception):
            raise self.answer
        if self.answer != 200:
            return httpx2.Response(self.answer, json={"message": "Nope"})
        if isinstance(self.release, bytes):
            return httpx2.Response(200, content=self.release)
        return httpx2.Response(200, json=self.release)


class FrozenClock(off.Clock):
    """Die Uhr der Updates, angehalten: ``sleep`` endet nie, die Schleife fragt nie von selbst."""

    def __init__(self) -> None:
        self.value = START
        self.mono = 1000.0

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.mono

    async def sleep(self, seconds: float) -> None:
        await asyncio.Event().wait()

    def advance(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)
        self.mono += seconds

    def stamp(self, offset_s: float = 0.0) -> str:
        return format_timestamp(self.value + timedelta(seconds=offset_s))


class StepClock(off.Clock):
    """Eine Uhr, die nur läuft, wenn der Test sie vorstellt; ``sleep`` endet erst dann."""

    def __init__(self) -> None:
        self.value = START
        self.mono = 0.0
        self.sleeps = 0  # so oft hat die Schleife zu warten begonnen
        self._sleepers: list[tuple[float, asyncio.Future[None]]] = []

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.mono

    async def sleep(self, seconds: float) -> None:
        self.sleeps += 1
        entry = (self.mono + seconds, asyncio.get_running_loop().create_future())
        self._sleepers.append(entry)
        try:
            await entry[1]
        finally:
            self._sleepers.remove(entry)

    def advance(self, seconds: float) -> None:
        self.mono += seconds
        self.value += timedelta(seconds=seconds)
        for target, future in self._sleepers:
            if target <= self.mono and not future.done():
                future.set_result(None)

    def wakeups(self) -> list[float]:
        """Wann die Schleife wieder aufwacht, in Sekunden der Uhr."""
        return sorted(target for target, future in self._sleepers if not future.done())


def updater_time(moment: datetime) -> str:
    """Ein Zeitpunkt, wie der Updater ihn schreibt (``date -u +%Y-%m-%dT%H:%M:%SZ``)."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_run(settings: Settings) -> scheduler.JobRun:
    con = db.connect(settings.database_path)
    try:
        return scheduler.load_run(con, updates.JOB)
    finally:
        con.close()


@dataclasses.dataclass
class Bench:
    settings: Settings
    app: FastAPI
    client: TestClient
    github: GitHub
    clock: FrozenClock
    device: Device

    @property
    def folder(self) -> Path:
        return self.settings.update_dir

    # ------------------------------------------------------------------ Aufrufe

    def check(self, after: float = 0.0) -> dict:
        """Knopfdruck ``after`` Sekunden später; liefert den Zustand aus der Antwort."""
        self.clock.advance(after)
        response = self.client.post("/api/update/check", headers=self.device.headers)
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        UpdateStatus.model_validate(response.json())
        return response.json()

    def status(self) -> dict:
        """``IntegrationStatus.update`` über ``GET /api/integrations``, zur Zeit der Uhr der Updates."""
        response = self.client.get("/api/integrations", headers=self.device.headers)
        assert response.status_code == 200, response.text
        IntegrationStatus.model_validate(response.json())
        return response.json()["update"]

    def state(self) -> tuple:
        result = self.status()
        return tuple(result[key] for key in STATE)

    def install(self, version: str, device: Device | None = None) -> httpx2.Response:
        return self.client.post(
            "/api/update/install", json={"version": version}, headers=(device or self.device).headers
        )

    def run(self) -> scheduler.JobRun:
        return load_run(self.settings)

    # ------------------------------------------------------------------ Dateien des Updaters

    def write(self, name: str, content: str | bytes) -> None:
        data = content.encode("utf-8") if isinstance(content, str) else content
        (self.folder / name).write_bytes(data)

    def remove(self, name: str) -> None:
        (self.folder / name).unlink()

    def ago(self, seconds: float) -> datetime:
        return self.clock.value - timedelta(seconds=seconds)

    def updater_seen(self, ago_s: float = 30.0) -> None:
        """Der Updater hat sich vor ``ago_s`` Sekunden gemeldet."""
        self.write("updater", f"seen_at={updater_time(self.ago(ago_s))}\nupdater=1\n")

    def reported(self, state: str, version: str, *, ago_s: float = 30.0, message: str = "") -> None:
        """Der Updater meldet ``state`` für ``version``, geschrieben vor ``ago_s`` Sekunden."""
        at = updater_time(self.ago(ago_s))
        self.write("state", f"state={state}\nversion={version}\nfrom={CURRENT}\nat={at}\nmessage={message}\n")

    def requested(self, version: str, *, ago_s: float = 0.0) -> None:
        """Eine Anforderung, wie der Server sie vor ``ago_s`` Sekunden geschrieben hätte."""
        stamp = format_timestamp(self.ago(ago_s))
        self.write("request", f"version={version}\nrequested_at={stamp}\ndevice=Handy\n")


def make_app(settings: Settings, github: GitHub, clock: off.Clock, **more: Any) -> FastAPI:
    return create_app(
        settings, update_transport=httpx2.MockTransport(github.handle), update_clock=clock, **more
    )


@pytest.fixture
def configured(settings) -> Settings:
    return dataclasses.replace(settings, update_repo=REPO)


@pytest.fixture
def bench(configured, monkeypatch) -> Iterator[Bench]:
    github, clock = GitHub(), FrozenClock()
    monkeypatch.setattr(integrations_endpoint, "server_now", clock.now)
    app = make_app(configured, github, clock)
    with TestClient(app) as client:
        yield Bench(configured, app, client, github, clock, Device(client, "Küchen-Handy"))


# --- Abfrage bei GitHub (10.2) -----------------------------------------------------------------


def test_the_query_asks_github_like_the_contract_says(bench):
    result = bench.check()
    (request,) = bench.github.requests
    assert (request.method, str(request.url)) == ("GET", API)
    assert request.headers["accept"] == "application/vnd.github+json"
    assert request.headers["x-github-api-version"] == "2022-11-28"
    assert request.headers["user-agent"] == f"Stowly/{CURRENT}"
    assert "authorization" not in request.headers
    assert result == {
        "configured": True,
        "repo": REPO,
        "current": CURRENT,
        "latest": NEWER,
        "latest_name": f"Stowly {NEWER}",
        "notes": "## Neu\n\n- Updates aus der App",
        "published_at": "2026-11-15T18:30:00.000Z",
        "url": f"https://github.com/{REPO}/releases/tag/v{NEWER}",
        "available": True,
        "checked_at": "2026-11-16T09:00:00.000Z",
        "check_error": None,
        "updater_ready": False,
        "updater_seen_at": None,
        "state": "idle",
        "state_version": None,
        "state_at": None,
        "state_message": None,
    }
    # Gespeichert in job_runs, Aufgabe update_check; der Zustand der App sagt dasselbe.
    run = bench.run()
    assert (run.last_date, run.last_at, run.last_error) == ("2026-11-16", "2026-11-16T09:00:00.000Z", None)
    assert run.state == {
        "latest": NEWER,
        "latest_name": f"Stowly {NEWER}",
        "notes": "## Neu\n\n- Updates aus der App",
        "published_at": "2026-11-15T18:30:00.000Z",
        "url": f"https://github.com/{REPO}/releases/tag/v{NEWER}",
        "notified": NEWER,
    }
    assert bench.status() == result


@pytest.mark.parametrize("tag", [f"v{NEWER}", NEWER])
def test_the_tag_counts_with_or_without_v(bench, tag):
    bench.github.release = release(tag)
    result = bench.check()
    assert (result["latest"], result["available"], result["check_error"]) == (NEWER, True, None)


@pytest.mark.parametrize(
    ("tag", "shown"),
    [
        ("nightly", "nightly"),
        ("v1.2", "v1.2"),
        (f"v{NEWER}-rc.1", f"v{NEWER}-rc.1"),  # eine Vorabversion
        (f"V{NEWER}", f"V{NEWER}"),
        (f"vv{NEWER}", f"vv{NEWER}"),
        ("v１.２.３", "v１.２.３"),  # andere Ziffern als 0 bis 9
        ("x" * 80, "x" * 59 + "…"),
        ("", "fehlt"),
        (None, "fehlt"),
        (17, "fehlt"),
    ],
)
def test_a_tag_without_a_version_number_fails_and_keeps_what_was_known(bench, tag, shown):
    first = bench.check()
    bench.github.release = {**release(), "tag_name": tag}
    failed = bench.check(after=60)
    assert failed["check_error"] == f"Das neueste Release hat keine Versionsnummer wie 1.2.3 (Tag {shown})."
    assert {key: failed[key] for key in KNOWN} == {key: first[key] for key in KNOWN}


def test_a_newline_after_the_version_is_no_version():
    """``$`` in Python träfe auch vor einem Zeilenende am Schluss."""
    assert updates.tag_version(f"v{NEWER}") == NEWER
    assert updates.tag_version(f"{NEWER}\n") is None
    assert updates.parse_version("1.2.3") == (1, 2, 3)
    assert updates.parse_version("1" * 37 + ".0.0") is None  # länger als eine anforderbare Version
    assert updates.newer("1.10.0", "1.9.9") and not updates.newer("1.9.9", "1.10.0")
    assert not updates.newer("1.2.3", "1.2.3") and not updates.newer(None, "1.2.3")
    assert updates.newer(CURRENT, OLDER) and updates.newer(NEWER, CURRENT) and updates.newer(NEWEST, NEWER)


def test_the_notes_are_cut_to_4000_characters(bench):
    bench.github.release = release(body="a" * 3000 + " " + "b" * 2000)
    notes = bench.check()["notes"]
    assert len(notes) == UPDATE_NOTES_MAX == 4000
    assert notes == "a" * 3000 + " " + "b" * 998 + "…"
    bench.github.release = release(body="c" * 4000)
    assert bench.check(after=60)["notes"] == "c" * 4000


@pytest.mark.parametrize(("name", "body"), [("", None), ("   ", ""), (None, "  \n "), (7, 7)])
def test_an_empty_name_or_body_is_null(bench, name, body):
    bench.github.release = release(name=name, body=body)
    result = bench.check()
    assert (result["latest"], result["latest_name"], result["notes"]) == (NEWER, None, None)


@pytest.mark.parametrize(
    ("html_url", "url"),
    [
        (
            f"https://github.com/{REPO}/releases/tag/v{NEWER}",
            f"https://github.com/{REPO}/releases/tag/v{NEWER}",
        ),
        (f"http://github.com/{REPO}/releases/tag/v{NEWER}", None),
        ("https://github.com.example/stowly", None),
        ("https://example.org/https://github.com/", None),
        ("javascript:alert(1)", None),
        (None, None),
        (42, None),
    ],
)
def test_the_page_of_the_release_only_on_github(bench, html_url, url):
    bench.github.release = release(html_url=html_url)
    assert bench.check()["url"] == url


@pytest.mark.parametrize(
    ("published", "expected"),
    [
        ("2026-11-15T18:30:00Z", "2026-11-15T18:30:00.000Z"),
        ("2026-11-15T19:30:00+01:00", "2026-11-15T18:30:00.000Z"),
        ("2026-11-15T18:30:00.123456Z", "2026-11-15T18:30:00.123Z"),
        ("2026-11-15T18:30:00", None),  # ohne Zeitzone
        ("2026-11-15", None),
        ("gestern", None),
        (None, None),
    ],
)
def test_published_at_in_the_format_of_the_contract(bench, published, expected):
    bench.github.release = release(published_at=published)
    assert bench.check()["published_at"] == expected


def test_404_means_no_release_yet_and_counts_as_success(bench):
    bench.check()
    bench.github.answer = 404
    result = bench.check(after=60)
    assert {key: result[key] for key in (*KNOWN, "check_error")} == {
        "latest": None,
        "latest_name": None,
        "notes": None,
        "published_at": None,
        "url": None,
        "available": False,
        "checked_at": bench.clock.stamp(),
        "check_error": None,
    }
    # Gemeldet bleibt gemeldet: Kommt das Release zurück, gibt es keine zweite Nachricht.
    assert bench.run().state["notified"] == NEWER


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        (403, "GitHub lehnt die Abfrage gerade ab (Ratenlimit). Der nächste Versuch kommt planmäßig."),
        (429, "GitHub lehnt die Abfrage gerade ab (Ratenlimit). Der nächste Versuch kommt planmäßig."),
        (500, "GitHub antwortet mit 500."),
        (503, "GitHub antwortet mit 503."),
        (301, "GitHub antwortet mit 301."),  # Weiterleitungen folgt der Server nicht
        (401, "GitHub antwortet mit 401."),
        (httpx2.ConnectError("weg"), "GitHub ist nicht erreichbar."),
        (httpx2.ReadTimeout("zu langsam"), "GitHub ist nicht erreichbar."),
    ],
)
def test_errors_keep_what_was_known(bench, answer, message):
    first = bench.check()
    bench.github.answer = answer
    failed = bench.check(after=60)
    assert failed["check_error"] == message
    assert {key: failed[key] for key in KNOWN} == {key: first[key] for key in KNOWN}
    assert failed["checked_at"] == "2026-11-16T09:00:00.000Z"  # die letzte gelungene Abfrage
    run = bench.run()
    assert (run.last_at, run.last_error, run.last_error_at) == (
        "2026-11-16T09:00:00.000Z",
        message,
        bench.clock.stamp(),
    )
    # Der nächste Erfolg löscht den Fehler.
    bench.github.answer = 200
    again = bench.check(after=60)
    assert (again["check_error"], again["checked_at"]) == (None, bench.clock.stamp())


def test_an_error_before_any_success(bench):
    bench.github.answer = httpx2.ConnectError("weg")
    result = bench.check()
    assert {key: result[key] for key in KNOWN} == dict.fromkeys(KNOWN) | {"available": False}
    assert result["check_error"] == "GitHub ist nicht erreichbar."


@pytest.mark.parametrize("content", [b"<html>Wartung</html>", b"[]", b"null", b"\xff\xfe"])
def test_an_answer_that_is_no_release_is_an_error(bench, content):
    bench.github.release = content
    result = bench.check()
    assert (result["latest"], result["check_error"]) == (None, "GitHub antwortet unerwartet.")


def test_a_slow_github_is_given_up_after_the_time_limit(configured, monkeypatch):
    """Höchstens 10 Sekunden; der Test kürzt die Grenze, statt so lange zu warten."""
    assert updates.TIMEOUT_S == 10.0
    monkeypatch.setattr(updates, "TIMEOUT_S", 0.2)

    async def slow(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(5)
        return httpx2.Response(200, json=release())

    create_app(configured)  # legt die Datenbank an
    checker = updates.UpdateChecker(configured, transport=httpx2.MockTransport(slow), clock=FrozenClock())

    async def scenario() -> None:
        try:
            await checker.check()
        finally:
            await checker.aclose()

    started = time.monotonic()
    asyncio.run(scenario())
    assert time.monotonic() - started < 3
    assert load_run(configured).last_error == "GitHub ist nicht erreichbar."


def test_the_result_survives_a_restart(configured, monkeypatch):
    github, clock = GitHub(), FrozenClock()
    monkeypatch.setattr(integrations_endpoint, "server_now", clock.now)
    with TestClient(make_app(configured, github, clock)) as client:
        device = Device(client, "Handy")
        first = client.post("/api/update/check", headers=device.headers).json()
    assert first["latest"] == NEWER

    github.answer = httpx2.ConnectError("weg")
    with TestClient(make_app(configured, github, clock)) as client:
        device = Device(client, "Handy")
        assert client.get("/api/integrations", headers=device.headers).json()["update"] == first
        failed = client.post("/api/update/check", headers=device.headers).json()
    assert {key: failed[key] for key in KNOWN} == {key: first[key] for key in KNOWN}
    assert failed["check_error"] == "GitHub ist nicht erreichbar."
    assert load_run(configured).state["notified"] == NEWER


# --- Push einmal je Version (10.2) -------------------------------------------------------------


class PushServices:
    """Nachgebildete Push-Dienste: nehmen alles an (201) und merken sich jede Anfrage."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return httpx2.Response(201)


def subscribe(
    client: TestClient, device: Device, endpoint: str, origin: str = "https://stowly.example"
) -> Browser:
    browser = Browser()
    response = client.put(
        "/api/push/subscription", json=browser.subscription(endpoint, origin=origin), headers=device.headers
    )
    assert response.status_code == 204, response.text
    return browser


@dataclasses.dataclass
class PushBench:
    bench: Bench
    services: PushServices
    browsers: dict[str, Browser]

    def messages(self) -> dict[str, list[dict]]:
        """Je Endpunkt die Nachrichten, entschlüsselt wie im Browser."""
        found: dict[str, list[dict]] = {}
        for request in self.services.requests:
            browser = self.browsers[str(request.url)]
            found.setdefault(str(request.url), []).append(
                json.loads(decrypt(request.content, browser.key, browser.auth))
            )
        return found


@pytest.fixture
def push_bench(configured, monkeypatch) -> Iterator[PushBench]:
    with_push = dataclasses.replace(configured, push_contact=CONTACT)
    github, clock, services = GitHub(), FrozenClock(), PushServices()
    monkeypatch.setattr(integrations_endpoint, "server_now", clock.now)
    app = make_app(with_push, github, clock, push_transport=httpx2.MockTransport(services.handle))
    with TestClient(app) as client:
        phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
        browsers = {
            FCM: subscribe(client, phone, FCM),
            APPLE: subscribe(client, tablet, APPLE, origin="https://stowly.example:8443"),
        }
        yield PushBench(Bench(with_push, app, client, github, clock, phone), services, browsers)


def test_a_new_version_is_announced_once_to_every_subscription(push_bench):
    bench, services = push_bench.bench, push_bench.services
    bench.check()
    messages = push_bench.messages()
    assert set(messages) == {FCM, APPLE}
    for endpoint, origin in ((FCM, "https://stowly.example"), (APPLE, "https://stowly.example:8443")):
        assert messages[endpoint] == [
            {
                "web_push": 8030,
                "notification": {
                    "title": "Neue Version",
                    "body": f"Stowly {NEWER} ist verfügbar.",
                    "navigate": f"{origin}/einstellungen",
                    "lang": "de-DE",
                    "dir": "ltr",
                    "tag": "stowly-update",
                    "silent": False,
                },
            }
        ]
    for request in services.requests:
        assert request.headers["topic"] == "stowly-update"
        assert request.headers["ttl"] == "86400"
        assert request.headers["urgency"] == "normal"
        assert request.headers["content-encoding"] == "aes128gcm"
        assert request.headers["authorization"].startswith("vapid t=")
    assert bench.run().state["notified"] == NEWER

    # Dieselbe Version nie ein zweites Mal: weder bei der nächsten Abfrage noch nach einem Fehler oder
    # einem 404 dazwischen.
    bench.check(after=60)
    bench.github.answer = 500
    bench.check(after=60)
    bench.github.answer = 404
    bench.check(after=60)
    bench.github.answer = 200
    bench.check(after=60)
    assert len(services.requests) == 2

    # Eine neuere Version: wieder eine Nachricht je Abo.
    bench.github.release = release(f"v{NEWEST}")
    bench.check(after=60)
    assert len(services.requests) == 4
    assert [message["notification"]["body"] for message in push_bench.messages()[FCM]] == [
        f"Stowly {NEWER} ist verfügbar.",
        f"Stowly {NEWEST} ist verfügbar.",
    ]
    assert bench.run().state["notified"] == NEWEST


@pytest.mark.parametrize("version", [CURRENT, OLDER])
def test_a_release_that_is_not_newer_is_not_announced(push_bench, version):
    bench = push_bench.bench
    bench.github.release = release(f"v{version}")
    result = bench.check()
    assert (result["latest"], result["available"]) == (version, False)
    assert push_bench.services.requests == []
    assert bench.run().state["notified"] is None


def test_without_push_the_version_counts_as_announced(configured, monkeypatch):
    """Danach gilt notified = latest, auch ohne Push: Ein späteres Einschalten meldet nichts nach."""
    github, clock, services = GitHub(), FrozenClock(), PushServices()
    with TestClient(make_app(configured, github, clock)) as client:
        device = Device(client, "Handy")
        assert client.post("/api/update/check", headers=device.headers).status_code == 200
    assert load_run(configured).state["notified"] == NEWER

    with_push = dataclasses.replace(configured, push_contact=CONTACT)
    app = make_app(with_push, github, clock, push_transport=httpx2.MockTransport(services.handle))
    with TestClient(app) as client:
        device = Device(client, "Handy")
        subscribe(client, device, FCM)
        assert client.post("/api/update/check", headers=device.headers).status_code == 200
    assert services.requests == []


# --- Zustand (10.4) ----------------------------------------------------------------------------


def test_without_files_nothing_happens(bench):
    assert bench.state() == ("idle", None, None, None)
    assert (bench.status()["updater_ready"], bench.status()["updater_seen_at"]) == (False, None)
    assert bench.folder.is_dir()  # den Ordner legt der Server beim Start an


@pytest.mark.parametrize(
    ("seen", "ready"), [(0, True), (30, True), (600, True), (601, False), (86400, False)]
)
def test_the_updater_counts_as_ready_for_ten_minutes(bench, seen, ready):
    bench.updater_seen(ago_s=seen)
    result = bench.status()
    assert (result["updater_ready"], result["updater_seen_at"]) == (ready, bench.clock.stamp(-seen))


@pytest.mark.parametrize(
    ("line", "seen_at"),
    [
        ("seen_at=2026-11-16T08:58:00Z", "2026-11-16T08:58:00.000Z"),  # so schreibt der Updater
        ("seen_at=2026-11-16T08:58:00.250Z", "2026-11-16T08:58:00.250Z"),  # Format des Vertrags
        ("seen_at=2026-11-16 08:58:00", None),
        ("seen_at=2026-13-16T08:58:00Z", None),
        ("seen_at=", None),
        ("updater=1", None),
    ],
)
def test_seen_at_in_both_formats(bench, line, seen_at):
    bench.write("updater", line + "\n")
    result = bench.status()
    assert (result["updater_seen_at"], result["updater_ready"]) == (seen_at, seen_at is not None)


def test_a_fresh_request_is_requested(bench):
    bench.updater_seen()
    bench.requested(NEWER)
    assert bench.state() == ("requested", NEWER, bench.clock.stamp(), None)


def test_a_request_the_updater_does_not_pick_up(bench):
    bench.requested(NEWER, ago_s=601)
    stale = "Der Updater hat die Anforderung noch nicht abgeholt. Läuft die Aufgabe auf dem Rechner?"
    assert bench.state() == ("requested", NEWER, bench.clock.stamp(-601), stale)
    # Genau zehn Minuten sind noch nicht „älter".
    bench.requested(NEWER, ago_s=600)
    assert bench.state()[3] is None
    # Meldet sich der Updater, ist eine alte Anforderung kein Grund zur Sorge.
    bench.requested(NEWER, ago_s=3600)
    bench.updater_seen()
    assert bench.state() == ("requested", NEWER, bench.clock.stamp(-3600), None)


def test_installing_this_request(bench):
    bench.requested(NEWER, ago_s=90)
    bench.reported("installing", NEWER, ago_s=60, message=f"Lade ghcr.io/beispiel/stowly:{NEWER}.")
    assert bench.state() == ("installing", NEWER, bench.clock.stamp(-60), None)


def test_a_state_for_another_request_means_requested(bench):
    bench.requested(NEWEST, ago_s=10)
    for state in ("installing", "failed", "done"):
        bench.reported(state, NEWER, ago_s=3600)
        assert bench.state() == ("requested", NEWEST, bench.clock.stamp(-10), None), state


def test_installing_without_a_request(bench):
    bench.reported("installing", NEWER, ago_s=30)
    assert bench.state() == ("installing", NEWER, bench.clock.stamp(-30), None)
    bench.reported("installing", NEWER, ago_s=15 * 60)
    assert bench.state()[3] is None
    bench.reported("installing", NEWER, ago_s=15 * 60 + 1)
    assert bench.state() == (
        "installing",
        NEWER,
        bench.clock.stamp(-(15 * 60 + 1)),
        "Der Updater meldet sich seit 15 Minuten nicht. Bitte auf dem Rechner nachsehen.",
    )


def test_done_counts_only_for_this_version(bench):
    bench.reported("done", CURRENT, ago_s=120, message=f"Aktualisiert von {OLDER} auf {CURRENT}.")
    assert bench.state() == ("done", CURRENT, bench.clock.stamp(-120), None)
    # Done für eine andere Version, etwa nach einem Zurückspielen von Hand: idle.
    bench.reported("done", NEWER, ago_s=120)
    assert bench.state() == ("idle", None, None, None)


def test_failed_with_the_message_of_the_updater(bench):
    message = f"Die neue Version startete nicht, zurück auf {CURRENT}."
    bench.reported("failed", NEWER, ago_s=300, message=message)
    assert bench.state() == ("failed", NEWER, bench.clock.stamp(-300), message)
    bench.reported("failed", NEWER, ago_s=300)
    assert bench.state() == ("failed", NEWER, bench.clock.stamp(-300), None)
    # Eine ungültige Anforderung meldet der Updater ohne Version.
    bench.reported("failed", "", ago_s=300, message="Die Anforderung nennt keine gültige Version.")
    assert bench.state() == (
        "failed",
        None,
        bench.clock.stamp(-300),
        "Die Anforderung nennt keine gültige Version.",
    )


def test_an_unknown_state_is_idle(bench):
    bench.reported("kaputt", NEWER)
    assert bench.state() == ("idle", None, None, None)


def test_the_files_are_read_tolerantly(bench):
    """UTF-8 mit BOM, ``\\r\\n``, unbekannte Schlüssel, Zeilen ohne ``=``, kaputte Bytes; der erste Wert gilt."""
    bench.write(
        "state",
        b"\xef\xbb\xbfstate=failed\r\n"
        b"Zeile ohne Gleichheitszeichen\r\n"
        b"unbekannt=1\r\n"
        b"version=" + NEWER.encode() + b"\r\n"
        b"at=2026-11-16T08:00:00Z\r\n"
        b"message=  Kaputt: \xff\xfe  \r\n"
        b"state=done\r\n",
    )
    assert bench.state() == ("failed", NEWER, "2026-11-16T08:00:00.000Z", "Kaputt: \ufffd\ufffd")
    # Ohne Zeilenumbruch am Ende, mit Leerraum um den Schlüssel.
    bench.write("updater", " seen_at =2026-11-16T08:59:00Z")
    assert bench.status()["updater_seen_at"] == "2026-11-16T08:59:00.000Z"
    # Eine leere Anforderung liegt trotzdem vor.
    bench.write("request", "")
    assert bench.state() == ("requested", None, None, None)


def test_a_long_message_of_the_updater_is_cut(bench):
    bench.reported("failed", NEWER, message="Fehler " + "x" * 1000)
    message = bench.state()[3]
    assert len(message) == updates.MESSAGE_MAX and message.endswith("…")


def test_the_state_never_shows_paths_or_the_log(bench):
    bench.write("log", "GEHEIMES-LOG aus /volume1/docker/stowly\n")
    bench.write("before-0.1.0-20261116T080000Z.sqlite3", "SQLite format 3")
    bench.reported("failed", NEWER, message=f"Die neue Version startete nicht, zurück auf {CURRENT}.")
    bench.updater_seen()
    response = bench.client.get("/api/integrations", headers=bench.device.headers)
    text = response.text
    for secret in ("GEHEIMES-LOG", "/volume1", "before-", "SQLite format"):
        assert secret not in text, secret
    for form in (str(bench.settings.data_dir), json.dumps(str(bench.settings.data_dir))[1:-1]):
        assert form not in text


# --- Anfordern (10.5) --------------------------------------------------------------------------


def test_without_a_repo_check_and_install_are_503(client):
    device = Device(client, "Handy")
    message = "Updates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO)."
    for path, body in (("/api/update/check", None), ("/api/update/install", {"version": NEWER})):
        response = client.post(path, json=body, headers=device.headers)
        assert response.status_code == 503, path
        assert response.json() == {"error": {"code": "not_configured", "message": message, "details": None}}
        # Ohne Geräte-Token zuerst 401.
        assert client.post(path, json=body).status_code == 401
    assert client.app.state.updates is None


def test_without_a_token_401(bench):
    for path, body in (("/api/update/check", None), ("/api/update/install", {"version": NEWER})):
        response = bench.client.post(path, json=body)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"
        assert response.json()["error"]["code"] == "unauthorized"
    assert bench.github.requests == []


@pytest.mark.parametrize(
    "version", ["1.2", "v1.2.3", "1.2.3-rc.1", "１.２.３", "1.2.3\n", "", "1" * 37 + ".0.0"]
)
def test_install_wants_a_plain_version(bench, version):
    response = bench.install(version)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "version"]


def refused(bench: Bench, version: str, status: int, message: str) -> None:
    response = bench.install(version)
    assert response.status_code == status, response.text
    code = "not_configured" if status == 503 else "conflict"
    assert response.json() == {"error": {"code": code, "message": message, "details": None}}
    assert not (bench.folder / "request.tmp").exists()


MISSING = "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9)."
ALREADY = "Ein Update ist schon angefordert."
NOT_LATEST = "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen."
INSTALLED = "Diese Version ist schon installiert."


def test_install_checks_in_the_order_of_the_contract(bench):
    bench.check()

    # 2. Der Updater meldet sich nicht (oder zu lange nicht): 503, auch wenn sonst alles passt.
    refused(bench, NEWER, 503, MISSING)
    bench.updater_seen(ago_s=601)
    refused(bench, NEWER, 503, MISSING)
    bench.requested(NEWER, ago_s=10)  # vor der Prüfung auf eine Anforderung
    refused(bench, "9.9.9", 503, MISSING)
    bench.remove("request")
    bench.updater_seen(ago_s=600)

    # 3. Schon angefordert oder in Arbeit: 409, vor der Prüfung der Version.
    bench.requested(NEWER, ago_s=10)
    refused(bench, "9.9.9", 409, ALREADY)
    refused(bench, NEWER, 409, ALREADY)
    bench.remove("request")
    bench.reported("installing", NEWER)
    refused(bench, "9.9.9", 409, ALREADY)
    bench.remove("state")

    # 4. Nicht die zuletzt gesehene neueste Version.
    refused(bench, NEWEST, 409, NOT_LATEST)
    refused(bench, CURRENT, 409, NOT_LATEST)

    # 5. Die neueste Version ist nicht neuer als dieser Server.
    bench.github.release = release(f"v{CURRENT}")
    bench.check(after=60)
    bench.updater_seen()
    refused(bench, CURRENT, 409, INSTALLED)
    bench.github.release = release(f"v{OLDER}")
    bench.check(after=60)
    bench.updater_seen()
    refused(bench, OLDER, 409, INSTALLED)
    refused(bench, NEWER, 409, NOT_LATEST)
    assert not (bench.folder / "request").exists()

    # 6. Sonst: angefordert.
    bench.github.release = release(f"v{NEWER}")
    bench.check(after=60)
    bench.updater_seen()
    assert bench.install(NEWER).status_code == 202


def test_nothing_known_nothing_to_install(bench):
    bench.updater_seen()
    refused(bench, NEWER, 409, NOT_LATEST)
    bench.github.answer = 404
    bench.check()
    refused(bench, NEWER, 409, NOT_LATEST)


def test_install_writes_the_request_and_logs_who_asked(bench, caplog):
    caplog.set_level(logging.INFO, logger="stowly")
    bench.check()
    bench.updater_seen()
    # Ein gescheiterter Versuch bleibt liegen, bis der Updater ihn überschreibt; ein Ergebnis für eine
    # andere Version hält nichts auf.
    bench.reported("failed", NEWER, ago_s=3600, message="Das Image ließ sich nicht laden.")
    before = (bench.folder / "state").read_bytes()
    bench.clock.advance(5)

    response = bench.install(NEWER)
    assert response.status_code == 202, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    UpdateStatus.model_validate(result)
    assert tuple(result[key] for key in STATE) == ("requested", NEWER, bench.clock.stamp(), None)
    assert (result["latest"], result["available"], result["updater_ready"]) == (NEWER, True, True)

    request = (bench.folder / "request").read_bytes()
    assert request == f"version={NEWER}\nrequested_at={bench.clock.stamp()}\ndevice=Küchen-Handy\n".encode()
    assert not (bench.folder / "request.tmp").exists()
    assert (bench.folder / "state").read_bytes() == before
    assert f"Update auf {NEWER} angefordert von Küchen-Handy" in caplog.text
    assert bench.status() == result

    # Ein zweites Mal, von einem anderen Gerät: schon angefordert.
    other = Device(bench.client, "Tablet")
    refused_twice = bench.install(NEWER, other)
    assert (refused_twice.status_code, refused_twice.json()["error"]["message"]) == (409, ALREADY)
    assert (bench.folder / "request").read_bytes() == request


def test_done_for_this_version_does_not_block_the_next(bench):
    bench.check()
    bench.updater_seen()
    bench.reported("done", CURRENT)
    assert bench.install(NEWER).status_code == 202


def test_the_device_name_in_the_request_is_cleaned(bench):
    odd = Device(bench.client, " Tab=let\n\x07Küche\u2028\u0085\x7f= ")
    bench.check()
    bench.updater_seen()
    assert bench.install(NEWER, odd).status_code == 202
    content = (bench.folder / "request").read_text(encoding="utf-8")
    assert content == f"version={NEWER}\nrequested_at={bench.clock.stamp()}\ndevice=TabletKüche\n"
    assert updates.clean_device("x" * 80) == "x" * 60
    assert updates.clean_device("a\tb=c\r\nd\ud800e") == "abcde"


def test_a_stale_tmp_file_is_replaced(bench):
    bench.check()
    bench.updater_seen()
    bench.write("request.tmp", "version=6.6.6\nhalb geschrieben")
    assert bench.install(NEWER).status_code == 202
    assert not (bench.folder / "request.tmp").exists()
    assert (bench.folder / "request").read_text(encoding="utf-8").startswith(f"version={NEWER}\n")


# --- Knopfdruck (POST /api/update/check) -------------------------------------------------------


def test_the_button_works_once_a_minute_for_the_whole_server(bench):
    bench.check()
    bench.clock.advance(12.5)
    tablet = Device(bench.client, "Tablet")
    for device in (bench.device, tablet):
        response = bench.client.post("/api/update/check", headers=device.headers)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "48"
        error = response.json()["error"]
        assert (error["code"], error["details"]) == ("rate_limited", {"retry_after_s": 48})
    assert len(bench.github.requests) == 1
    bench.clock.advance(UPDATE_CHECK_MIN_GAP_S - 12.5)
    response = bench.client.post("/api/update/check", headers=tablet.headers)
    assert response.status_code == 200
    assert len(bench.github.requests) == 2


def test_a_failure_at_github_is_no_failure_of_the_button(bench):
    bench.github.answer = 500
    result = bench.check()
    assert result["check_error"] == "GitHub antwortet mit 500."


# --- Die Schleife ------------------------------------------------------------------------------


def test_the_loop_runs_only_with_a_repo(settings, configured):
    app = create_app(settings)
    with TestClient(app):
        assert app.state.updates is None
    assert settings.update_dir.is_dir()  # angelegt auch ohne Repository: Der Updater findet ihn vor

    github = GitHub()
    app = make_app(configured, github, FrozenClock())
    with TestClient(app):
        assert isinstance(app.state.updates, updates.UpdateChecker)
    assert app.state.updates is None
    assert github.requests == []  # die erste Abfrage käme erst nach einer Minute


def run_loop(settings: Settings, script) -> GitHub:
    """Lässt die Schleife mit ``StepClock`` laufen, während ``script(checker, clock, github, waiting)``
    sie treibt; danach endet sie mit ``stop``."""
    create_app(settings)  # legt die Datenbank an
    github, clock = GitHub(), StepClock()
    checker = updates.UpdateChecker(settings, transport=httpx2.MockTransport(github.handle), clock=clock)

    async def waiting(sleeps: int) -> None:
        """Bis die Schleife zum ``sleeps``-ten Mal zu warten begonnen hat."""
        for _ in range(500):
            if clock.sleeps >= sleeps and clock.wakeups():
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"Die Schleife wartet nicht (sleep {clock.sleeps}-mal).")

    async def scenario() -> None:
        task = asyncio.create_task(checker.run())
        try:
            await script(checker, clock, github, waiting)
        finally:
            checker.stop()
            await asyncio.wait_for(task, 5)
            await checker.aclose()

    asyncio.run(scenario())
    return github


def test_the_loop_asks_after_a_minute_then_every_six_hours_and_a_press_starts_anew(configured):
    async def script(checker, clock, github, waiting) -> None:
        await waiting(1)
        assert clock.wakeups() == [UPDATE_CHECK_FIRST_S] == [60]
        clock.advance(59)
        await asyncio.sleep(0.05)
        assert github.requests == []
        clock.advance(1)
        await waiting(2)
        assert len(github.requests) == 1
        assert clock.wakeups() == [60 + SIX_HOURS]

        # Sechs Stunden nach der letzten Abfrage, auch wenn sie scheiterte.
        github.answer = 500
        clock.advance(SIX_HOURS - 1)
        await asyncio.sleep(0.05)
        assert len(github.requests) == 1
        clock.advance(1)
        await waiting(3)
        assert len(github.requests) == 2
        assert clock.wakeups() == [60 + 2 * SIX_HOURS]

        # Ein Knopfdruck eine Stunde später fragt sofort und beginnt den Takt neu.
        github.answer = 200
        clock.advance(3600)
        await checker.check_now()
        assert len(github.requests) == 3
        await waiting(4)
        pressed = 60 + SIX_HOURS + 3600
        assert clock.wakeups() == [pressed + SIX_HOURS]
        clock.advance(SIX_HOURS - 1)  # vorbei an dem Zeitpunkt, der ohne Knopfdruck gegolten hätte
        assert clock.mono > 60 + 2 * SIX_HOURS
        await asyncio.sleep(0.05)
        assert len(github.requests) == 3
        clock.advance(1)
        await waiting(5)
        assert len(github.requests) == 4

    run_loop(configured, script)
    run = load_run(configured)
    assert (run.last_error, run.state["latest"]) == (None, NEWER)


def test_a_press_in_the_first_minute_replaces_the_first_check(configured):
    async def script(checker, clock, github, waiting) -> None:
        await waiting(1)
        clock.advance(10)
        await checker.check_now()
        await waiting(2)
        assert clock.wakeups() == [10 + SIX_HOURS]
        clock.advance(50)  # eine Minute nach dem Start
        await asyncio.sleep(0.05)
        assert len(github.requests) == 1
        # Ein zweiter Knopfdruck binnen einer Minute zählt nicht.
        with pytest.raises(updates.TooSoon) as error:
            await checker.check_now()
        assert error.value.retry_after_s == 10
        assert len(github.requests) == 1
        clock.advance(SIX_HOURS - 50)
        await waiting(3)
        assert len(github.requests) == 2

    run_loop(configured, script)


def test_the_loop_ends_promptly_while_it_waits(configured):
    """``stop`` weckt die wartende Schleife; ``run_loop`` gibt ihr dafür höchstens fünf Sekunden."""

    async def script(checker, clock, github, waiting) -> None:
        await waiting(1)

    started = time.monotonic()
    github = run_loop(configured, script)
    assert time.monotonic() - started < 3
    assert github.requests == []
