"""Der Updater-Container (stowly/updater/; docs/integrationen.md, 10.3 bis 10.7).

Docker ersetzt ``FakeEngine`` (tests/docker_fake.py) im Speicher; so laufen die Tests auch unter Windows.
Der Datenordner ist ein temporärer Ordner mit Datenbank und ``update/``. Den echten Unix-Socket prüft nur
ein Test unter Linux; echte Symlinks gehen unter Windows ohne Sonderrechte nicht, dort wird der Link
nachgebildet.
"""

import http.client
import io
import json
import os
import socket
import socketserver
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from docker_fake import (
    DATA_SOURCE,
    NEW_IMAGE_ENV,
    REPOSITORY,
    UPDATER_ID,
    Crash,
    FakeEngine,
    dsm_container,
    image_config,
)

from stowly import __version__, db, updates
from stowly.config import Settings
from stowly.updater import clone, command, run
from stowly.updater.docker import (
    DockerError,
    Engine,
    PullFailed,
    Reply,
    UnixTransport,
    demux,
    pull_error,
    read_body,
)

NEW = "0.3.0"
OLD = "0.2.1"
DSM_ID = dsm_container()["Id"]


# --- Klonregeln ------------------------------------------------------------------------------------


def test_the_container_from_the_dsm_interface_becomes_a_clean_create_body():
    container = dsm_container()
    body, later = clone.create_body(container, image_config(OLD), f"{REPOSITORY}:{NEW}", (1, 41))
    assert later == []
    # Nichts klebt am alten Image: keine seiner Umgebungsvariablen, kein User=stowly, kein Befehl.
    assert body["Env"] == []
    assert not any(entry.startswith("PYTHON_VERSION=") for entry in body["Env"])
    for key in ("User", "WorkingDir", "StopSignal"):
        assert key not in body
    assert (body["Cmd"], body["Entrypoint"], body["Healthcheck"], body["Volumes"]) == (None, None, None, None)
    assert body["Labels"] == {}
    assert body["Image"] == f"{REPOSITORY}:{NEW}"
    # Was DSM eingestellt hat, bleibt.
    assert body["Hostname"] == "stowly"
    assert body["ExposedPorts"] == {"8010/tcp": {}}
    assert (body["Tty"], body["OpenStdin"], body["DDSM"]) == (True, True, False)
    host = body["HostConfig"]
    assert host["Binds"] == ["/volume1/docker/stowly:/data:rw"]
    assert host["PortBindings"] == {"8010/tcp": [{"HostIp": "", "HostPort": "8010"}]}
    assert host["RestartPolicy"] == {"Name": "always", "MaximumRetryCount": 0}
    assert host["LogConfig"] == {"Type": "db", "Config": {}}
    assert host["CpuShares"] == 50
    assert host == {**container["HostConfig"], "Binds": host["Binds"]}
    assert body["NetworkingConfig"] == {"EndpointsConfig": {"bridge": {}}}
    json.dumps(body)  # so geht es an Docker


def test_what_the_user_set_survives_the_clone():
    container = dsm_container()
    config = container["Config"]
    config["Env"] = [*config["Env"], "STOWLY_PUSH_CONTACT=mailto:betrieb@example.org"]
    config["Env"] = [entry if entry != "STOWLY_PORT=8010" else "STOWLY_PORT=9000" for entry in config["Env"]]
    config["Labels"] = {**config["Labels"], "eigenes": "ja", "org.opencontainers.image.title": "Anders"}
    config["ExposedPorts"] = {"8010/tcp": {}, "9999/tcp": {}}
    config["Healthcheck"] = {**config["Healthcheck"], "Interval": 60_000_000_000}
    config["User"] = "0:0"
    config["StopSignal"] = "SIGINT"
    config["Hostname"] = DSM_ID[:12]
    body, _later = clone.create_body(container, image_config(OLD), f"{REPOSITORY}:{NEW}", (1, 41))
    assert body["Env"] == ["STOWLY_PORT=9000", "STOWLY_PUSH_CONTACT=mailto:betrieb@example.org"]
    assert body["Labels"] == {"eigenes": "ja", "org.opencontainers.image.title": "Anders"}
    assert body["ExposedPorts"] == {"9999/tcp": {}, "8010/tcp": {}}
    assert body["Healthcheck"] == {"Interval": 60_000_000_000}
    assert (body["User"], body["StopSignal"]) == ("0:0", "SIGINT")
    assert "Hostname" not in body  # die alte Kurz-ID: Docker vergibt eine neue


def test_cmd_stays_when_the_entrypoint_was_changed():
    container = dsm_container()
    container["Config"]["Entrypoint"] = ["/bin/sh", "-c"]
    body, _later = clone.create_body(container, image_config(OLD), f"{REPOSITORY}:{NEW}", (1, 41))
    assert body["Entrypoint"] == ["/bin/sh", "-c"]
    assert body["Cmd"] == ["python", "-m", "stowly"]


def test_anonymous_volumes_come_along_and_links_are_rewritten():
    container = dsm_container()
    anonymous = "f" * 64
    container["HostConfig"]["Binds"] = None
    container["HostConfig"]["Links"] = ["/datenbank:/stowly/db", "/cache:/stowly/cache"]
    container["Mounts"] = [
        {
            "Type": "volume",
            "Name": anonymous,
            "Source": f"/var/lib/docker/volumes/{anonymous}/_data",
            "Destination": "/data",
            "RW": True,
        },
        {"Type": "volume", "Name": "nur-lesen", "Destination": "/vorlagen", "RW": False},
        {"Type": "bind", "Source": "/srv/x", "Destination": "/x", "RW": True},
    ]
    host = clone.host_config(container)
    assert host["Binds"] == [f"{anonymous}:/data", "nur-lesen:/vorlagen:ro"]
    assert host["Links"] == ["datenbank:db", "cache:cache"]
    # Schon als Bind eingetragen: nicht doppelt.
    container["HostConfig"]["Binds"] = [f"{anonymous}:/data"]
    assert clone.host_config(container)["Binds"] == [f"{anonymous}:/data", "nur-lesen:/vorlagen:ro"]


def custom_network_container() -> dict[str, Any]:
    container = dsm_container()
    container["HostConfig"]["NetworkMode"] = "stowly-netz"
    old = DSM_ID[:12]
    container["NetworkSettings"]["Networks"] = {
        "stowly-netz": {
            "IPAMConfig": {"IPv4Address": "172.30.0.10"},
            "Aliases": ["stowly", old],
            "Links": None,
            "DriverOpts": None,
            "NetworkID": "n1",
            "EndpointID": "e1",
            "IPAddress": "172.30.0.10",
            "MacAddress": "02:42:ac:1e:00:0a",
        },
        "ha-netz": {"Aliases": [old], "IPAMConfig": None, "NetworkID": "n2", "IPAddress": "172.31.0.5"},
    }
    return container


def test_up_to_api_1_44_one_network_at_create_the_rest_by_connect():
    at_create, later = clone.network_plan(custom_network_container(), (1, 41))
    assert at_create == {"stowly-netz": {"IPAMConfig": {"IPv4Address": "172.30.0.10"}, "Aliases": ["stowly"]}}
    assert later == [("ha-netz", {})]


def test_from_api_1_44_all_networks_at_create():
    at_create, later = clone.network_plan(custom_network_container(), (1, 44))
    assert set(at_create or {}) == {"stowly-netz", "ha-netz"} and later == []


@pytest.mark.parametrize("mode", ["host", "none", f"container:{'b' * 64}"])
def test_without_an_own_network_there_is_no_network_config(mode):
    container = dsm_container()
    container["HostConfig"]["NetworkMode"] = mode
    body, later = clone.create_body(container, image_config(OLD), f"{REPOSITORY}:{NEW}", (1, 41))
    assert "NetworkingConfig" not in body and later == []
    if mode.startswith("container:"):
        assert "Hostname" not in body


@pytest.mark.parametrize(
    ("image", "repository", "tag"),
    [
        ("ghcr.io/beispiel/stowly:0.2.1", "ghcr.io/beispiel/stowly", "0.2.1"),
        ("beispiel/stowly:latest", "beispiel/stowly", "latest"),
        ("registry.local:5000/beispiel/stowly:0.2.1", "registry.local:5000/beispiel/stowly", "0.2.1"),
        ("registry.local:5000/beispiel/stowly", "registry.local:5000/beispiel/stowly", None),
        ("ghcr.io/beispiel/stowly:0.2.1@sha256:" + "0" * 64, "ghcr.io/beispiel/stowly", "0.2.1"),
        ("sha256:" + "0" * 64, None, None),
        ("", None, None),
    ],
)
def test_repository_and_tag_of_an_image(image, repository, tag):
    assert clone.repository(image) == repository
    assert clone.tag(image) == tag


def test_familiar_names_match_the_repo_tags_of_docker():
    assert clone.familiar("docker.io/beispiel/stowly") == "beispiel/stowly"
    assert clone.familiar("docker.io/library/python") == "python"
    assert clone.familiar("ghcr.io/beispiel/stowly") == "ghcr.io/beispiel/stowly"


# --- Engine API ------------------------------------------------------------------------------------


class Recording:
    def __init__(self, *replies: Reply) -> None:
        self.replies = list(replies)
        self.paths: list[str] = []

    def __call__(self, method: str, path: str, body: bytes | None, timeout: float) -> Reply:
        self.paths.append(path)
        return self.replies.pop(0)


def version_reply(api: str, minimum: str = "1.12") -> Reply:
    return Reply(200, json.dumps({"ApiVersion": api, "MinAPIVersion": minimum}).encode())


@pytest.mark.parametrize(
    ("api", "minimum", "prefix"),
    [
        ("1.41", "1.12", "/v1.41/"),
        ("1.47", "1.24", "/v1.44/"),
        ("1.52", "1.46", "/v1.46/"),
        ("1.40", "1.12", "/v1.40/"),
    ],
)
def test_the_engine_negotiates_its_api_version(api, minimum, prefix):
    transport = Recording(version_reply(api, minimum), Reply(200, b"[]"))
    engine = Engine(transport)
    assert engine.containers() == []
    assert transport.paths[0] == "/version"
    assert transport.paths[1] == f"{prefix}containers/json?all=1"


def test_an_engine_older_than_1_40_is_refused():
    with pytest.raises(DockerError, match="zu alt"):
        Engine(Recording(version_reply("1.39"))).negotiate()


def test_a_pull_reads_the_stream_to_the_end():
    ok = b'{"status":"Pulling"}\r\n{"status":"Downloading","progressDetail":{}}\r\n{"status":"Done"}\r\n'
    assert pull_error(ok) is None
    assert pull_error(b'{"status":"a"}{"status":"b"}') is None
    late = (
        ok + b'{"errorDetail":{"message":"unauthorized"},"error":"unauthorized: authentication required"}\r\n'
    )
    assert pull_error(late) == "unauthorized: authentication required"
    assert pull_error(b'{"errorDetail":{"message":"nur im Detail"}}') == "nur im Detail"
    assert pull_error(b"<html>") is not None
    engine = Engine(Recording(version_reply("1.41"), Reply(200, late)))
    with pytest.raises(PullFailed, match="unauthorized"):
        engine.pull(REPOSITORY, NEW)
    engine = Engine(Recording(version_reply("1.41"), Reply(500, b'{"message":"no such host"}')))
    with pytest.raises(PullFailed, match="no such host"):
        engine.pull(REPOSITORY, NEW)


def test_log_frames_are_untangled():
    frames = b"\x01\0\0\0\0\0\0\x06Hallo\n" + b"\x02\0\0\0\0\0\0\x07Fehler\n"
    assert demux(frames) == b"Hallo\nFehler\n"
    assert demux(b"roh, mit TTY\n") == b"roh, mit TTY\n"
    assert demux(b"") == b""


class FakeSocket:
    """Genug von einem Socket für ``http.client.HTTPResponse``."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    def makefile(self, _mode: str, *args: Any, **kwargs: Any) -> io.BytesIO:
        return io.BytesIO(self.data)


def test_chunked_answers_are_read_completely():
    raw = (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"10\r\n" + b'{"status":"a"}\r\n' + b"\r\n" + b"7\r\n" + b'{"b":1}' + b"\r\n0\r\n\r\n"
    )
    response = http.client.HTTPResponse(FakeSocket(raw))  # type: ignore[arg-type]
    response.begin()
    assert read_body(response) == b'{"status":"a"}\r\n{"b":1}'
    too_big = http.client.HTTPResponse(FakeSocket(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n12345"))  # type: ignore[arg-type]
    too_big.begin()
    with pytest.raises(DockerError):
        read_body(too_big, limit=4)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="echter Unix-Socket nur unter Linux")
def test_the_real_unix_socket(tmp_path):
    path = str(tmp_path / "docker.sock")

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            request = self.rfile.readline()
            while self.rfile.readline() not in (b"\r\n", b""):
                pass
            assert request.startswith(b"GET /version HTTP/1.1")
            body = json.dumps({"ApiVersion": "1.41"}).encode()
            self.wfile.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
            self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n")

    server = socketserver.UnixStreamServer(path, Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert Engine(UnixTransport(path)).negotiate() == (1, 41)
    finally:
        server.shutdown()
        server.server_close()
    with pytest.raises(DockerError, match="antwortet nicht"):
        UnixTransport(str(tmp_path / "fehlt.sock"))("GET", "/version", None, 1.0)


# --- Befehl für den Updater ------------------------------------------------------------------------


MOUNTINFO = (
    "1580 1570 0:45 / / rw,relatime - btrfs /dev/md2 rw\n"
    f"1590 1580 0:45 /@docker/containers/{DSM_ID}/resolv.conf /etc/resolv.conf rw - btrfs /dev/md2 rw\n"
    f"1591 1580 0:45 /@docker/containers/{DSM_ID}/hostname /etc/hostname rw - btrfs /dev/md2 rw\n"
)


def test_the_own_container_id_comes_from_mountinfo(tmp_path):
    path = tmp_path / "mountinfo"
    path.write_text(MOUNTINFO)
    assert command.own_container_id(path) == DSM_ID
    path.write_text("1 0 0:1 / / rw - ext4 /dev/sda1 rw\n")
    assert command.own_container_id(path) is None
    assert command.own_container_id(tmp_path / "fehlt") is None


def test_the_command_for_the_updater_container(tmp_path):
    path = tmp_path / "mountinfo"
    path.write_text(MOUNTINFO)
    settings = Settings.from_env(
        {"STOWLY_DATA_DIR": str(tmp_path), "STOWLY_IMAGE_REF": "docker.io/beispiel/stowly"}
    )
    assert command.updater_command(settings, mountinfo=path) == (
        "/usr/local/bin/docker rm -f stowly-updater; /usr/local/bin/docker run -d --name stowly-updater "
        "--restart unless-stopped --user 0:0 --network none --read-only --tmpfs /tmp --no-healthcheck "
        "-v /var/run/docker.sock:/var/run/docker.sock "
        f"--volumes-from {DSM_ID} docker.io/beispiel/stowly:{__version__} python -m stowly.updater"
    )
    assert (
        command.updater_command(Settings.from_env({"STOWLY_DATA_DIR": str(tmp_path)}), mountinfo=path) is None
    )
    assert command.updater_command(settings, mountinfo=tmp_path / "fehlt") is None


def test_the_command_names_the_published_tag_of_a_prerelease(tmp_path):
    # Eine Vorabversion meldet sich als X.Y.Z, liegt aber unter :X.Y.Z-rc.N; ein Image :X.Y.Z gibt es
    # zu der Zeit noch nicht (so geschehen mit 0.3.0-rc.4 auf DSM).
    path = tmp_path / "mountinfo"
    path.write_text(MOUNTINFO)
    settings = Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path),
            "STOWLY_IMAGE_REF": "docker.io/beispiel/stowly",
            "STOWLY_IMAGE_TAG": f"{__version__}-rc.4",
        }
    )
    assert command.updater_command(settings, mountinfo=path).endswith(
        f" docker.io/beispiel/stowly:{__version__}-rc.4 python -m stowly.updater"
    )


@pytest.mark.parametrize("tag", ["0.3.1", "0.3.1-rc.1", "latest", "v1_2"])
def test_image_tags_as_docker_knows_them(tmp_path, tag):
    settings = Settings.from_env({"STOWLY_DATA_DIR": str(tmp_path), "STOWLY_IMAGE_TAG": f" {tag} "})
    assert settings.image_tag == tag
    assert Settings.from_env({"STOWLY_DATA_DIR": str(tmp_path), "STOWLY_IMAGE_TAG": ""}).image_tag is None


@pytest.mark.parametrize("tag", ["-rc.1", ".1", "0.3.1 rc", "0.3.1:x", "0.3.1/x", "a" * 129])
def test_other_image_tags_are_refused(tmp_path, tag):
    with pytest.raises(ValueError, match="STOWLY_IMAGE_TAG"):
        Settings.from_env({"STOWLY_DATA_DIR": str(tmp_path), "STOWLY_IMAGE_TAG": tag})


# --- Der Ablauf ------------------------------------------------------------------------------------


class FakeClock(run.Clock):
    """Eine Uhr, deren ``sleep`` nur vorstellt."""

    def __init__(self) -> None:
        self.value = datetime(2026, 11, 16, 10, 0, 0, tzinfo=UTC)
        self.slept: list[float] = []

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.value.timestamp()

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.value += timedelta(seconds=seconds)


class Host:
    """Ein NAS im Kleinen: Datenordner mit Datenbank und update/, Docker im Speicher, der Updater."""

    def __init__(self, root: Path) -> None:
        self.data = root / "data"
        (self.data / "update").mkdir(parents=True)
        (self.data / "stowly.sqlite3").write_bytes(b"db-alt")
        (self.data / "stowly.sqlite3-wal").write_bytes(b"wal-alt")
        self.engine = FakeEngine(self.data)
        self.engine.add_dsm_stowly()
        self.engine.add_updater()
        self.engine.add_image("0.1.9", image_config("0.1.9"))
        self.clock = FakeClock()
        self.updater = self.new_updater()

    def new_updater(self) -> run.Updater:
        return run.Updater(
            Engine(self.engine),
            data_dir=self.data,
            own_id=UPDATER_ID,
            image_ref="docker.io/beispiel/stowly",
            clock=self.clock,
        )

    @property
    def update(self) -> Path:
        return self.data / "update"

    def request(self, version: str = NEW) -> None:
        (self.update / "request").write_text(
            f"version={version}\nrequested_at=2026-11-16T09:59:00.000Z\ndevice=Handy\n"
        )

    def state(self) -> dict[str, str]:
        return updates.read_fields(self.update / "state") or {}

    def stowly(self) -> dict[str, Any] | None:
        return self.engine.by_name("stowly")


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def test_the_heartbeat_is_readable_by_the_server(host, tmp_path):
    host.updater.tick()
    fields = updates.read_fields(host.update / "updater")
    assert fields == {
        "seen_at": "2026-11-16T10:00:00Z",
        "updater": "2",
        "kind": "container",
        "version": __version__,
        "target": "stowly",
    }
    # So zeigt es der Server in UpdateStatus.
    settings = Settings.from_env({"STOWLY_DATA_DIR": str(host.data), "STOWLY_PASSWORD": "x"})
    db.initialise(settings.database_path.with_name("server.sqlite3"))
    con = db.connect(settings.database_path.with_name("server.sqlite3"))
    try:
        status = updates.status(settings, con, host.clock.now() + timedelta(seconds=30))
    finally:
        con.close()
    assert (status["updater_ready"], status["updater_kind"], status["updater_version"]) == (
        True,
        "container",
        __version__,
    )
    assert not (host.update / "state").exists()


def test_an_update_replaces_the_container_and_cleans_up(host):
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()

    state = host.state()
    assert (state["state"], state["version"], state["from"]) == ("done", NEW, OLD)
    assert state["message"] == f"Aktualisiert von {OLD} auf {NEW}."
    for name in ("request", "journal", "lock"):
        assert not (host.update / name).exists(), name
    # Der neue Container heißt wie der alte, läuft mit dem neuen Image; den alten gibt es nicht mehr.
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] != DSM_ID
    assert stowly["Config"]["Image"] == f"{REPOSITORY}:{NEW}"
    assert stowly["State"]["Health"]["Status"] == "healthy"
    assert host.engine.find(DSM_ID) is None
    assert host.engine.by_name("stowly-vorher") is None
    ((name, body),) = host.engine.created
    assert name == "stowly" and body["Env"] == [] and "User" not in body
    assert body["HostConfig"]["RestartPolicy"]["Name"] == "always"
    # Laden aus derselben Herkunft wie der alte Container (Config.Image), nicht aus STOWLY_IMAGE_REF.
    assert (
        "POST",
        "/v1.41/images/create?fromImage=ghcr.io%2Fbeispiel%2Fstowly&tag=0.3.0",
    ) in host.engine.calls
    # Kopie der Datenbank vor dem Update, samt -wal.
    (copy,) = host.update.glob(f"before-{OLD}-*.sqlite3")
    assert copy.read_bytes() == b"db-alt"
    assert Path(f"{copy}-wal").read_bytes() == b"wal-alt"
    # Aufgeräumt: alte Versionen weg, die neue und die vorige bleiben.
    assert host.engine.removed_images == [f"{REPOSITORY}:0.1.9"]
    log = (host.update / "log").read_text(encoding="utf-8")
    assert "Anforderung: Version '0.3.0'" in log and "Aktualisiert" in log


def test_a_failed_pull_leaves_everything_as_it_was(host):
    host.engine.offer(NEW)
    host.engine.pull_failures = ["http", "http", "http"]
    host.request()
    host.updater.tick()
    state = host.state()
    assert state["state"] == "failed"
    assert (
        state["message"]
        == f"Das Image {REPOSITORY}:{NEW} ließ sich nicht laden. Stowly läuft weiter mit {OLD}."
    )
    assert sum(1 for method, path in host.engine.calls if "images/create" in path) == 3
    assert host.clock.slept.count(run.PULL_PAUSE_S) == 2
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Running"]
    assert host.engine.created == [] and list(host.update.glob("before-*")) == []
    assert not (host.update / "request").exists()


def test_an_error_in_the_pull_stream_counts_as_failure(host):
    host.engine.offer(NEW)
    host.engine.pull_failures = ["stream", "stream", "stream"]
    host.request()
    host.updater.tick()
    assert host.state()["state"] == "failed"
    assert "manifest unknown" in (host.update / "log").read_text(encoding="utf-8")
    assert host.engine.created == []


def test_a_second_try_of_the_pull_may_work(host):
    host.engine.offer(NEW)
    host.engine.pull_failures = ["stream"]
    host.request()
    host.updater.tick()
    assert host.state()["state"] == "done"


def write_new_data(host: Host) -> None:
    """Was die neue Version beim Start mit der Datenbank tut (sie migriert)."""

    def on_start(version: str) -> None:
        if version == NEW:
            (host.data / "stowly.sqlite3").write_bytes(b"db-neu")
            (host.data / "stowly.sqlite3-wal").write_bytes(b"wal-neu")
            (host.data / "stowly.sqlite3-shm").write_bytes(b"shm-neu")

    host.engine.on_start = on_start


@pytest.mark.parametrize("outcome", ["unhealthy", "exit"])
def test_a_new_version_that_does_not_start_is_rolled_back(host, outcome):
    host.engine.offer(NEW, health=outcome)
    write_new_data(host)
    host.request()
    host.updater.tick()
    state = host.state()
    assert state["state"] == "failed"
    assert state["message"] == f"Die neue Version startete nicht, zurück auf {OLD}."
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Health"]["Status"] == "healthy"
    assert len(host.engine.containers) == 2  # Stowly und der Updater; der neue ist gelöscht
    # Die Datenbank von vorher, ohne -wal und -shm des Fehlversuchs.
    assert (host.data / "stowly.sqlite3").read_bytes() == b"db-alt"
    assert (host.data / "stowly.sqlite3-wal").read_bytes() == b"wal-alt"
    assert not (host.data / "stowly.sqlite3-shm").exists()
    assert "Traceback: Version kaputt" in (host.update / "log").read_text(encoding="utf-8")
    assert host.engine.removed_images == []


def test_if_the_old_version_does_not_start_either_it_says_so(host):
    host.engine.offer(NEW, health="unhealthy")
    host.engine.health[OLD] = "unhealthy"
    host.request()
    host.updater.tick()
    assert "startet auch nicht mehr" in host.state()["message"]


def test_a_slow_start_is_awaited(host):
    host.engine.offer(NEW, health="slow")
    host.request()
    host.updater.tick()
    assert host.state()["state"] == "done"
    assert run.HEALTH_POLL_S in host.clock.slept


def test_if_stowly_does_not_stop_nothing_happens(host):
    host.engine.offer(NEW)
    host.engine.stop_fails = True
    host.request()
    host.updater.tick()
    assert host.state()["message"] == f"Stowly ließ sich nicht anhalten. Es läuft weiter mit {OLD}."
    assert host.engine.created == [] and list(host.update.glob("before-*")) == []
    assert not (host.update / "journal").exists()


def test_compose_containers_are_refused(host):
    host.engine.containers[DSM_ID]["Config"]["Labels"]["com.docker.compose.project"] = "stowly"
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    assert host.state()["message"] == run.COMPOSE_REFUSED
    assert not any("images/create" in path for _method, path in host.engine.calls)


def test_an_invalid_version_is_refused(host):
    host.request("0.3.0;reboot")
    host.updater.tick()
    assert host.state()["message"] == "Die Anforderung nennt keine gültige Version."
    assert host.engine.created == []


def test_the_same_version_again_is_done_when_it_runs(host):
    host.request(OLD)
    host.updater.tick()
    assert (host.state()["state"], host.state()["message"]) == ("done", f"Stowly läuft mit {OLD}.")


def test_without_a_target_the_heartbeat_says_so_and_a_request_fails(host):
    host.engine.containers[DSM_ID]["Mounts"][0]["Source"] = "/volume1/docker/anderer-ordner"
    host.request()
    host.updater.tick()
    assert updates.read_fields(host.update / "updater")["target"] == ""
    assert host.state()["message"] == run.NO_TARGET


def test_a_left_over_previous_container_is_removed_first(host):
    leftover = json.loads(json.dumps(host.engine.containers[DSM_ID]))
    leftover.update(Id="d" * 64, Name="/stowly-vorher")
    leftover["State"] = {"Status": "exited", "Running": False}
    host.engine.containers[leftover["Id"]] = leftover
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    assert host.state()["state"] == "done"
    assert host.engine.find("d" * 64) is None


def test_only_the_three_newest_copies_stay(host):
    for index in range(4):
        old = host.update / f"before-0.1.{index}-2026010{index}T000000Z.sqlite3"
        old.write_bytes(b"alt")
        stamp = time.time() - 3600 * (10 - index)
        os.utime(old, (stamp, stamp))
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    names = sorted(path.name for path in host.update.glob("before-*.sqlite3"))
    assert len(names) == 3 and any(name.startswith(f"before-{OLD}-") for name in names)


# --- Sperre ----------------------------------------------------------------------------------------


def test_a_running_host_updater_blocks_the_container_updater(host):
    (host.update / "lock").mkdir()
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    assert (host.update / "request").exists() and not (host.update / "state").exists()
    assert (host.update / "updater").exists()  # der Herzschlag kommt trotzdem


def test_a_stale_lock_is_taken_over(host):
    lock = host.update / "lock"
    lock.mkdir()
    stamp = time.time() - 2 * 3600
    os.utime(lock, (stamp, stamp))
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    assert host.state()["state"] == "done" and not lock.exists()


# --- Wiederanlauf ----------------------------------------------------------------------------------


def crash_during(host: Host, method: str, route: str) -> None:
    host.engine.crash_after = (method, route)
    with pytest.raises(Crash):
        host.updater.tick()
    assert (host.update / "journal").exists()


def test_a_crash_after_the_start_of_a_healthy_version_ends_in_done(host):
    host.engine.offer(NEW)
    host.request()
    crash_during(host, "POST", r"/containers/[0-9a-f]+/start")
    assert host.engine.by_name("stowly-vorher") is not None
    host.new_updater().tick()
    state = host.state()
    assert (state["state"], state["message"]) == ("done", f"Aktualisiert von {OLD} auf {NEW}.")
    assert host.engine.by_name("stowly-vorher") is None and host.engine.find(DSM_ID) is None
    assert not (host.update / "journal").exists() and not (host.update / "request").exists()
    assert "Wiederanlauf" in (host.update / "log").read_text(encoding="utf-8")


def test_a_crash_after_renaming_goes_back_to_the_old_container(host):
    host.engine.offer(NEW)
    host.request()
    crash_during(host, "POST", r"/containers/[0-9a-f]+/rename")
    host.new_updater().tick()
    state = host.state()
    assert state["state"] == "failed"
    assert state["message"] == f"Das Update auf {NEW} brach ab, zurück auf {OLD}."
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Running"]
    assert host.engine.created == []
    assert (host.data / "stowly.sqlite3").read_bytes() == b"db-alt"


def test_a_crash_after_creating_removes_the_new_container(host):
    host.engine.offer(NEW)
    host.request()
    crash_during(host, "POST", r"/containers/create")
    host.new_updater().tick()
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Running"]
    assert len(host.engine.containers) == 2
    assert "brach ab" in host.state()["message"]


def test_a_crash_while_stopping_restarts_the_old_container(host):
    host.engine.offer(NEW)
    host.request()
    crash_during(host, "POST", r"/containers/[0-9a-f]+/stop")
    assert host.engine.containers[DSM_ID]["State"]["Running"] is False
    host.new_updater().tick()
    assert host.engine.containers[DSM_ID]["State"]["Running"] is True
    assert host.state()["message"] == f"Das Update auf {NEW} brach ab; Stowly läuft weiter mit {OLD}."


def test_a_crash_after_starting_an_unhealthy_version_restores_the_database(host):
    host.engine.offer(NEW, health="unhealthy")
    write_new_data(host)
    host.request()
    crash_during(host, "POST", r"/containers/[0-9a-f]+/start")
    assert (host.data / "stowly.sqlite3").read_bytes() == b"db-neu"
    host.new_updater().tick()
    assert (host.data / "stowly.sqlite3").read_bytes() == b"db-alt"
    assert not (host.data / "stowly.sqlite3-shm").exists()
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID


def test_another_updater_does_not_take_over_a_fresh_lock_of_a_crashed_run(host):
    host.engine.offer(NEW)
    host.request()
    crash_during(host, "POST", r"/containers/[0-9a-f]+/rename")
    (host.update / "lock").mkdir()  # wie hinterlassen
    other = run.Updater(Engine(host.engine), data_dir=host.data, own_id="e" * 64, clock=host.clock)
    other.tick()
    assert (host.update / "journal").exists()  # nicht seins: Er wartet, bis die Sperre alt ist
    host.new_updater().tick()  # der eigene Updater nach seinem Neustart
    assert not (host.update / "journal").exists()


# --- Symlinks --------------------------------------------------------------------------------------


def can_symlink(tmp_path: Path) -> bool:
    try:
        os.symlink(tmp_path / "ziel", tmp_path / "probe-link")
    except (OSError, NotImplementedError):
        return False
    os.unlink(tmp_path / "probe-link")
    return True


@pytest.fixture
def links(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Legt echte Symlinks an, wo das geht; sonst (Windows) sieht ``SafeFolder`` den Namen als Link."""
    real = can_symlink(tmp_path)
    fake: set[Path] = set()
    if not real:
        original_kind = run.SafeFolder.kind
        original_open = run.SafeFolder.open_read

        def kind(self: run.SafeFolder, name: str) -> str:
            return "link" if self.path / name in fake else original_kind(self, name)

        def open_read(self: run.SafeFolder, name: str) -> int:
            if self.path / name in fake:
                raise run.LinkFound(name)
            return original_open(self, name)

        monkeypatch.setattr(run.SafeFolder, "kind", kind)
        monkeypatch.setattr(run.SafeFolder, "open_read", open_read)

    def make(path: Path, target: Path) -> None:
        if real:
            path.unlink(missing_ok=True)
            os.symlink(target, path)
        else:
            path.write_bytes(b"als Link nachgebildet")
            fake.add(path)

    return make


@pytest.mark.parametrize("name", ["request", "state", "log", "journal"])
def test_a_symlink_in_update_is_refused_without_following_it(host, links, tmp_path, name):
    secret = tmp_path / "fremd.txt"
    secret.write_bytes(b"gehoert root")
    host.engine.offer(NEW)
    host.request()
    links(host.update / name, secret)
    host.updater.tick()
    state = host.state()
    assert state["state"] == "failed" and "Symlink" in state["message"] and f"({name})" in state["message"]
    assert secret.read_bytes() == b"gehoert root"
    assert host.engine.created == [] and not any("images/create" in p for _m, p in host.engine.calls)
    assert host.stowly()["Id"] == DSM_ID  # type: ignore[index]


@pytest.mark.parametrize("name", ["stowly.sqlite3", "stowly.sqlite3-wal"])
def test_a_symlinked_database_is_not_copied(host, links, tmp_path, name):
    secret = tmp_path / "geheim.txt"
    secret.write_bytes(b"nicht kopieren")
    links(host.data / name, secret)
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    state = host.state()
    assert state["message"] == f"Die Datenbank ließ sich nicht sichern. Stowly läuft weiter mit {OLD}."
    assert not any(path.read_bytes() == b"nicht kopieren" for path in host.update.glob("before-*"))
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Running"]
    assert not (host.update / "journal").exists()


@pytest.mark.skipif(os.name == "nt", reason="Symlinks brauchen unter Windows Sonderrechte")
def test_an_update_folder_that_is_a_symlink_is_left_alone(host, tmp_path):
    elsewhere = tmp_path / "anderswo"
    elsewhere.mkdir()
    (host.update / "request").unlink(missing_ok=True)
    os.rmdir(host.update)
    os.symlink(elsewhere, host.update)
    host.updater.tick()
    assert list(elsewhere.iterdir()) == []


@pytest.mark.skipif(os.name == "nt", reason="Symlinks brauchen unter Windows Sonderrechte")
def test_writing_replaces_a_symlink_instead_of_following_it(tmp_path):
    folder = tmp_path / "update"
    folder.mkdir()
    target = tmp_path / "ziel.txt"
    target.write_bytes(b"bleibt")
    os.symlink(target, folder / "state")
    with run.SafeFolder(folder) as safe:
        safe.write("state", b"state=failed\n")
        assert safe.kind("state") == "file"
    assert target.read_bytes() == b"bleibt"
    assert (folder / "state").read_bytes() == b"state=failed\n"


def test_an_unexpected_error_ends_the_request_instead_of_repeating_it(host, monkeypatch):
    host.engine.offer(NEW)
    host.request()

    def broken(*_args: Any) -> None:
        raise KeyError("kaputt")

    monkeypatch.setattr(run.Run, "backup_name", broken)
    host.updater.tick()
    assert host.state()["state"] == "failed" and "Unerwarteter Fehler" in host.state()["message"]
    assert not (host.update / "request").exists() and not (host.update / "lock").exists()


def test_a_directory_instead_of_the_request_is_refused_too(host):
    (host.update / "request").mkdir()
    host.updater.tick()
    assert host.state()["state"] == "failed" and "(request)" in host.state()["message"]
    assert not (host.update / "request").exists()
    host.updater.tick()  # danach ist Ruhe


def test_safe_folder_basics(tmp_path):
    folder = tmp_path / "ordner"
    folder.mkdir()
    with run.SafeFolder(folder) as safe:
        assert safe.read("fehlt") is None
        safe.write("a", b"eins")
        assert safe.read("a") == b"eins" and safe.kind("a") == "file"
        assert safe.mkdir("lock") and not safe.mkdir("lock") and safe.kind("lock") == "dir"
        with pytest.raises(run.LinkFound):
            safe.read("lock")
        safe.rmdir("lock")
        log = safe.new_log("log")
        log.write(b"zeile\n")
        log.close()
        assert (folder / "log").read_bytes() == b"zeile\n"
        safe.unlink("a")
        safe.unlink("a")
        assert sorted(safe.names()) == ["log"]
        with pytest.raises(ValueError):
            safe.read("../draussen")
    with pytest.raises(FileNotFoundError):
        run.SafeFolder(tmp_path / "fehlt")
    (tmp_path / "datei").write_bytes(b"")
    with pytest.raises(run.LinkFound):
        run.SafeFolder(tmp_path / "datei")


def test_main_starts_the_loop(monkeypatch, tmp_path):
    started: list[run.Updater] = []
    monkeypatch.setattr(run.Updater, "run_forever", lambda self: started.append(self))
    monkeypatch.setattr(run, "own_container_id", lambda: UPDATER_ID)
    monkeypatch.setenv("STOWLY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("STOWLY_IMAGE_REF", "docker.io/beispiel/stowly")
    monkeypatch.setattr(run.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(run.logging, "basicConfig", lambda **_options: None)  # die Tests behalten ihr Logging
    assert run.main() == 0
    (updater,) = started
    assert (updater.own_id, updater.data_dir, updater.image_ref) == (
        UPDATER_ID,
        tmp_path,
        "docker.io/beispiel/stowly",
    )


def test_the_data_source_of_inspect_and_list():
    assert run.data_source(dsm_container()) == ("bind", DATA_SOURCE)
    assert run.data_source(
        {"Mounts": [{"Type": "volume", "Name": "stowly-data", "Destination": "/data"}]}
    ) == (
        "volume",
        "stowly-data",
    )
    assert run.data_source({"Mounts": []}) is None


def test_the_running_version_comes_from_the_tag_or_the_label():
    container = dsm_container()
    assert run.running_version(container, None) == OLD
    container["Config"]["Image"] = "beispiel/stowly:latest"
    assert (
        run.running_version(container, {"Config": {"Labels": {"org.opencontainers.image.version": "0.2.0"}}})
        == "0.2.0"
    )
    assert run.running_version(container, None) == OLD  # aus dem Label des Containers
    container["Config"]["Labels"] = {}
    assert run.running_version(container, None) is None


def test_the_new_image_brings_its_own_environment():
    """Docker ergänzt beim Anlegen, was fehlt, aus dem neuen Image: deshalb bleibt Env leer."""
    assert set(NEW_IMAGE_ENV) <= set(image_config(NEW, extra_env=NEW_IMAGE_ENV)["Env"])


def test_a_socket_family_is_needed_for_the_real_transport(monkeypatch):
    monkeypatch.delattr(socket, "AF_UNIX", raising=False)
    with pytest.raises(DockerError):
        UnixTransport("/var/run/docker.sock")("GET", "/version", None, 1.0)


# --- Das Journal kann auch der Server schreiben (Prüfung der Sicherheit, Runde 2) --------------------

HA_ID = "b" * 64
TOOL_ID = "d" * 64
HA_REPOSITORY = "ghcr.io/home-assistant/home-assistant"


def add_foreign_containers(host: Host) -> None:
    """Zwei fremde Container auf dem NAS: Home Assistant (läuft, mit Geheimnis im Log) und ein angehaltenes
    Werkzeug mit Rechten; beide mit eigenen Ordnern, nicht mit dem von Stowly."""
    stowly = host.engine.containers[DSM_ID]
    ha = json.loads(json.dumps(stowly))
    ha.update(Id=HA_ID, Name="/homeassistant")
    ha["Config"] = dict(ha["Config"], Image=f"{HA_REPOSITORY}:2026.11.0", Tty=True)
    ha["Mounts"] = [{"Type": "bind", "Source": "/volume1/docker/ha", "Destination": "/config", "RW": True}]
    ha["State"] = {
        "Status": "running",
        "Running": True,
        "StartedAt": "2026-11-01T00:00:00Z",
        "Health": {"Status": "healthy"},
    }
    host.engine.containers[HA_ID] = ha
    tool = json.loads(json.dumps(ha))
    tool.update(Id=TOOL_ID, Name="/werkzeug")
    tool["Config"] = dict(tool["Config"], Image="alpine:3.20")
    tool["HostConfig"] = {"Privileged": True, "Binds": ["/:/host"]}
    tool["State"] = {"Status": "exited", "Running": False, "StartedAt": "2026-10-01T00:00:00Z"}
    host.engine.containers[TOOL_ID] = tool
    host.engine.logs = b"INFO token=geheim-ha-token-123\n"
    host.engine.add_image("2026.10.0", image_config("x"), "sha256:" + "e" * 64)
    host.engine.images["sha256:" + "e" * 64]["RepoTags"] = [f"{HA_REPOSITORY}:2026.10.0"]


def write_journal(host: Host, **fields: str) -> None:
    base = {
        "updater": UPDATER_ID,
        "version": NEW,
        "from": OLD,
        "name": "stowly",
        "old_id": DSM_ID,
        "image": f"{REPOSITORY}:{NEW}",
        "repository": REPOSITORY,
        "backup": f"before-{OLD}-20261116T100000Z.sqlite3",
        "tty": "1",
        "phase": "renamed",
    }
    base.update(fields)
    (host.update / "journal").write_text("".join(f"{key}={value}\n" for key, value in base.items()))


def changing_calls(host: Host) -> list[tuple[str, str]]:
    return [(method, path) for method, path in host.engine.calls if method != "GET"]


def test_a_journal_that_the_updater_did_not_write_is_deleted_not_executed(host, monkeypatch, caplog):
    write_journal(host, phase="stopping")
    host.engine.containers[DSM_ID]["State"] = {
        "Status": "exited",
        "Running": False,
        "StartedAt": "2026-11-16T09:00:00Z",
    }
    # Die Datei gehört nicht dem Updater (im Betrieb: dem Server mit uid 10001 statt root).
    monkeypatch.setattr(run, "_expected_uid", lambda: 4242)
    with caplog.at_level("WARNING", logger="stowly.updater"):
        host.updater.tick()
    assert not (host.update / "journal").exists()
    assert changing_calls(host) == []
    assert not (host.update / "state").exists()
    assert any("stammt nicht vom Updater" in record.getMessage() for record in caplog.records)


def test_a_journal_with_a_second_hard_link_is_never_executed(host):
    (host.update / "state").write_text("state=done\n")
    write_journal(host, phase="stopping")
    os.unlink(host.update / "journal")
    os.link(host.update / "state", host.update / "journal")  # zwei Namen, eine Datei
    host.updater.tick()
    assert not (host.update / "journal").exists()
    assert (host.update / "state").read_text() == "state=done\n"
    assert changing_calls(host) == []


@pytest.mark.parametrize(
    ("label", "fields"),
    [
        ("Logs, Anhalten und Löschen eines fremden Containers", {"new_id": HA_ID, "phase": "created"}),
        (
            "Starten eines fremden, angehaltenen Containers",
            {"old_id": TOOL_ID, "name": "werkzeug", "phase": "stopping"},
        ),
        (
            "Löschen eines fremden Containers und fremder Images",
            {
                "old_id": TOOL_ID,
                "new_id": HA_ID,
                "name": "homeassistant",
                "phase": "starting",
                "repository": HA_REPOSITORY,
            },
        ),
        (
            "Umbenennen eines fremden Containers",
            {"old_id": HA_ID, "name": "stowly-vorher", "phase": "renamed"},
        ),
        ("fremdes Repository", {"phase": "renamed", "repository": HA_REPOSITORY}),
        ("Name, der nicht zum alten Container passt", {"name": "homeassistant", "phase": "renamed"}),
        ("der Updater selbst als neuer Container", {"new_id": UPDATER_ID, "phase": "created"}),
        ("Sicherung außerhalb des Musters", {"backup": "stowly.sqlite3"}),
        ("Kennung ist kein Container", {"old_id": "werkzeug"}),
        ("unbekannter Schritt", {"phase": "aufräumen"}),
        ("Version", {"version": "0.3.0;reboot"}),
    ],
)
def test_a_journal_that_does_not_fit_stowly_touches_no_container(host, label, fields):
    add_foreign_containers(host)
    write_journal(host, **fields)
    host.updater.tick()
    state = host.state()
    assert (state["state"], state["message"]) == ("failed", run.FOREIGN_JOURNAL), label
    assert changing_calls(host) == [], label
    assert not any("/logs" in path for _method, path in host.engine.calls), label
    assert host.engine.containers[HA_ID]["Name"] == "/homeassistant"
    assert host.engine.containers[TOOL_ID]["State"]["Running"] is False
    assert host.engine.removed_images == []
    assert "geheim" not in (host.update / "log").read_text(encoding="utf-8")
    assert not (host.update / "journal").exists()


def test_a_genuine_journal_still_brings_the_update_back(host):
    """Gegenprobe: dasselbe Journal, wie es der Updater nach dem Umbenennen hinterlässt, wird ausgeführt."""
    add_foreign_containers(host)
    host.engine.containers[DSM_ID]["Name"] = "/stowly-vorher"
    host.engine.containers[DSM_ID]["State"] = {
        "Status": "exited",
        "Running": False,
        "StartedAt": "2026-11-16T09:00:00Z",
    }
    write_journal(host, phase="renamed")
    host.updater.tick()
    stowly = host.stowly()
    assert stowly is not None and stowly["Id"] == DSM_ID and stowly["State"]["Running"]
    assert host.state()["message"] == f"Das Update auf {NEW} brach ab, zurück auf {OLD}."


# --- Nie zurück auf eine ältere Version, Rechte, Pfade ---------------------------------------------


def test_an_older_version_is_refused(host):
    host.engine.offer("0.2.0")
    host.request("0.2.0")
    host.updater.tick()
    state = host.state()
    assert state["state"] == "failed" and "älter als 0.2.1" in state["message"]
    assert changing_calls(host) == []


@pytest.mark.skipif(os.name == "nt", reason="setuid gibt es unter Windows nicht")
def test_copies_of_the_database_never_keep_setuid_bits(host):
    os.chmod(host.data / "stowly.sqlite3", 0o6644)
    host.engine.offer(NEW)
    host.request()
    host.updater.tick()
    (copy,) = host.update.glob(f"before-{OLD}-*.sqlite3")
    assert copy.stat().st_mode & 0o7777 == 0o644


def test_container_names_never_leave_their_place_in_the_path():
    transport = Recording(version_reply("1.41"), Reply(404, b'{"message":"no such container"}'))
    assert Engine(transport).container("../../images/x") is None
    assert transport.paths[1] == "/v1.41/containers/..%2F..%2Fimages%2Fx/json"
