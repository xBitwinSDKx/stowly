"""Versionsnummern und Release-Text von Stowly (docs/betrieb.md, Abschnitt 9.4).

    python scripts/release.py 0.3.0           Nummer überall setzen (CHANGELOG.md braucht "## 0.3.0")
    python scripts/release.py --check 0.3.0   prüfen, dass überall 0.3.0 steht (für GitHub Actions)
    python scripts/release.py --notes 0.3.0   den Abschnitt "## 0.3.0" aus CHANGELOG.md ausgeben

Die Nummer steht an fünf Stellen: server/stowly/__init__.py, server/pyproject.toml,
print/pyproject.toml, web/package.json und web/package-lock.json (zweimal). Sie ist SemVer ohne
Zusatz; ein Tag mit Zusatz (v0.3.0-rc.1) ist eine Vorabversion derselben Nummer. Nur Standardbibliothek.
"""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
CHANGELOG = ROOT / "CHANGELOG.md"
INIT = ROOT / "server" / "stowly" / "__init__.py"
PYPROJECTS = (ROOT / "server" / "pyproject.toml", ROOT / "print" / "pyproject.toml")
PACKAGE = ROOT / "web" / "package.json"
LOCK = ROOT / "web" / "package-lock.json"

_INIT_LINE = re.compile(r'^__version__ = "([^"]*)"$', re.MULTILINE)
_PYPROJECT_LINE = re.compile(r'^version = "([^"]*)"$', re.MULTILINE)
_JSON_LINE = re.compile(r'^(  "version": ")([^"]*)(",?)$', re.MULTILINE)
_LOCK_ROOT = re.compile(r'^(    "": \{\n(?:      .*\n)*?      "version": ")([^"]*)(",?)$', re.MULTILINE)


def _read(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def _write(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def found() -> dict[str, str]:
    """Die Nummer an jeder Stelle, so wie sie dort steht."""
    numbers: dict[str, str] = {}
    match = _INIT_LINE.search(_read(INIT))
    numbers[str(INIT.relative_to(ROOT))] = match.group(1) if match else "?"
    for path in PYPROJECTS:
        match = _PYPROJECT_LINE.search(_read(path))
        numbers[str(path.relative_to(ROOT))] = match.group(1) if match else "?"
    numbers[str(PACKAGE.relative_to(ROOT))] = json.loads(_read(PACKAGE))["version"]
    lock = json.loads(_read(LOCK))
    numbers[f"{LOCK.relative_to(ROOT)} (oben)"] = lock["version"]
    numbers[f'{LOCK.relative_to(ROOT)} (packages."")'] = lock["packages"][""]["version"]
    return numbers


def notes(version: str) -> str | None:
    """Der Abschnitt "## <version>" aus CHANGELOG.md, ohne die Überschrift; None, wenn er fehlt."""
    lines = _read(CHANGELOG).splitlines()
    heading = re.compile(rf"^## \[?{re.escape(version)}\]?(\s|$)")
    for index, line in enumerate(lines):
        if heading.match(line):
            body: list[str] = []
            for following in lines[index + 1 :]:
                if following.startswith("## "):
                    break
                body.append(following)
            return "\n".join(body).strip() + "\n"
    return None


def set_version(version: str) -> None:
    """Setzt die Nummer an allen Stellen; ändert sonst kein Zeichen der Dateien."""

    def replace_once(pattern: re.Pattern[str], text: str, replacement: str, path: Path) -> str:
        new, count = pattern.subn(replacement, text, count=1)
        if count != 1:
            raise SystemExit(f"{path.relative_to(ROOT)}: Versionszeile nicht gefunden.")
        return new

    _write(INIT, replace_once(_INIT_LINE, _read(INIT), f'__version__ = "{version}"', INIT))
    for path in PYPROJECTS:
        _write(path, replace_once(_PYPROJECT_LINE, _read(path), f'version = "{version}"', path))
    _write(PACKAGE, replace_once(_JSON_LINE, _read(PACKAGE), rf"\g<1>{version}\g<3>", PACKAGE))
    lock = replace_once(_JSON_LINE, _read(LOCK), rf"\g<1>{version}\g<3>", LOCK)
    _write(LOCK, replace_once(_LOCK_ROOT, lock, rf"\g<1>{version}\g<3>", LOCK))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="nur prüfen, nichts ändern")
    mode.add_argument("--notes", action="store_true", help="den Abschnitt aus CHANGELOG.md ausgeben")
    parser.add_argument("version", help="SemVer ohne Zusatz, etwa 0.3.0")
    args = parser.parse_args(argv)

    version = args.version.removeprefix("v")
    if not VERSION.match(version):
        print(f"'{args.version}' ist keine Version wie 1.2.3.", file=sys.stderr)
        return 2

    if args.notes:
        text = notes(version)
        if text is None:
            print(f"CHANGELOG.md hat keinen Abschnitt '## {version}'.", file=sys.stderr)
            return 1
        sys.stdout.buffer.write(text.encode("utf-8"))
        return 0

    if notes(version) is None:
        print(f"CHANGELOG.md hat keinen Abschnitt '## {version}'.", file=sys.stderr)
        return 1

    if args.check:
        wrong = {place: number for place, number in found().items() if number != version}
        for place, number in wrong.items():
            print(f"{place}: {number} statt {version}", file=sys.stderr)
        return 1 if wrong else 0

    set_version(version)
    for place, number in found().items():
        print(f"{place}: {number}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
