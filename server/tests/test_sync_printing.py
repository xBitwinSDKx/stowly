"""Drucker, Druckerzustand, Etiketten und Vorlagen im Sync.

Reine Datenhaltung nach denselben Regeln wie alles andere; gedruckt wird erst in Runde 2
(docs/etiketten.md, Abschnitt 4; docs/sync-protokoll.md, Abschnitte 6.6 und 7.1).
"""

import itertools
import json

from support import events_of, statuses

from stowly import db, label_templates
from stowly.contract import ids
from stowly_print.templates import builtin_templates

DIRECT = {
    "urls": ["https://10.71.83.1:8443", "http://10.71.83.1:8080"],
    "token": "pi-geheim-123",
    "printer": None,
}
SERVER = {"driver": "brother_ql", "model": "QL-820NWB", "address": "tcp://192.168.1.60:9100", "media": "62"}
STATUS = {"reachable": True, "ready": True, "media_detected": None, "errors": []}
HOST = {
    "uptime_s": 120.5,
    "temperature_c": 48.2,
    "throttled": False,
    "undervoltage": None,
    "storage_errors": 0,
    "storage_read_only": False,
    "overlay_used_pct": 12.5,
    "memory_available_mb": 301.0,
}


def new_printer(device, name: str = "Keller", *, age: float = 0.0, **payload) -> tuple[str, dict]:
    """Befehl für einen neuen Drucker; ohne weitere Angaben der Pi im Keller."""
    printer_id = ids.new_uuid()
    payload = payload or {"connection": "direct", "direct": DIRECT}
    return printer_id, device.cmd("printer.create", age=age, printer_id=printer_id, name=name, **payload)


def printer_events(device, printer_id: str) -> list[tuple[str, dict]]:
    return [
        (e["type"], e["data"])
        for e in events_of(device.client, device, entity="printer", entity_id=printer_id)
    ]


# --- Drucker -----------------------------------------------------------------------------


def test_creating_printers_of_both_kinds(make_device, clock):
    device = make_device()
    pi, create_pi = new_printer(device, "Keller", age=10)
    lan, create_lan = new_printer(device, "Küche", connection="server", server=SERVER)
    assert statuses(device.sync([create_pi, create_lan])) == [("applied", None)] * 2

    assert device.printers[pi] == {
        "id": pi,
        "name": "Keller",
        "connection": "direct",
        "server": None,
        "direct": DIRECT,  # das Token steht im Sync: Alle Geräte des Haushalts drucken dort
        "created_at": clock.stamp(10),
        "updated_at": clock.stamp(10),
        "deleted_at": None,
    }
    assert device.printers[lan]["server"] == SERVER
    assert device.printers[lan]["direct"] is None

    assert statuses(
        device.sync(
            [device.cmd("printer.create", printer_id=pi, name="Doppelt", connection="direct", direct=DIRECT)]
        )
    ) == [("rejected", "id_conflict")]


def test_printer_tokens_never_reach_the_event_log(make_device, con):
    device = make_device()
    pi, create = new_printer(device)
    changed = {**DIRECT, "token": "pi-neu-456"}
    device.sync(
        [
            create,
            device.cmd("printer.update", printer_id=pi, changes={"direct": changed, "name": "Kellerdrucker"}),
            device.cmd("printer.delete", printer_id=pi),
        ]
    )
    text = "\n".join(str(tuple(row)) for row in con.execute("SELECT * FROM events"))
    assert "pi-geheim-123" not in text and "pi-neu-456" not in text

    log = printer_events(device, pi)
    visible = {"urls": DIRECT["urls"], "printer": None}
    assert log[0] == (
        "printer.created",
        {"changes": {"name": "Keller", "connection": "direct", "direct": visible}},
    )
    assert log[1] == (
        "printer.updated",
        {
            "changes": {
                # Dass sich das Token geändert hat, steht da; das Token nicht.
                "direct": {"old": visible, "new": visible, "token_changed": True},
                "name": {"old": "Keller", "new": "Kellerdrucker"},
            },
            "superseded": {},
        },
    )
    assert log[2][0] == "printer.deleted"


def test_printer_fields_follow_the_later_timestamp(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    pi, create = new_printer(phone)
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    newer = {**DIRECT, "urls": ["https://10.71.83.1:8443"]}
    older = {**DIRECT, "printer": "QL-800"}
    tablet.sync([tablet.cmd("printer.update", age=5, printer_id=pi, changes={"direct": newer})])
    phone.sync(
        [
            phone.cmd(
                "printer.update", age=60, printer_id=pi, changes={"direct": older, "name": "Pi im Keller"}
            )
        ]
    )

    printer = phone.printers[pi]
    assert printer["direct"] == newer  # das Objekt als Ganzes, die spätere Änderung gewinnt
    assert printer["name"] == "Pi im Keller"
    assert printer["updated_at"] == clock.stamp(5)


def test_the_kind_of_connection_never_changes(make_device):
    device = make_device()
    pi, create_pi = new_printer(device)
    lan, create_lan = new_printer(device, "Küche", connection="server", server=SERVER)
    data = device.sync(
        [
            create_pi,
            create_lan,
            device.cmd("printer.update", printer_id=pi, changes={"server": SERVER}),
            device.cmd("printer.update", printer_id=lan, changes={"direct": DIRECT, "name": "Anders"}),
            device.cmd("printer.update", printer_id=ids.new_uuid(), changes={"name": "Niemand"}),
        ]
    )
    assert statuses(data) == [
        ("applied", None),
        ("applied", None),
        ("rejected", "invalid"),
        ("rejected", "invalid"),
        ("rejected", "not_found"),
    ]
    assert device.printers[pi]["direct"] == DIRECT and device.printers[pi]["server"] is None
    assert device.printers[lan]["name"] == "Küche"  # abgelehnt heißt: gar nichts geändert


def test_deleting_a_printer_clears_references(make_device, clock):
    device = make_device()
    home = device.zone_id
    pi, create = new_printer(device)
    other, create_other = new_printer(device, "Anderer")
    cellar = ids.new_uuid()
    device.sync(
        [
            create,
            create_other,
            device.cmd("zone.create", zone_id=cellar, name="Keller", printer_id=pi),
            device.cmd("zone.update", zone_id=home, changes={"printer_id": other}),
            device.cmd("settings.update", changes={"default_printer_id": pi}),
        ]
    )
    clock.advance(3600)

    delete = device.cmd("printer.delete", age=20, printer_id=pi)
    data = device.sync([delete])
    assert statuses(data) == [("applied", None)]
    assert device.printers[pi]["deleted_at"] == clock.stamp(20)
    assert device.zones[cellar]["printer_id"] is None
    assert device.zones[home]["printer_id"] == other  # fremde Verweise bleiben
    assert device.settings["default_printer_id"] is None
    assert [zone["id"] for zone in data["changes"]["zones"]] == [cellar]
    assert printer_events(device, pi)[-1] == (
        "printer.deleted",
        {"changes": {"deleted_at": {"old": None, "new": clock.stamp(20)}}, "zones": 1, "default": True},
    )

    # Schon gelöscht: ohne Wirkung. Bearbeiten geht nicht mehr.
    data = device.sync(
        [
            device.cmd("printer.delete", printer_id=pi),
            device.cmd("printer.update", printer_id=pi, changes={"name": "Zombie"}),
            device.cmd("printer.delete", printer_id=ids.new_uuid()),
        ]
    )
    assert statuses(data) == [("applied", None), ("rejected", "not_found"), ("rejected", "not_found")]
    assert device.printers[pi]["deleted_at"] == clock.stamp(20)


# --- Druckerzustand ----------------------------------------------------------------------


def test_the_phone_brings_the_state_of_the_pi(make_device, clock, con):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    pi, create = new_printer(phone)
    phone.sync([create])
    clock.advance(3600)

    report = phone.cmd("printer.report", age=600, printer_id=pi, boot_id="boot-1", status=STATUS, host=HOST)
    assert statuses(phone.sync([report])) == [("applied", None)]
    assert phone.printer_status[pi] == {
        "printer_id": pi,
        "observed_at": clock.stamp(600),  # die Zeit der Beobachtung setzt das Handy, der Pi hat keine Uhr
        "boot_id": "boot-1",
        "status": STATUS,
        "host": HOST,
    }
    tablet.sync()
    assert tablet.printer_status[pi] == phone.printer_status[pi]
    assert con.execute("SELECT device_id FROM printer_status").fetchone()[0] == phone.id

    # Eine ältere Beobachtung, die später eintrifft, ersetzt die jüngere nicht.
    stale = tablet.cmd("printer.report", age=900, printer_id=pi, boot_id="boot-0", status=None, host=None)
    assert statuses(tablet.sync([stale])) == [("applied", None)]
    assert tablet.printer_status[pi]["boot_id"] == "boot-1"

    # Eine jüngere ersetzt den Zustand als Ganzes, auch mit null.
    fresh = tablet.cmd("printer.report", age=5, printer_id=pi)
    tablet.sync([fresh])
    assert tablet.printer_status[pi] == {
        "printer_id": pi,
        "observed_at": clock.stamp(5),
        "boot_id": None,
        "status": None,
        "host": None,
    }

    # Zu häufig und ohne bleibenden Wert: kein Eintrag im Ereignisprotokoll.
    assert [e for e in events_of(phone.client, phone, entity="printer", entity_id=pi)][1:] == []
    assert statuses(phone.sync([phone.cmd("printer.report", printer_id=ids.new_uuid())])) == [
        ("rejected", "not_found")
    ]


# --- Etiketten ---------------------------------------------------------------------------


def test_requesting_labels(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    pi, create = new_printer(phone)
    product_id, package_id = phone.store("Reis")
    phone.sync([create])
    clock.advance(3600)

    package_job, zone_job = ids.new_uuid(), ids.new_uuid()
    data = phone.sync(
        [
            phone.cmd("print.request", age=30, job_id=package_job, kind="package", package_id=package_id),
            phone.cmd(
                "print.request", age=20, job_id=zone_job, kind="zone", zone_id=phone.zone_id, printer_id=pi
            ),
        ]
    )
    assert statuses(data) == [("applied", None)] * 2
    assert phone.print_jobs[package_job] == {
        "id": package_job,
        "kind": "package",
        "package_id": package_id,
        "zone_id": None,
        "printer_id": None,
        "state": "pending",
        "error": None,
        "boot_id": None,
        "device_id": phone.id,
        "created_at": clock.stamp(30),
        "updated_at": clock.stamp(30),
    }
    assert (phone.print_jobs[zone_job]["zone_id"], phone.print_jobs[zone_job]["printer_id"]) == (
        phone.zone_id,
        pi,
    )
    # Ob ein Etikett noch aussteht, sehen alle Geräte.
    tablet.sync()
    assert tablet.print_jobs == phone.print_jobs

    log = events_of(phone.client, phone, entity="print_job", entity_id=package_job)
    assert [(e["type"], e["data"]) for e in log] == [
        (
            "print.requested",
            {
                "kind": "package",
                "state": "pending",
                "printer_id": None,
                "error": None,
                "package_id": package_id,
                "zone_id": None,
            },
        )
    ]


def test_label_requests_for_unknown_things_are_rejected(make_device):
    device = make_device()
    home = device.zone_id
    _, package_id = device.store("Reis")
    job = ids.new_uuid()
    device.sync([device.cmd("print.request", job_id=job, kind="package", package_id=package_id)])

    data = device.sync(
        [
            device.cmd("print.request", job_id=job, kind="package", package_id=package_id),
            device.cmd("print.request", job_id=ids.new_uuid(), kind="package", package_id="ZZZZZ"),
            device.cmd("print.request", job_id=ids.new_uuid(), kind="zone", zone_id=ids.new_uuid()),
            device.cmd(
                "print.request", job_id=ids.new_uuid(), kind="zone", zone_id=home, printer_id=ids.new_uuid()
            ),
            device.cmd("print.report", job_id=ids.new_uuid(), state="printed"),
        ]
    )
    assert statuses(data) == [
        ("rejected", "id_conflict"),
        ("rejected", "not_found"),
        ("rejected", "not_found"),
        ("rejected", "not_found"),  # diesen Drucker gab es nie
        ("rejected", "not_found"),
    ]
    assert list(device.print_jobs) == [job]


def test_labels_can_be_requested_for_things_that_are_gone(make_device):
    """Abgelehnt wird nur, was es nie gab: Entnehmen und Löschen können von einem anderen Gerät stammen."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home = phone.zone_id
    cellar = ids.new_uuid()
    pi, create = new_printer(phone)
    _, package_id = phone.store("Reis")
    phone.sync([create, phone.cmd("zone.create", zone_id=cellar, name="Keller")])
    tablet.sync()
    phone.sync(
        [
            phone.cmd("package.remove", package_id=package_id, reason="consumed"),
            phone.cmd("zone.delete", zone_id=cellar, move_to=home),
            phone.cmd("printer.delete", printer_id=pi),
        ]
    )

    # Das Tablet weiß von alledem noch nichts.
    jobs = [ids.new_uuid() for _ in range(3)]
    data = tablet.sync(
        [
            tablet.cmd("print.request", job_id=jobs[0], kind="package", package_id=package_id),
            tablet.cmd("print.request", job_id=jobs[1], kind="zone", zone_id=cellar),
            tablet.cmd("print.request", job_id=jobs[2], kind="zone", zone_id=home, printer_id=pi),
        ]
    )
    assert statuses(data) == [("applied", None)] * 3
    assert {tablet.print_jobs[job]["state"] for job in jobs} == {"pending"}
    assert tablet.print_jobs[jobs[1]]["zone_id"] == cellar  # unverändert, die App folgt moved_to selbst
    assert tablet.print_jobs[jobs[2]]["printer_id"] == pi


def test_the_latest_report_decides_the_state_of_a_label(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    pi, create = new_printer(phone)
    _, package_id = phone.store("Reis")
    job = ids.new_uuid()
    phone.sync([create, phone.cmd("print.request", job_id=job, kind="package", package_id=package_id)])
    tablet.sync()
    clock.advance(3600)

    queued = phone.cmd("print.report", age=60, job_id=job, state="queued", printer_id=pi, boot_id="boot-1")
    failed = phone.cmd(
        "print.report", age=30, job_id=job, state="failed", printer_id=pi, boot_id="boot-1", error="no_media"
    )
    assert statuses(phone.sync([queued, failed])) == [("applied", None)] * 2
    label = phone.print_jobs[job]
    assert (label["state"], label["error"], label["printer_id"], label["boot_id"]) == (
        "failed",
        "no_media",
        pi,
        "boot-1",
    )
    assert label["updated_at"] == clock.stamp(30)

    # Eine ältere Meldung, die später eintrifft, ändert nichts mehr.
    stale = tablet.cmd("print.report", age=45, job_id=job, state="printing", printer_id=pi, boot_id="boot-1")
    data = tablet.sync([stale])
    assert statuses(data) == [("applied", None)]
    assert tablet.print_jobs[job]["state"] == "failed"

    # Die jüngste gilt, und zwar als Ganzes: Zustand, Drucker, boot_id und Fehler sind ein Feld.
    answer = tablet.cmd("print.report", age=5, job_id=job, state="printed", printer_id=pi, boot_id="boot-1")
    tablet.sync([answer])
    label = tablet.print_jobs[job]
    assert (label["state"], label["error"], label["printer_id"], label["boot_id"]) == (
        "printed",
        None,
        pi,
        "boot-1",
    )

    # Was die Meldung nicht nennt, ist null, ob der Schlüssel fehlt oder null trägt.
    bare = tablet.cmd("print.report", age=1, job_id=job, state="unknown")
    tablet.sync([bare])
    label = tablet.print_jobs[job]
    assert (label["state"], label["printer_id"], label["boot_id"], label["error"]) == (
        "unknown",
        None,
        None,
        None,
    )

    log = events_of(phone.client, phone, entity="print_job", entity_id=job)
    assert [(e["type"], e["data"]["state"], e["data"]["error"]) for e in log] == [
        ("print.requested", "pending", None),
        ("print.reported", "queued", None),
        ("print.reported", "failed", "no_media"),
        ("print.reported", "printed", None),
        ("print.reported", "unknown", None),
    ]
    assert log[1]["data"] == {
        "kind": "package",
        "state": "queued",
        "printer_id": pi,
        "error": None,
        "old": {"state": "pending", "error": None},
    }


def test_a_pending_label_can_be_cancelled_by_another_device(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    job = ids.new_uuid()
    phone.sync([phone.cmd("print.request", job_id=job, kind="package", package_id=package_id)])
    tablet.sync()
    tablet.sync(
        [
            tablet.cmd("package.remove", package_id=package_id, reason="consumed"),
            tablet.cmd("print.report", job_id=job, state="cancelled"),
        ]
    )
    phone.sync()
    assert phone.print_jobs[job]["state"] == "cancelled"
    assert phone.print_jobs[job]["device_id"] == phone.id  # bleibt das Gerät, das angefordert hat


# --- Vorlagen ----------------------------------------------------------------------------


def test_builtin_templates_are_distributed(make_device, con):
    device = make_device()
    builtin = builtin_templates()
    assert set(device.label_templates) == {"package", "zone"}
    for key, (digest, body) in builtin.items():
        template = device.label_templates[key]
        assert template["hash"] == digest
        assert template["body"] == body  # unverändert, die App reicht es als template weiter
    assert device.sync()["changes"]["label_templates"] == []
    # Ein Neustart mit denselben Vorlagen ändert nichts.
    assert label_templates.install(con) == []
    assert device.sync()["changes"]["label_templates"] == []


def test_a_changed_template_reaches_every_device(make_device, con):
    device = make_device()
    before = device.label_templates["package"]
    # So sieht die Datenbank nach einem Update aus, das die Vorlage geändert hat.
    with db.transaction(con):
        con.execute(
            "UPDATE label_templates SET hash = 'alt', body = ? WHERE key = 'package'",
            (json.dumps({"schema": 1}),),
        )
    assert label_templates.install(con) == ["package"]

    data = device.sync()
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert device.label_templates["package"]["hash"] == before["hash"]
    assert device.label_templates["package"]["body"] == before["body"]
    assert label_templates.install(con) == []


def test_the_state_of_a_label_does_not_depend_on_the_order_of_arrival(make_device, clock):
    """Dieselben drei Meldungen, in jeder Reihenfolge des Eintreffens: ein Endzustand."""
    device = make_device()
    pi, create = new_printer(device)
    _, package_id = device.store("Reis")
    device.sync([create])
    clock.advance(3600)

    final = set()
    for order in itertools.permutations(range(3)):
        job = ids.new_uuid()
        device.sync([device.cmd("print.request", age=100, job_id=job, kind="package", package_id=package_id)])
        reports = [
            device.cmd("print.report", age=60, job_id=job, state="queued", printer_id=pi, boot_id="boot-1"),
            device.cmd("print.report", age=40, job_id=job, state="printing", printer_id=pi, boot_id="boot-1"),
            device.cmd("print.report", age=20, job_id=job, state="failed", error="not_printed"),
        ]
        for index in order:
            device.sync([reports[index]])
        label = device.print_jobs[job]
        final.add(
            (label["state"], label["error"], label["printer_id"], label["boot_id"], label["updated_at"])
        )
    assert final == {("failed", "not_printed", None, None, clock.stamp(20))}
