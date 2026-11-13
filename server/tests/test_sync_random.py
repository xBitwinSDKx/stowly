"""Zufällige Befehlsfolgen von mehreren Geräten gegen die Zusagen der Änderungsfolge.

Kein Ersatz für die gezielten Tests der Konfliktregeln, sondern ein Netz darunter. Drei
Geräte schicken bunt gemischt alle 19 Befehle, auch unsinnige (unbekannte Kennungen,
gelöschte Zonen, zusammengeführte Produkte). Nach jedem Schritt muss gelten:

* Kein Aufruf scheitert, kein Befehl endet mit ``internal``.
* Ein Beobachter, der nur schrittweise abgleicht (in kleinen Seiten), hat denselben Stand
  wie ein frisches Gerät nach einem vollständigen Abzug. Fehlte irgendwo ein neuer ``rev``,
  erführe der Beobachter von der Änderung nie.
* Derselbe Befehl noch einmal ändert nichts mehr.

Die Folgen sind zufällig, aber durch den Startwert festgelegt: Ein Fehlschlag lässt sich wiederholen.
"""

import random

import pytest
from support import EAN_A, EAN_B, EAN_C, EAN_STORE, Device, ServerClock

from stowly.contract import ids
from stowly.sync import changes

BARCODES = [EAN_A, EAN_B, EAN_C, EAN_STORE, "20000004", "4000000000006", "4000000000013"]
DATES = [None, "2026-12-31", "2027-03-25", "2028-02-29"]
STATES = ["pending", "queued", "printing", "printed", "sent", "failed", "unknown", "cancelled"]
DIRECT = {"urls": ["https://10.71.83.1:8443"], "token": "pi-token", "printer": None}
SERVER = {"driver": "image", "model": None, "address": None, "media": "62"}


class World:
    """Was die Geräte an Kennungen kennen; mit Absicht auch solche, die es nie gab."""

    def __init__(self, rng: random.Random, first_zone: str) -> None:
        self.rng = rng
        self.zones = [first_zone]
        self.products: list[str] = []
        self.packages: list[str] = []
        self.printers: list[str] = []
        self.jobs: list[str] = []

    def pick(self, known: list[str], fresh=ids.new_uuid) -> str:
        """Meist eine bekannte Kennung, manchmal eine, die es nicht gibt."""
        if known and self.rng.random() < 0.9:
            return self.rng.choice(known)
        return fresh()

    def command(self, device: Device) -> dict:
        rng = self.rng
        age = rng.choice([0, 0, 1, 5, 30, 90])
        kind = rng.choice(
            [
                "product.create",
                "product.create",
                "product.update",
                "product.add_barcode",
                "product.remove_barcode",
                "product.merge",
                "package.create",
                "package.create",
                "package.create",
                "package.update",
                "package.update",
                "package.remove",
                "package.remove",
                "package.restore",
                "zone.create",
                "zone.update",
                "zone.delete",
                "settings.update",
                "printer.create",
                "printer.update",
                "printer.delete",
                "printer.report",
                "print.request",
                "print.report",
            ]
        )
        if kind == "product.create":
            product_id = ids.new_uuid()
            self.products.append(product_id)
            return device.cmd(
                kind,
                age=age,
                product_id=product_id,
                name=rng.choice(["", "Reis", "Nudeln"]),
                barcodes=rng.sample(BARCODES, rng.choice([0, 0, 1, 2])),
            )
        if kind == "product.update":
            fields = {
                "name": rng.choice(["", "Mehl", "Zucker"]),
                "brand": "Marke",
                "warn_days": rng.choice([None, 7]),
            }
            chosen = rng.sample(sorted(fields), rng.randint(0, 3))
            return device.cmd(
                kind,
                age=age,
                product_id=self.pick(self.products),
                changes={key: fields[key] for key in chosen},
            )
        if kind in ("product.add_barcode", "product.remove_barcode"):
            return device.cmd(
                kind, age=age, product_id=self.pick(self.products), barcode=rng.choice(BARCODES)
            )
        if kind == "product.merge":
            return device.cmd(
                kind, age=age, source_id=self.pick(self.products), target_id=self.pick(self.products)
            )
        if kind == "package.create":
            package_id = device.new_package_id() if rng.random() < 0.9 else self.pick(self.packages)
            if not ids.is_package_id(package_id):
                package_id = ids.random_package_id()
            self.packages.append(package_id)
            return device.cmd(
                kind,
                age=age,
                package_id=package_id,
                product_id=self.pick(self.products),
                zone_id=self.pick(self.zones),
                best_before=rng.choice(DATES),
            )
        if kind == "package.update":
            fields = {
                "best_before": rng.choice(DATES),
                "zone_id": self.pick(self.zones),
                "product_id": self.pick(self.products),
            }
            chosen = rng.sample(sorted(fields), rng.randint(0, 3))
            return device.cmd(
                kind,
                age=age,
                package_id=self.pick(self.packages, ids.random_package_id),
                changes={key: fields[key] for key in chosen},
            )
        if kind == "package.remove":
            return device.cmd(
                kind,
                age=age,
                package_id=self.pick(self.packages, ids.random_package_id),
                reason=rng.choice(["consumed", "discarded", "mistake"]),
            )
        if kind == "package.restore":
            return device.cmd(
                kind,
                age=age,
                package_id=self.pick(self.packages, ids.random_package_id),
                apply_displaced=rng.random() < 0.5,
            )
        if kind == "zone.create":
            zone_id = ids.new_uuid()
            self.zones.append(zone_id)
            return device.cmd(
                kind, age=age, zone_id=zone_id, name=f"Zone {len(self.zones)}", sort=len(self.zones)
            )
        if kind == "zone.update":
            fields = {
                "name": "Umbenannt",
                "sort": rng.randint(0, 9),
                "printer_id": rng.choice([None, *self.printers]),
            }
            chosen = rng.sample(sorted(fields), rng.randint(0, 3))
            return device.cmd(
                kind, age=age, zone_id=self.pick(self.zones), changes={key: fields[key] for key in chosen}
            )
        if kind == "zone.delete":
            return device.cmd(kind, age=age, zone_id=self.pick(self.zones), move_to=self.pick(self.zones))
        if kind == "settings.update":
            fields = {
                "warn_days": rng.randint(0, 30),
                "zone_mode": rng.choice(["primary", "equal"]),
                "primary_zone_id": rng.choice([None, *self.zones]),
                "default_printer_id": rng.choice([None, *self.printers]),
            }
            chosen = rng.sample(sorted(fields), rng.randint(0, 4))
            return device.cmd(kind, age=age, changes={key: fields[key] for key in chosen})
        if kind == "printer.create":
            printer_id = ids.new_uuid()
            self.printers.append(printer_id)
            if rng.random() < 0.5:
                return device.cmd(
                    kind, age=age, printer_id=printer_id, name="Pi", connection="direct", direct=DIRECT
                )
            return device.cmd(
                kind, age=age, printer_id=printer_id, name="Bild", connection="server", server=SERVER
            )
        if kind == "printer.update":
            changes_ = rng.choice([{"name": "Neu"}, {"direct": DIRECT}, {"server": SERVER}, {}])
            return device.cmd(kind, age=age, printer_id=self.pick(self.printers), changes=changes_)
        if kind == "printer.delete":
            return device.cmd(kind, age=age, printer_id=self.pick(self.printers))
        if kind == "printer.report":
            return device.cmd(
                kind,
                age=age,
                printer_id=self.pick(self.printers),
                boot_id=rng.choice([None, "boot-1"]),
                status=rng.choice(
                    [None, {"reachable": True, "ready": None, "media_detected": None, "errors": []}]
                ),
            )
        if kind == "print.request":
            job_id = ids.new_uuid()
            self.jobs.append(job_id)
            if rng.random() < 0.7:
                return device.cmd(
                    kind,
                    age=age,
                    job_id=job_id,
                    kind="package",
                    package_id=self.pick(self.packages, ids.random_package_id),
                    printer_id=rng.choice([None, *self.printers]),
                )
            return device.cmd(kind, age=age, job_id=job_id, kind="zone", zone_id=self.pick(self.zones))
        return device.cmd(
            "print.report",
            age=age,
            job_id=self.pick(self.jobs),
            state=rng.choice(STATES),
            printer_id=rng.choice([None, *self.printers]),
            boot_id=rng.choice([None, "boot-1"]),
            error=rng.choice([None, "no_media"]),
        )


def snapshot(device: Device) -> dict:
    return {
        "zones": device.zones,
        "products": device.products,
        "packages": device.packages,
        "printers": device.printers,
        "printer_status": device.printer_status,
        "print_jobs": device.print_jobs,
        "label_templates": device.label_templates,
        "settings": device.settings,
    }


@pytest.mark.parametrize("seed", range(6))
def test_random_commands_keep_every_device_in_step(client, clock: ServerClock, monkeypatch, seed):
    rng = random.Random(seed)
    clock.advance(3600)
    devices = [
        Device(client, f"Gerät {number}", clock=clock, clock_offset_s=offset)
        for number, offset in enumerate([0, 3600, -86400])
    ]
    for device in devices:
        device.sync()
    observer = Device(client, "Beobachter", clock=clock)
    observer.sync()
    world = World(rng, devices[0].zone_id)
    seen: list[dict] = []

    for _step in range(40):
        clock.advance(rng.choice([0, 1, 20, 200]))
        device = rng.choice(devices)
        batch = [world.command(device) for _ in range(rng.randint(1, 8))]
        if seen and rng.random() < 0.3:
            batch.insert(rng.randrange(len(batch) + 1), rng.choice(seen))  # ein alter Befehl noch einmal
        monkeypatch.setattr(changes, "PAGE_LIMIT", rng.randint(1, 9))
        pages = device.sync_all(batch)
        results = pages[0]["results"]
        assert len(results) == len(batch)
        assert [result["id"] for result in results] == [command["id"] for command in batch]
        assert "internal" not in {result["code"] for result in results}, results
        seen.extend(batch)

        # Der Beobachter gleicht in kleinen Seiten ab, ein frisches Gerät zieht alles neu.
        observer.sync_all()
        monkeypatch.setattr(changes, "PAGE_LIMIT", changes.MAX_CHANGES_PER_SYNC)
        fresh = Device(client, "Frisch", clock=clock)
        fresh.sync()
        assert snapshot(observer) == snapshot(fresh)
        assert observer.cursor == fresh.cursor

    # Höchstens einmal: Alles noch einmal geschickt ändert nichts mehr.
    before = snapshot(observer)
    for start in range(0, len(seen), 400):
        again = devices[0].sync_all(seen[start : start + 400])
        assert all(result["duplicate"] for result in again[0]["results"])
    observer.sync_all()
    assert snapshot(observer) == before
