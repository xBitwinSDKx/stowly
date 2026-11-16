"""Der eigenständige Druckdienst (Raspberry Pi).

    python -m stowly_print serve --config /etc/stowly-print/stowly-print.toml
    python -m stowly_print sample --out /tmp/etiketten
    python -m stowly_print pair --server http://192.168.1.10:8010 --code ABCD-EFGH
    python -m stowly_print selftest

``serve`` bedient HTTP und HTTPS im selben Prozess. Der Auftragsspeicher liegt im RAM: Jeder
Start ist ein neuer Lauf mit neuer ``boot_id`` (docs/etiketten.md, 5.4).

``sample`` rendert die mitgelieferten Vorlagen mit Beispieldaten als PNG, mit den Schriften
dieses Rechners. So lässt sich ansehen, wie die Etiketten hier aussehen, ohne zu drucken.

``pair`` koppelt den Pi mit Stowly, ``selftest`` prüft danach HTTP, HTTPS und druckt ein Testetikett
(``stowly_print.pairing``; beides ruft ``pi/install.sh --pair`` auf).
"""

import argparse
import logging
import signal
import ssl
import sys
import threading
from pathlib import Path

from stowly_print import __version__, pairing
from stowly_print.config import ConfigurationError, Listener, ServiceConfig, load_config

log = logging.getLogger("stowly_print")

SAMPLES = {
    "package": {
        "qr": "STOWLY/P/A2B3C",
        "id": "A2B3C",
        "title": "Basmati Reis",
        "subtitle": "1 kg · Kornhaus",
        "best_before": "25.03.2027",
        "stored": "13.11.2026",
        "zone": "",
    },
    "package-lang": {
        "qr": "STOWLY/P/QW7E8",
        "id": "QW7E8",
        "title": "Bio Vollkorn Haferflocken extra zart aus kontrolliert ökologischem Anbau",
        "subtitle": "1000 g · Mühlenhof Naturkost",
        "best_before": "01.12.2027",
        "stored": "13.11.2026",
        "zone": "Keller",
    },
    "zone": {
        "qr": "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B",
        "title": "Gefrierschrank",
        "subtitle": "Lagerzone",
    },
}


def configure_logging(level: str) -> None:
    # Ohne Zeitstempel: Der Pi hat keine Uhr, und das Journal schreibt seine eigene Zeit dazu.
    logging.basicConfig(
        level=level.upper(), format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr, force=True
    )


def build_service(config: ServiceConfig):
    """Der Auftragsdienst mit den Druckern der Konfiguration; der erste ist der Standarddrucker."""
    from stowly_print.drivers import build_driver
    from stowly_print.service import PrinterEntry, PrintService, StaticPrinters
    from stowly_print.store import MemoryStore

    entries = [
        PrinterEntry(
            name=printer.name, driver_name=printer.driver, model=printer.model, driver=build_driver(printer)
        )
        for printer in config.printers
    ]
    return PrintService(StaticPrinters(entries), MemoryStore())


def build_app(config: ServiceConfig, service):
    """Die HTTP-Schnittstelle des eigenständigen Dienstes: mit CORS, Seite ``/p`` und Zustand des Rechners."""
    from stowly_print.health import read_host_health
    from stowly_print.http import TokenAuthorizer, create_app

    return create_app(
        service,
        authorize=TokenAuthorizer(config.token),
        origins=config.origins,
        standalone=True,
        host_health=read_host_health,
    )


def _usable_tls(listener: Listener) -> bool:
    """Prüft Zertifikat und Schlüssel vorab, damit ein Fehler dort den HTTP-Zugang nicht mitreißt."""
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(listener.certificate), str(listener.key))
    except (OSError, ssl.SSLError) as exc:
        log.error(
            "HTTPS bleibt aus: Zertifikat %s oder Schlüssel %s ist nicht brauchbar (%s).",
            listener.certificate,
            listener.key,
            exc,
        )
        return False
    return True


def serve(config: ServiceConfig) -> int:
    import uvicorn

    listeners = [config.http] if config.http is not None else []
    if config.https is not None and _usable_tls(config.https):
        listeners.append(config.https)
    if not listeners:
        log.error("Kein Zugang lässt sich öffnen: Der Dienst startet nicht.")
        return 1

    service = build_service(config)
    service.start()
    app = build_app(config, service)

    servers: list[uvicorn.Server] = []
    for listener in listeners:
        options = {}
        if listener.tls:
            options = {"ssl_certfile": str(listener.certificate), "ssl_keyfile": str(listener.key)}
        servers.append(
            uvicorn.Server(
                uvicorn.Config(
                    app,
                    host=listener.host,
                    port=listener.port,
                    log_level=config.log_level,
                    log_config=None,
                    access_log=False,
                    server_header=False,
                    lifespan="off",
                    timeout_graceful_shutdown=5,
                    # Fest wie in den Tests: Debian zieht zu uvicorn auch uvloop (und womöglich
                    # httptools) nach, und „auto" nähme auf dem Pi dann eine ungeprüfte Schleife.
                    loop="asyncio",
                    http="h11",
                    **options,
                )
            )
        )

    stop = threading.Event()

    def run(server: "uvicorn.Server") -> None:
        try:
            server.run()
        except SystemExit:
            # uvicorn beendet sich so, wenn es den Port nicht bekommt.
            pass
        except Exception:
            log.exception("Ein Zugang des Druckdienstes ist ausgefallen.")
        finally:
            stop.set()

    def on_signal(_number: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    if hasattr(signal, "SIGBREAK"):  # Windows: Strg+Untbr
        signal.signal(signal.SIGBREAK, on_signal)

    # Kein Thread als Hintergrund-Thread: Beim Beenden sollen laufende Antworten noch hinausgehen.
    threads = [
        threading.Thread(target=run, args=(server,), name=f"stowly-print-http-{index}")
        for index, server in enumerate(servers)
    ]
    for thread in threads:
        thread.start()
    for listener in listeners:
        log.info(
            "Druckdienst %s hört auf %s://%s:%d",
            __version__,
            "https" if listener.tls else "http",
            listener.host,
            listener.port,
        )
    printers = ", ".join(f"{printer.name} ({printer.driver})" for printer in config.printers)
    log.info("Drucker: %s. Erlaubte Ursprünge: %s", printers, ", ".join(config.origins) or "keine")

    try:
        # In Abständen aufwachen: Unter Windows käme Strg+C sonst nicht durch.
        while not stop.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    failed = any(not server.started for server in servers)
    # Erst die Wartenden wecken, dann die Zugänge schließen: Sonst hielte ein ?wait=30 das Beenden auf.
    service.close(grace_s=2.0)
    for server in servers:
        server.should_exit = True
    for thread in threads:
        thread.join(timeout=15)
    if failed:
        log.error("Mindestens ein Zugang ließ sich nicht öffnen (Port belegt?).")
        return 1
    return 0


def sample(out: Path) -> int:
    from stowly_print import render
    from stowly_print.templates import load_builtin

    out.mkdir(parents=True, exist_ok=True)
    fonts = render.default_fonts()
    for name, source in fonts.describe().items():
        print(f"Schrift {name}: {source}")
    for name, data in SAMPLES.items():
        template = load_builtin(name.split("-")[0])
        image, report = render.render_with_report(template, data, fonts=fonts)
        path = out / f"{name}.png"
        image.save(path, format="PNG", optimize=True)
        print(f"{path}: {image.size[0]} × {image.size[1]} Pixel")
        for placed in report:
            if placed.type == "text" and placed.drawn:
                note = " (gekürzt)" if placed.truncated else ""
                print(f"    {placed.size_mm:g} mm: {' / '.join(placed.lines)}{note}")
    return 0


def _paths_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, default=pairing.CONFIG, help="Konfigurationsdatei")
    parser.add_argument(
        "--tls-dir", type=Path, default=pairing.TLS_DIR, help="Ordner für Schlüssel und Zertifikate"
    )


def pair(arguments: argparse.Namespace) -> int:
    """``pair``: mit Stowly koppeln (oder mit ``--start`` nur melden). Das Token erscheint nie."""
    try:
        if arguments.start:
            hostname = pairing.announce(arguments.server, arguments.code)
            print(f'    Stowly kennt den Code; der Pi „{hostname}" richtet sich jetzt ein.')
            return 0
        outcome = pairing.pair(
            arguments.server,
            arguments.code,
            origins=arguments.origin,
            model=arguments.model,
            address=arguments.address,
            paths=pairing.Paths(config=arguments.config, tls=arguments.tls_dir, state=arguments.state),
        )
    except pairing.PairingError as exc:
        print(f"Koppeln: {exc}", file=sys.stderr)
        return 1
    print(f'    Gekoppelt mit {outcome.server}: Drucker „{outcome.printer_name}" in Stowly.')
    if outcome.printer_found and outcome.model is not None:
        print(f"    Am USB erkannt: Brother {outcome.model}.")
    elif not outcome.printer_found:
        print("    Am USB hängt noch kein Brother-Drucker; er kann auch später kommen.")
    print(f"    Adressen für die App: {', '.join(outcome.urls)}")
    print(f"    Erlaubte Ursprünge: {', '.join(outcome.origins)}")
    print(f"    Zertifikat gültig bis {outcome.not_after[:10]}.")
    if outcome.token_new:
        print("    Neues Token für den Drucker; Stowly hat es schon eingetragen.")
    for note in outcome.notes:
        print(f"    Hinweis: {note}")
    return 0


def selftest(arguments: argparse.Namespace) -> int:
    """``selftest``: HTTP, HTTPS gegen ``ca.crt`` und ein Testetikett. 1, wenn HTTP oder HTTPS scheitert."""
    checks = pairing.selftest(arguments.config, tls=arguments.tls_dir, test_print=not arguments.no_test_print)
    for check in checks:
        print(f"    {check.name}: {'ok' if check.ok else 'FEHLER'}, {check.message}")
    return 0 if all(check.ok for check in checks) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m stowly_print", description="Stowly-Druckdienst")
    parser.add_argument("--version", action="version", version=f"stowly-print {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_parser = commands.add_parser("serve", help="Druckdienst starten (HTTP und HTTPS)")
    serve_parser.add_argument("--config", required=True, type=Path, help="Konfigurationsdatei (TOML)")
    sample_parser = commands.add_parser("sample", help="Beispiel-Etiketten als PNG rendern, ohne zu drucken")
    sample_parser.add_argument("--out", required=True, type=Path, help="Verzeichnis für die PNG-Dateien")
    pair_parser = commands.add_parser("pair", help="mit Stowly koppeln (Befehl aus der App, als root)")
    pair_parser.add_argument(
        "--server", required=True, help="Adresse von Stowly, etwa http://192.168.1.10:8010"
    )
    pair_parser.add_argument("--code", required=True, help="Kopplungscode aus der App (ABCD-EFGH)")
    pair_parser.add_argument(
        "--start",
        action="store_true",
        help="nur beim Server melden (der Pi richtet sich ein), nichts schreiben",
    )
    pair_parser.add_argument(
        "--origin", action="append", default=[], help="weiterer Ursprung der App (mehrfach möglich)"
    )
    pair_parser.add_argument("--model", help="Modell, wenn keins erkannt wird (etwa QL-800)")
    pair_parser.add_argument(
        "--address", help="Adresse des Druckers für eine neue Konfiguration (usb://04f9)"
    )
    _paths_arguments(pair_parser)
    pair_parser.add_argument("--state", type=Path, default=pairing.STATE, help="Stand der Kopplung (JSON)")
    selftest_parser = commands.add_parser("selftest", help="HTTP, HTTPS und ein Testetikett prüfen")
    _paths_arguments(selftest_parser)
    selftest_parser.add_argument("--no-test-print", action="store_true", help="kein Testetikett drucken")
    arguments = parser.parse_args(argv)

    if arguments.command == "sample":
        configure_logging("info")
        return sample(arguments.out)
    if arguments.command == "pair":
        return pair(arguments)
    if arguments.command == "selftest":
        return selftest(arguments)

    try:
        config = load_config(arguments.config)
    except ConfigurationError as exc:
        print(f"Konfiguration: {exc}", file=sys.stderr)
        return 2
    configure_logging(config.log_level)
    return serve(config)


if __name__ == "__main__":
    sys.exit(main())
