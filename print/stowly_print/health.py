"""Was der Rechner über sich selbst ehrlich sagen kann (docs/etiketten.md, 5.5).

Gelesen wird nur aus ``/proc`` und ``/sys``. Was sich nicht feststellen lässt, ist ``None``,
unter Windows also alles. ``undervoltage`` ist immer ``None``: Die Pi-Zero-Reihe hat dafür
keinen Detektor.

Für die SD-Karte gibt es nur Symptome (docs/recherche.md, Abschnitt 6): den Fehlerzähler von
ext4, ein unerwartet nur lesbar eingehängtes Wurzelverzeichnis und den Füllstand des Overlays
im RAM. Das Kernel-Log wird nicht gelesen; dafür bräuchte der Dienst mehr Rechte, als er hat.
"""

import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from stowly_print.model import HostHealth

# Bits von get_throttled der Raspberry-Pi-Firmware, die „jetzt gerade" bedeuten:
# 1 = Takt begrenzt, 2 = gedrosselt, 3 = weiche Temperaturgrenze erreicht.
# Bit 0 (Unterspannung) bleibt außen vor: Der Zero hat dafür keinen Detektor.
_THROTTLED_NOW = 0b1110
_THROTTLED_FILES = (
    "sys/devices/platform/soc/soc:firmware/get_throttled",
    "sys/devices/platform/soc/soc:firmware/raspberrypi-hwmon/get_throttled",
)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii", errors="replace").strip()
    except OSError:
        return None


def _uptime(root: Path) -> float | None:
    text = _read(root / "proc/uptime")
    try:
        return None if text is None else float(text.split()[0])
    except (ValueError, IndexError):
        return None


def _temperature(root: Path) -> float | None:
    text = _read(root / "sys/class/thermal/thermal_zone0/temp")
    try:
        return None if text is None else round(int(text) / 1000, 1)
    except ValueError:
        return None


def _throttled(root: Path) -> bool | None:
    for name in _THROTTLED_FILES:
        text = _read(root / name)
        if text is None:
            continue
        try:
            return bool(int(text, 16) & _THROTTLED_NOW)
        except ValueError:
            return None
    return None


def _memory_available(root: Path) -> float | None:
    text = _read(root / "proc/meminfo")
    if text is None:
        return None
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            try:
                return round(int(line.split()[1]) / 1024, 1)
            except (ValueError, IndexError):
                return None
    return None


def _storage_errors(root: Path) -> int | None:
    """Summe der Fehlerzähler aller eingehängten ext4-Dateisysteme."""
    try:
        counters = sorted((root / "sys/fs/ext4").glob("*/errors_count"))
    except OSError:
        return None
    total: int | None = None
    for counter in counters:
        text = _read(counter)
        try:
            value = None if text is None else int(text)
        except ValueError:
            value = None
        if value is not None:
            total = value if total is None else total + value
    return total


def _root_mount(root: Path) -> tuple[str, set[str]] | None:
    """Dateisystem und Optionen, mit denen ``/`` eingehängt ist (der letzte Eintrag gilt)."""
    text = _read(root / "proc/mounts")
    if text is None:
        return None
    found = None
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[1] == "/":
            found = (fields[2], set(fields[3].split(",")))
    return found


def _storage_read_only(mount: tuple[str, set[str]] | None) -> bool | None:
    """Wahr, wenn das Wurzelverzeichnis unerwartet nur lesbar ist.

    Mit Overlay liegt ``/`` im RAM und ist beschreibbar; dass die Karte darunter nur lesbar
    eingehängt ist, ist dort Absicht. Ohne Overlay hängt ext4 nach einem Fehler von selbst
    nur lesbar ein (``errors=remount-ro``): Das ist das Symptom.
    """
    if mount is None:
        return None
    return "ro" in mount[1]


def _overlay_used(mount: tuple[str, set[str]] | None, statvfs: Callable[[str], Any] | None) -> float | None:
    """Belegter Anteil des Overlays in Prozent; ``None``, wenn ``/`` kein Overlay ist."""
    if mount is None or mount[0] != "overlay" or statvfs is None:
        return None
    try:
        stats = statvfs("/")
    except OSError:
        return None
    if not stats.f_blocks:
        return None
    return round(100.0 * (stats.f_blocks - stats.f_bfree) / stats.f_blocks, 1)


def read_host_health(
    root: Path | str = "/", *, platform: str | None = None, statvfs: Callable[[str], Any] | None = None
) -> HostHealth:
    """Der Zustand des Rechners. ``root`` und ``statvfs`` lassen sich für Tests ersetzen."""
    if (platform or sys.platform) != "linux":
        return HostHealth()
    root = Path(root)
    if statvfs is None:
        statvfs = getattr(os, "statvfs", None)
    mount = _root_mount(root)
    return HostHealth(
        uptime_s=_uptime(root),
        temperature_c=_temperature(root),
        throttled=_throttled(root),
        undervoltage=None,
        storage_errors=_storage_errors(root),
        storage_read_only=_storage_read_only(mount),
        overlay_used_pct=_overlay_used(mount, statvfs),
        memory_available_mb=_memory_available(root),
    )
