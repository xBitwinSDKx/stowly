"""Die Tagesnachricht „nur Neues" (docs/integrationen.md, Abschnitt 4.8).

Die Aufgabe ``push_daily`` des Zeitplans: einmal am Tag ab ``notify_time`` in ihrem Fenster (1.4),
nur mit ``STOWLY_PUSH_CONTACT``. Sie läuft auch ohne Abo und ohne Neues; der Lauf rückt das Fenster
vor.

**Das Fenster** reicht vom vorigen Lauf ``P`` bis zu diesem ``R``. Neu ist eine Packung im Bestand,

* deren Eintritt in ihre Stufe (``soon_from``: MHD minus Vorlaufzeit, ``expired_from``: MHD plus ein
  Tag) im Fenster liegt (``P.date < Eintritt ≤ R.date``), oder
* die seit ``P.at`` neu im Bestand ist: Der Server hat ``package.created`` oder ``package.restored``
  danach verbucht (``recorded_at``). Es zählt, wann der Server davon erfuhr: Was ein Gerät vor Tagen
  offline eingelagert hat und erst heute abgleicht, ist für den Haushalt neu.

**Je Packung höchstens zwei Nachrichten:** ``push_notices`` merkt sich je Packung und Stufe, wann sie
in einer Nachricht stand; was dort steht, ist nie wieder neu. Eingetragen wird, sobald die Nachricht an
mindestens ein Abo hinausging (der Push-Dienst hat geantwortet, gleich was).
"""

import asyncio
import logging
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from stowly import db, localtime, push, records, scheduler, summary, texts
from stowly.config import Settings
from stowly.contract.api import PUSH_PATHS, PushTestStatus
from stowly.contract.mhd import expired_from, soon_from
from stowly.contract.timeutil import format_timestamp, is_time_of_day
from stowly.off import Clock

log = logging.getLogger("stowly.push")

JOB = "push_daily"
# Kopfzeilen der Tagesnachricht (4.6): Nach einem Funkloch kommt nur die neueste.
TTL_S = 86400
TOPIC = "stowly-daily"
URGENCY = "normal"
TAG = "stowly-daily"
# iOS setzt unter den Titel selbst „from" und den Namen der App; „Stowly" stünde dort doppelt.
TITLE = "MHD-Hinweis"
# So viele Einträge hat eine Liste höchstens; der Name eines Produkts höchstens so viele Zeichen.
LIST_MAX = 3
NAME_MAX = 40
DEFAULT_NOTIFY_TIME = "17:00"


# --- Was ist neu? ------------------------------------------------------------------------------


def previous_run(run: scheduler.JobRun, now: datetime, tz: ZoneInfo) -> tuple[str, str]:
    """``(P.date, P.at)``: der vorige Lauf; gab es keinen, gestern zur selben Stunde (jetzt minus 24 Stunden)."""
    if run.last_date is not None and run.last_at is not None:
        return run.last_date, run.last_at
    yesterday = now - timedelta(hours=24)
    return localtime.today(yesterday, tz).isoformat(), format_timestamp(yesterday)


def entered(day: str | None, previous_day: str, this_day: str) -> bool:
    """Liegt der Eintritt in eine Stufe im Fenster (``P.date < Eintritt ≤ R.date``)?"""
    return day is not None and previous_day < day <= this_day


@dataclass
class News:
    """Was ein Lauf gefunden hat."""

    day: str  # R.date
    soon: list[summary.Stocked] = field(default_factory=list)  # neu bald fällig
    expired: list[summary.Stocked] = field(default_factory=list)  # neu abgelaufen
    # Neu abgelaufen und zugleich neu bald fällig (etwa nach einem Ausfall): zählt als abgelaufen
    # und gilt danach für beide Stufen als gemeldet.
    both: set[str] = field(default_factory=set)
    total_soon: int = 0
    total_expired: int = 0

    @property
    def count(self) -> int:
        return len(self.soon) + len(self.expired)


def find_news(con: sqlite3.Connection, now: datetime, tz: ZoneInfo, run: scheduler.JobRun) -> News:
    """Die neu bald fälligen und neu abgelaufenen Packungen dieses Laufs."""
    previous_day, previous_at = previous_run(run, now, tz)
    this_day = localtime.today(now, tz).isoformat()
    packages = summary.stocked(con, this_day)
    noticed = {
        (row["package_id"], row["state"]) for row in con.execute("SELECT package_id, state FROM push_notices")
    }
    fresh = {
        row["entity_id"]
        for row in con.execute(
            "SELECT DISTINCT entity_id FROM events WHERE type IN ('package.created', 'package.restored') "
            "AND recorded_at > ?",
            (previous_at,),
        )
    }
    news = News(day=this_day)

    def new_in(stage: str, entry: str | None, package: summary.Stocked) -> bool:
        if (package.id, stage) in noticed:
            return False
        return entered(entry, previous_day, this_day) or package.id in fresh

    for package in packages:
        if package.state == "soon":
            news.total_soon += 1
            if new_in("soon", soon_from(package.best_before, package.warn_days), package):
                news.soon.append(package)
        elif package.state == "expired":
            news.total_expired += 1
            if new_in("expired", expired_from(package.best_before), package):
                news.expired.append(package)
                if new_in("soon", soon_from(package.best_before, package.warn_days), package):
                    news.both.add(package.id)
    return news


# --- Der Text ----------------------------------------------------------------------------------


def listing(packages: Sequence[summary.Stocked]) -> str:
    """„Joghurt (16.11.)", „2× Joghurt (16.11.) und Milch (18.11.)"; bei mehr als drei Einträgen die
    ersten zwei und „und <n> weitere", damit die Liste nie mehr als drei Teile hat."""
    entries = [
        f"{texts.counted(count)}{texts.shorten(first.name, NAME_MAX)} ({texts.day_month(first.best_before or '')})"
        for first, count in summary.groups(packages)
    ]
    if len(entries) > LIST_MAX:
        return f"{', '.join(entries[: LIST_MAX - 1])} und {len(entries) - (LIST_MAX - 1)} weitere"
    return texts.joined(entries)


def body(news: News) -> str:
    """Der Rumpf: das neu Abgelaufene, das neu bald Fällige, immer die Gesamtzahlen."""
    parts: list[str] = []
    if news.expired:
        parts.append(f"Neu abgelaufen: {listing(news.expired)}.")
    if news.soon:
        parts.append(f"Neu bald fällig: {listing(news.soon)}.")
    parts.append(f"Insgesamt {news.total_soon} bald, {news.total_expired} abgelaufen.")
    return " ".join(parts)


# --- Die Aufgabe -------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Plan:
    at: str
    news: News
    subscriptions: list[push.Subscription]


class PushDailyJob:
    """Die Aufgabe ``push_daily`` des Zeitplans. Sie spricht über ``push.PushService`` mit den Push-Diensten
    und läuft deshalb als Koroutine; die Datenbank liest und schreibt sie in einem eigenen Thread."""

    name = JOB

    def __init__(self, settings: Settings, sender: push.PushService, *, clock: Clock | None = None) -> None:
        self.settings = settings
        self._sender = sender
        self._clock = clock or Clock()

    def notify_time(self) -> str:
        """Die Uhrzeit aus den Einstellungen des Haushalts; ohne gültigen Wert die Vorgabe 17:00."""
        con = db.connect(self.settings.database_path)
        try:
            value = records.settings_values(con).get("notify_time")
        finally:
            con.close()
        return value if isinstance(value, str) and is_time_of_day(value) else DEFAULT_NOTIFY_TIME

    def due(self, run: scheduler.JobRun, now: datetime) -> bool:
        if not self.settings.push_configured:
            return False
        return scheduler.push_daily_due(run, now, self.settings.tz, self.notify_time())

    async def run(self, now: datetime) -> None:
        plan = await asyncio.to_thread(self._plan, now)
        deliveries: list[push.Delivery | None] = []
        if plan.news.count and plan.subscriptions:
            text = body(plan.news)
            deliveries = list(await asyncio.gather(*(self._send(item, text) for item in plan.subscriptions)))
        await asyncio.to_thread(self._finish, plan, deliveries)

    def _plan(self, now: datetime) -> _Plan:
        con = db.connect(self.settings.database_path)
        try:
            news = find_news(con, now, self.settings.tz, scheduler.load_run(con, JOB))
            rows = con.execute(
                "SELECT device_id, endpoint, p256dh, auth, origin FROM push_subscriptions "
                "ORDER BY created_at, device_id"
            ).fetchall()
        finally:
            con.close()
        subscriptions = [push.Subscription(**{key: row[key] for key in row.keys()}) for row in rows]
        return _Plan(at=format_timestamp(now), news=news, subscriptions=subscriptions)

    async def _send(self, subscription: push.Subscription, text: str) -> push.Delivery | None:
        payload = push.notification(
            TITLE, text, origin=subscription.origin, path=PUSH_PATHS["daily"], tag=TAG
        )
        try:
            return await self._sender.deliver(subscription, payload, ttl=TTL_S, topic=TOPIC, urgency=URGENCY)
        except Exception:
            # Etwa ein unbrauchbarer Schlüssel am Abo: Die anderen Abos bekommen ihre Nachricht trotzdem.
            log.exception("Tagesnachricht an %s ließ sich nicht schicken", subscription.host)
            return None

    def _finish(self, plan: _Plan, deliveries: Sequence[push.Delivery | None]) -> None:
        news = plan.news
        # „Hinausgegangen": Der Push-Dienst hat geantwortet, gleich was. „Erreicht": Er hat angenommen.
        went_out = any(item is not None and item.http_status is not None for item in deliveries)
        reached = any(item is not None and item.status is PushTestStatus.SENT for item in deliveries)
        errors = sum(1 for item in deliveries if item is None or item.status is not PushTestStatus.SENT)
        state: dict[str, object] = {
            "packages": news.count,
            "subscriptions": len(plan.subscriptions),
            "errors": errors,
        }
        sent_at = format_timestamp(self._clock.now()) if went_out else None
        if sent_at is not None:
            state = {"sent_at": sent_at, **state}
        error = None
        if deliveries and not reached:
            notes = sorted({item.note for item in deliveries if item is not None and item.note})
            error = "Die Tagesnachricht hat kein Abo erreicht" + (f" ({', '.join(notes)})." if notes else ".")

        con = db.connect(self.settings.database_path)
        try:
            with db.transaction(con):
                if sent_at is not None:
                    notices = [(package.id, "soon") for package in news.soon]
                    notices += [(package.id, "expired") for package in news.expired]
                    notices += [(package_id, "soon") for package_id in sorted(news.both)]
                    con.executemany(
                        "INSERT OR IGNORE INTO push_notices (package_id, state, sent_at) VALUES (?, ?, ?)",
                        [(package_id, stage, sent_at) for package_id, stage in notices],
                    )
                scheduler.save_success(con, JOB, day=news.day, at=plan.at, state=dict(state), error=error)
        finally:
            con.close()

        packages = "1 Packung" if news.count == 1 else f"{news.count} Packungen"
        if not news.count:
            log.info("Tagesnachricht: nichts Neues.")
        elif not deliveries:
            log.info("Tagesnachricht: %s neu, aber kein Abo.", packages)
        elif error is not None:
            log.warning("Tagesnachricht: %s", error)
        else:
            log.info(
                "Tagesnachricht: %s neu, angenommen bei %d von %d Abos.",
                packages,
                len(deliveries) - errors,
                len(deliveries),
            )
