"""Der Auftragsdienst: Reihenfolge, nie doppelt, Neustart (docs/etiketten.md, 5.3 und 5.4)."""

import base64
import io
import subprocess
import sys
import textwrap
import threading
import time

import pytest
from PIL import Image
from print_support import READY, FakeDriver, Recorder, make_service, new_id, package_request, wait_until

from stowly_print.model import (
    MAX_QUEUED_JOBS,
    MIN_REMEMBERED_JOBS,
    DriverStatus,
    JobRequest,
    JobState,
    PrintOutcome,
    ServiceError,
)
from stowly_print.render import Fonts, render
from stowly_print.service import PrinterEntry, PrintService, ServiceFault, StaticPrinters
from stowly_print.store import FileStore, MemoryStore
from stowly_print.templates import load_builtin


def fault(code: ServiceError):
    """Erwartet genau diesen Fehler des Dienstes."""
    return pytest.raises(ServiceFault, check=lambda exc: exc.code == code)


def finished(service: PrintService, job_id: str, timeout: float = 5.0):
    job = service.wait(job_id, timeout)
    assert job.state in (JobState.PRINTED, JobState.SENT, JobState.FAILED, JobState.UNKNOWN), job
    return job


# --- Annehmen und drucken ----------------------------------------------------------------


def test_a_job_is_rendered_printed_and_reported_in_order():
    driver = FakeDriver()
    service, recorder = make_service(driver)
    job_id = new_id()
    job, created = service.submit(job_id, package_request())
    assert created
    assert job.id == job_id
    assert job.printer == "drucker-1"
    assert job.boot_id == service.boot_id
    assert job.error is None

    done = finished(service, job_id)
    assert done.state == JobState.PRINTED
    assert done.position is None
    assert recorder.states(job_id) == ["queued", "printing", "printed"]
    assert [event.previous for event in recorder.events] == [None, JobState.QUEUED, JobState.PRINTING]

    # Gedruckt wurde genau das Bild, das der Renderer für diesen Drucker liefert.
    assert driver.calls == 1
    expected = render(
        load_builtin("package"), package_request().data, driver.capabilities(), fonts=Fonts.builtin()
    )
    assert driver.printed[0].tobytes() == expected.tobytes()
    assert driver.cuts == [True]
    service.close()


def test_jobs_print_in_the_order_they_were_accepted():
    driver = FakeDriver()
    driver.gate.clear()
    service, recorder = make_service(driver)
    ids = [new_id() for _ in range(5)]
    for number, job_id in enumerate(ids):
        service.submit(job_id, package_request(f"Etikett {number}"))
    wait_until(driver.entered.is_set)

    # Der erste druckt, die anderen warten in ihrer Reihenfolge.
    assert service.get(ids[0]).state == JobState.PRINTING
    assert service.get(ids[0]).position is None
    assert [service.get(job_id).position for job_id in ids[1:]] == [0, 1, 2, 3]
    assert service.waiting() == 4

    driver.gate.set()
    for job_id in ids:
        assert finished(service, job_id).state == JobState.PRINTED
    final = [event.job.id for event in recorder.events if event.job.state == JobState.PRINTED]
    assert final == ids
    for number, image in enumerate(driver.printed):
        expected = render(
            load_builtin("package"), package_request(f"Etikett {number}").data, fonts=Fonts.builtin()
        )
        assert image.tobytes() == expected.tobytes()
    service.close()


def test_each_printer_has_its_own_queue():
    slow, fast = FakeDriver(), FakeDriver()
    slow.gate.clear()
    service, _recorder = make_service(slow, fast)
    blocked, quick = new_id(), new_id()
    service.submit(blocked, package_request(printer="drucker-1"))
    service.submit(quick, package_request(printer="drucker-2"))
    # Der zweite Drucker druckt, obwohl der erste hängt.
    assert finished(service, quick).state == JobState.PRINTED
    assert service.get(blocked).state in (JobState.QUEUED, JobState.PRINTING)
    slow.gate.set()
    assert finished(service, blocked).state == JobState.PRINTED
    assert (slow.calls, fast.calls) == (1, 1)
    service.close()


def test_job_without_printer_goes_to_the_first_printer():
    first, second = FakeDriver(), FakeDriver()
    service, _recorder = make_service(first, second)
    job, _created = service.submit(new_id(), package_request())
    assert job.printer == "drucker-1"
    finished(service, job.id)
    assert (first.calls, second.calls) == (1, 0)
    service.close()


def test_unknown_printer_and_service_without_default():
    service, _recorder = make_service()
    with fault(ServiceError.UNKNOWN_PRINTER):
        service.submit(new_id(), package_request(printer="gibt-es-nicht"))
    service.close()

    class NoDefault(StaticPrinters):
        def default(self) -> None:
            return None

    driver = FakeDriver()
    printers = NoDefault([PrinterEntry("a", "fake", None, driver)])
    service = PrintService(printers, fonts=Fonts.builtin())
    service.start()
    with fault(ServiceError.UNKNOWN_PRINTER):
        service.submit(new_id(), package_request())
    job, created = service.submit(new_id(), package_request(printer="a"))
    assert created
    assert finished(service, job.id).state == JobState.PRINTED
    service.close()


def test_admission_is_asked_for_new_jobs_only_and_before_the_printer():
    """Am Server entscheidet ``admit`` (gibt es das Etikett, wartet es noch?), bevor der Drucker zählt."""
    driver = FakeDriver()
    asked: list[str] = []
    refused: set[str] = set()

    def admit(job_id: str, _request: JobRequest) -> None:
        asked.append(job_id)
        if job_id in refused:
            raise ServiceFault(ServiceError.NOT_PENDING, "Das Etikett ist verworfen.")

    service, recorder = make_service(driver, admit=admit)
    accepted, rejected = new_id(), new_id()
    refused.add(rejected)
    # Unbekannter Drucker und verworfenes Etikett zugleich: Das Etikett zählt zuerst.
    with fault(ServiceError.NOT_PENDING):
        service.submit(rejected, package_request(printer="gibt-es-nicht"))
    with fault(ServiceError.NOT_PENDING):
        service.submit(rejected, package_request())
    with fault(ServiceError.NOT_FOUND):
        service.get(rejected)
    assert recorder.events == [] and driver.calls == 0

    assert service.submit(accepted, package_request())[1] is True
    finished(service, accepted)
    # Ein schon bekannter Auftrag liefert seinen Zustand, ohne erneut zu fragen.
    refused.add(accepted)
    assert service.submit(accepted, package_request())[0].state == JobState.PRINTED
    assert asked == [rejected, rejected, accepted]
    assert driver.calls == 1
    service.close()


def test_copies_print_the_same_image_several_times():
    driver = FakeDriver()
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request(copies=3, cut=False))
    assert finished(service, job_id).state == JobState.PRINTED
    assert driver.calls == 3
    assert len({image.tobytes() for image in driver.printed}) == 1
    assert driver.cuts == [False, False, False]
    service.close()


def test_transport_that_cannot_confirm_ends_as_sent():
    driver = FakeDriver(outcome=PrintOutcome.SENT, confirms_print=False)
    service, recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    assert finished(service, job_id).state == JobState.SENT
    assert recorder.states(job_id) == ["queued", "printing", "sent"]
    service.close()


def test_ready_made_png_is_printed_as_it_is():
    driver = FakeDriver()
    service, _recorder = make_service(driver)
    image = Image.new("1", (696, 200), 1)
    image.paste(0, (10, 10, 300, 100))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

    job_id = new_id()
    service.submit(job_id, JobRequest.from_dict({"png": encoded}))
    assert finished(service, job_id).state == JobState.PRINTED
    assert driver.printed[0].size == (696, 200)
    assert driver.printed[0].tobytes() == image.tobytes()

    # Falsche Breite: wird nicht angenommen.
    wrong = io.BytesIO()
    Image.new("1", (500, 200), 1).save(wrong, format="PNG")
    refused = new_id()
    with fault(ServiceError.RENDER_FAILED):
        service.submit(
            refused, JobRequest.from_dict({"png": base64.b64encode(wrong.getvalue()).decode("ascii")})
        )
    with fault(ServiceError.NOT_FOUND):
        service.get(refused)
    service.close()


def test_what_cannot_be_rendered_is_not_accepted():
    driver = FakeDriver()
    service, recorder = make_service(driver)
    template = load_builtin("package")
    template["schema"] = 99
    job_id = new_id()
    with fault(ServiceError.RENDER_FAILED) as caught:
        service.submit(job_id, JobRequest.from_dict({"template": template, "data": {"qr": "x"}}))
    assert "schema" in caught.value.message
    with fault(ServiceError.NOT_FOUND):
        service.get(job_id)
    assert recorder.events == []
    assert driver.calls == 0
    # Die Kennung ist danach frei für einen brauchbaren Auftrag.
    job, created = service.submit(job_id, package_request())
    assert created
    finished(service, job_id)
    service.close()


# --- Nie doppelt -------------------------------------------------------------------------


def test_same_job_again_returns_its_state_and_does_not_print():
    driver = FakeDriver()
    service, recorder = make_service(driver)
    job_id = new_id()
    request = package_request()
    assert service.submit(job_id, request)[1] is True
    assert finished(service, job_id).state == JobState.PRINTED

    for _ in range(3):
        again, created = service.submit(job_id, package_request())
        assert created is False
        assert again.state == JobState.PRINTED
    assert driver.calls == 1
    assert recorder.states(job_id) == ["queued", "printing", "printed"]

    # token und expect_boot_id gehören nicht zum Inhalt.
    with_boot = package_request(expect_boot_id=service.boot_id)
    assert service.submit(job_id, with_boot) == (again, False)
    assert driver.calls == 1
    service.close()


def test_same_job_again_while_it_waits_or_prints():
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver)
    first, second = new_id(), new_id()
    service.submit(first, package_request("eins"))
    service.submit(second, package_request("zwei"))
    wait_until(driver.entered.is_set)
    assert service.submit(first, package_request("eins")) == (service.get(first), False)
    assert service.submit(second, package_request("zwei"))[0].state == JobState.QUEUED
    assert service.waiting() == 1
    driver.gate.set()
    finished(service, second)
    assert driver.calls == 2
    service.close()


def test_same_id_with_other_content_is_a_conflict():
    driver = FakeDriver()
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request("Basmati Reis"))
    finished(service, job_id)
    for other in (
        package_request("Jasmin Reis"),
        package_request("Basmati Reis", copies=2),
        package_request("Basmati Reis", cut=False),
        package_request("Basmati Reis", printer="drucker-1"),
    ):
        with fault(ServiceError.JOB_CONFLICT):
            service.submit(job_id, other)
    assert driver.calls == 1
    assert service.get(job_id).state == JobState.PRINTED
    service.close()


def test_same_job_arriving_twice_at_once_prints_once():
    driver = FakeDriver()
    service, recorder = make_service(driver)
    job_id = new_id()
    results = []
    barrier = threading.Barrier(8)

    def submit() -> None:
        barrier.wait()
        results.append(service.submit(job_id, package_request()))

    threads = [threading.Thread(target=submit) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    finished(service, job_id)
    assert sum(1 for _job, created in results if created) == 1
    assert driver.calls == 1
    assert recorder.states(job_id) == ["queued", "printing", "printed"]
    service.close()


def test_wrong_boot_id_accepts_nothing():
    driver = FakeDriver()
    service, recorder = make_service(driver)
    job_id = new_id()
    with fault(ServiceError.BOOT_MISMATCH) as caught:
        service.submit(job_id, package_request(expect_boot_id="ein-frueherer-lauf"))
    assert caught.value.details == {"boot_id": service.boot_id}
    assert caught.value.status == 409
    with fault(ServiceError.NOT_FOUND):
        service.get(job_id)
    assert driver.calls == 0
    assert recorder.events == []

    # Mit der richtigen boot_id geht derselbe Auftrag durch.
    job, created = service.submit(job_id, package_request(expect_boot_id=service.boot_id))
    assert created
    assert finished(service, job_id).state == JobState.PRINTED

    # Auch ein bekannter Auftrag wird mit falscher boot_id nicht beantwortet: Der Lauf ist ein anderer.
    with fault(ServiceError.BOOT_MISMATCH):
        service.submit(job_id, package_request(expect_boot_id="ein-frueherer-lauf"))
    service.close()


# --- Verwerfen ---------------------------------------------------------------------------


def test_cancelling_a_waiting_job():
    driver = FakeDriver()
    driver.gate.clear()
    service, recorder = make_service(driver)
    printing, waiting, later = new_id(), new_id(), new_id()
    for job_id, title in ((printing, "eins"), (waiting, "zwei"), (later, "drei")):
        service.submit(job_id, package_request(title))
    wait_until(driver.entered.is_set)

    cancelled = service.cancel(waiting)
    assert cancelled.state == JobState.FAILED
    assert (cancelled.error.code, cancelled.position) == ("cancelled", None)
    assert service.get(later).position == 0
    # Noch einmal verwerfen: dieselbe Antwort, kein Fehler.
    assert service.cancel(waiting) == cancelled

    # Zu spät: Was druckt oder fertig ist, lässt sich nicht mehr verwerfen.
    with fault(ServiceError.NOT_CANCELLABLE) as caught:
        service.cancel(printing)
    assert caught.value.details == {"state": "printing"}
    driver.gate.set()
    finished(service, printing)
    finished(service, later)
    with fault(ServiceError.NOT_CANCELLABLE):
        service.cancel(printing)
    with fault(ServiceError.NOT_FOUND):
        service.cancel(new_id())

    assert driver.calls == 2
    assert recorder.states(waiting) == ["queued", "failed"]

    # Verworfene Aufträge bleiben bekannt: Eine verspätete Wiederholung druckt nicht doch noch.
    again, created = service.submit(waiting, package_request("zwei"))
    assert (created, again.state, again.error.code) == (False, JobState.FAILED, "cancelled")
    with fault(ServiceError.JOB_CONFLICT):
        service.submit(waiting, package_request("anders"))
    assert driver.calls == 2
    service.close()


# --- Volle Warteschlange, Warten ---------------------------------------------------------


def test_queue_full_counts_only_waiting_jobs():
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver, max_queued=3)
    first = new_id()
    service.submit(first, package_request("druckt"))
    wait_until(driver.entered.is_set)
    waiting = [new_id() for _ in range(3)]
    for number, job_id in enumerate(waiting):
        service.submit(job_id, package_request(f"wartet {number}"))
    refused = new_id()
    with fault(ServiceError.QUEUE_FULL) as caught:
        service.submit(refused, package_request("zu viel"))
    assert caught.value.status == 503
    with fault(ServiceError.NOT_FOUND):
        service.get(refused)
    # Ein bekannter Auftrag bekommt auch bei voller Schlange seine Antwort.
    assert service.submit(waiting[0], package_request("wartet 0"))[1] is False

    # Sobald einer verworfen ist, ist wieder Platz.
    service.cancel(waiting[2])
    service.submit(refused, package_request("zu viel"))
    driver.gate.set()
    finished(service, refused)
    assert driver.calls == 4
    assert MAX_QUEUED_JOBS == 100
    service.close()


def test_wait_returns_at_the_final_state_or_when_time_is_up():
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    wait_until(driver.entered.is_set)

    started = time.monotonic()
    assert service.wait(job_id, 0.15).state == JobState.PRINTING
    assert 0.1 <= time.monotonic() - started < 2
    assert service.wait(job_id, 0).state == JobState.PRINTING

    threading.Timer(0.1, driver.gate.set).start()
    started = time.monotonic()
    assert service.wait(job_id, 10).state == JobState.PRINTED
    assert time.monotonic() - started < 5
    # Fertig: Die Antwort kommt sofort.
    started = time.monotonic()
    assert service.wait(job_id, 10).state == JobState.PRINTED
    assert time.monotonic() - started < 1
    with fault(ServiceError.NOT_FOUND):
        service.wait(new_id(), 1)
    service.close()


def test_wait_returns_only_after_the_observer_knows_the_final_state():
    driver = FakeDriver()
    slow_observer_done = threading.Event()
    seen: list[str] = []

    def observer(event) -> None:
        if event.job.state == JobState.PRINTED:
            time.sleep(0.2)
            slow_observer_done.set()
        seen.append(event.job.state.value)

    service = PrintService(
        StaticPrinters([PrinterEntry("a", "fake", None, driver)]), observer=observer, fonts=Fonts.builtin()
    )
    service.start()
    job_id = new_id()
    service.submit(job_id, package_request())
    assert service.wait(job_id, 10).state == JobState.PRINTED
    assert slow_observer_done.is_set()
    assert seen == ["queued", "printing", "printed"]
    service.close()


def test_failing_observer_does_not_stop_printing():
    driver = FakeDriver()

    def observer(_event) -> None:
        raise RuntimeError("Beobachter kaputt")

    service = PrintService(
        StaticPrinters([PrinterEntry("a", "fake", None, driver)]), observer=observer, fonts=Fonts.builtin()
    )
    service.start()
    ids = [new_id(), new_id()]
    for job_id in ids:
        service.submit(job_id, package_request())
    for job_id in ids:
        assert finished(service, job_id).state == JobState.PRINTED
    assert driver.calls == 2
    service.close()


# --- Der Treiber scheitert oder bricht ab ------------------------------------------------


@pytest.mark.parametrize("code", ["no_media", "cover_open", "offline", "config"])
def test_driver_that_fails_ends_the_job_as_failed_with_its_code(code):
    driver = FakeDriver(outcome=PrintOutcome.FAILED)
    driver.error = code
    service, recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    job = finished(service, job_id)
    assert job.state == JobState.FAILED
    assert job.error.code == code
    assert job.error.message
    assert recorder.states(job_id) == ["queued", "printing", "failed"]
    # Kein zweiter Versuch, auch nicht beim erneuten Einreichen.
    assert service.submit(job_id, package_request())[0].state == JobState.FAILED
    assert driver.calls == 1
    service.close()


def test_failure_code_falls_back_to_the_driver_status():
    driver = FakeDriver(outcome=PrintOutcome.FAILED)
    driver.status_value = DriverStatus(
        reachable=True, ready=False, media_detected=True, errors=["cutter_jam"]
    )
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    assert finished(service, job_id).error.code == "cutter_jam"

    driver.status_value = READY
    other = new_id()
    service.submit(other, package_request("ohne Grund"))
    assert finished(service, other).error.code == "unknown"
    service.close()


def test_driver_that_breaks_off_midway_leaves_the_job_unknown_and_is_never_retried():
    driver = FakeDriver()
    driver.raises = OSError("Verbindung weg")
    service, recorder = make_service(driver)
    job_id, next_id = new_id(), new_id()
    service.submit(job_id, package_request())
    job = finished(service, job_id)
    assert job.state == JobState.UNKNOWN
    assert job.error.code == "interrupted"
    assert recorder.states(job_id) == ["queued", "printing", "unknown"]

    # Der Dienst druckt weiter, aber diesen Auftrag nie wieder.
    driver.raises = None
    service.submit(next_id, package_request("der nächste"))
    assert finished(service, next_id).state == JobState.PRINTED
    assert service.submit(job_id, package_request())[0].state == JobState.UNKNOWN
    with fault(ServiceError.NOT_CANCELLABLE):
        service.cancel(job_id)
    assert driver.calls == 2
    service.close()


def test_some_copies_printed_and_then_a_failure_is_neither_printed_nor_failed():
    driver = FakeDriver()
    driver.fail_after = 3
    driver.error = "no_media"
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request(copies=5))
    job = finished(service, job_id)
    assert job.state == JobState.UNKNOWN
    assert job.error.code == "interrupted"
    assert "2 von 5" in job.error.message
    assert driver.calls == 3
    service.close()


def test_printer_that_vanished_or_changed_between_accepting_and_printing():
    class Changing(StaticPrinters):
        def __init__(self) -> None:
            self.entry: PrinterEntry | None = None

        def names(self) -> list[str]:
            return [] if self.entry is None else [self.entry.name]

        def default(self) -> None:
            return None

        def lookup(self, name: str) -> PrinterEntry | None:
            return self.entry if self.entry is not None and self.entry.name == name else None

    blocker, replacement = FakeDriver(), FakeDriver(printable_px=472, dpi=203)
    blocker.gate.clear()
    printers = Changing()
    printers.entry = PrinterEntry("p", "fake", None, blocker)
    service = PrintService(printers, fonts=Fonts.builtin())
    service.start()
    first, resized, orphan = new_id(), new_id(), new_id()
    for job_id, title in ((first, "eins"), (resized, "zwei"), (orphan, "drei")):
        service.submit(job_id, package_request(title, printer="p"))
    wait_until(blocker.entered.is_set)

    # Der Drucker wird umgestellt, während der erste Auftrag druckt: Der nächste wird für das
    # neue Gerät neu gerendert.
    printers.entry = PrinterEntry("p", "fake", None, replacement)
    replacement.gate.clear()
    blocker.gate.set()
    wait_until(replacement.entered.is_set)
    # Und während der zweite druckt, verschwindet der Drucker ganz.
    printers.entry = None
    replacement.gate.set()
    assert finished(service, resized).state == JobState.PRINTED
    assert replacement.printed[0].size == (472, 231)
    gone = finished(service, orphan)
    assert (gone.state, gone.error.code) == (JobState.FAILED, "unknown_printer")
    assert service.printers() == []
    service.close()


# --- Neustart ----------------------------------------------------------------------------


def test_memory_store_forgets_everything_and_gets_a_new_boot_id():
    driver = FakeDriver()
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    finished(service, job_id)
    old_boot = service.boot_id
    service.close()

    again, _recorder = make_service(driver)
    assert again.boot_id != old_boot
    with fault(ServiceError.NOT_FOUND):
        again.get(job_id)
    # Die App schickt die boot_id des ersten Absendens mit: Der neue Lauf nimmt nichts an.
    with fault(ServiceError.BOOT_MISMATCH) as caught:
        again.submit(job_id, package_request(expect_boot_id=old_boot))
    assert caught.value.details == {"boot_id": again.boot_id}
    assert driver.calls == 1
    assert MemoryStore().boot_id != MemoryStore().boot_id
    again.close()


def test_file_store_keeps_boot_id_and_finished_jobs(tmp_path):
    path = tmp_path / "print" / "jobs.sqlite3"
    driver = FakeDriver()
    service, _recorder = make_service(driver, store=FileStore(path))
    done, failed = new_id(), new_id()
    service.submit(done, package_request())
    finished(service, done)
    driver.outcome, driver.error = PrintOutcome.FAILED, "no_media"
    service.submit(failed, package_request("leer"))
    finished(service, failed)
    boot_id = service.boot_id
    service.close()
    assert path.is_file()

    driver = FakeDriver()
    service, recorder = make_service(driver, store=FileStore(path))
    assert service.boot_id == boot_id
    assert service.get(done).state == JobState.PRINTED
    restored = service.get(failed)
    assert (restored.state, restored.error.code) == (JobState.FAILED, "no_media")
    assert restored.error.message
    # Erledigtes wird nicht noch einmal gemeldet und nie noch einmal gedruckt.
    assert recorder.events == []
    assert service.submit(done, package_request()) == (service.get(done), False)
    with fault(ServiceError.JOB_CONFLICT):
        service.submit(done, package_request("anders"))
    assert driver.calls == 0
    # Die boot_id des ersten Absendens passt weiterhin.
    service.submit(new_id(), package_request("neu", expect_boot_id=boot_id))
    service.close()


def test_file_store_restart_continues_waiting_jobs_in_order(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver, store=FileStore(path))
    ids = [new_id() for _ in range(4)]
    for number, job_id in enumerate(ids):
        service.submit(job_id, package_request(f"Etikett {number}", copies=2 if number == 3 else 1))
    wait_until(driver.entered.is_set)
    service.close(grace_s=0)  # der erste druckt gerade, drei warten

    fresh = FakeDriver()
    service, recorder = make_service(fresh, store=FileStore(path))
    for job_id in ids[1:]:
        assert finished(service, job_id).state == JobState.PRINTED
    # Der unterbrochene Auftrag ist „unknown" und wird nicht wiederholt; die wartenden laufen weiter.
    interrupted = service.get(ids[0])
    assert (interrupted.state, interrupted.error.code) == (JobState.UNKNOWN, "interrupted")
    assert fresh.calls == 4
    for number, image in zip((1, 2, 3, 3), fresh.printed, strict=True):
        expected = render(
            load_builtin("package"), package_request(f"Etikett {number}").data, fonts=Fonts.builtin()
        )
        assert image.tobytes() == expected.tobytes()
    assert recorder.states(ids[0]) == ["unknown"]
    assert recorder.states(ids[1]) == ["printing", "printed"]
    service.close()

    # Der hängende Treiber des alten Laufs wird fertig: Der alte Lauf meldet und schreibt nichts mehr.
    driver.gate.set()
    time.sleep(0.1)
    service, _recorder = make_service(FakeDriver(), store=FileStore(path))
    assert service.get(ids[0]).state == JobState.UNKNOWN
    service.close()


def test_job_that_was_printing_stays_unknown_and_is_not_printed_after_restart(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver, store=FileStore(path))
    job_id = new_id()
    service.submit(job_id, package_request())
    wait_until(driver.entered.is_set)
    boot_id = service.boot_id
    service.close(grace_s=0)

    for _restart in range(3):
        fresh = FakeDriver()
        service, _recorder = make_service(fresh, store=FileStore(path))
        assert service.boot_id == boot_id
        job = service.get(job_id)
        assert (job.state, job.error.code) == (JobState.UNKNOWN, "interrupted")
        assert service.submit(job_id, package_request(expect_boot_id=boot_id))[0].state == JobState.UNKNOWN
        time.sleep(0.05)
        assert fresh.calls == 0
        service.close()
    driver.gate.set()


def test_shutdown_waits_briefly_for_a_running_print(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    driver = FakeDriver()
    driver.gate.clear()
    service, recorder = make_service(driver, store=FileStore(path))
    job_id = new_id()
    service.submit(job_id, package_request())
    wait_until(driver.entered.is_set)
    threading.Timer(0.1, driver.gate.set).start()
    service.close(grace_s=5)
    # Innerhalb der Frist fertig geworden: Das Ergebnis ist festgehalten und gemeldet.
    assert recorder.states(job_id) == ["queued", "printing", "printed"]
    service, _recorder = make_service(FakeDriver(), store=FileStore(path))
    assert service.get(job_id).state == JobState.PRINTED
    service.close()


def test_process_killed_in_the_middle_of_a_print(tmp_path):
    """Der Ernstfall: Der Prozess stirbt, während der Treiber druckt."""
    path = tmp_path / "jobs.sqlite3"
    job_id = new_id()
    script = textwrap.dedent(
        """
        import sys, time
        from stowly_print.model import Capabilities, DriverStatus, JobRequest, Media
        from stowly_print.service import PrinterEntry, PrintService, StaticPrinters
        from stowly_print.store import FileStore
        from stowly_print.templates import load_builtin

        class Hanging:
            def capabilities(self):
                return Capabilities(300, Media(62.0, None, 696), True, ["black"], True, True)
            def status(self):
                return DriverStatus(True, True, True, [])
            def print(self, image, cut=True):
                print("druckt", flush=True)
                time.sleep(60)

        service = PrintService(StaticPrinters([PrinterEntry("p", "fake", None, Hanging())]), FileStore(sys.argv[1]))
        service.start()
        request = JobRequest.from_dict({"template": load_builtin("package"), "data": {"qr": "STOWLY/P/A2B3C", "id": "A2B3C", "title": "x"}})
        service.submit(sys.argv[2], request)
        service.submit(sys.argv[3], request)
        print(service.boot_id, flush=True)
        time.sleep(60)
        """
    )
    waiting_id = new_id()
    child = subprocess.Popen(
        [sys.executable, "-c", script, str(path), job_id, waiting_id],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        lines = {child.stdout.readline().strip(), child.stdout.readline().strip()}
        assert "druckt" in lines
        (boot_id,) = lines - {"druckt"}
    finally:
        child.kill()
        child.wait(timeout=10)
        child.stdout.close()

    driver = FakeDriver()
    recorder = Recorder()
    service = PrintService(
        StaticPrinters([PrinterEntry("p", "fake", None, driver)]),
        FileStore(path),
        observer=recorder,
        fonts=Fonts.builtin(),
    )
    service.start()
    assert service.boot_id == boot_id
    job = service.get(job_id)
    assert (job.state, job.error.code) == (JobState.UNKNOWN, "interrupted")
    # Der wartende Auftrag läuft weiter, der unterbrochene wird nicht noch einmal gedruckt.
    assert finished(service, waiting_id).state == JobState.PRINTED
    assert driver.calls == 1
    assert recorder.states(job_id) == ["unknown"]
    service.close()


def test_job_is_not_printed_when_printing_cannot_be_recorded_first(tmp_path):
    class Failing(FileStore):
        broken = False

        def save(self, record) -> None:
            if self.broken and record.state == JobState.PRINTING:
                raise OSError("Platte voll")
            super().save(record)

    store = Failing(tmp_path / "jobs.sqlite3")
    driver = FakeDriver()
    service, recorder = make_service(driver, store=store)
    store.broken = True
    job_id = new_id()
    service.submit(job_id, package_request())
    job = finished(service, job_id)
    assert (job.state, job.error.code) == (JobState.FAILED, "unknown")
    assert driver.calls == 0
    assert recorder.states(job_id) == ["queued", "failed"]
    service.close()


def test_unreadable_store_is_set_aside_and_a_new_run_begins(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    service, _recorder = make_service(FakeDriver(), store=FileStore(path))
    job_id = new_id()
    service.submit(job_id, package_request())
    finished(service, job_id)
    old_boot = service.boot_id
    service.close()

    for extra in (path, path.with_name(path.name + "-wal")):
        if extra.exists():
            extra.write_bytes(b"das ist keine Datenbank" * 100)
    store = FileStore(path)
    assert store.boot_id != old_boot
    assert store.load() == []
    assert (tmp_path / "jobs.sqlite3.defekt-1").is_file()
    service, _recorder = make_service(FakeDriver(), store=store)
    # Wer noch die alte boot_id schickt, erfährt den neuen Lauf, statt doppelt zu drucken.
    with fault(ServiceError.BOOT_MISMATCH):
        service.submit(job_id, package_request(expect_boot_id=old_boot))
    service.close()


# --- Gedächtnis --------------------------------------------------------------------------


def test_old_finished_jobs_are_forgotten_only_beyond_the_remembered_number():
    driver = FakeDriver()
    service, _recorder = make_service(driver, remembered=5)
    ids = [new_id() for _ in range(20)]
    for number, job_id in enumerate(ids):
        service.submit(job_id, package_request(f"Etikett {number}"))
        finished(service, job_id)
    known = [job_id for job_id in ids if _knows(service, job_id)]
    # Mindestens die letzten fünf bleiben, die ältesten sind fort.
    assert 5 <= len(known) <= 7
    assert known == ids[-len(known) :]
    assert MIN_REMEMBERED_JOBS == 10_000
    service.close()


def test_file_store_forgets_by_age_and_number(tmp_path):
    now = [1_000_000.0]
    path = tmp_path / "jobs.sqlite3"
    driver = FakeDriver()
    service, _recorder = make_service(
        driver, store=FileStore(path), remembered=3, retention_s=90 * 86400, wall_clock=lambda: now[0]
    )
    old = [new_id() for _ in range(6)]
    for number, job_id in enumerate(old):
        service.submit(job_id, package_request(f"alt {number}"))
        finished(service, job_id)
    # Über der Zahl, aber jung: Alle bleiben.
    assert all(_knows(service, job_id) for job_id in old)

    now[0] += 91 * 86400
    recent = [new_id() for _ in range(2)]
    for number, job_id in enumerate(recent):
        service.submit(job_id, package_request(f"neu {number}"))
        finished(service, job_id)
    # Jetzt sind die alten über 90 Tage alt: Es bleiben die jüngsten drei (der eben erledigte
    # zählt beim Aufräumen noch nicht mit, deshalb höchstens einer mehr).
    remaining = [job_id for job_id in old + recent if _knows(service, job_id)]
    assert remaining in ([old[-1], *recent], [*old[-2:], *recent])
    service.close()
    # Auch in der Datei.
    assert [record.id for record in FileStore(path).load()] == remaining


def _knows(service: PrintService, job_id: str) -> bool:
    try:
        service.get(job_id)
    except ServiceFault:
        return False
    return True


# --- Drucker und ihr Zustand -------------------------------------------------------------


def test_printers_are_listed_in_fixed_order_with_capabilities_and_status():
    first, second = FakeDriver(), FakeDriver(printable_px=472, dpi=203)
    second.status_value = DriverStatus(reachable=False, ready=None, media_detected=None, errors=["offline"])
    service, _recorder = make_service(first, second)
    listed = service.printers()
    assert [printer.name for printer in listed] == ["drucker-1", "drucker-2"]
    assert listed[0].driver == "fake"
    assert listed[0].capabilities.media.printable_px == 696
    assert listed[1].capabilities.dpi == 203
    assert listed[0].status == READY
    assert listed[1].status.errors == ["offline"]
    service.close()


def test_status_is_cached_briefly_and_refreshed_after_every_job():
    now = [100.0]
    driver = FakeDriver()
    service, recorder = make_service(driver, clock=lambda: now[0], status_ttl_s=2.0)
    service.printers()
    service.printers()
    assert driver.status_calls == 1
    now[0] += 2.5
    service.printers()
    assert driver.status_calls == 2
    service.printers(fresh=True)
    assert driver.status_calls == 3
    assert [name for name, _status in recorder.statuses] == ["drucker-1"] * 3

    # Nach jedem Auftrag fragt der Dienst den Drucker selbst und sagt es weiter.
    driver.status_value = DriverStatus(reachable=True, ready=False, media_detected=False, errors=["no_media"])
    job_id = new_id()
    service.submit(job_id, package_request())
    service.wait(job_id, 5)
    wait_until(lambda: driver.status_calls == 4)
    wait_until(lambda: len(recorder.statuses) == 4)
    assert recorder.statuses[-1][1].errors == ["no_media"]
    assert service.printers()[0].status.errors == ["no_media"]
    assert driver.status_calls == 4
    service.close()


def test_driver_whose_status_raises_is_reported_as_unknown():
    driver = FakeDriver()

    def broken() -> DriverStatus:
        raise RuntimeError("darf nicht passieren")

    driver.status = broken  # type: ignore[method-assign]
    service, _recorder = make_service(driver, FakeDriver())
    listed = service.printers()
    assert listed[0].status.errors == ["unknown"]
    assert listed[0].status.reachable is False
    assert listed[1].status == READY
    service.close()


def test_slow_printer_does_not_hold_up_the_status_of_the_others():
    slow, quick = FakeDriver(), FakeDriver()

    def sleepy() -> DriverStatus:
        time.sleep(0.4)
        return READY

    slow.status = sleepy  # type: ignore[method-assign]
    slow_too = FakeDriver()
    slow_too.status = sleepy  # type: ignore[method-assign]
    service, _recorder = make_service(slow, quick, slow_too)
    started = time.monotonic()
    assert len(service.printers()) == 3
    # Nebeneinander gefragt: etwa 0,4 s, nicht 0,8 s.
    assert time.monotonic() - started < 0.75
    service.close()


# --- Vorschau und Bild -------------------------------------------------------------------


def test_preview_renders_for_the_named_or_the_default_printer():
    wide, narrow = FakeDriver(), FakeDriver(printable_px=472, dpi=203)
    service, _recorder = make_service(wide, narrow)
    template, data = load_builtin("package"), package_request().data
    with Image.open(io.BytesIO(service.render(template, data, None))) as preview:
        assert (preview.size, preview.mode) == ((696, 342), "1")
    with Image.open(io.BytesIO(service.render(template, data, "drucker-2"))) as preview:
        assert preview.size == (472, 231)
    with fault(ServiceError.UNKNOWN_PRINTER):
        service.render(template, data, "gibt-es-nicht")
    with fault(ServiceError.RENDER_FAILED):
        service.render({"schema": 7}, data, None)
    assert wide.calls == narrow.calls == 0
    service.close()


def test_closed_service_accepts_nothing_and_wakes_waiters():
    driver = FakeDriver()
    driver.gate.clear()
    service, _recorder = make_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    wait_until(driver.entered.is_set)
    woke = []
    waiter = threading.Thread(target=lambda: woke.append(service.wait(job_id, 30)))
    waiter.start()
    time.sleep(0.05)
    service.close(grace_s=0)
    waiter.join(timeout=5)
    assert not waiter.is_alive()
    assert woke[0].state == JobState.PRINTING
    with fault(ServiceError.QUEUE_FULL):
        service.submit(new_id(), package_request())
    service.close()  # zweimal schließen schadet nicht
    driver.gate.set()


def test_service_must_be_started_before_it_accepts_jobs():
    service, recorder = make_service(start=False)
    with fault(ServiceError.QUEUE_FULL):
        service.submit(new_id(), package_request())
    service.start()
    service.start()
    job, _created = service.submit(new_id(), package_request())
    finished(service, job.id)
    assert isinstance(recorder, Recorder)
    service.close()
