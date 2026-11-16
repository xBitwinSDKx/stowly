"""Das Paket für den Raspberry Pi (docs/sync-protokoll.md, 11.8).

Ein immer gleiches ``tar.gz`` mit der Wurzel ``stowly/``:

* ``pi/`` ohne Tests und Caches (Skripte, Dienst, Regeln, Anleitung),
* aus ``print/`` die Dateien ``pyproject.toml`` und ``requirements-brother.txt`` und ``stowly_print/``.

„Immer gleich" heißt: dieselben Dateien ergeben dieselben Bytes. Die Einträge stehen sortiert, gehören
uid und gid 0 ohne Namen, tragen eine feste Zeit und feste Rechte (Skripte 0755, sonst 0644), und
auch der gzip-Kopf hat keine Zeit. Schlüssel und Zertifikate (``*.key``, ``*.pem``, ``*.crt`` …) kommen
nie hinein, auch wenn jemand sie in ``pi/`` abgelegt hat: Das Paket ist ohne Anmeldung abrufbar.

Im Image entsteht das Paket in einer eigenen Bau-Stufe; ``STOWLY_PI_BUNDLE`` nennt die Datei::

    python pi_bundle.py <repository> <ziel.tar.gz>

Dafür braucht dieses Modul nur die Standardbibliothek und importiert nichts aus ``stowly``. Ein Server
im Quell-Checkout baut das Paket beim ersten Gebrauch im Speicher (``load``). Die SHA-256 wird einmal
berechnet; das Startskript (``install_script``, Vorlage ``pi_install.sh``) prüft das Paket damit.
"""

import gzip
import hashlib
import io
import logging
import re
import sys
import tarfile
import threading
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("stowly.pi")

ROOT = "stowly"
# Feste Zeit aller Einträge: 2026-01-01T00:00:00Z. Nach 1980, denn pip baut daraus ein Wheel (ZIP).
MTIME = 1767225600
# Ordner und Dateien, die nie ins Paket kommen.
SKIPPED_DIRS = frozenset({"tests", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "build"})
SKIPPED_SUFFIXES = frozenset({".pyc", ".pyo", ".key", ".pem", ".crt", ".csr", ".p12", ".pfx", ".sqlite3"})
SKIPPED_NAMES = frozenset({".env", ".DS_Store", "Thumbs.db"})
PRINT_FILES = ("pyproject.toml", "requirements-brother.txt")

# server/stowly/pi_bundle.py -> Wurzel des Repositorys (nur in einem Quell-Checkout sinnvoll)
# Als Skript in der Bau-Stufe des Images liegt die Datei flach (/build/pi_bundle.py): Dort gibt es diese
# Ebene nicht, und es gibt auch keinen Quell-Checkout. Dann zeigt _REPO_ROOT auf die Wurzel des
# Dateisystems, wo in_source_checkout nichts findet.
_PARENTS = Path(__file__).resolve().parents
_REPO_ROOT = _PARENTS[2] if len(_PARENTS) > 2 else _PARENTS[-1]
_TEMPLATE = Path(__file__).with_name("pi_install.sh")
# Die Adresse dieses Servers im Startskript: Schema, Name oder IP (IPv6 in Klammern), Port.
_SERVER = re.compile(r"https?://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def _skipped(path: Path) -> bool:
    return (
        path.name in SKIPPED_NAMES
        or path.name.startswith(".env.")
        or path.suffix.lower() in SKIPPED_SUFFIXES
        or path.name.endswith(".egg-info")
    )


def _walk(source: Path, prefix: str, entries: dict[str, Path | None]) -> None:
    """Nimmt ``source`` mit allem darunter auf; Ordner als ``None``, Dateien mit ihrem Pfad."""
    entries[prefix] = None
    for child in sorted(source.iterdir(), key=lambda item: item.name):
        name = f"{prefix}/{child.name}"
        if child.is_symlink():
            continue  # nie einem Link folgen, nie einen ins Paket legen
        if child.is_dir():
            if child.name not in SKIPPED_DIRS and not child.name.endswith(".egg-info"):
                _walk(child, name, entries)
        elif child.is_file() and not _skipped(child):
            entries[name] = child


def collect(repo: Path) -> dict[str, Path | None]:
    """Alle Einträge des Pakets: Name im Archiv -> Datei (``None`` = Ordner)."""
    pi, printing = repo / "pi", repo / "print"
    if not (pi / "install.sh").is_file() or not (printing / "stowly_print").is_dir():
        raise FileNotFoundError(f"{repo}: pi/install.sh oder print/stowly_print fehlt.")
    entries: dict[str, Path | None] = {ROOT: None}
    _walk(pi, f"{ROOT}/pi", entries)
    entries[f"{ROOT}/print"] = None
    for name in PRINT_FILES:
        entries[f"{ROOT}/print/{name}"] = printing / name
    _walk(printing / "stowly_print", f"{ROOT}/print/stowly_print", entries)
    return entries


def _info(name: str, *, directory: bool, size: int = 0) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.mtime = MTIME
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    if directory:
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
    else:
        info.size = size
        info.mode = 0o755 if name.endswith(".sh") else 0o644
    return info


def build(repo: Path) -> bytes:
    """Das Paket als Bytes; dieselben Dateien ergeben dieselben Bytes."""
    entries = collect(repo)
    buffer = io.BytesIO()
    # filename="" und mtime=0: Der gzip-Kopf nennt weder Datei noch Zeit.
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, compresslevel=9, mtime=0) as packed:
        with tarfile.open(fileobj=packed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(entries, key=lambda item: item.split("/")):
                source = entries[name]
                if source is None:
                    archive.addfile(_info(name, directory=True))
                else:
                    data = source.read_bytes()
                    archive.addfile(_info(name, directory=False, size=len(data)), io.BytesIO(data))
    return buffer.getvalue()


@dataclass(frozen=True)
class Bundle:
    """Das Paket samt seiner SHA-256 (hex)."""

    data: bytes
    sha256: str

    @classmethod
    def of(cls, data: bytes) -> "Bundle":
        return cls(data=data, sha256=hashlib.sha256(data).hexdigest())


_lock = threading.Lock()
_cache: dict[Path, Bundle] = {}


def in_source_checkout(repo: Path = _REPO_ROOT) -> bool:
    """Wahr, wenn neben ``server/`` auch ``pi/`` und ``print/`` liegen (nicht in site-packages)."""
    return (repo / "pi" / "install.sh").is_file() and (repo / "print" / "stowly_print").is_dir()


def load(configured: Path | None, *, repo: Path = _REPO_ROOT) -> Bundle | None:
    """Das Paket: die Datei aus ``STOWLY_PI_BUNDLE``, sonst im Quell-Checkout im Speicher gebaut.

    Einmal gelesen bzw. gebaut, bleibt es im Speicher. ``None``, wenn es keins gibt (der Server antwortet
    dann mit 503); warum, steht im Log.
    """
    key = configured if configured is not None else repo
    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached
        if configured is not None:
            try:
                bundle = Bundle.of(configured.read_bytes())
            except OSError as exc:
                log.warning("Pi: Das Paket %s lässt sich nicht lesen (%s).", configured, exc.strerror or exc)
                return None
            source = str(configured)
        elif in_source_checkout(repo):
            try:
                bundle = Bundle.of(build(repo))
            except OSError as exc:
                log.warning("Pi: Das Paket ließ sich nicht bauen (%s).", exc)
                return None
            source = f"gebaut aus {repo}"
        else:
            return None
        _cache[key] = bundle
    log.info("Pi: Paket %s (%d KB, SHA-256 %s…)", source, len(bundle.data) // 1024, bundle.sha256[:12])
    return bundle


def install_script(server: str, sha256: str) -> str:
    """Das Startskript für ``curl -fsSL …/api/pi/install.sh | sudo sh -s -- CODE``.

    ``server`` (``http://192.168.1.10:8010``) und ``sha256`` stehen danach im Skripttext; beide werden
    hier noch einmal streng geprüft, damit nichts anderes hineingerät.
    """
    if not _SERVER.fullmatch(server) or not _SHA256.fullmatch(sha256):
        raise ValueError("Server oder Prüfsumme taugen nicht für das Startskript.")
    template = _TEMPLATE.read_text(encoding="utf-8")
    return template.replace("@@SERVER@@", server).replace("@@SHA256@@", sha256)


def main(argv: list[str] | None = None) -> int:
    """``python pi_bundle.py <repository> <ziel.tar.gz>``: das Paket als Datei (Bau-Stufe im Dockerfile)."""
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 2:
        print("Aufruf: python pi_bundle.py <repository> <ziel.tar.gz>", file=sys.stderr)
        return 2
    repo, target = Path(arguments[0]), Path(arguments[1])
    try:
        data = build(repo)
    except OSError as exc:
        print(f"Das Paket ließ sich nicht bauen: {exc}", file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"{target}: {len(data)} Bytes, SHA-256 {hashlib.sha256(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
