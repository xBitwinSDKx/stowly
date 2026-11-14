"""Automatische Einträge der Einkaufsliste gegen die gemeinsamen Fälle (docs/vectors.json, ``shopping_auto``).

Jeder Fall läuft gegen den echten Server, mit angehaltener Serveruhr. Ein Schritt stellt die Uhr
auf ``received`` und schickt den Befehl mit dem Alter ``received - at``: Der Server rechnet daraus
den wirksamen Zeitpunkt ``Beginn + at`` (Protokoll, Abschnitt 4). Jedes Gerät ist eine eigene
Anmeldung. Erwartet wird die Menge aller Einträge, wie sie ein Gerät aus ``changes.shopping_items``
kennt; dieselben Fälle prüft die Nachbildung des Servers in ``web/src/core/testing``.
"""

import json
from collections import Counter
from datetime import timedelta
from pathlib import Path

import pytest
from support import Device, statuses

from stowly.contract import ids

VECTORS = Path(__file__).resolve().parents[2] / "docs" / "vectors.json"
CASES = json.loads(VECTORS.read_text(encoding="utf-8"))["shopping_auto"]["cases"]


class Case:
    """Ein Fall: Geräte, Kürzel und Kennungen."""

    def __init__(self, client, clock, con) -> None:
        self.client = client
        self.clock = clock
        self.con = con
        self.start = clock.value
        self.devices: dict[str, Device] = {}
        self.products: dict[str, str] = {}
        self.packages: dict[str, str] = {}
        self.items: dict[str, str] = {}
        self.observer = Device(client, "Beobachter", clock=clock)
        self.observer.sync()

    def device(self, name: str) -> Device:
        if name not in self.devices:
            device = Device(self.client, f"Gerät {name}", clock=self.clock)
            device.sync()
            self.devices[name] = device
        return self.devices[name]

    # ------------------------------------------------------------------ Kürzel

    def product(self, short: str) -> str:
        if short not in self.products:
            self.products[short] = ids.new_uuid()
        return self.products[short]

    def resolve(self, product_id: str) -> str:
        """Folgt ``merged_into`` wie der Server."""
        for _hop in range(100):
            row = self.con.execute("SELECT merged_into FROM products WHERE id = ?", (product_id,)).fetchone()
            if row is None or row["merged_into"] is None:
                return product_id
            product_id = row["merged_into"]
        raise AssertionError("Schleife in merged_into")

    def auto(self, short: str, pick: str | None) -> str:
        """Der offene automatische Eintrag des Produkts; mit ``pick: done`` der zuletzt erledigte."""
        product_id = self.resolve(self.products[short])
        if pick == "done":
            row = self.con.execute(
                "SELECT id FROM shopping_items WHERE product_id = ? AND origin = 'min_stock' "
                "AND done_at IS NOT NULL AND deleted_at IS NULL ORDER BY done_at DESC, id DESC LIMIT 1",
                (product_id,),
            ).fetchone()
        else:
            assert pick is None, pick
            rows = self.con.execute(
                "SELECT id FROM shopping_items WHERE product_id = ? AND origin = 'min_stock' "
                "AND done_at IS NULL AND deleted_at IS NULL",
                (product_id,),
            ).fetchall()
            assert len(rows) <= 1, "mehr als ein offener automatischer Eintrag"
            row = rows[0] if rows else None
        assert row is not None, f"kein passender automatischer Eintrag für {short}"
        return row["id"]

    # ------------------------------------------------------------------ Schritte

    def payload(self, step: dict, device: Device) -> dict:
        command = step["cmd"]
        payload: dict = {}
        for key, value in step.items():
            if key in ("at", "cmd", "device", "received", "_fall", "pick"):
                continue
            if key == "product":
                payload["product_id"] = self.product(value)
            elif key == "package":
                if command == "package.create":
                    self.packages[value] = device.new_package_id()
                payload["package_id"] = self.packages[value]
            elif key == "item":
                if command == "shopping_item.create":
                    self.items[value] = ids.new_uuid()
                payload["item_id"] = self.items[value]
            elif key == "auto":
                payload["item_id"] = self.auto(value, step.get("pick"))
            elif key == "source":
                payload["source_id"] = self.product(value)
            elif key == "target":
                payload["target_id"] = self.product(value)
            elif key == "changes":
                payload["changes"] = {
                    ("product_id" if name == "product" else name): (
                        self.product(change) if name == "product" else change
                    )
                    for name, change in value.items()
                }
            else:
                payload[key] = value
        if command == "package.create":
            payload["zone_id"] = device.zone_id
        return payload

    def run(self, step: dict) -> None:
        received = step.get("received", step["at"])
        self.clock.value = self.start + timedelta(seconds=received)
        device = self.device(step.get("device", "A"))
        command = device.cmd(step["cmd"], age=received - step["at"], **self.payload(step, device))
        data = device.sync([command])
        assert statuses(data) == [("applied", None)], (step, data["results"])

    # ------------------------------------------------------------------ Erwartung

    def state(self, items: dict[str, dict]) -> Counter:
        """Die Einträge als Menge wie im Fall: ``(product|text, Kürzel|Text, origin, quantity, state)``."""
        names = {product_id: short for short, product_id in self.products.items()}
        found: Counter = Counter()
        for item in items.values():
            # Gelöscht geht vor erledigt.
            state = "deleted" if item["deleted_at"] else "done" if item["done_at"] else "open"
            if item["product_id"] is None:
                subject = ("text", item["text"])
            else:
                subject = ("product", names[item["product_id"]])
            found[(*subject, item["origin"], item["quantity"], state)] += 1
        return found


def expected(entries: list[dict]) -> Counter:
    return Counter(
        (
            *(("product", entry["product"]) if "product" in entry else ("text", entry["text"])),
            entry["origin"],
            entry["quantity"],
            entry["state"],
        )
        for entry in entries
    )


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_shared_cases(client, clock, con, case):
    run = Case(client, clock, con)
    checked = 0
    for step in case["steps"]:
        if "expect" not in step:
            run.run(step)
            continue
        # Ein Gerät, das schrittweise abgleicht, und eines, das alles neu holt, sehen dasselbe.
        run.observer.sync()
        wanted = expected(step["expect"])
        assert run.state(run.observer.shopping_items) == wanted, (case["name"], checked)
        fresh = Device(client, "Frisch", clock=clock)
        fresh.sync()
        assert run.state(fresh.shopping_items) == wanted, (case["name"], checked)
        assert fresh.shopping_items == run.observer.shopping_items
        checked += 1
    assert checked > 0
