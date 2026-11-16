"""Bausteine der Server-Tests: eine anhaltbare Serveruhr und nachgespielte Geräte.

Ein ``Device`` verhält sich wie die Web-App gegenüber dem Server: Es meldet sich an,
schickt Befehle mit ``at`` und ``sent_at`` seiner eigenen Uhr und merkt sich ``cursor``,
``dataset_id``, den ID-Vorrat und alle gelieferten Datensätze.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from stowly.contract import PROTOCOL_VERSION, ids
from stowly.contract.timeutil import format_timestamp

TEST_PASSWORD = "test-passwort"

# Erfundene Barcodes mit gültiger Prüfziffer.
EAN_A = "4006381333931"
EAN_B = "96385074"
EAN_C = "0036000291452"
EAN_STORE = "2112345678900"  # ladenintern (Präfix 2)


class ServerClock:
    """Die Empfangszeit des Servers, angehalten und von Hand vorstellbar."""

    def __init__(self, start: datetime | None = None) -> None:
        start = start or datetime.now(UTC)
        # Auf Millisekunden gekürzt: So lassen sich Zeitstempel im Test genau vorhersagen.
        self.value = start.replace(microsecond=start.microsecond // 1000 * 1000)

    def now(self) -> datetime:
        return self.value

    def advance(self, seconds: float = 0.0, **more: float) -> None:
        self.value += timedelta(seconds=seconds, **more)

    def stamp(self, age_s: float = 0.0) -> str:
        """Der Zeitstempel, den der Server für einen ``age_s`` Sekunden alten Befehl berechnet."""
        return format_timestamp(self.value - timedelta(seconds=age_s))


class Device:
    """Ein angemeldetes Gerät."""

    def __init__(
        self,
        client: TestClient,
        name: str = "Testgerät",
        *,
        clock: ServerClock | None = None,
        clock_offset_s: float = 0.0,
        password: str = TEST_PASSWORD,
    ) -> None:
        self.client = client
        self.clock = clock
        # So viele Sekunden geht die Uhr dieses Geräts vor (negativ: nach).
        self.clock_offset_s = clock_offset_s
        response = client.post("/api/auth/login", json={"password": password, "device_name": name})
        assert response.status_code == 200, response.text
        body = response.json()
        self.token: str = body["token"]
        self.id: str = body["device"]["id"]
        self.headers = {"Authorization": f"Bearer {self.token}"}
        self.cursor = 0
        self.dataset_id: str | None = None
        self.pool: list[str] = []
        # Die lokale Kopie: alles, was der Server bisher geliefert hat.
        self.zones: dict[str, dict] = {}
        self.products: dict[str, dict] = {}
        self.packages: dict[str, dict] = {}
        self.printers: dict[str, dict] = {}
        self.printer_status: dict[str, dict] = {}
        self.print_jobs: dict[str, dict] = {}
        self.label_templates: dict[str, dict] = {}
        self.shopping_items: dict[str, dict] = {}
        self.settings: dict | None = None

    # ------------------------------------------------------------------ Zeit

    def now(self) -> datetime:
        base = self.clock.now() if self.clock is not None else datetime.now(UTC)
        return base + timedelta(seconds=self.clock_offset_s)

    def stamp(self, age_s: float = 0.0) -> str:
        """Zeitstempel der Geräteuhr, ``age_s`` Sekunden in der Vergangenheit."""
        return format_timestamp(self.now() - timedelta(seconds=age_s))

    # ------------------------------------------------------------------ Befehle

    def cmd(self, type_: str, /, *, age: float = 0.0, at: str | None = None, **payload: Any) -> dict:
        """Ein Befehl, den der Anwender vor ``age`` Sekunden ausgelöst hat."""
        return {"id": ids.new_uuid(), "at": at or self.stamp(age), "type": type_, **payload}

    def new_package_id(self) -> str:
        return self.pool.pop() if self.pool else ids.random_package_id()

    # ------------------------------------------------------------------ Sync

    def request(self, commands: Any = (), **overrides: Any) -> dict:
        """Der Rumpf eines Aufrufs; ``overrides`` ersetzt einzelne Felder, auch durch Unsinn."""
        body = {
            "protocol": PROTOCOL_VERSION,
            "dataset_id": self.dataset_id,
            "cursor": self.cursor,
            "sent_at": self.stamp(),
            # Listen werden kopiert, alles andere geht unverändert durch (kaputte Rahmen).
            "commands": list(commands) if isinstance(commands, (list, tuple)) else commands,
            "id_pool": {"have": len(self.pool)},
        }
        body.update(overrides)
        return body

    def post(self, commands: Any = (), **overrides: Any):
        """Der rohe Aufruf, ohne die Antwort anzuwenden."""
        return self.client.post("/api/sync", json=self.request(commands, **overrides), headers=self.headers)

    def sync(self, commands: Any = (), **overrides: Any) -> dict:
        """Ein Aufruf; die Antwort wird in die lokale Kopie übernommen."""
        response = self.post(commands, **overrides)
        assert response.status_code == 200, response.text
        data = response.json()
        self.apply(data)
        return data

    def sync_all(self, commands: Any = (), **overrides: Any) -> list[dict]:
        """Gleicht ab und blättert weiter, bis ``has_more`` falsch ist. Liefert alle Seiten."""
        pages = [self.sync(commands, **overrides)]
        while pages[-1]["has_more"]:
            assert len(pages) < 10_000
            pages.append(self.sync())
        return pages

    def apply(self, data: dict) -> None:
        if data["reset"]:
            for store in (
                self.zones,
                self.products,
                self.packages,
                self.printers,
                self.printer_status,
                self.print_jobs,
                self.label_templates,
                self.shopping_items,
            ):
                store.clear()
            self.settings = None
            self.pool.clear()
        changes = data["changes"]
        for item in changes["shopping_items"]:
            self.shopping_items[item["id"]] = item
        for zone in changes["zones"]:
            self.zones[zone["id"]] = zone
        for product in changes["products"]:
            self.products[product["id"]] = product
        for package in changes["packages"]:
            self.packages[package["id"]] = package
        for printer in changes["printers"]:
            self.printers[printer["id"]] = printer
        for status in changes["printer_status"]:
            self.printer_status[status["printer_id"]] = status
        for job in changes["print_jobs"]:
            self.print_jobs[job["id"]] = job
        for template in changes["label_templates"]:
            self.label_templates[template["key"]] = template
        if changes["settings"] is not None:
            self.settings = changes["settings"]
        self.cursor = data["cursor"]
        self.dataset_id = data["dataset_id"]
        self.pool.extend(data["id_pool"]["grant"])

    # ------------------------------------------------------------------ Abkürzungen

    @property
    def zone_id(self) -> str:
        """Die erste nicht gelöschte Zone (eine neue Datenbank hat genau eine: „Vorrat")."""
        zones = sorted(
            (zone for zone in self.zones.values() if zone["deleted_at"] is None),
            key=lambda zone: (zone["sort"], zone["name"]),
        )
        return zones[0]["id"]

    def product(self, name: str = "Basmati Reis", **payload: Any) -> tuple[str, dict]:
        """Befehl für ein neues Produkt; liefert ``(product_id, befehl)``."""
        product_id = ids.new_uuid()
        return product_id, self.cmd("product.create", product_id=product_id, name=name, **payload)

    def package(self, product_id: str, **payload: Any) -> tuple[str, dict]:
        """Befehl für eine neue Packung in der ersten Zone; liefert ``(package_id, befehl)``."""
        package_id = payload.pop("package_id", None) or self.new_package_id()
        payload.setdefault("zone_id", self.zone_id)
        return package_id, self.cmd("package.create", package_id=package_id, product_id=product_id, **payload)

    def store(self, name: str = "Basmati Reis", **package: Any) -> tuple[str, str]:
        """Legt ein Produkt mit einer Packung an und gleicht ab; liefert ``(product_id, package_id)``."""
        product_id, create_product = self.product(name)
        package_id, create_package = self.package(product_id, **package)
        results = self.sync([create_product, create_package])["results"]
        assert [result["status"] for result in results] == ["applied", "applied"], results
        return product_id, package_id


def statuses(data: dict) -> list[tuple[str, str | None]]:
    """``(status, code)`` je Befehl einer Antwort."""
    return [(result["status"], result["code"]) for result in data["results"]]


def events_of(client: TestClient, device: Device, **query: Any) -> list[dict]:
    """Alle Ereignisse zum Filter, älteste zuerst."""
    collected: list[dict] = []
    before: int | None = None
    while True:
        parameters = {**query, "limit": 500}
        if before is not None:
            parameters["before"] = before
        response = client.get("/api/events", params=parameters, headers=device.headers)
        assert response.status_code == 200, response.text
        page = response.json()
        collected.extend(page["events"])
        before = page["next_before"]
        if before is None:
            return list(reversed(collected))


def asgi_call(
    app: Any, method: str, path: str, headers: dict[str, str], parts: AsyncIterator[bytes]
) -> tuple[int, Any]:
    """Eine Anfrage direkt an die App (ASGI), ohne TestClient: Der Rumpf kommt Teil für Teil aus ``parts``,
    ohne Content-Length, und darf stocken. Der TestClient läse ihn vorher ganz. Liefert Status und JSON."""

    async def run() -> tuple[int, Any]:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": b"",
            "server": ("127.0.0.1", 8010),
            "client": ("127.0.0.1", 50000),
            "headers": [
                (name.lower().encode(), value.encode())
                for name, value in {
                    "host": "127.0.0.1:8010",
                    "transfer-encoding": "chunked",
                    **headers,
                }.items()
            ],
        }
        feed = aiter(parts)
        done = False

        async def receive() -> dict[str, Any]:
            nonlocal done
            if done:
                return {"type": "http.disconnect"}
            part = await anext(feed, None)
            if part is None:
                done = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.request", "body": part, "more_body": True}

        sent: list[dict[str, Any]] = []

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        await app(scope, receive, send)
        start = next(message for message in sent if message["type"] == "http.response.start")
        body = b"".join(
            message.get("body", b"") for message in sent if message["type"] == "http.response.body"
        )
        return start["status"], json.loads(body) if body else None

    return asyncio.run(run())
