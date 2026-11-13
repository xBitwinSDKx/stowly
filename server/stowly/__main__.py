"""Startet den Server: ``python -m stowly [--dev] [--host H] [--port P]``.

Ohne Angaben gelten die Umgebungsvariablen ``STOWLY_*`` (siehe .env.example).
"""

import argparse
import dataclasses
import sys

import uvicorn

from stowly import __version__
from stowly.app import create_app
from stowly.config import DEV_PASSWORD, Settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stowly", description="Stowly-Server")
    parser.add_argument(
        "--dev",
        action="store_true",
        help=f"Entwicklungsmodus: Passwort '{DEV_PASSWORD}', API-Dokumentation unter /api/docs",
    )
    parser.add_argument(
        "--host", help="Adresse, an die der Server bindet (Vorgabe: STOWLY_HOST oder 127.0.0.1)"
    )
    parser.add_argument("--port", type=int, help="Port (Vorgabe: STOWLY_PORT oder 8010)")
    parser.add_argument("--version", action="version", version=f"stowly {__version__}")
    args = parser.parse_args(argv)

    try:
        settings = Settings.from_env(dev=True if args.dev else None)
    except ValueError as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2
    if args.host:
        settings = dataclasses.replace(settings, host=args.host)
    if args.port:
        settings = dataclasses.replace(settings, port=args.port)

    if not settings.configured:
        print(
            "Hinweis: STOWLY_PASSWORD ist nicht gesetzt. Der Server startet, aber niemand kann sich anmelden.",
            file=sys.stderr,
        )
    if settings.web_dir is None or not (settings.web_dir / "index.html").is_file():
        print(
            "Hinweis: Die Web-App ist nicht gebaut; es antwortet nur die Schnittstelle unter /api.",
            file=sys.stderr,
        )

    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level)
    return 0


if __name__ == "__main__":
    sys.exit(main())
