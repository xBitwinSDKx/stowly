"""Paket und Startskript für den Raspberry Pi (stowly/pi_bundle.py, stowly/pi_install.sh; Protokoll 11.8).

Das Startskript läuft hier wirklich unter ``sh``, mit nachgebildeten ``id`` und ``curl`` vorn im PATH und
einem Paket, dessen ``pi/install.sh`` nur aufschreibt, wie es gerufen wurde. Ohne ``sh`` (Windows ohne
Git for Windows) werden diese Tests übersprungen.
"""

import ast
import gzip
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest
from conftest import REPO_ROOT

from stowly import pi_bundle

SH = shutil.which("sh")
SERVER = "http://192.168.1.10:8010"
needs_sh = pytest.mark.skipif(SH is None, reason="kein sh gefunden")


def members(data: bytes) -> dict[str, tarfile.TarInfo]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        return {member.name: member for member in archive.getmembers()}


def small_repo(root: Path, *, install: str = "#!/usr/bin/env bash\necho installiert\n") -> Path:
    """Ein Repository im Kleinen: pi/ mit install.sh, print/ mit dem Nötigsten."""
    (root / "pi").mkdir(parents=True)
    (root / "pi" / "install.sh").write_bytes(install.encode())
    (root / "pi" / "README.md").write_bytes(b"# Pi\n")
    package = root / "print" / "stowly_print"
    package.mkdir(parents=True)
    (package / "__init__.py").write_bytes(b'__version__ = "0.0.0"\n')
    (root / "print" / "pyproject.toml").write_bytes(b"[project]\nname = 'x'\n")
    (root / "print" / "requirements-brother.txt").write_bytes(b"# leer\n")
    return root


def test_the_module_loads_from_a_flat_path_like_in_the_image():
    """Im Image liegt das Skript unter /build/pi_bundle.py: Laden darf nicht an fehlenden Ebenen scheitern.

    So scheiterte der Bau von v0.3.0-rc.1 (``parents[2]`` gab einen ``IndexError``).
    """
    source = Path(pi_bundle.__file__).read_text(encoding="utf-8")
    flat = "/build/pi_bundle.py"
    namespace: dict = {"__file__": flat, "__name__": "pi_bundle_flach"}
    exec(compile(source, flat, "exec"), namespace)  # noqa: S102 - der eigene Quelltext unter anderem Pfad
    assert namespace["in_source_checkout"]() is False


# --- Das Paket -----------------------------------------------------------------------------------


def test_the_bundle_is_always_the_same_wherever_it_is_built(tmp_path):
    first = pi_bundle.build(REPO_ROOT)
    assert pi_bundle.build(REPO_ROOT) == first
    # Eine Kopie an anderer Stelle, mit anderen Zeiten: dieselben Bytes.
    copy = tmp_path / "kopie"
    shutil.copytree(REPO_ROOT / "pi", copy / "pi")
    shutil.copytree(REPO_ROOT / "print" / "stowly_print", copy / "print" / "stowly_print")
    for name in pi_bundle.PRINT_FILES:
        shutil.copy(REPO_ROOT / "print" / name, copy / "print" / name)
    for path in copy.rglob("*"):
        os.utime(path, (1_000_000_000, 1_000_000_000))
    assert pi_bundle.build(copy) == first


def test_the_bundle_holds_pi_and_the_print_service_under_one_root():
    data = pi_bundle.build(REPO_ROOT)
    entries = members(data)
    names = set(entries)
    assert all(name == "stowly" or name.startswith("stowly/") for name in names)
    for expected in (
        "stowly/pi/install.sh",
        "stowly/pi/README.md",
        "stowly/pi/stowly-print.service",
        "stowly/print/pyproject.toml",
        "stowly/print/requirements-brother.txt",
        "stowly/print/stowly_print/__init__.py",
        "stowly/print/stowly_print/pairing.py",
        "stowly/print/stowly_print/fonts/DejaVuSans.ttf",
        "stowly/print/stowly_print/templates/zone-62x29.json",
    ):
        assert expected in names, expected
    assert not any(part in ("tests", "__pycache__") for name in names for part in name.split("/"))
    assert not any(name.endswith((".pyc", ".egg-info")) for name in names)
    assert not any(name.startswith("stowly/print/tests") for name in names)
    for name, member in entries.items():
        assert (member.uid, member.gid, member.uname, member.gname) == (0, 0, "", "")
        assert member.mtime == pi_bundle.MTIME
        if member.isdir():
            assert member.mode == 0o755
        else:
            assert member.isfile()
            assert member.mode == (0o755 if name.endswith(".sh") else 0o644), name
    # Der gzip-Kopf: keine Zeit (Byte 4 bis 7) und kein Dateiname (Bit FNAME).
    assert data[:2] == b"\x1f\x8b"
    assert data[4:8] == b"\0\0\0\0"
    assert data[3] & 0x08 == 0


def test_the_files_in_the_bundle_are_the_files_of_the_repository():
    data = pi_bundle.build(REPO_ROOT)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        script = archive.extractfile("stowly/pi/install.sh")
        assert script is not None
        assert script.read() == (REPO_ROOT / "pi" / "install.sh").read_bytes()


def test_every_tracked_file_is_in_the_bundle():
    git = shutil.which("git")
    if git is None:
        pytest.skip("kein git")
    listed = subprocess.run(
        [git, "ls-files", "pi", "print/stowly_print", *(f"print/{name}" for name in pi_bundle.PRINT_FILES)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if listed.returncode != 0:
        pytest.skip("kein Git-Checkout")
    names = set(members(pi_bundle.build(REPO_ROOT)))
    tracked = [line for line in listed.stdout.splitlines() if "/tests/" not in f"/{line}"]
    assert tracked
    missing = [path for path in tracked if f"stowly/{path}" not in names]
    assert missing == []


def test_keys_caches_and_tests_never_get_in(tmp_path):
    repo = small_repo(tmp_path / "repo")
    for name in ("pi.key", "pi.crt", "stowly-ca.pem", ".env", "probe.csr"):
        (repo / "pi" / name).write_bytes(b"geheim")
    (repo / "pi" / "tests").mkdir()
    (repo / "pi" / "tests" / "test_x.py").write_bytes(b"")
    (repo / "print" / "stowly_print" / "__pycache__").mkdir()
    (repo / "print" / "stowly_print" / "__pycache__" / "x.cpython-312.pyc").write_bytes(b"")
    (repo / "print" / "stowly_print" / "alt.pyc").write_bytes(b"")
    (repo / "print" / "tests").mkdir()
    (repo / "print" / "tests" / "test_y.py").write_bytes(b"")
    names = set(members(pi_bundle.build(repo)))
    assert names == {
        "stowly",
        "stowly/pi",
        "stowly/pi/README.md",
        "stowly/pi/install.sh",
        "stowly/print",
        "stowly/print/pyproject.toml",
        "stowly/print/requirements-brother.txt",
        "stowly/print/stowly_print",
        "stowly/print/stowly_print/__init__.py",
    }


@pytest.mark.skipif(os.name == "nt", reason="Symlinks brauchen unter Windows Sonderrechte")
def test_a_symlink_never_gets_in(tmp_path):
    repo = small_repo(tmp_path / "repo")
    (tmp_path / "geheim.txt").write_bytes(b"geheim")
    os.symlink(tmp_path / "geheim.txt", repo / "pi" / "link.txt")
    assert "stowly/pi/link.txt" not in members(pi_bundle.build(repo))


def test_without_pi_or_print_there_is_nothing_to_build(tmp_path):
    with pytest.raises(FileNotFoundError):
        pi_bundle.build(tmp_path)


def test_the_module_needs_only_the_standard_library():
    """Die Bau-Stufe im Dockerfile ruft es ohne installiertes Stowly auf."""
    tree = ast.parse((Path(pi_bundle.__file__)).read_text(encoding="utf-8"))
    imported = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert imported <= set(sys.stdlib_module_names), imported - set(sys.stdlib_module_names)


def test_as_a_script_it_writes_the_bundle(tmp_path):
    repo = small_repo(tmp_path / "repo")
    target = tmp_path / "out" / "pi-bundle.tar.gz"
    result = subprocess.run(
        [sys.executable, "-I", str(Path(pi_bundle.__file__)), str(repo), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == pi_bundle.build(repo)
    assert hashlib.sha256(target.read_bytes()).hexdigest() in result.stdout
    wrong = subprocess.run(
        [sys.executable, "-I", str(Path(pi_bundle.__file__))], capture_output=True, text=True, check=False
    )
    assert wrong.returncode == 2


# --- Laden im Server -----------------------------------------------------------------------------


def test_the_configured_file_is_read_once_and_kept(tmp_path):
    path = tmp_path / "pi-bundle.tar.gz"
    path.write_bytes(b"paket-1")
    bundle = pi_bundle.load(path)
    assert bundle is not None
    assert (bundle.data, bundle.sha256) == (b"paket-1", hashlib.sha256(b"paket-1").hexdigest())
    path.write_bytes(b"paket-2")
    assert pi_bundle.load(path) is bundle


def test_a_missing_file_means_no_bundle(tmp_path):
    assert pi_bundle.load(tmp_path / "fehlt.tar.gz") is None


def test_a_source_checkout_builds_the_bundle_in_memory(tmp_path):
    repo = small_repo(tmp_path / "repo")
    bundle = pi_bundle.load(None, repo=repo)
    assert bundle is not None
    assert bundle.data == pi_bundle.build(repo)
    # Ohne pi/ und print/ (etwa installiert in site-packages) gibt es keins.
    assert pi_bundle.load(None, repo=tmp_path / "anderswo") is None


# --- Startskript ---------------------------------------------------------------------------------


def test_the_script_knows_the_server_and_the_checksum():
    sha = "a" * 64
    script = pi_bundle.install_script(SERVER, sha)
    assert f"server='{SERVER}'" in script
    assert f"sha256='{sha}'" in script
    assert "@@" not in script
    assert script.startswith("#!/bin/sh\n")
    assert script.rstrip().endswith('main "$@"')


@pytest.mark.parametrize(
    "server",
    ["192.168.1.10:8010", "ftp://192.168.1.10", "http://x'; rm -rf /", "http://a b", "http://[zz:1]x", ""],
)
def test_nothing_else_gets_into_the_script(server):
    with pytest.raises(ValueError):
        pi_bundle.install_script(server, "a" * 64)
    with pytest.raises(ValueError):
        pi_bundle.install_script(SERVER, "kein-hash")


@needs_sh
def test_the_script_is_valid_sh():
    script = pi_bundle.install_script(SERVER, "b" * 64)
    result = subprocess.run([SH, "-n"], input=script, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


FAKE_ID = '#!/bin/sh\nif [ "$1" = "-u" ]; then echo "${FAKE_UID:-0}"; else echo "uid=0(root)"; fi\n'
FAKE_CURL = r"""#!/bin/sh
# Nachgebildetes curl: kopiert das Paket aus $FAKE_BUNDLE dorthin, wo -o hinzeigt.
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$FAKE_RECORD.curl"
cp "$FAKE_BUNDLE" "$out"
"""
# Das install.sh im Paket schreibt nur auf, wie es gerufen wurde und was auf der Standardeingabe kommt.
RECORDING_INSTALL = """#!/usr/bin/env bash
{ printf 'args:'; printf ' %s' "$@"; printf '\\n'
  if read -r line; then echo "stdin: $line"; else echo "stdin: leer"; fi
} > "$FAKE_RECORD"
exit "${FAKE_STATUS:-0}"
"""


class StartScript:
    """Das Startskript mit einem Paket, nachgebildetem id und curl; gespeist wie bei ``curl … | sh -s``."""

    def __init__(self, root: Path, *, sha256: str | None = None) -> None:
        repo = small_repo(root / "repo", install=RECORDING_INSTALL)
        self.bundle = root / "paket.tar.gz"
        self.bundle.write_bytes(pi_bundle.build(repo))
        self.script = pi_bundle.install_script(
            SERVER, sha256 or hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        )
        self.bin = root / "bin"
        self.bin.mkdir()
        for name, text in (("id", FAKE_ID), ("curl", FAKE_CURL)):
            (self.bin / name).write_bytes(text.encode())
            (self.bin / name).chmod(0o755)
        self.record = root / "aufruf.txt"

    def run(self, *arguments: str, **env: str) -> subprocess.CompletedProcess:
        assert SH is not None
        path = [str(self.bin)]
        if os.name == "nt":
            path.append(str(Path(SH).parent))  # bash, tar, sha256sum und mktemp von Git
        environment = {
            **os.environ,
            "PATH": os.pathsep.join([*path, os.environ.get("PATH", "")]),
            "FAKE_BUNDLE": str(self.bundle),
            "FAKE_RECORD": str(self.record),
            **env,
        }
        return subprocess.run(
            [SH, "-s", "--", *arguments],
            input=self.script,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )


@needs_sh
def test_the_start_script_loads_checks_and_starts_the_installation(tmp_path):
    start = StartScript(tmp_path)
    result = start.run("ABCD-EFGH")
    assert result.returncode == 0, result.stdout + result.stderr
    lines = start.record.read_text().splitlines()
    assert lines == [f"args: --pair {SERVER} ABCD-EFGH", "stdin: leer"]
    assert (tmp_path / "aufruf.txt.curl").read_text().split() == [f"{SERVER}/api/pi/bundle.tar.gz"]


@needs_sh
def test_the_exit_code_of_the_installation_comes_through(tmp_path):
    start = StartScript(tmp_path)
    assert start.run("ABCD-EFGH", FAKE_STATUS="3").returncode == 3


@needs_sh
def test_a_bundle_with_another_checksum_is_not_started(tmp_path):
    start = StartScript(tmp_path, sha256="0" * 64)
    result = start.run("ABCD-EFGH")
    assert result.returncode == 1
    assert "Prüfsumme" in result.stderr
    assert not start.record.exists()


@needs_sh
def test_without_root_or_without_exactly_one_code_it_stops(tmp_path):
    start = StartScript(tmp_path)
    not_root = start.run("ABCD-EFGH", FAKE_UID="1000")
    assert not_root.returncode == 1 and "sudo" in not_root.stderr
    assert start.run().returncode == 1
    assert start.run("ABCD", "EFGH").returncode == 1
    assert not start.record.exists()


BASH = shutil.which("bash")


@pytest.mark.skipif(BASH is None, reason="kein bash gefunden")
@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        (["--pair", "http://192.168.1.10:8010"], "braucht Server und Code"),
        (["--pair", "192.168.1.10:8010", "ABCD-EFGH"], "erwartet die Adresse von Stowly"),
        (["--pair", "http://192.168.1.10:8010/pfad", "ABCD-EFGH"], "erwartet die Adresse von Stowly"),
        (["--pair", SERVER, "AB"], "kein Kopplungscode"),
        (["--pair", SERVER, "ABCD-EFGH;reboot"], "kein Kopplungscode"),
        (["--pair", SERVER, "ABCD-EFGH", "--cert", "pi.crt", "--key", "pi.key"], "passen nicht zu --pair"),
    ],
)
def test_install_sh_checks_the_pairing_arguments_before_anything_else(tmp_path, arguments, message):
    """Mit falschen Angaben bricht pi/install.sh ab, bevor es irgendetwas am System anfasst."""
    assert BASH is not None
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "id").write_bytes(FAKE_ID.encode())
    (fake / "id").chmod(0o755)
    environment = {**os.environ, "PATH": os.pathsep.join([str(fake), os.environ.get("PATH", "")])}
    result = subprocess.run(
        [BASH, str(REPO_ROOT / "pi" / "install.sh"), *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 1
    assert message in result.stderr
    assert "System prüfen" not in result.stdout


def test_the_gzip_layer_holds_a_plain_tar(tmp_path):
    data = pi_bundle.build(small_repo(tmp_path / "repo"))
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as unpacked:
        raw = unpacked.read()
    assert raw[257:262] == b"ustar"


def test_python_never_takes_modules_from_the_working_directory():
    """pi/install.sh ruft Python immer mit -P auf, das Startskript mit -I: Eine Datei wie json.py im
    Arbeitsordner (etwa im Home des Benutzers) ersetzt so kein Modul."""
    # Ein Aufruf: python3 oder das Python des venv am Anfang eines Befehls (Zeile, "$(" oder "|").
    invocation = re.compile(r'(?:^|\$\(|\|)\s*(?:python3|"\$PREFIX/venv/bin/python")\s+(\S+)')
    script = (REPO_ROOT / "pi" / "install.sh").read_text(encoding="utf-8")
    found = 0
    for number, line in enumerate(script.splitlines(), start=1):
        if line.lstrip().startswith("#"):
            continue
        for argument in invocation.findall(line):
            found += 1
            # "$(python3 --version)" zeigt nur die Version und führt nichts aus dem Arbeitsordner aus.
            assert argument.rstrip(")\"'") in ("-P", "--version"), (
                f"pi/install.sh, Zeile {number}: {line.strip()}"
            )
    assert found >= 10
    template = (Path(pi_bundle.__file__).with_name("pi_install.sh")).read_text(encoding="utf-8")
    assert "python3 -I -c" in template and "python3 -c" not in template
