"""Schreibt die aus den Modellen abgeleiteten Vertragsdateien.

    python -m stowly.contract.export          # schreibt beide Dateien neu
    python -m stowly.contract.export --check  # prüft nur, Exit-Code 1 bei Abweichung

Erzeugt werden ``docs/openapi.json`` und ``web/src/contract/api.gen.ts``.
Nur der Coordinator ruft das ohne ``--check`` auf: Die Dateien sind der Vertrag.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from stowly.config import Settings
from stowly.contract.tsgen import generate_typescript

REPO_ROOT = Path(__file__).resolve().parents[3]
OPENAPI_PATH = REPO_ROOT / "docs" / "openapi.json"
TYPESCRIPT_PATH = REPO_ROOT / "web" / "src" / "contract" / "api.gen.ts"


def contract_document() -> dict[str, Any]:
    """Das Vertragsdokument der App, ohne eine Datenbank anzufassen."""
    from stowly.app import build_app

    settings = Settings.from_env({}, dev=False)
    return build_app(settings).openapi()


def render() -> dict[Path, str]:
    """Soll-Inhalt aller erzeugten Dateien."""
    document = contract_document()
    return {
        OPENAPI_PATH: json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        TYPESCRIPT_PATH: generate_typescript(document),
    }


def stale_files() -> list[Path]:
    """Dateien, deren Inhalt nicht (mehr) zu den Modellen passt."""
    stale: list[Path] = []
    for path, expected in render().items():
        try:
            actual = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            stale.append(path)
            continue
        if actual != expected:
            stale.append(path)
    return stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="nur prüfen, nichts schreiben")
    args = parser.parse_args(argv)

    if args.check:
        stale = stale_files()
        for path in stale:
            print(f"veraltet: {path.relative_to(REPO_ROOT)}")
        return 1 if stale else 0

    for path, content in render().items():
        path.parent.mkdir(parents=True, exist_ok=True)
        # newline="\n": auch unter Windows LF schreiben (.gitattributes)
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"geschrieben: {path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
