"""Die Tagesnachricht „nur Neues" (docs/integrationen.md, Abschnitte 1.4 und 4.8).

Der Zeitplan läuft mit eingereichter Uhr; die Push-Dienste bildet ``httpx2.MockTransport`` nach, und
jede Nachricht wird wie im Browser entschlüsselt. Packungen entstehen über den Sync mit angehaltener
Serveruhr: Wann der Server von ihnen erfuhr (``recorded_at``), bestimmt der Test.
"""

import asyncio
import dataclasses
import json
import time
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from fastapi.testclient import TestClient
from support import Device, ServerClock
from test_push import Browser, decrypt

from stowly import daily, db, off, push, scheduler, summary
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids

CONTACT = "mailto:betrieb@example.org"
FCM = "https://fcm.googleapis.com/fcm/send/handy"
APPLE = "https://web.push.apple.com/tablet"


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


class JobClock(off.Clock):
    def __init__(self) -> None:
        self.value = utc(2026, 11, 14, 16, 0)

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.value.timestamp()

    async def sleep(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


class Services:
    """Nachgebildete Push-Dienste: eine Antwort je Endpunkt, Vorgabe 201."""

    def __init__(self) -> None:
        self.answers: dict[str, int | Exception] = {}
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        answer = self.answers.get(str(request.url), 201)
        if isinstance(answer, Exception):
            raise answer
        return httpx2.Response(answer)


@dataclasses.dataclass
class Bench:
    settings: Settings
    client: TestClient
    clock: ServerClock  # Serveruhr des Sync
    job_clock: JobClock  # Uhr des Zeitplans und des Versands
    services: Services
    sender: push.PushService
    jobs: scheduler.Scheduler
    device: Device
    browsers: dict[str, Browser]

    def run(self, at: datetime) -> list[str]:
        """Ein Takt des Zeitplans um ``at``; liefert die gestarteten Aufgaben."""
        self.job_clock.value = at
        return asyncio.run(self.jobs.run_once())

    def subscribe(self, endpoint: str = FCM, device: Device | None = None) -> Browser:
        browser = Browser()
        device = device or self.device
        response = self.client.put(
            "/api/push/subscription", json=browser.subscription(endpoint), headers=device.headers
        )
        assert response.status_code == 204, response.text
        self.browsers[endpoint] = browser
        return browser

    def messages(self) -> list[tuple[str, dict]]:
        """Jede verschickte Nachricht als ``(Endpunkt, Nutzlast)``, entschlüsselt wie im Browser."""
        found = []
        for request in self.services.requests:
            browser = self.browsers[str(request.url)]
            found.append((str(request.url), json.loads(decrypt(request.content, browser.key, browser.auth))))
        return found

    def bodies(self) -> list[str]:
        return [payload["notification"]["body"] for _, payload in self.messages()]

    def stock(self, name: str, *best_before: str | None, at: datetime, **product) -> tuple[str, list[str]]:
        """Lagert zur Serverzeit ``at`` ein Produkt mit je einer Packung je MHD ein."""
        self.clock.value = at
        product_id, create = self.device.product(name, **product)
        packages = [self.device.package(product_id, best_before=day) for day in best_before]
        data = self.device.sync([create, *(command for _, command in packages)])
        assert all(result["status"] == "applied" for result in data["results"]), data["results"]
        return product_id, [package_id for package_id, _ in packages]

    def last_run(self) -> scheduler.JobRun:
        con = db.connect(self.settings.database_path)
        try:
            return scheduler.load_run(con, daily.JOB)
        finally:
            con.close()

    def notices(self) -> set[tuple[str, str]]:
        con = db.connect(self.settings.database_path)
        try:
            return {(row["package_id"], row["state"]) for row in con.execute("SELECT * FROM push_notices")}
        finally:
            con.close()

    def endpoints(self) -> list[str]:
        con = db.connect(self.settings.database_path)
        try:
            return [row["endpoint"] for row in con.execute("SELECT endpoint FROM push_subscriptions")]
        finally:
            con.close()


@pytest.fixture
def bench(settings, clock):
    configured = dataclasses.replace(settings, push_contact=CONTACT)
    # Ohne „with": Der lifespan läuft nicht; den Zeitplan treibt der Test selbst.
    client = TestClient(create_app(configured))
    services = Services()
    job_clock = JobClock()
    sender = push.PushService(configured, transport=httpx2.MockTransport(services.handle), clock=job_clock)
    job = daily.PushDailyJob(configured, sender, clock=job_clock)
    jobs = scheduler.Scheduler(configured.database_path, [job], clock=job_clock)
    clock.value = utc(2026, 11, 1, 9)
    device = Device(client, "Handy", clock=clock)
    device.sync()
    yield Bench(configured, client, clock, job_clock, services, sender, jobs, device, {})
    asyncio.run(sender.aclose())


# Der 14.11.2026 in Berlin; die Tagesnachricht um 17:00 (Vorgabe) ist 16:00 UTC. Ohne vorigen Lauf
# reicht das Fenster von gestern zur selben Stunde (13.11., 16:00 UTC).
RUN = utc(2026, 11, 14, 16, 0)
BEFORE = utc(2026, 11, 13, 10, 0)  # eingelagert vor dem Fenster


def test_nothing_new_means_no_message_but_the_run_counts(bench):
    bench.subscribe()
    bench.stock("Milch", "2026-11-20", at=BEFORE)  # seit dem 6.11. bald fällig, also nicht neu
    assert bench.run(RUN) == ["push_daily"]
    assert bench.services.requests == []
    run = bench.last_run()
    assert (run.last_date, run.last_at, run.last_error) == ("2026-11-14", "2026-11-14T16:00:00.000Z", None)
    assert run.state == {"packages": 0, "subscriptions": 1, "errors": 0}
    assert bench.notices() == set()


def test_new_soon_reaches_every_subscription_with_its_own_origin(bench):
    phone = bench.subscribe()
    tablet = Device(bench.client, "Tablet", clock=bench.clock)
    browser = Browser()
    response = bench.client.put(
        "/api/push/subscription",
        json=browser.subscription(APPLE, origin="https://stowly.example:8443"),
        headers=tablet.headers,
    )
    assert response.status_code == 204
    bench.browsers[APPLE] = browser
    bench.stock("Milch", "2026-11-20", at=BEFORE)
    _product, (yoghurt,) = bench.stock("Joghurt", "2026-11-28", at=BEFORE)  # bald fällig ab heute

    assert bench.run(RUN) == ["push_daily"]
    messages = dict(bench.messages())
    assert set(messages) == {FCM, APPLE}
    for endpoint, origin in ((FCM, "https://stowly.example"), (APPLE, "https://stowly.example:8443")):
        assert messages[endpoint] == {
            "web_push": 8030,
            "notification": {
                "title": "Stowly",
                "body": "Neu bald fällig: Joghurt (28.11.). Insgesamt 2 bald, 0 abgelaufen.",
                "navigate": f"{origin}/warnungen",
                "lang": "de-DE",
                "dir": "ltr",
                "tag": "stowly-daily",
                "silent": False,
            },
        }
    for request in bench.services.requests:
        assert request.headers["ttl"] == "86400"
        assert request.headers["topic"] == "stowly-daily"
        assert request.headers["urgency"] == "normal"
        assert request.headers["content-encoding"] == "aes128gcm"
        assert request.headers["authorization"].startswith("vapid t=")
    run = bench.last_run()
    assert run.state == {
        "sent_at": "2026-11-14T16:00:00.000Z",
        "packages": 1,
        "subscriptions": 2,
        "errors": 0,
    }
    assert run.last_error is None
    assert bench.notices() == {(yoghurt, "soon")}
    assert phone


def test_new_expired(bench):
    bench.subscribe()
    _product, (quark,) = bench.stock("Quark", "2026-11-13", at=BEFORE)  # seit heute abgelaufen
    bench.run(RUN)
    assert bench.bodies() == ["Neu abgelaufen: Quark (13.11.). Insgesamt 0 bald, 1 abgelaufen."]
    # Bald fällig war der Quark schon vor dem Fenster: nur die Stufe „abgelaufen" ist gemeldet.
    assert bench.notices() == {(quark, "expired")}


def test_soon_and_expired_at_once_count_as_expired_and_both_are_noted(bench):
    """Nach einem Ausfall: Eintritt in „bald" und in „abgelaufen" liegen beide im Fenster."""
    bench.subscribe()
    con = db.connect(bench.settings.database_path)
    try:
        scheduler.record_success(
            con, daily.JOB, day="2026-11-10", at="2026-11-10T16:00:00.000Z", state={"packages": 0}
        )
    finally:
        con.close()
    _product, (cream,) = bench.stock("Sahne", "2026-11-12", warn_days=1, at=utc(2026, 11, 9, 10))
    bench.stock("Butter", "2026-11-27", at=utc(2026, 11, 9, 10))  # bald ab 13.11., im Fenster
    bench.run(RUN)
    assert bench.bodies() == [
        "Neu abgelaufen: Sahne (12.11.). Neu bald fällig: Butter (27.11.). Insgesamt 1 bald, 1 abgelaufen."
    ]
    assert {(package, stage) for package, stage in bench.notices() if package == cream} == {
        (cream, "soon"),
        (cream, "expired"),
    }
    assert bench.last_run().state["packages"] == 2


def test_a_device_that_syncs_days_later_brings_news(bench):
    """Offline vor drei Tagen eingelagert, heute abgeglichen: für den Haushalt neu."""
    bench.subscribe()
    late = Device(bench.client, "Keller", clock=bench.clock)
    late.sync()
    bench.clock.value = utc(2026, 11, 14, 15, 0)
    product_id, create = late.product("Leberwurst", age=3 * 86400)
    package_id, store = late.package(product_id, best_before="2026-11-18", age=3 * 86400)
    late.sync([create, store])
    con = db.connect(bench.settings.database_path)
    try:
        created_at = con.execute("SELECT created_at FROM packages WHERE id = ?", (package_id,)).fetchone()[0]
    finally:
        con.close()
    assert created_at == "2026-11-11T15:00:00.000Z"  # der wirksame Zeitpunkt liegt vor dem Fenster
    bench.run(RUN)
    assert bench.bodies() == ["Neu bald fällig: Leberwurst (18.11.). Insgesamt 1 bald, 0 abgelaufen."]


def test_a_package_is_never_in_a_third_message(bench):
    bench.subscribe()
    _product, (milk,) = bench.stock("Milch", "2026-11-20", warn_days=6, at=BEFORE)  # bald ab 14.11.
    bench.run(RUN)
    assert bench.bodies() == ["Neu bald fällig: Milch (20.11.). Insgesamt 1 bald, 0 abgelaufen."]
    # Am nächsten Tag ist sie nicht mehr neu.
    bench.run(RUN + timedelta(days=1))
    assert len(bench.services.requests) == 1
    # Abgelaufen ab dem 21.11.: die zweite und letzte Nachricht.
    bench.run(utc(2026, 11, 21, 16, 0))
    assert bench.bodies()[-1] == "Neu abgelaufen: Milch (20.11.). Insgesamt 0 bald, 1 abgelaufen."
    assert bench.notices() == {(milk, "soon"), (milk, "expired")}
    # Neues MHD, entnommen und wiederhergestellt: nie wieder neu.
    bench.clock.value = utc(2026, 11, 22, 10, 0)
    device = bench.device
    device.sync([device.cmd("package.update", package_id=milk, changes={"best_before": "2026-11-23"})])
    device.sync([device.cmd("package.remove", package_id=milk, reason="consumed")])
    bench.clock.advance(60)
    device.sync([device.cmd("package.restore", package_id=milk)])
    bench.run(utc(2026, 11, 22, 16, 0))
    bench.clock.value = utc(2026, 11, 23, 10, 0)
    device.sync([device.cmd("package.update", package_id=milk, changes={"best_before": "2026-11-21"})])
    bench.run(utc(2026, 11, 24, 16, 0))
    assert len(bench.services.requests) == 2


def test_outside_the_window_the_message_is_skipped_for_the_day(bench):
    bench.subscribe()
    con = db.connect(bench.settings.database_path)
    try:
        scheduler.record_success(
            con, daily.JOB, day="2026-11-13", at="2026-11-13T16:00:00.000Z", state={"packages": 0}
        )
    finally:
        con.close()
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)  # bald fällig ab dem 14.11.
    assert bench.run(utc(2026, 11, 14, 20, 0)) == []  # 21:00 in Berlin: zu spät
    assert bench.run(utc(2026, 11, 14, 15, 59)) == []  # 16:59: noch nicht
    assert bench.services.requests == []
    # Nicht nachgeholt; der Lauf am nächsten Tag deckt alles seit dem letzten Lauf ab, auch den 14.11.
    bench.stock("Quark", "2026-11-14", at=utc(2026, 11, 14, 21, 0))  # spät abends eingelagert
    assert bench.run(utc(2026, 11, 15, 16, 30)) == ["push_daily"]
    assert bench.bodies() == [
        "Neu abgelaufen: Quark (14.11.). Neu bald fällig: Joghurt (28.11.). Insgesamt 1 bald, 1 abgelaufen."
    ]
    assert bench.last_run().last_date == "2026-11-15"


def test_a_new_time_after_the_run_brings_no_second_message_today(bench):
    bench.subscribe()
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    assert bench.run(RUN) == ["push_daily"]
    bench.clock.value = utc(2026, 11, 14, 16, 30)
    bench.device.sync([bench.device.cmd("settings.update", changes={"notify_time": "18:00"})])
    bench.stock("Quark", "2026-11-13", at=utc(2026, 11, 14, 16, 40))
    assert bench.run(utc(2026, 11, 14, 17, 0)) == []
    assert bench.run(utc(2026, 11, 15, 16, 59)) == []  # 17:59: vor der neuen Uhrzeit
    assert bench.run(utc(2026, 11, 15, 17, 0)) == ["push_daily"]
    assert bench.bodies()[-1] == "Neu abgelaufen: Quark (13.11.). Insgesamt 1 bald, 1 abgelaufen."


def test_the_change_to_summer_time(bench):
    """29.03.2026, Uhrzeit 02:30: Es gibt sie nicht; die Nachricht kommt mit dem Sprung auf 03:00."""
    bench.subscribe()
    bench.clock.value = utc(2026, 3, 27, 10)
    bench.device.sync([bench.device.cmd("settings.update", changes={"notify_time": "02:30"})])
    bench.stock("Milch", "2026-04-11", at=utc(2026, 3, 27, 10))  # bald ab 28.03.
    assert bench.run(utc(2026, 3, 28, 1, 30)) == ["push_daily"]  # 02:30 Winterzeit
    bench.stock("Butter", "2026-04-12", at=utc(2026, 3, 27, 11))  # bald ab 29.03.
    assert bench.run(utc(2026, 3, 29, 0, 59)) == []  # 01:59 Winterzeit
    assert bench.run(utc(2026, 3, 29, 1, 0)) == ["push_daily"]  # 03:00 Sommerzeit
    assert bench.bodies() == [
        "Neu bald fällig: Milch (11.04.). Insgesamt 1 bald, 0 abgelaufen.",
        "Neu bald fällig: Butter (12.04.). Insgesamt 2 bald, 0 abgelaufen.",
    ]
    assert bench.last_run().last_date == "2026-03-29"


def test_the_change_to_winter_time(bench):
    """25.10.2026: 02:30 gibt es zweimal; die Nachricht kommt beim ersten Mal und nur dann."""
    bench.subscribe()
    bench.clock.value = utc(2026, 10, 20, 10)
    bench.device.sync([bench.device.cmd("settings.update", changes={"notify_time": "02:30"})])
    bench.stock("Milch", "2026-11-08", at=utc(2026, 10, 20, 10))  # bald ab 25.10.
    assert bench.run(utc(2026, 10, 25, 0, 30)) == ["push_daily"]  # 02:30 Sommerzeit
    assert bench.run(utc(2026, 10, 25, 1, 30)) == []  # 02:30 Winterzeit
    assert bench.bodies() == ["Neu bald fällig: Milch (08.11.). Insgesamt 1 bald, 0 abgelaufen."]


def test_a_gone_and_a_failing_subscription(bench):
    bench.subscribe(FCM)
    tablet = Device(bench.client, "Tablet", clock=bench.clock)
    bench.subscribe(APPLE, device=tablet)
    bench.services.answers = {FCM: 410, APPLE: 500}
    _product, (yoghurt,) = bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    bench.run(RUN)
    run = bench.last_run()
    # Hinausgegangen ist die Nachricht (beide Dienste haben geantwortet), erreicht hat sie keinen.
    assert run.state == {
        "sent_at": "2026-11-14T16:00:00.000Z",
        "packages": 1,
        "subscriptions": 2,
        "errors": 2,
    }
    assert run.last_error == (
        "Die Tagesnachricht hat kein Abo erreicht (Abo erloschen (410), Fehler des Push-Dienstes (500))."
    )
    assert run.last_date == "2026-11-14"
    assert bench.notices() == {(yoghurt, "soon")}
    # Das erloschene Abo ist weg, das andere bleibt mit seinem Fehler.
    assert bench.endpoints() == [APPLE]


def test_the_last_run_reaches_the_app(bench, monkeypatch):
    """``PushStatus``: letzter Lauf, letzte verschickte Nachricht, Fehler des letzten Laufs."""
    from stowly.api import integrations as endpoint

    monkeypatch.setattr(endpoint, "server_now", lambda: RUN)
    bench.subscribe()
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    bench.run(RUN)
    response = bench.client.get("/api/integrations", headers=bench.device.headers)
    assert response.json()["push"] == {
        "configured": True,
        "problem": None,
        "subscriptions": 1,
        "this_device": True,
        "last_run_at": "2026-11-14T16:00:00.000Z",
        "last_sent_at": "2026-11-14T16:00:00.000Z",
        "last_error": None,
    }
    assert CONTACT not in response.text


def test_one_reached_is_enough(bench):
    bench.subscribe(FCM)
    tablet = Device(bench.client, "Tablet", clock=bench.clock)
    bench.subscribe(APPLE, device=tablet)
    bench.services.answers = {APPLE: 404}
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    bench.run(RUN)
    run = bench.last_run()
    assert (run.last_error, run.state["errors"]) == (None, 1)
    assert bench.endpoints() == [FCM]


def test_nothing_goes_out_without_an_answer(bench):
    """Kommt keine Antwort (Netz), ging nichts hinaus: Nichts wird als gemeldet eingetragen."""
    bench.subscribe()
    bench.services.answers = {FCM: httpx2.ConnectError("weg")}
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    bench.run(RUN)
    run = bench.last_run()
    assert run.state == {"packages": 1, "subscriptions": 1, "errors": 1}
    assert run.last_error == "Die Tagesnachricht hat kein Abo erreicht (Nicht erreichbar)."
    assert bench.notices() == set()


def test_without_subscriptions_the_run_counts_and_notes_nothing(bench):
    bench.stock("Joghurt", "2026-11-28", at=BEFORE)
    assert bench.run(RUN) == ["push_daily"]
    run = bench.last_run()
    assert (run.last_date, run.state, run.last_error) == (
        "2026-11-14",
        {"packages": 1, "subscriptions": 0, "errors": 0},
        None,
    )
    assert bench.notices() == set()


def test_the_list_sums_up_and_shortens(bench):
    bench.subscribe()
    long_name = "Bio-Vollmilchjoghurt mit Erdbeeren aus der Region und viel Liebe"
    bench.stock(long_name, "2026-11-28", "2026-11-28", at=BEFORE)
    bench.stock("Milch", "2026-11-28", at=BEFORE)
    bench.run(RUN)
    # Gleiches MHD: nach dem Namen. Der Name ist auf 40 Zeichen gekürzt.
    assert bench.bodies() == [
        "Neu bald fällig: 2× Bio-Vollmilchjoghurt mit Erdbeeren aus… (28.11.) und Milch (28.11.). "
        "Insgesamt 3 bald, 0 abgelaufen."
    ]


def test_more_than_three_entries_end_with_and_n_more(bench):
    bench.subscribe()
    for name, day in (("Apfel", "2026-11-25"), ("Birne", "2026-11-26"), ("Dattel", "2026-11-28")):
        bench.stock(name, day, at=utc(2026, 11, 14, 9))  # heute neu im Bestand
    bench.run(RUN)
    assert bench.bodies() == [
        "Neu bald fällig: Apfel (25.11.), Birne (26.11.) und Dattel (28.11.). Insgesamt 3 bald, 0 abgelaufen."
    ]
    # Vier Einträge (je Produkt und MHD): die ersten zwei und der Rest.
    bench.stock("Eis", "2026-11-26", "2026-11-27", at=utc(2026, 11, 15, 9))
    bench.stock("Feigen", "2026-11-28", at=utc(2026, 11, 15, 9))
    bench.stock("Gurke", "2026-11-29", at=utc(2026, 11, 15, 9))
    bench.run(RUN + timedelta(days=1))
    assert bench.bodies()[-1] == (
        "Neu bald fällig: Eis (26.11.), Eis (27.11.) und 2 weitere. Insgesamt 7 bald, 0 abgelaufen."
    )


def test_the_app_runs_the_daily_message_in_its_schedule(settings, clock):
    """Im Betrieb startet der Zeitplan der App die Aufgabe, beim ersten Takt nach dem Start."""
    configured = dataclasses.replace(settings, push_contact=CONTACT)
    services = Services()
    job_clock = JobClock()
    app = create_app(configured, push_transport=httpx2.MockTransport(services.handle), job_clock=job_clock)
    with TestClient(app) as client:
        assert app.state.scheduler.jobs == ["push_daily"]
        for _ in range(300):
            con = db.connect(configured.database_path)
            try:
                run = scheduler.load_run(con, daily.JOB)
            finally:
                con.close()
            if run.last_date is not None:
                break
            time.sleep(0.01)
        assert (run.last_date, run.last_at) == ("2026-11-14", "2026-11-14T16:00:00.000Z")
        assert client.get("/api/health").status_code == 200


def test_without_a_contact_the_task_does_not_run(settings):
    job = daily.PushDailyJob(settings, sender=None)  # type: ignore[arg-type]
    assert not job.due(scheduler.JobRun(daily.JOB), RUN)


def test_the_window_starts_yesterday_at_the_same_hour_without_a_previous_run():
    tz = Settings.from_env({"STOWLY_TIMEZONE": "Europe/Berlin"}).tz
    assert daily.previous_run(scheduler.JobRun(daily.JOB), RUN, tz) == (
        "2026-11-13",
        "2026-11-13T16:00:00.000Z",
    )
    # Am Tag nach der Umstellung auf Sommerzeit liegt „gestern zur selben Stunde" 24 Stunden zurück.
    assert daily.previous_run(scheduler.JobRun(daily.JOB), utc(2026, 3, 30, 15, 0), tz) == (
        "2026-03-29",
        "2026-03-29T15:00:00.000Z",
    )


def test_four_entries_show_two_and_the_rest():
    packages = [
        summary.Stocked(ids.new_uuid(), f"p{index}", "z", f"2026-11-2{index}", "t", name, 14, "soon")
        for index, name in enumerate(["Apfel", "Birne", "Dattel", "Eis"])
    ]
    assert daily.listing(packages) == "Apfel (20.11.), Birne (21.11.) und 2 weitere"
    assert daily.listing(packages[:2]) == "Apfel (20.11.) und Birne (21.11.)"
    assert daily.listing(packages[:1]) == "Apfel (20.11.)"
