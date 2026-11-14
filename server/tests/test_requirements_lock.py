"""Die Sperrdatei des Images passt zu den Abhängigkeiten und zur Umgebung der Tests.

Das Image installiert alle Python-Pakete aus ``server/requirements.lock``: jede Datei auf Version
und Prüfsumme festgelegt, ohne aufzulösen (``--no-deps``). Fehlt dort eine Abhängigkeit, fiele das
erst beim Bau oder im Betrieb auf. Diese Tests halten deshalb fest: Jede Laufzeit-Abhängigkeit von
stowly-server und stowly-print unter Linux (CPython 3.12, x86_64 und aarch64) steht in der
Sperrdatei, mit genau der Version, mit der die Tests hier laufen, und nichts steht darüber hinaus
darin (außer setuptools zum Bauen).

Welche Pakete das sind, ergibt sich aus den Metadaten: die direkten aus den beiden
``pyproject.toml``, alle weiteren rekursiv aus ``Requires-Dist`` der installierten Pakete, samt
Umgebungsmarkern. ``pip freeze`` taugt dafür nicht; dort stehen auch Entwicklungswerkzeuge und
Pakete nur für Windows.

Als Skript schreibt diese Datei die Sperrdatei neu (Anleitung am Kopf von ``requirements.lock``)::

    python tests/test_requirements_lock.py
"""

import json
import platform
import re
import tomllib
import urllib.request
from datetime import date
from importlib import metadata
from pathlib import Path
from typing import NamedTuple

import pytest
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVER_DIR.parent
LOCK_PATH = SERVER_DIR / "requirements.lock"
BROTHER_PATH = REPO_ROOT / "print" / "requirements-brother.txt"
PROJECTS = (SERVER_DIR / "pyproject.toml", REPO_ROOT / "print" / "pyproject.toml")

# Die eigenen Pakete baut das Image aus dem Quelltext; sie stehen nicht in der Sperrdatei.
OWN = {"stowly-server", "stowly-print"}
# Nur für den Bau ohne eigene Bau-Umgebung (--no-build-isolation), keine Laufzeit-Abhängigkeit.
BUILD_ONLY = {"setuptools"}
# Ab dieser Version baut setuptools Wheels selbst, ohne das Paket wheel.
SETUPTOOLS_MIN = Version("70.1")

# Das Image: python:3.12-slim (Debian) auf x86_64 oder aarch64.
PYTHON = "3.12"
MACHINES = ("x86_64", "aarch64")

PYPI_JSON = "https://pypi.org/pypi/{name}/{version}/json"
PIN_LINE = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>\S+)(?P<hashes>(?:\s+--hash=sha256:[0-9a-f]{64})+)$"
)
STAND_LINE = re.compile(r"^(# Stand: )\d{2}\.\d{2}\.\d{4}", re.MULTILINE)


class Pin(NamedTuple):
    version: str
    hashes: tuple[str, ...]


def read_pins(path: Path) -> dict[str, Pin]:
    """Eine Datei für ``pip install --require-hashes -r`` lesen: Name -> Version und Prüfsummen.

    Jede Anforderung muss ``name==version`` mit mindestens einer Prüfsumme sein, und jeder Name darf
    nur einmal vorkommen; alles andere ist ein Fehler der Datei.
    """
    logical: list[str] = []
    current = ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not current and (not line or line.startswith("#")):
            continue
        if line.endswith("\\"):
            current += line[:-1] + " "
            continue
        logical.append(current + line)
        current = ""
    assert not current, f"{path.name}: Die letzte Zeile endet mit einem Backslash."

    pins: dict[str, Pin] = {}
    for line in logical:
        match = PIN_LINE.match(line)
        assert match, f"{path.name}: keine Anforderung der Form name==version --hash=sha256:…: {line}"
        name = canonicalize_name(match["name"])
        assert name not in pins, f"{path.name}: {name} steht zweimal darin."
        hashes = tuple(match["hashes"].split("--hash=sha256:")[1:])
        pins[name] = Pin(match["version"], tuple(value.strip() for value in hashes))
    return pins


def linux(machine: str, extra: str = "") -> dict[str, str]:
    """Die Umgebungsmarker im Image (PEP 508)."""
    # Die Patch-Version des Images ist hier nicht bekannt; die der Testumgebung kommt ihr am nächsten.
    full = platform.python_version()
    if not full.startswith(PYTHON + "."):
        full = PYTHON + ".0"
    environment = dict(default_environment())
    environment.update(
        os_name="posix",
        sys_platform="linux",
        platform_system="Linux",
        platform_machine=machine,
        platform_release="",
        platform_version="",
        implementation_name="cpython",
        platform_python_implementation="CPython",
        implementation_version=full,
        python_version=PYTHON,
        python_full_version=full,
        extra=extra,
    )
    return environment


def applies(requirement: Requirement, machine: str, extras: frozenset[str]) -> bool:
    """Gilt die Anforderung im Image, wenn ihr Paket mit diesen Extras verlangt wurde?"""
    if requirement.marker is None:
        return True
    return any(requirement.marker.evaluate(linux(machine, extra)) for extra in {"", *extras})


def dependencies(roots: list[Requirement], machine: str) -> dict[str, str]:
    """Alle Abhängigkeiten der Wurzeln im Image, rekursiv: Name -> Version in dieser Umgebung.

    Die eigenen Pakete zählen nicht mit. Fehlt ein Paket hier oder passt seine Version nicht zur
    Anforderung, ist die Umgebung nicht in Ordnung (erst ``pip install -e …`` wiederholen).
    """
    found: dict[str, str] = {}
    visited: set[tuple[str, frozenset[str]]] = set()
    todo = [(requirement, frozenset[str]()) for requirement in roots]
    while todo:
        requirement, wanted_by = todo.pop()
        if not applies(requirement, machine, wanted_by):
            continue
        name = canonicalize_name(requirement.name)
        if name in OWN:
            continue
        try:
            distribution = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            raise AssertionError(
                f"{name} ({requirement}) ist in dieser Umgebung nicht installiert."
            ) from None
        version = distribution.version
        assert requirement.specifier.contains(version, prereleases=True), (
            f"{name} {version} passt nicht zur Anforderung {requirement}."
        )
        found[name] = version
        extras = frozenset(requirement.extras)
        if (name, extras) not in visited:
            visited.add((name, extras))
            todo += [(Requirement(line), extras) for line in distribution.requires or []]
    return found


def runtime_dependencies() -> dict[str, str]:
    """Die Laufzeit-Abhängigkeiten von stowly-server und stowly-print, für beide Plattformen."""
    roots: list[Requirement] = []
    for path in PROJECTS:
        project = tomllib.loads(path.read_text(encoding="utf-8"))["project"]
        roots += [Requirement(line) for line in project.get("dependencies", [])]
    found: dict[str, str] = {}
    for machine in MACHINES:
        found.update(dependencies(roots, machine))
    return found


def test_lock_lists_every_runtime_dependency_with_the_tested_version():
    locked = read_pins(LOCK_PATH)
    needed = runtime_dependencies()
    missing = sorted(f"{name}=={version}" for name, version in needed.items() if name not in locked)
    other_version = sorted(
        f"{name} (Sperrdatei {locked[name].version}, Umgebung {version})"
        for name, version in needed.items()
        if name in locked and locked[name].version != version
    )
    surplus = sorted(set(locked) - set(needed) - BUILD_ONLY)
    assert (missing, other_version, surplus) == ([], [], []), (
        "server/requirements.lock passt nicht zu den Abhängigkeiten dieser Umgebung. "
        f"Fehlt: {missing or '-'}. Andere Version: {other_version or '-'}. Überzählig: {surplus or '-'}. "
        "Erneuern: im Ordner server python tests/test_requirements_lock.py (Anleitung am Kopf der Datei)."
    )


def test_lock_brings_setuptools_that_builds_without_wheel():
    locked = read_pins(LOCK_PATH)
    assert "setuptools" in locked, "Ohne setuptools in der Sperrdatei kann das Image nichts bauen."
    assert Version(locked["setuptools"].version) >= SETUPTOOLS_MIN, (
        f"setuptools vor {SETUPTOOLS_MIN} braucht zum Bauen zusätzlich das Paket wheel."
    )


def test_brother_library_is_complete_with_the_lock():
    """Die Brother-Bibliothek kommt ebenfalls mit --no-deps: Was sie braucht, steht in einer der Dateien."""
    brother = read_pins(BROTHER_PATH)
    locked = read_pins(LOCK_PATH)
    both = sorted(set(brother) & set(locked))
    assert both == [], f"In beiden Dateien, also womöglich in zwei Versionen: {both}"
    try:
        installed = metadata.version("brother-ql-next")
    except metadata.PackageNotFoundError:
        pytest.skip('brother-ql-next ist hier nicht installiert (pip install -e "./print[brother]").')
    assert installed == brother["brother-ql-next"].version
    needed: dict[str, str] = {}
    for machine in MACHINES:
        needed.update(dependencies([Requirement("brother-ql-next")], machine))
    missing = sorted(set(needed) - set(brother) - set(locked))
    assert missing == [], f"Die Brother-Bibliothek braucht noch: {missing}"


# ---------------------------------------------------------------- Sperrdatei neu schreiben


def pypi_hashes(name: str, version: str) -> list[str]:
    """Die Prüfsummen (SHA-256) aller Dateien einer Version, aus der JSON-Schnittstelle von PyPI."""
    request = urllib.request.Request(
        PYPI_JSON.format(name=name, version=version), headers={"User-Agent": "stowly-requirements-lock"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    files = release["urls"]
    if not files:
        raise SystemExit(f"{name} {version}: PyPI nennt keine Dateien.")
    if release["info"].get("yanked") or any(file.get("yanked") for file in files):
        raise SystemExit(f"{name} {version} ist auf PyPI zurückgezogen (yanked). Eine andere Version wählen.")
    return sorted(file["digests"]["sha256"] for file in files)


def write_lock() -> None:
    """Die Sperrdatei neu schreiben: Kopf bleibt (mit neuem Datum), setuptools behält seine Version."""
    text = LOCK_PATH.read_text(encoding="utf-8")
    first = re.search(r"^[^#\s]", text, re.MULTILINE)
    header = text[: first.start()] if first else text
    header, count = STAND_LINE.subn(rf"\g<1>{date.today():%d.%m.%Y}", header, count=1)
    if count != 1:
        raise SystemExit("Im Kopf der Sperrdatei fehlt die Zeile '# Stand: TT.MM.JJJJ'.")
    pins = runtime_dependencies()
    for name in BUILD_ONLY:
        pins[name] = read_pins(LOCK_PATH)[name].version
    blocks = []
    for name, version in sorted(pins.items()):
        hashes = pypi_hashes(name, version)
        blocks.append(
            " \\\n".join([f"{name}=={version}", *(f"    --hash=sha256:{value}" for value in hashes)])
        )
        print(f"{name}=={version}: {len(hashes)} Dateien")
    LOCK_PATH.write_text(header + "\n".join(blocks) + "\n", encoding="utf-8", newline="\n")
    print(f"{LOCK_PATH} geschrieben: {len(pins)} Pakete.")


if __name__ == "__main__":
    write_lock()
