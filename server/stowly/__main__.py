"""Startet den Server: ``python -m stowly [--dev] [--host H] [--port P]``.

Ohne Angaben gelten die Umgebungsvariablen ``STOWLY_*`` (siehe .env.example).
"""

import argparse
import dataclasses
import logging
import sys

import uvicorn

from stowly import __version__, db
from stowly.app import create_app, prepare_database
from stowly.config import DEV_PASSWORD, Settings


def configure_logging(level: str) -> None:
    """Meldungen des Servers (``stowly.*``) und des Druckdienstes (``stowly_print.*``) im Stil von
    uvicorn auf die Standardfehlerausgabe.

    uvicorn richtet nur seine eigenen Logger ein. Ohne das hier gingen Hinweise des
    Hintergrund-Ablaufs unter. Tokens und das Passwort werden nie protokolliert.
    """
    numeric = logging.DEBUG if level == "trace" else getattr(logging, level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    for name in ("stowly", "stowly_print"):
        logger = logging.getLogger(name)
        logger.handlers[:] = [handler]
        logger.setLevel(numeric)
        logger.propagate = False


def renew_dataset(settings: Settings) -> int:
    """``--new-dataset``: neue Kennung des Datenbestands, damit alle Geräte neu abziehen."""
    if not settings.database_path.is_file():
        print(f"Die Datenbank {settings.database_path} gibt es nicht.", file=sys.stderr)
        return 1
    prepare_database(settings)
    con = db.connect(settings.database_path)
    try:
        dataset_id = db.renew_dataset_id(con)
    finally:
        con.close()
    print(f"Neue Kennung des Datenbestands: {dataset_id}")
    print("Alle Geräte holen den Bestand beim nächsten Abgleich vollständig neu.")
    return 0


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
    parser.add_argument(
        "--new-dataset",
        action="store_true",
        help=(
            "Gibt dem Datenbestand eine neue Kennung und endet, ohne den Server zu starten. "
            "Nötig, nachdem eine Kopie der Datenbank zurückgespielt wurde, die nicht aus der "
            "Sicherung der App stammt: Erst dann holen alle Geräte den Bestand vollständig neu."
        ),
    )
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

    if args.new_dataset:
        return renew_dataset(settings)

    configure_logging(settings.log_level)
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
    # Beim Beenden höchstens 5 Sekunden auf laufende Anfragen warten: Eine Abfrage mit ?wait=30 am
    # Druckdienst hielte das Herunterfahren sonst auf, und Docker beendet nach 10 Sekunden hart.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        timeout_graceful_shutdown=5,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
