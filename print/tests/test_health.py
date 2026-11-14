"""Zustand des Rechners: das Wurzelverzeichnis in der Sicht des Systems, nicht des Dienstes."""

from pathlib import Path

from stowly_print.health import read_host_health

SYSTEM_RW = "/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n"
# So sieht der Dienst sein eigenes `/` mit ProtectSystem=strict.
SERVICE_RO = "/dev/mmcblk0p2 / ext4 ro,nosuid,nodev,noatime 0 0\n"


def _proc(tmp_path: Path, *, own: str | None, system: str | None) -> Path:
    if own is not None:
        (tmp_path / "proc").mkdir(parents=True, exist_ok=True)
        (tmp_path / "proc" / "mounts").write_text(own, encoding="utf-8")
    if system is not None:
        (tmp_path / "proc" / "1").mkdir(parents=True, exist_ok=True)
        (tmp_path / "proc" / "1" / "mounts").write_text(system, encoding="utf-8")
    return tmp_path


def test_reads_the_root_as_the_system_sees_it_not_the_hardened_service(tmp_path: Path) -> None:
    root = _proc(tmp_path, own=SERVICE_RO, system=SYSTEM_RW)
    assert read_host_health(root, platform="linux").storage_read_only is False


def test_reports_a_root_that_the_system_remounted_read_only(tmp_path: Path) -> None:
    root = _proc(tmp_path, own=SERVICE_RO, system="/dev/mmcblk0p2 / ext4 ro,noatime 0 0\n")
    assert read_host_health(root, platform="linux").storage_read_only is True


def test_falls_back_to_its_own_view_when_the_system_view_is_hidden(tmp_path: Path) -> None:
    root = _proc(tmp_path, own=SYSTEM_RW, system=None)
    assert read_host_health(root, platform="linux").storage_read_only is False
    hidden = _proc(tmp_path / "zweiter", own=SERVICE_RO, system=None)
    assert read_host_health(hidden, platform="linux").storage_read_only is True


def test_an_overlay_root_is_not_read_only_and_reports_its_use(tmp_path: Path) -> None:
    class Stats:
        f_blocks = 1000
        f_bfree = 750

    overlay = (
        "overlayroot / overlay rw,relatime,lowerdir=/media/root-ro,upperdir=/media/root-rw/overlay 0 0\n"
    )
    root = _proc(tmp_path, own=SERVICE_RO, system=overlay)
    health = read_host_health(root, platform="linux", statvfs=lambda _path: Stats())
    assert health.storage_read_only is False
    assert health.overlay_used_pct == 25.0


def test_without_any_mount_table_it_says_nothing(tmp_path: Path) -> None:
    health = read_host_health(tmp_path, platform="linux")
    assert health.storage_read_only is None
    assert health.overlay_used_pct is None
