"""Docker im Speicher: eine nachgebildete Engine API für die Tests des Updater-Containers.

``FakeEngine`` ist ein Transport für ``stowly.updater.docker.Engine``: Sie bekommt Methode, Pfad und Rumpf
wie über den Socket und antwortet wie Docker, mit Containern, Images und Netzen im Speicher. Was der
Updater tut, steht danach in ``calls``, ``created`` und ``connected``. Eingestellt wird:

* ``health``: je Version des Images, was nach dem Start herauskommt (``healthy``, ``unhealthy``, ``exit``,
  ``slow`` = erst nach einigen Abfragen healthy),
* ``pull_failures``: je Versuch ``None`` (gelingt), ``"http"`` (HTTP 500) oder ``"stream"`` (Fehler im
  Datenstrom bei HTTP 200),
* ``stop_fails``, ``crash_after`` (ein Aufruf, nach dem der Updater „abstürzt") und ``on_start`` (was eine
  Version beim Start mit den Daten tut).
"""

import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from stowly.updater.docker import Reply

FIXTURE = Path(__file__).parent / "fixtures" / "dsm_container_inspect.json"
REPOSITORY = "ghcr.io/beispiel/stowly"
OLD_IMAGE_ID = "sha256:52450dd989c58dfb1e8eff3096c36a98f25e0d0ef8dc8966255bbc33e33ce39e"
UPDATER_ID = "a" * 64
DATA_SOURCE = "/volume1/docker/stowly"


class Crash(BaseException):
    """Der Updater stirbt mitten im Update (wie bei einem Neustart des NAS)."""


def dsm_container() -> dict[str, Any]:
    """Das bereinigte ``inspect`` eines Containers, den DSM 6.2 über die Oberfläche angelegt hat."""
    return json.loads(FIXTURE.read_text(encoding="utf-8"))[0]


def image_config(
    version: str, *, extra_env: tuple[str, ...] = (), ports: tuple[str, ...] = ("8010/tcp",)
) -> dict[str, Any]:
    """Die ``Config`` des Images einer Version, wie sie das Dockerfile ergibt."""
    container = dsm_container()["Config"]
    labels = dict(container["Labels"])
    labels["org.opencontainers.image.version"] = version
    return {
        "User": "stowly",
        "Env": [*container["Env"], *extra_env],
        "Cmd": ["python", "-m", "stowly"],
        "Entrypoint": None,
        "WorkingDir": "/app",
        "ExposedPorts": {port: {} for port in ports},
        "Volumes": {"/data": {}},
        "Healthcheck": copy.deepcopy(container["Healthcheck"]),
        "Labels": labels,
    }


NEW_IMAGE_ENV = ("STOWLY_HTTPS_PORT=8443", "STOWLY_PI_BUNDLE=/app/pi-bundle.tar.gz")


class FakeEngine:
    def __init__(self, data_dir: Path, *, api: str = "1.41") -> None:
        self.data_dir = data_dir
        self.api = api
        self.min_api = "1.12"
        self.containers: dict[str, dict[str, Any]] = {}
        self.images: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str]] = []
        self.created: list[tuple[str, dict[str, Any]]] = []
        self.connected: list[tuple[str, str, dict[str, Any]]] = []
        self.removed_images: list[str] = []
        self.health: dict[str, str] = {}
        self.pull_failures: list[str | None] = []
        self.stop_fails = False
        self.crash_after: tuple[str, str] | None = None
        self.on_start: Callable[[str], None] | None = None
        self.logs = b"Traceback: Version kaputt\n"
        self._polls: dict[str, int] = {}
        self._counter = 0

    # ------------------------------------------------------------------ Aufbau

    def add_image(self, version: str, config: dict[str, Any], image_id: str | None = None) -> str:
        image_id = image_id or f"sha256:{version.replace('.', '') * 16}"[:71]
        self.images[image_id] = {"Id": image_id, "RepoTags": [f"{REPOSITORY}:{version}"], "Config": config}
        return image_id

    def add_dsm_stowly(self) -> dict[str, Any]:
        """Stowly 0.2.1, angelegt über die Oberfläche von DSM, mit dem Ordner für /data."""
        self.add_image("0.2.1", image_config("0.2.1"), OLD_IMAGE_ID)
        container = dsm_container()
        self.containers[container["Id"]] = container
        return container

    def add_updater(self) -> None:
        self.containers[UPDATER_ID] = {
            "Id": UPDATER_ID,
            "Name": "/stowly-updater",
            "Image": OLD_IMAGE_ID,
            "Config": {"Image": f"{REPOSITORY}:0.2.1", "Labels": {}, "Tty": False},
            "State": {"Status": "running", "Running": True, "StartedAt": "2026-11-16T10:00:00Z"},
            "HostConfig": {"NetworkMode": "none"},
            "Mounts": [
                {"Type": "bind", "Source": DATA_SOURCE, "Destination": "/data", "RW": True},
                {
                    "Type": "bind",
                    "Source": "/var/run/docker.sock",
                    "Destination": "/var/run/docker.sock",
                    "RW": True,
                },
            ],
            "NetworkSettings": {"Networks": {"none": {}}},
        }

    def offer(self, version: str, *, health: str = "healthy") -> None:
        """Eine neue Version, die sich laden lässt (sie entsteht erst beim Laden)."""
        self.health[version] = health

    # ------------------------------------------------------------------ Hilfen

    def find(self, ref: str) -> dict[str, Any] | None:
        if ref in self.containers:
            return self.containers[ref]
        for container in self.containers.values():
            if container["Name"].lstrip("/") == ref or (len(ref) >= 12 and container["Id"].startswith(ref)):
                return container
        return None

    def by_name(self, name: str) -> dict[str, Any] | None:
        return next((c for c in self.containers.values() if c["Name"].lstrip("/") == name), None)

    def image_by_ref(self, ref: str) -> dict[str, Any] | None:
        if ref in self.images:
            return self.images[ref]
        return next((image for image in self.images.values() if ref in image["RepoTags"]), None)

    @staticmethod
    def _json(status: int, body: Any) -> Reply:
        return Reply(status, json.dumps(body).encode())

    @staticmethod
    def _error(status: int, message: str) -> Reply:
        return Reply(status, json.dumps({"message": message}).encode())

    def _summary(self, container: dict[str, Any]) -> dict[str, Any]:
        return {
            "Id": container["Id"],
            "Names": [container["Name"]],
            "Image": container["Config"].get("Image"),
            "State": container["State"]["Status"],
            "Labels": container["Config"].get("Labels") or {},
            "Mounts": copy.deepcopy(container.get("Mounts") or []),
        }

    def _version_of(self, container: dict[str, Any]) -> str:
        return str(container["Config"].get("Image", "")).rsplit(":", 1)[-1]

    # ------------------------------------------------------------------ Transport

    def __call__(self, method: str, path: str, body: bytes | None, timeout: float) -> Reply:
        self.calls.append((method, path))
        parts = urlsplit(path)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        route = parts.path
        if route == "/version":
            return self._json(
                200, {"ApiVersion": self.api, "MinAPIVersion": self.min_api, "Version": "20.10.3"}
            )
        prefix = re.match(r"/v(\d+\.\d+)(/.*)", route)
        assert prefix is not None, f"ohne Version: {path}"
        route = prefix.group(2)
        payload = json.loads(body) if body else None
        reply = self._route(method, route, query, payload)
        if (
            self.crash_after is not None
            and re.fullmatch(self.crash_after[1], route)
            and method == self.crash_after[0]
        ):
            self.crash_after = None
            raise Crash(f"{method} {route}")
        return reply

    def _route(self, method: str, route: str, query: dict[str, str], payload: Any) -> Reply:
        if method == "GET" and route == "/containers/json":
            return self._json(200, [self._summary(c) for c in self.containers.values()])
        if method == "POST" and route == "/containers/create":
            return self._create(query["name"], payload)
        if method == "GET" and route == "/images/json":
            return self._json(200, [{"Id": i["Id"], "RepoTags": i["RepoTags"]} for i in self.images.values()])
        if method == "POST" and route == "/images/create":
            return self._pull(query["fromImage"], query["tag"])
        match = re.fullmatch(r"/containers/([^/]+)(/[a-z]+)?", route)
        if match:
            return self._container(method, unquote(match.group(1)), match.group(2) or "", query)
        match = re.fullmatch(r"/networks/([^/]+)/connect", route)
        if match and method == "POST":
            self.connected.append((unquote(match.group(1)), payload["Container"], payload["EndpointConfig"]))
            return Reply(200, b"")
        match = re.fullmatch(r"/images/(.+?)(/json)?", route)
        if match:
            image = self.image_by_ref(unquote(match.group(1)))
            if method == "GET":
                return self._json(200, image) if image else self._error(404, "no such image")
            if method == "DELETE":
                if image is None:
                    return self._error(404, "no such image")
                ref = unquote(match.group(1))
                if any(c["Config"].get("Image") == ref for c in self.containers.values()):
                    return self._error(409, "image is being used")
                image["RepoTags"].remove(ref)
                self.removed_images.append(ref)
                return self._json(200, [{"Untagged": ref}])
        raise AssertionError(f"Unbekannter Aufruf: {method} {route}")

    def _pull(self, repository: str, tag: str) -> Reply:
        failure = self.pull_failures.pop(0) if self.pull_failures else None
        if failure == "http":
            return self._error(500, "Get https://ghcr.io/v2/: dial tcp: lookup ghcr.io: no such host")
        progress = b'{"status":"Pulling from beispiel/stowly","id":"' + tag.encode() + b'"}\r\n'
        progress += b'{"status":"Downloading","progressDetail":{"current":1,"total":2},"id":"abc"}\r\n'
        if failure == "stream":
            return Reply(
                200,
                progress + b'{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\r\n',
            )
        if tag not in self.health:
            return self._error(404, f"manifest for {repository}:{tag} not found")
        if self.image_by_ref(f"{repository}:{tag}") is None:
            self.add_image(tag, image_config(tag, extra_env=NEW_IMAGE_ENV, ports=("8010/tcp", "8443/tcp")))
        return Reply(
            200, progress + b'{"status":"Status: Downloaded newer image for ' + tag.encode() + b'"}\r\n'
        )

    def _create(self, name: str, body: dict[str, Any]) -> Reply:
        if self.by_name(name) is not None:
            return self._error(409, f'Conflict. The container name "/{name}" is already in use')
        image = self.image_by_ref(body["Image"])
        if image is None:
            return self._error(404, "no such image")
        self._counter += 1
        container_id = f"{self._counter:x}".rjust(64, "c")
        config = {key: value for key, value in body.items() if key not in ("HostConfig", "NetworkingConfig")}
        networks = (body.get("NetworkingConfig") or {}).get("EndpointsConfig") or {}
        container = {
            "Id": container_id,
            "Name": f"/{name}",
            "Image": image["Id"],
            "Config": config,
            "HostConfig": body.get("HostConfig") or {},
            "State": {"Status": "created", "Running": False, "StartedAt": "0001-01-01T00:00:00Z"},
            "Mounts": [{"Type": "bind", "Source": DATA_SOURCE, "Destination": "/data", "RW": True}],
            "NetworkSettings": {"Networks": dict(networks)},
        }
        self.containers[container_id] = container
        self.created.append((name, body))
        return self._json(201, {"Id": container_id, "Warnings": []})

    def _container(self, method: str, ref: str, action: str, query: dict[str, str]) -> Reply:
        container = self.find(ref)
        if container is None:
            return self._error(404, f"No such container: {ref}")
        state = container["State"]
        if method == "GET" and action == "/json":
            if state.get("Running") and state.get("Health", {}).get("Status") == "starting":
                polls = self._polls.get(container["Id"], 0) + 1
                self._polls[container["Id"]] = polls
                if polls >= 3:
                    state["Health"]["Status"] = "healthy"
            return self._json(200, container)
        if method == "GET" and action == "/logs":
            if container["Config"].get("Tty"):
                return Reply(200, self.logs)
            return Reply(200, b"\x02\0\0\0" + len(self.logs).to_bytes(4, "big") + self.logs)
        if method == "POST" and action == "/stop":
            if not state["Running"]:
                return Reply(304, b"")
            if not self.stop_fails:
                state.update(Status="exited", Running=False)
            return Reply(204, b"")
        if method == "POST" and action == "/start":
            if state["Running"]:
                return Reply(304, b"")
            version = self._version_of(container)
            outcome = self.health.get(version, "healthy")
            state["StartedAt"] = "2026-11-16T12:00:00Z"
            if self.on_start is not None:
                self.on_start(version)
            if outcome == "exit":
                state.update(Status="exited", Running=False)
            else:
                health = {"healthy": "healthy", "unhealthy": "unhealthy", "slow": "starting"}[outcome]
                state.update(Status="running", Running=True, Health={"Status": health})
            return Reply(204, b"")
        if method == "POST" and action == "/rename":
            if self.by_name(query["name"]) is not None:
                return self._error(409, "name is already in use")
            container["Name"] = f"/{query['name']}"
            return Reply(204, b"")
        if method == "DELETE" and action == "":
            assert query.get("v") is None, "nie samt Volumes löschen"
            if state["Running"] and query.get("force") != "1":
                return self._error(409, "You cannot remove a running container")
            del self.containers[container["Id"]]
            return Reply(204, b"")
        raise AssertionError(f"Unbekannter Aufruf: {method} {ref}{action}")
