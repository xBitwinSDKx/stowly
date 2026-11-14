"""Zeitplan und Zeit des Servers (docs/integrationen.md, Abschnitte 1 und 2).

Die Uhr ist eingereicht: Die Tests stellen sie auf die Tage der Zeitumstellung, auf einen Neustart
nach einem Ausfall und vor und hinter 21:00 für das Fenster der Tagesnachricht.
"""

import asyncio
import threading
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from stowly import db, localtime, off, scheduler
from stowly.scheduler import JobRun, Scheduler

BERLIN = ZoneInfo("Europe/Berlin")


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


class FakeClock(off.Clock):
    """Eine Uhr, die nur weitergeht, wenn der Test sie stellt."""

    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.value.timestamp()

    async def sleep(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


# --- Zeit des Servers ------------------------------------------------------------------------


def test_today_and_reached_are_in_the_timezone_of_the_server():
    late = utc(2026, 11, 14, 23, 30)  # in Berlin schon der 15.
    assert localtime.today(late, BERLIN) == date(2026, 11, 15)
    assert localtime.today(late, ZoneInfo("UTC")) == date(2026, 11, 14)
    assert localtime.reached(utc(2026, 11, 14, 2, 30), BERLIN, "03:30")
    assert not localtime.reached(utc(2026, 11, 14, 2, 29, 59), BERLIN, "03:30")
    with pytest.raises(ValueError):
        localtime.today(datetime(2026, 11, 14, 12, 0), BERLIN)  # ohne Zeitzone


@pytest.mark.parametrize(
    ("day", "hhmm", "expected"),
    [
        (date(2026, 11, 14), "03:30", utc(2026, 11, 14, 2, 30)),
        (date(2026, 7, 1), "03:30", utc(2026, 7, 1, 1, 30)),
        # 29.03.2026: 02:00 bis 02:59 gibt es nicht; erreicht ist 02:30 mit dem Sprung auf 03:00.
        (date(2026, 3, 29), "02:30", utc(2026, 3, 29, 1, 0)),
        (date(2026, 3, 29), "02:00", utc(2026, 3, 29, 1, 0)),
        (date(2026, 3, 29), "01:59", utc(2026, 3, 29, 0, 59)),
        (date(2026, 3, 29), "03:00", utc(2026, 3, 29, 1, 0)),
        # 25.10.2026: 02:00 bis 02:59 gibt es zweimal; erreicht ist es beim ersten Mal.
        (date(2026, 10, 25), "02:30", utc(2026, 10, 25, 0, 30)),
        (date(2026, 10, 25), "03:00", utc(2026, 10, 25, 2, 0)),
        (date(2026, 10, 25), "00:00", utc(2026, 10, 24, 22, 0)),
    ],
)
def test_the_first_moment_of_a_time_of_day(day, hhmm, expected):
    assert localtime.first_moment(day, hhmm, BERLIN) == expected


# --- Fällig (1.2, 1.3, 1.4) ------------------------------------------------------------------


def test_the_spring_forward_day_runs_once_after_the_jump():
    """29.03.2026, Uhrzeit 02:30: Der erste Takt nach dem Sprung (01:00 UTC) startet die Aufgabe."""
    run = JobRun("backup")
    assert not scheduler.daily_due(run, utc(2026, 3, 29, 0, 59), BERLIN, "02:30")
    assert scheduler.daily_due(run, utc(2026, 3, 29, 1, 0), BERLIN, "02:30")
    after = JobRun("backup", last_date="2026-03-29", last_at="2026-03-29T01:00:00.000Z")
    assert not scheduler.daily_due(after, utc(2026, 3, 29, 1, 1), BERLIN, "02:30")
    assert not scheduler.daily_due(after, utc(2026, 3, 29, 21, 59), BERLIN, "02:30")
    assert scheduler.daily_due(after, utc(2026, 3, 30, 0, 30), BERLIN, "02:30")


def test_the_fall_back_day_runs_at_the_first_0230_only():
    """25.10.2026: 02:30 kommt zweimal (00:30 und 01:30 UTC); die Aufgabe läuft beim ersten Mal."""
    run = JobRun("backup", last_date="2026-10-24")
    assert not scheduler.daily_due(run, utc(2026, 10, 25, 0, 29), BERLIN, "02:30")
    assert scheduler.daily_due(run, utc(2026, 10, 25, 0, 30), BERLIN, "02:30")
    after = JobRun("backup", last_date="2026-10-25")
    assert not scheduler.daily_due(after, utc(2026, 10, 25, 1, 30), BERLIN, "02:30")


def test_after_an_outage_the_task_catches_up_at_the_first_tick():
    """Der Server war um 03:30 aus und startet um 10:00: Die Aufgabe kommt jetzt, einmal."""
    run = JobRun("backup", last_date="2026-11-11")
    assert scheduler.daily_due(run, utc(2026, 11, 14, 9, 0), BERLIN, "03:30")
    # Auch abends noch.
    assert scheduler.daily_due(run, utc(2026, 11, 14, 22, 30), BERLIN, "03:30")
    # Eine Uhr, die zurückgestellt wurde, lässt sie nicht zweimal laufen.
    ahead = JobRun("backup", last_date="2026-11-15")
    assert not scheduler.daily_due(ahead, utc(2026, 11, 14, 9, 0), BERLIN, "03:30")


@pytest.mark.parametrize(
    ("notify", "window"),
    [
        ("17:00", ("17:00", "21:00")),
        ("06:30", ("06:30", "21:00")),
        ("20:59", ("20:59", "21:00")),
        ("21:00", ("21:00", "22:00")),
        ("22:59", ("22:59", "23:59")),
        ("23:00", ("23:00", None)),
        ("23:30", ("23:30", None)),
    ],
)
def test_the_window_of_the_daily_message(notify, window):
    start, end = scheduler.push_window(notify)
    assert (start.strftime("%H:%M"), None if end is None else end.strftime("%H:%M")) == window


def berlin(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, 14, hour, minute, tzinfo=BERLIN).astimezone(UTC)


@pytest.mark.parametrize(
    ("notify", "now", "due"),
    [
        ("17:00", berlin(16, 59), False),
        ("17:00", berlin(17, 0), True),
        ("17:00", berlin(20, 59), True),  # nach einem Ausfall: bis 21 Uhr
        ("17:00", berlin(21, 0), False),
        ("17:00", berlin(23, 0), False),
        ("21:00", berlin(21, 0), True),
        ("21:00", berlin(21, 59), True),
        ("21:00", berlin(22, 0), False),
        ("23:30", berlin(23, 59), True),
        ("23:30", berlin(0, 15), False),  # Mitternacht ist das Ende; am nächsten Tag nichts nachholen
    ],
)
def test_the_daily_message_is_due_only_in_its_window(notify, now, due):
    assert scheduler.push_daily_due(JobRun("push_daily", last_date="2026-11-13"), now, BERLIN, notify) is due


def test_the_daily_message_comes_once_a_day_even_with_a_new_time():
    """Wer notify_time ändert, nachdem die Nachricht heute lief, bekommt heute keine zweite."""
    ran = JobRun("push_daily", last_date="2026-11-14")
    assert not scheduler.push_daily_due(ran, berlin(19, 0), BERLIN, "18:30")
    assert scheduler.push_daily_due(JobRun("push_daily"), berlin(19, 0), BERLIN, "18:30")


# --- job_runs --------------------------------------------------------------------------------


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "data" / "stowly.sqlite3"
    db.initialise(path)
    return path


def test_job_runs_keep_the_last_success_and_the_last_error(database):
    con = db.connect(database)
    try:
        assert scheduler.load_run(con, "backup") == JobRun("backup")
        scheduler.record_failure(con, "backup", at="2026-11-14T02:30:00.000Z", error="Kaputt.")
        assert scheduler.load_run(con, "backup") == JobRun(
            "backup", last_error="Kaputt.", last_error_at="2026-11-14T02:30:00.000Z"
        )
        scheduler.record_success(
            con, "backup", day="2026-11-14", at="2026-11-14T03:30:00.000Z", state={"file": "a", "size": 3}
        )
        scheduler.record_failure(con, "backup", at="2026-11-15T02:30:00.000Z", error="Wieder.")
        run = scheduler.load_run(con, "backup")
        # Ein Fehler lässt den letzten gelungenen Lauf stehen.
        assert (run.last_date, run.last_at, run.state) == (
            "2026-11-14",
            "2026-11-14T03:30:00.000Z",
            {"file": "a", "size": 3},
        )
        assert (run.last_error, run.last_error_at) == ("Wieder.", "2026-11-15T02:30:00.000Z")
        scheduler.record_success(con, "backup", day="2026-11-15", at="2026-11-15T03:30:00.000Z", state={})
        run = scheduler.load_run(con, "backup")
        assert (run.last_error, run.last_error_at, run.last_date) == (None, None, "2026-11-15")
    finally:
        con.close()


# --- Die Schleife ----------------------------------------------------------------------------


class DailyJob:
    """Eine Aufgabe zum Zählen: täglich ab ``hhmm``; vermerkt sich selbst in ``job_runs``."""

    def __init__(self, database, name: str = "zaehlen", hhmm: str = "03:30", fail: bool = False) -> None:
        self.database = database
        self.name = name
        self.hhmm = hhmm
        self.fail = fail
        self.runs: list[datetime] = []
        self.threads: set[int] = set()
        self.release: threading.Event | None = None

    def due(self, run: JobRun, now: datetime) -> bool:
        return scheduler.daily_due(run, now, BERLIN, self.hhmm)

    def run(self, now: datetime) -> None:
        self.runs.append(now)
        self.threads.add(threading.get_ident())
        if self.release is not None:
            self.release.wait(5)
        if self.fail:
            raise RuntimeError("geht nicht")
        con = db.connect(self.database)
        try:
            scheduler.record_success(
                con,
                self.name,
                day=localtime.today(now, BERLIN).isoformat(),
                at=now.isoformat(),
                state={},
            )
        finally:
            con.close()


def test_the_scheduler_runs_what_is_due_once_a_day(database):
    clock = FakeClock(utc(2026, 3, 29, 0, 59))
    job = DailyJob(database, hhmm="02:30")
    jobs = Scheduler(database, [job], clock=clock)

    assert asyncio.run(jobs.run_once()) == []
    clock.value = utc(2026, 3, 29, 1, 0)
    assert asyncio.run(jobs.run_once()) == ["zaehlen"]
    clock.value = utc(2026, 3, 29, 1, 1)
    assert asyncio.run(jobs.run_once()) == []
    clock.value = utc(2026, 3, 30, 0, 30)  # 02:30 Sommerzeit am nächsten Tag
    assert asyncio.run(jobs.run_once()) == ["zaehlen"]
    assert job.runs == [utc(2026, 3, 29, 1, 0), utc(2026, 3, 30, 0, 30)]
    # Im eigenen Thread, nicht in der Ereignisschleife.
    assert threading.get_ident() not in job.threads


def test_a_failing_task_is_logged_and_noted_but_never_stops_the_loop(database, caplog):
    clock = FakeClock(utc(2026, 11, 14, 9, 0))
    broken = DailyJob(database, name="kaputt", fail=True)
    fine = DailyJob(database, name="heil")
    jobs = Scheduler(database, [broken, fine], clock=clock)
    assert sorted(asyncio.run(jobs.run_once())) == ["heil", "kaputt"]
    assert "Die Aufgabe kaputt ist unerwartet fehlgeschlagen" in caplog.text
    con = db.connect(database)
    try:
        run = scheduler.load_run(con, "kaputt")
        assert run.last_error == "Unerwarteter Fehler (Einzelheiten im Log des Servers)."
        assert run.last_date is None
        assert scheduler.load_run(con, "heil").last_date == "2026-11-14"
    finally:
        con.close()
    # Weiter geht es trotzdem: Der kaputte bleibt fällig, der heile ist erledigt.
    clock.value += timedelta(minutes=1)
    assert asyncio.run(jobs.run_once()) == ["kaputt"]


def test_a_task_never_runs_twice_at_the_same_time(database):
    clock = FakeClock(utc(2026, 11, 14, 9, 0))
    job = DailyJob(database)
    job.release = threading.Event()
    jobs = Scheduler(database, [job], clock=clock)

    async def scenario() -> list[str]:
        first = await jobs.tick()
        second = await jobs.tick()  # der erste Lauf hängt noch
        job.release.set()
        await asyncio.gather(*first, *second)
        return [task.get_name() for task in [*first, *second]]

    assert asyncio.run(scenario()) == ["stowly-job-zaehlen"]
    assert len(job.runs) == 1


def test_the_loop_checks_at_start_and_after_wake_and_stops_cleanly(database):
    clock = FakeClock(utc(2026, 11, 14, 9, 0, 30))
    job = DailyJob(database)
    jobs = Scheduler(database, [job], clock=clock)

    async def scenario() -> None:
        loop = asyncio.create_task(jobs.run())
        for _ in range(200):  # sofort nach dem Start: die versäumte Aufgabe von heute
            await asyncio.sleep(0.01)
            if job.runs:
                break
        assert len(job.runs) == 1
        # Neuer Tag, geweckt statt bis zur vollen Minute zu warten.
        clock.value = utc(2026, 11, 15, 9, 0, 30)
        jobs.wake()
        for _ in range(200):
            await asyncio.sleep(0.01)
            if len(job.runs) == 2:
                break
        assert len(job.runs) == 2
        jobs.stop()
        await asyncio.wait_for(loop, 2)
        await jobs.aclose()

    asyncio.run(scenario())


def test_the_loop_wakes_at_the_full_minute():
    assert scheduler.seconds_to_next_tick(utc(2026, 11, 14, 9, 0, 45, 500_000)) == pytest.approx(14.55)
    assert scheduler.seconds_to_next_tick(utc(2026, 11, 14, 9, 0, 0)) == pytest.approx(60.05)
    assert scheduler.seconds_to_next_tick(utc(2026, 11, 14, 9, 0, 59, 999_000)) == pytest.approx(0.051)
