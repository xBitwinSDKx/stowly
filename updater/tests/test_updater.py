"""Tests für den Updater auf dem Rechner (updater/stowly-update.sh; docs/integrationen.md, 10.6).

Das Skript läuft unter ``sh`` mit nachgebildeten ``docker`` und ``docker-compose`` vorn im PATH.
Die Nachbildung merkt sich in einem Ordner, welche Version läuft, welche nicht "healthy" wird, was
geladen und was gelöscht wurde. Unter Windows braucht es das ``sh`` von Git for Windows; fehlt es,
werden die Tests übersprungen (in CI laufen sie unter Linux).
"""

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "stowly-update.sh"
SH = shutil.which("sh")
IMAGE = "ghcr.io/beispiel/stowly"
VOLUME = "stowly_stowly-data"

pytestmark = pytest.mark.skipif(SH is None, reason="kein sh gefunden")

FAKE_DOCKER = r"""#!/bin/sh
F="$FAKE_DIR"
echo "docker $*" >> "$F/calls"
compose() {
  case "$1" in
    version) exit 0 ;;
    stop) [ -f "$F/stop_fails" ] || echo stopped > "$F/running" ;;
    up)
      v=$(sed -n 's/^STOWLY_VERSION=//p' .env | tr -d '\r' | tail -n 1)
      echo "$v" > "$F/running"
      if [ "$v" != "$(cat "$F/initial")" ]; then
        echo "db-$v" > "$FAKE_DATA/stowly.sqlite3"
        echo "wal-$v" > "$FAKE_DATA/stowly.sqlite3-wal"
      fi ;;
  esac
  exit 0
}
case "$1" in
  compose)
    [ -n "${FAKE_COMPOSE_V2:-}" ] || exit 1
    shift; compose "$@" ;;
  volume)
    for last; do :; done
    [ "$last" = "$FAKE_VOLUME" ] || exit 1
    echo "$FAKE_DATA" ;;
  pull)
    tag=${2##*:}
    if grep -qx "$tag" "$F/pull_fail" 2>/dev/null; then echo "kein Netz" >&2; exit 1; fi
    echo "$tag" >> "$F/pulled" ;;
  inspect)
    running=$(cat "$F/running")
    case "$3" in
      *Config.Image*) [ "$running" = stopped ] || echo "$FAKE_IMAGE:$running" ;;
      *State.Running*) if [ "$running" = stopped ]; then echo false; else echo true; fi ;;
      *Health*)
        if [ "$running" = stopped ]; then echo exited
        elif grep -qx "$running" "$F/bad" 2>/dev/null; then echo unhealthy
        else echo healthy; fi ;;
    esac ;;
  logs) echo "Traceback: Version kaputt" ;;
  images) cat "$F/images" 2>/dev/null ;;
  rmi) echo "$2" >> "$F/removed" ;;
esac
exit 0
"""

FAKE_COMPOSE = r"""#!/bin/sh
F="$FAKE_DIR"
echo "docker-compose $*" >> "$F/calls"
case "$1" in
  stop) [ -f "$F/stop_fails" ] || echo stopped > "$F/running" ;;
  up)
    v=$(sed -n 's/^STOWLY_VERSION=//p' .env | tr -d '\r' | tail -n 1)
    echo "$v" > "$F/running"
    if [ "$v" != "$(cat "$F/initial")" ]; then
      echo "db-$v" > "$FAKE_DATA/stowly.sqlite3"
      echo "wal-$v" > "$FAKE_DATA/stowly.sqlite3-wal"
    fi ;;
esac
exit 0
"""

ENV = (
    "# Stowly\n"
    "STOWLY_PASSWORD=geheim\n"
    f"STOWLY_IMAGE={IMAGE}\n"
    "STOWLY_VERSION=0.2.0\n"
    "STOWLY_UPDATE_REPO=beispiel/stowly\n"
)


class Host:
    """Ein nachgebildeter Rechner: Projektordner mit .env, Datenvolume, docker und docker-compose."""

    def __init__(self, root: Path, env: str = ENV, running: str = "0.2.0") -> None:
        self.project = root / "projekt"
        self.data = root / "volume"
        self.fake = root / "fake"
        self.bin = root / "bin"
        for folder in (self.project, self.data / "update", self.fake, self.bin):
            folder.mkdir(parents=True)
        self.env_file = self.project / ".env"
        self.env_file.write_bytes(env.encode())
        self.db.write_text("db-alt\n")
        (self.fake / "running").write_text(running + "\n")
        (self.fake / "initial").write_text(running + "\n")
        (self.fake / "images").write_text("0.1.9\n0.2.0\n<none>\n")
        for name, text in (("docker", FAKE_DOCKER), ("docker-compose", FAKE_COMPOSE)):
            path = self.bin / name
            path.write_bytes(text.encode())
            path.chmod(0o755)

    @property
    def db(self) -> Path:
        return self.data / "stowly.sqlite3"

    @property
    def update(self) -> Path:
        return self.data / "update"

    def request(self, version: str) -> None:
        (self.update / "request").write_text(
            f"version={version}\nrequested_at=2026-11-16T10:00:00.000Z\ndevice=Handy\n"
        )

    def fake_file(self, name: str, *lines: str) -> None:
        (self.fake / name).write_text("".join(f"{line}\n" for line in lines))

    def lines(self, name: str) -> list[str]:
        path = self.fake / name
        return path.read_text().split() if path.exists() else []

    def run(self, **extra: str) -> subprocess.CompletedProcess:
        path = [str(self.bin)]
        if os.name == "nt":
            # Das GNU-Werkzeug (find, date …) von Git vor dem aus System32.
            path.append(str(Path(SH).parent))
        inherited = {name: value for name, value in os.environ.items() if name != "STOWLY_VOLUME"}
        env = {
            **inherited,
            "PATH": os.pathsep.join([*path, os.environ.get("PATH", "")]),
            "FAKE_DIR": str(self.fake),
            "FAKE_DATA": str(self.data),
            "FAKE_VOLUME": VOLUME,
            "FAKE_IMAGE": IMAGE,
            "STOWLY_PROJECT_DIR": str(self.project),
            "STOWLY_UPDATER_POLL_S": "0",
            "STOWLY_PULL_PAUSE_S": "0",
            "STOWLY_HEALTH_TRIES": "3",
            "STOWLY_PULL_TRIES": "2",
            **extra,
        }
        return subprocess.run(
            [SH, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60, check=False
        )

    def state(self) -> dict[str, str]:
        path = self.update / "state"
        if not path.exists():
            return {}
        return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines())

    def env_value(self, name: str) -> str:
        for line in self.env_file.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1]
        return ""


@pytest.fixture
def host(tmp_path) -> Host:
    return Host(tmp_path)


# --- Jeder Lauf ------------------------------------------------------------------------------


def test_without_a_request_it_only_reports_itself(host):
    result = host.run()
    assert result.returncode == 0, result.stderr
    seen = dict(line.split("=", 1) for line in (host.update / "updater").read_text().splitlines())
    assert seen["updater"] == "1" and seen["seen_at"].endswith("Z")
    assert not (host.update / "state").exists()
    assert host.lines("pulled") == []
    assert "docker-compose" not in (host.fake / "calls").read_text()


def test_an_unknown_volume_stops_it(host):
    result = host.run(STOWLY_VOLUME="anderes_volume")
    assert result.returncode == 1
    assert "anderes_volume" in result.stderr


def test_the_volume_name_can_come_from_the_env_file(tmp_path):
    host = Host(tmp_path, env=ENV + "STOWLY_VOLUME=stowly_stowly-data\n")
    assert host.run().returncode == 0
    assert (host.update / "updater").exists()


# --- Erfolg ----------------------------------------------------------------------------------


def test_an_update_switches_the_version_and_keeps_a_copy(host):
    host.request("0.2.1")
    host.fake_file("images", "0.1.9", "0.2.0", "latest", "<none>")
    inode = host.env_file.stat().st_ino
    result = host.run()
    assert result.returncode == 0, result.stdout + result.stderr

    state = host.state()
    assert state["state"] == "done"
    assert (state["version"], state["from"]) == ("0.2.1", "0.2.0")
    assert state["message"] == "Aktualisiert von 0.2.0 auf 0.2.1."
    assert not (host.update / "request").exists()
    assert not (host.update / "lock").exists()

    # Die .env: nur die Version neu, alles andere wie vorher, dieselbe Datei.
    assert host.env_value("STOWLY_VERSION") == "0.2.1"
    assert host.env_value("STOWLY_PASSWORD") == "geheim"
    assert host.env_file.read_text().replace("0.2.1", "0.2.0") == ENV
    if os.name == "posix":
        assert host.env_file.stat().st_ino == inode
    assert (host.project / ".env.bak").read_text() == ENV

    # Die Kopie vor dem Update und das neue Image.
    (copy,) = host.update.glob("before-0.2.0-*.sqlite3")
    assert copy.read_text() == "db-alt\n"
    assert host.lines("pulled") == ["0.2.1"]
    assert host.lines("running") == ["0.2.1"]
    # Aufgeräumt wird nur, was weder neu noch vorige Version ist; latest und <none> bleiben.
    assert host.lines("removed") == [f"{IMAGE}:0.1.9"]


def test_docker_compose_version_2_works_too(host):
    host.request("0.2.1")
    result = host.run(FAKE_COMPOSE_V2="1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert host.state()["state"] == "done"
    calls = (host.fake / "calls").read_text()
    assert "docker compose up -d stowly" in calls and "docker-compose" not in calls


def test_quoted_values_and_windows_line_endings_in_the_env_file(tmp_path):
    env = ENV.replace(f"STOWLY_IMAGE={IMAGE}", f'STOWLY_IMAGE="{IMAGE}"').replace("\n", "\r\n")
    host = Host(tmp_path, env=env)
    host.request("0.2.1")
    result = host.run()
    assert result.returncode == 0, result.stdout + result.stderr
    assert host.state()["state"] == "done"
    assert host.lines("pulled") == ["0.2.1"]


def test_only_the_three_newest_copies_stay(host):
    for index in range(4):
        old = host.update / f"before-0.1.{index}-2026010{index}T000000Z.sqlite3"
        old.write_text("alt")
        stamp = time.time() - 3600 * (10 - index)
        os.utime(old, (stamp, stamp))
    host.request("0.2.1")
    assert host.run().returncode == 0
    names = sorted(path.name for path in host.update.glob("before-*.sqlite3"))
    assert len(names) == 3
    assert any(name.startswith("before-0.2.0-") for name in names)
    assert "before-0.1.0-20260100T000000Z.sqlite3" not in names


def test_a_finished_run_that_was_cut_off_counts_as_done(tmp_path):
    host = Host(tmp_path, env=ENV.replace("0.2.0", "0.2.1"), running="0.2.1")
    host.request("0.2.1")
    assert host.run().returncode == 0
    assert host.state()["state"] == "done"
    assert host.lines("pulled") == []


# --- Gescheitert, die alte Version läuft weiter --------------------------------------------------


@pytest.mark.parametrize("version", ["1.2", "0.2.1;reboot", "", "v0.2.1"])
def test_an_invalid_version_is_refused(host, version):
    host.request(version)
    assert host.run().returncode == 1
    state = host.state()
    assert state["state"] == "failed"
    assert state["message"] == "Die Anforderung nennt keine gültige Version."
    assert not (host.update / "request").exists()
    assert host.lines("pulled") == []
    assert host.lines("running") == ["0.2.0"]


def test_without_image_in_the_env_file(tmp_path):
    host = Host(tmp_path, env=ENV.replace(f"STOWLY_IMAGE={IMAGE}\n", ""))
    host.request("0.2.1")
    assert host.run().returncode == 1
    assert "STOWLY_IMAGE und STOWLY_VERSION" in host.state()["message"]


def test_an_old_version_that_is_no_version(tmp_path):
    host = Host(tmp_path, env=ENV.replace("STOWLY_VERSION=0.2.0", "STOWLY_VERSION=local"))
    host.request("0.2.1")
    assert host.run().returncode == 1
    assert host.state()["message"] == "STOWLY_VERSION in der .env ist keine Version wie 1.2.3."


def test_a_failed_download_leaves_everything_as_it_was(host):
    host.request("0.2.1")
    host.fake_file("pull_fail", "0.2.1")
    assert host.run().returncode == 1
    state = host.state()
    assert state["state"] == "failed"
    assert "ließ sich nicht laden" in state["message"] and "weiter mit 0.2.0" in state["message"]
    assert (host.fake / "calls").read_text().count("docker pull") == 2  # STOWLY_PULL_TRIES
    assert host.lines("running") == ["0.2.0"]
    assert host.env_file.read_text() == ENV
    assert not (host.update / "request").exists()
    assert list(host.update.glob("before-*")) == []


def test_if_stowly_does_not_stop_nothing_is_copied(host):
    host.request("0.2.1")
    host.fake_file("stop_fails")
    assert host.run().returncode == 1
    assert host.state()["message"] == "Stowly ließ sich nicht anhalten. Es läuft weiter mit 0.2.0."
    assert list(host.update.glob("before-*")) == []
    assert host.env_file.read_text() == ENV


def test_a_version_that_does_not_start_is_rolled_back(host):
    host.request("0.2.1")
    host.fake_file("bad", "0.2.1")
    assert host.run().returncode == 1
    state = host.state()
    assert state["state"] == "failed"
    assert state["message"] == "Die neue Version startete nicht, zurück auf 0.2.0."
    # Die Datenbank von vorher, ohne die WAL-Datei des Fehlversuchs.
    assert host.db.read_text() == "db-alt\n"
    assert not Path(f"{host.db}-wal").exists()
    assert host.env_value("STOWLY_VERSION") == "0.2.0"
    assert host.lines("running") == ["0.2.0"]
    assert "Traceback: Version kaputt" in (host.update / "log").read_text(encoding="utf-8")
    assert host.lines("removed") == []
    assert not (host.update / "request").exists()


def test_if_the_old_version_does_not_start_either_it_says_so(host):
    host.request("0.2.1")
    host.fake_file("bad", "0.2.0", "0.2.1")
    assert host.run().returncode == 1
    assert "startet auch nicht mehr" in host.state()["message"]


# --- Sperre ----------------------------------------------------------------------------------


def test_a_running_update_blocks_a_second_run(host):
    host.request("0.2.1")
    (host.update / "lock").mkdir()
    assert host.run().returncode == 0
    assert (host.update / "request").exists()
    assert host.lines("pulled") == []


def test_a_stale_lock_is_taken_over(host):
    host.request("0.2.1")
    lock = host.update / "lock"
    lock.mkdir()
    stamp = time.time() - 2 * 3600
    os.utime(lock, (stamp, stamp))
    assert host.run().returncode == 0
    assert host.state()["state"] == "done"
    assert not lock.exists()
