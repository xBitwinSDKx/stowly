"""Bild-Treiber und das Anlegen von Treibern aus den Angaben zu einem Drucker."""

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from PIL import Image
from print_support import make_service, new_id, package_request, wait_until

from stowly_print import media as catalog
from stowly_print.drivers import BrokenDriver, Driver, PrinterConfig, build_driver
from stowly_print.drivers.brother_ql import BrotherQLDriver
from stowly_print.drivers.image import SIMULATE_FILE, ImageDriver, PrintAborted
from stowly_print.model import JobState, PrintOutcome
from stowly_print.render import Fonts, render
from stowly_print.service import PrinterEntry, PrintService, StaticPrinters
from stowly_print.templates import load_builtin


def label() -> Image.Image:
    return render(load_builtin("package"), package_request().data, fonts=Fonts.builtin())


def image_service(driver: ImageDriver) -> PrintService:
    service = PrintService(
        StaticPrinters([PrinterEntry("bild", "image", None, driver)]), fonts=Fonts.builtin()
    )
    service.start()
    return service


def remove_switch(directory: Path) -> None:
    """Entfernt ``simulate.txt`` aus dem Verzeichnis des Bild-Treibers.

    Unter Windows lässt sich eine Datei nicht löschen, solange ein anderer Thread sie gerade liest
    (``WinError 32``). Das kommt hier vor: Der Dienst fragt nach jedem Auftrag den Zustand ab, und
    ein hängender Druck prüft den Schalter alle 0,1 s. Dann kurz warten und noch einmal versuchen.
    """
    path = directory / SIMULATE_FILE
    deadline = time.monotonic() + 5
    while True:
        try:
            path.unlink()
            return
        except PermissionError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.01)


# --- Bild-Treiber ------------------------------------------------------------------------


def test_image_driver_writes_one_png_per_job(tmp_path):
    driver = ImageDriver(tmp_path / "etiketten")
    assert isinstance(driver, Driver)
    capabilities = driver.capabilities()
    assert (capabilities.dpi, capabilities.media.printable_px, capabilities.media.length_mm) == (
        300,
        696,
        None,
    )
    assert capabilities.confirms_print is True
    # Das Verzeichnis entsteht erst beim ersten Druck; erreichbar ist der Treiber vorher schon.
    assert not (tmp_path / "etiketten").exists()
    assert driver.status().reachable is True
    assert driver.status().errors == []

    job_id = new_id()
    assert driver.image_path(job_id) is None
    assert driver.for_job(job_id).print(label()) == PrintOutcome.PRINTED
    path = driver.image_path(job_id)
    assert path == tmp_path / "etiketten" / f"{job_id}.png"
    with Image.open(path) as stored:
        assert stored.mode == "1"
        assert stored.size == (696, 342)
        assert stored.tobytes() == label().tobytes()

    # Weitere Exemplare liegen daneben; nichts bleibt halbfertig liegen.
    assert driver.for_job(job_id, 2).print(label()) == PrintOutcome.PRINTED
    assert driver.for_job(job_id, 3).print(label()) == PrintOutcome.PRINTED
    assert sorted(entry.name for entry in (tmp_path / "etiketten").iterdir()) == sorted(
        [f"{job_id}.png", f"{job_id}.2.png", f"{job_id}.3.png"]
    )
    # Ohne Auftrag im Rücken bekommt die Datei irgendeinen Namen.
    assert driver.print(label()) == PrintOutcome.PRINTED
    assert len(list((tmp_path / "etiketten").glob("druck-*.png"))) == 1


def test_image_driver_refuses_an_image_that_does_not_fit(tmp_path):
    driver = ImageDriver(tmp_path)
    assert driver.for_job("a").print(Image.new("1", (500, 342), 1)) == PrintOutcome.FAILED
    assert driver.last_error == "config"
    assert driver.for_job("b").print(Image.new("L", (696, 342), 255)) == PrintOutcome.FAILED
    assert list(tmp_path.iterdir()) == []


def test_image_driver_writes_any_paper_of_the_catalog_in_its_size(tmp_path):
    driver = ImageDriver(tmp_path)
    media = driver.capabilities().media
    assert (media.id, media.kind, media.printable_length_px) == ("62", "endless", None)
    assert driver.loaded is None  # keine Rolle, also auch kein Abgleich
    die_cut = driver.for_paper(catalog.paper("62x29"))
    assert die_cut.capabilities().media.printable_length_px == 271
    assert die_cut.loaded is None
    # Gestanzt: genau die druckbaren Punkte, 696 × 271; die Länge der Vorlage zählt nicht.
    assert die_cut.for_job("gestanzt").print(Image.new("1", (696, 271), 1)) == PrintOutcome.PRINTED
    assert die_cut.for_job("zu-lang").print(Image.new("1", (696, 342), 1)) == PrintOutcome.FAILED
    assert die_cut.last_error == "config"
    # Endlos und gedreht: quer 306 Punkte, die Länge ist frei.
    narrow = driver.for_paper(catalog.paper("29")).for_job("schmal", 2)
    assert narrow.print(Image.new("1", (306, 732), 1)) == PrintOutcome.PRINTED
    assert narrow.print(Image.new("1", (732, 306), 1)) == PrintOutcome.FAILED  # Leserichtung, nicht gedreht
    with Image.open(tmp_path / "gestanzt.png") as stored:
        assert stored.size == (696, 271)
    with Image.open(tmp_path / "schmal.2.png") as stored:
        assert stored.size == (306, 732)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["gestanzt.png", "schmal.2.png"]
    # Mit einem anderen Papier als Vorgabe; ein unbekanntes ist ein Fehler beim Anlegen.
    assert ImageDriver(tmp_path, media="62x100").capabilities().media.printable_length_px == 1109
    with pytest.raises(ValueError, match="63"):
        ImageDriver(tmp_path, media="63")


def test_image_driver_reports_a_directory_it_cannot_use(tmp_path):
    blocker = tmp_path / "datei"
    blocker.write_text("kein Verzeichnis", encoding="utf-8")
    driver = ImageDriver(blocker / "darunter")
    status = driver.status()
    assert (status.reachable, status.errors) == (False, ["offline"])
    assert driver.for_job("a").print(label()) == PrintOutcome.FAILED
    assert driver.last_error == "offline"


@pytest.mark.parametrize(
    ("switch", "code"),
    [
        ("fail", "no_media"),
        ("fail:cover_open", "cover_open"),
        (" FAIL : Offline \n", "offline"),
        ("fail:quatsch", "no_media"),
    ],
)
def test_image_driver_can_be_told_to_fail(tmp_path, switch, code):
    for driver in (ImageDriver(tmp_path / "a", simulate=switch), ImageDriver(tmp_path / "b")):
        if driver.simulate is None:
            driver.directory.mkdir()
            (driver.directory / SIMULATE_FILE).write_text(switch, encoding="utf-8")
        assert driver.for_job("x").print(label()) == PrintOutcome.FAILED
        assert driver.last_error == code
        assert driver.image_path("x") is None
        status = driver.status()
        assert (status.reachable, status.ready, status.errors) == (True, False, [code])
        assert status.media_detected is (code != "no_media")


def test_image_driver_can_be_told_to_break_off_midway(tmp_path):
    driver = ImageDriver(tmp_path, simulate="abort")
    with pytest.raises(PrintAborted):
        driver.for_job("x").print(label())
    assert driver.image_path("x") is None
    # Ohne den Schalter druckt derselbe Treiber wieder.
    driver.simulate = None
    assert driver.for_job("y").print(label()) == PrintOutcome.PRINTED


def test_image_driver_can_be_told_to_hang_until_the_switch_is_removed(tmp_path):
    (tmp_path / SIMULATE_FILE).write_text("hang", encoding="utf-8")
    driver = ImageDriver(tmp_path)
    outcome: list[PrintOutcome] = []
    worker = threading.Thread(target=lambda: outcome.append(driver.for_job("x").print(label())))
    worker.start()
    time.sleep(0.3)
    assert worker.is_alive()
    assert driver.image_path("x") is None
    assert driver.status().ready is True  # der Zustand lässt sich trotzdem abfragen
    remove_switch(tmp_path)
    worker.join(timeout=5)
    assert outcome == [PrintOutcome.PRINTED]
    assert driver.image_path("x") is not None


def test_image_driver_cleans_up_by_age_and_number(tmp_path):
    driver = ImageDriver(tmp_path)
    now = time.time()
    for number in range(10):
        path = tmp_path / f"job-{number}.png"
        path.write_bytes(b"x")
        os.utime(path, (now - number * 86400, now - number * 86400))  # je einen Tag älter
    (tmp_path / "notiz.txt").write_text("bleibt", encoding="utf-8")
    stale = tmp_path / "halb.tmp"
    stale.write_bytes(b"x")
    os.utime(stale, (now - 7200, now - 7200))

    # Älter als fünfeinhalb Tage fällt weg, dazu die liegen gebliebene halbe Datei.
    assert driver.cleanup(max_age_s=5.5 * 86400, keep=100) == 5
    assert sorted(entry.name for entry in tmp_path.iterdir()) == [
        *(f"job-{number}.png" for number in range(6)),
        "notiz.txt",
    ]
    # Von den übrigen nur die drei jüngsten.
    assert driver.cleanup(max_age_s=365 * 86400, keep=3) == 3
    assert sorted(entry.name for entry in tmp_path.glob("*.png")) == ["job-0.png", "job-1.png", "job-2.png"]
    assert driver.cleanup(max_age_s=365 * 86400, keep=3) == 0
    assert ImageDriver(tmp_path / "fehlt").cleanup(max_age_s=1, keep=1) == 0


# --- Bild-Treiber im Auftragsdienst ------------------------------------------------------


def test_job_through_the_image_driver_leaves_exactly_one_png(tmp_path):
    driver = ImageDriver(tmp_path)
    service = image_service(driver)
    job_id = new_id()
    service.submit(job_id, package_request())
    assert service.wait(job_id, 5).state == JobState.PRINTED
    path = service.image_path(job_id)
    assert path == tmp_path / f"{job_id}.png"
    first_written = path.stat().st_mtime_ns

    # Derselbe Auftrag noch einmal: kein zweites Bild, das erste bleibt unberührt.
    assert service.submit(job_id, package_request())[1] is False
    assert [entry.name for entry in tmp_path.iterdir()] == [f"{job_id}.png"]
    assert path.stat().st_mtime_ns == first_written

    copies = new_id()
    service.submit(copies, package_request("mehrfach", copies=2))
    assert service.wait(copies, 5).state == JobState.PRINTED
    assert len(list(tmp_path.glob("*.png"))) == 3
    service.close()


def test_image_driver_switch_makes_jobs_fail_or_stay_unknown(tmp_path):
    driver = ImageDriver(tmp_path)
    service = image_service(driver)
    (tmp_path / SIMULATE_FILE).write_text("fail:cover_open", encoding="utf-8")
    failed = new_id()
    service.submit(failed, package_request("scheitert"))
    job = service.wait(failed, 5)
    assert (job.state, job.error.code) == (JobState.FAILED, "cover_open")
    assert service.printers(fresh=True)[0].status.errors == ["cover_open"]

    (tmp_path / SIMULATE_FILE).write_text("abort", encoding="utf-8")
    aborted = new_id()
    service.submit(aborted, package_request("bricht ab"))
    job = service.wait(aborted, 5)
    assert (job.state, job.error.code) == (JobState.UNKNOWN, "interrupted")
    assert service.image_path(aborted) is None
    assert service.image_path(failed) is None

    # Nach dem Auftrag liest der Dienst den Schalter noch einmal (Zustand des Druckers).
    remove_switch(tmp_path)
    fine = new_id()
    service.submit(fine, package_request("geht wieder"))
    assert service.wait(fine, 5).state == JobState.PRINTED
    service.close()


def test_job_hanging_in_the_image_driver_is_unknown_after_a_restart(tmp_path):
    from stowly_print.store import FileStore

    images = tmp_path / "bilder"
    images.mkdir()
    (images / SIMULATE_FILE).write_text("hang", encoding="utf-8")
    service = PrintService(
        StaticPrinters([PrinterEntry("bild", "image", None, ImageDriver(images))]),
        FileStore(tmp_path / "jobs.sqlite3"),
        fonts=Fonts.builtin(),
    )
    service.start()
    job_id = new_id()
    service.submit(job_id, package_request())
    wait_until(lambda: service.get(job_id).state == JobState.PRINTING)
    wait_until(lambda: (images / f"{job_id}.tmp").exists())
    service.close(grace_s=0)

    again = PrintService(
        StaticPrinters([PrinterEntry("bild", "image", None, ImageDriver(images))]),
        FileStore(tmp_path / "jobs.sqlite3"),
        fonts=Fonts.builtin(),
    )
    again.start()
    job = again.get(job_id)
    assert (job.state, job.error.code) == (JobState.UNKNOWN, "interrupted")
    assert again.image_path(job_id) is None  # kein Druck
    again.close()
    remove_switch(images)  # gibt den hängenden Thread des ersten Laufs frei
    time.sleep(0.3)


# --- Treiber aus Angaben -----------------------------------------------------------------


def test_build_driver_picks_the_driver_and_never_raises(tmp_path):
    image = build_driver(PrinterConfig(name="bild", driver="image", directory=tmp_path, simulate="fail"))
    assert isinstance(image, ImageDriver)
    assert image.simulate == "fail"
    brother = build_driver(
        PrinterConfig(name="keller", driver="brother_ql", model="QL-800", address="usb://04f9:209b")
    )
    assert isinstance(brother, BrotherQLDriver)
    # Die Rolle der Konfiguration ist die Vorgabe für Vorlagen ohne Papier, ohne Angabe 62 mm endlos.
    assert image.paper == catalog.paper("62")
    other = build_driver(PrinterConfig(name="bild", driver="image", directory=tmp_path, media="62x29"))
    assert isinstance(other, ImageDriver) and other.paper == catalog.paper("62x29")

    for config in (
        PrinterConfig(name="x", driver="image"),  # ohne Verzeichnis
        PrinterConfig(name="x", driver="zpl", address="tcp://10.0.0.5"),
        PrinterConfig(name="x", driver=""),
    ):
        broken = build_driver(config)
        assert isinstance(broken, BrokenDriver)
        assert isinstance(broken, Driver)
        status = broken.status()
        assert (status.reachable, status.errors) == (False, ["config"])
        assert broken.capabilities().media.printable_px == 696
        assert broken.print(label()) == PrintOutcome.FAILED
        assert broken.last_error == "config"


def test_printer_with_unusable_settings_stays_listed_and_fails_its_jobs():
    broken = build_driver(PrinterConfig(name="x", driver="zpl"))
    service = PrintService(StaticPrinters([PrinterEntry("x", "zpl", "ZD421", broken)]), fonts=Fonts.builtin())
    service.start()
    listed = service.printers()
    assert [(printer.name, printer.driver, printer.model) for printer in listed] == [("x", "zpl", "ZD421")]
    assert listed[0].status.reachable is False
    assert listed[0].status.errors == ["config"]
    job_id = new_id()
    service.submit(job_id, package_request())
    job = service.wait(job_id, 5)
    assert (job.state, job.error.code) == (JobState.FAILED, "config")
    service.close()


def test_package_imports_without_the_brother_library():
    """``stowly_print`` und sein Brother-Modul laden die Bibliothek erst, wenn ein Drucker benutzt wird."""
    script = (
        "import sys\n"
        "import stowly_print, stowly_print.service, stowly_print.drivers.brother_ql\n"
        "from stowly_print.drivers import PrinterConfig, build_driver\n"
        "driver = build_driver(PrinterConfig(name='k', driver='brother_ql', model='QL-800', address='usb://04f9:209b'))\n"
        "loaded = sorted(name for name in sys.modules if name.split('.')[0] in ('brother_ql', 'usb', 'packbits'))\n"
        "assert not loaded, loaded\n"
        "sys.modules['brother_ql'] = None  # so, als wäre sie nicht installiert\n"
        "status = driver.status()\n"
        "assert (status.reachable, status.errors) == (False, ['config']), status\n"
        "assert driver.capabilities().media.printable_px == 696\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_make_service_helper_uses_the_given_drivers():
    service, _recorder = make_service()
    assert [printer.name for printer in service.printers()] == ["drucker-1"]
    service.close()
