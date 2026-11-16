"""Die Engine API von Docker über den Unix-Socket (docs/integrationen.md, 10.7), nur Standardbibliothek.

* **Transport:** ein Aufruf je Verbindung (``Connection: close``), HTTP/1.1 mit ``http.client`` über
  ``AF_UNIX``; das liest auch ``Transfer-Encoding: chunked``. Tests reichen einen eigenen Transport ein
  (eine nachgebildete Engine im Speicher), der echte Socket läuft nur unter Linux.
* **Version:** ``GET /version`` ohne Präfix, dann alle Aufrufe unter ``/v<version>``: die der Engine,
  höchstens ``MAX_API``, mindestens ``MIN_API``. DSM 6.2 hat 1.41.
* **Image laden:** Den Datenstrom von ``POST /images/create`` bis zum Ende lesen. Ein ``error`` darin
  ist ein Fehlschlag, auch bei HTTP 200.
* **Log:** Ohne TTY trennt Docker stdout und stderr in Rahmen mit 8 Byte Kopf (``demux``); mit TTY
  kommt der Text roh.
"""

import http.client
import json
import socket
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

SOCKET = "/var/run/docker.sock"
MIN_API = (1, 40)
# Bis hierher sind die Regeln geprüft; ab 1.44 legt create auch mehrere Netze an (clone.py).
MAX_API = (1, 44)
TIMEOUT_S = 60.0
# Laden und Anhalten dauern länger: Das Image kommt in Schichten, stop wartet bis zu t Sekunden.
PULL_TIMEOUT_S = 900.0
STOP_GRACE_S = 30.0
BODY_MAX = 64 * 1024 * 1024


@dataclass(frozen=True)
class Reply:
    status: int
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body) if self.body.strip() else None


class Transport(Protocol):
    def __call__(self, method: str, path: str, body: bytes | None, timeout: float) -> Reply: ...


class DockerError(Exception):
    """Ein Aufruf der Engine API ging schief. ``status`` ist 0, wenn Docker gar nicht antwortete."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class PullFailed(DockerError):
    """Das Image ließ sich nicht laden (HTTP-Fehler oder ``error`` im Datenstrom)."""


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        family = getattr(socket, "AF_UNIX", None)
        if family is None:
            raise DockerError("Unix-Sockets gibt es hier nicht.")
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self._path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def read_body(response: http.client.HTTPResponse, limit: int = BODY_MAX) -> bytes:
    """Der ganze Rumpf (auch chunked), höchstens ``limit`` Bytes."""
    data = response.read(limit + 1)
    if len(data) > limit:
        raise DockerError(f"Die Antwort von Docker ist größer als {limit} Bytes.")
    return data


class UnixTransport:
    """HTTP/1.1 über den Socket von Docker."""

    def __init__(self, path: str = SOCKET) -> None:
        self.path = path

    def __call__(self, method: str, path: str, body: bytes | None, timeout: float) -> Reply:
        connection = _UnixConnection(self.path, timeout)
        headers = {"Host": "docker", "Connection": "close", "User-Agent": "Stowly-Updater"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return Reply(response.status, read_body(response))
        except (OSError, http.client.HTTPException) as exc:
            raise DockerError(f"Docker antwortet nicht ({type(exc).__name__}: {exc}).") from None
        finally:
            connection.close()


def parse_version(text: object) -> tuple[int, int] | None:
    """``"1.41"`` als ``(1, 41)``; sonst ``None``."""
    if not isinstance(text, str):
        return None
    parts = text.split(".")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return None
    return int(parts[0]), int(parts[1])


def pull_error(stream: bytes) -> str | None:
    """Der erste Fehler im Datenstrom von ``POST /images/create``; ``None``, wenn keiner darin steht.

    Docker schreibt ein JSON-Objekt je Zeile; gelesen wird so, dass auch aneinandergehängte Objekte
    ohne Zeilenende gehen. Was kein JSON ist, zählt als Fehler.
    """
    decoder = json.JSONDecoder()
    text = stream.decode("utf-8", "replace")
    position = 0
    while True:
        while position < len(text) and text[position] in " \t\r\n":
            position += 1
        if position >= len(text):
            return None
        try:
            item, position = decoder.raw_decode(text, position)
        except ValueError:
            return "Docker meldet beim Laden etwas Unlesbares."
        if isinstance(item, dict):
            detail = item.get("errorDetail")
            message = item.get("error") or (detail.get("message") if isinstance(detail, dict) else None)
            if message:
                return str(message)


def demux(data: bytes) -> bytes:
    """Das Log ohne die Rahmen (8 Byte: Strom, drei Nullen, Länge). Ohne Rahmen bleibt es, wie es ist."""
    if len(data) < 8 or data[0] not in (0, 1, 2) or data[1:4] != b"\0\0\0":
        return data
    out = bytearray()
    while len(data) >= 8 and data[0] in (0, 1, 2) and data[1:4] == b"\0\0\0":
        size = int.from_bytes(data[4:8], "big")
        out += data[8 : 8 + size]
        data = data[8 + size :]
    return bytes(out + data)


def _query(values: Mapping[str, Any]) -> str:
    return urllib.parse.urlencode({key: value for key, value in values.items() if value is not None})


def _quote(name: str) -> str:
    """Ein Image im Pfad: ``/`` und ``:`` gehören zum Namen (``ghcr.io/beispiel/stowly:0.3.0``)."""
    return urllib.parse.quote(name, safe=":/@")


def _part(name: str) -> str:
    """Ein Container oder Netz im Pfad: alles maskiert, auch ``/``, damit ein Name den Pfad nie verlässt."""
    return urllib.parse.quote(name, safe="")


class Engine:
    """Die Aufrufe, die der Updater braucht. ``transport`` ersetzt in Tests den Socket."""

    def __init__(self, transport: Transport | None = None) -> None:
        self._transport = transport or UnixTransport()
        self.api: tuple[int, int] | None = None

    # ------------------------------------------------------------------ Grundlagen

    def _call(
        self,
        method: str,
        path: str,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        *,
        timeout: float = TIMEOUT_S,
        versioned: bool = True,
    ) -> Reply:
        if versioned:
            if self.api is None:
                self.negotiate()
            assert self.api is not None
            path = f"/v{self.api[0]}.{self.api[1]}{path}"
        if query:
            path = f"{path}?{_query(query)}"
        payload = None if body is None else json.dumps(body).encode("utf-8")
        return self._transport(method, path, payload, timeout)

    @staticmethod
    def _fail(reply: Reply, what: str) -> DockerError:
        try:
            message = (reply.json() or {}).get("message")
        except (ValueError, AttributeError):
            message = None
        detail = message or reply.body[:200].decode("utf-8", "replace").strip() or f"HTTP {reply.status}"
        return DockerError(f"{what}: {detail}", reply.status)

    def negotiate(self) -> tuple[int, int]:
        """``GET /version``: die Version der Engine API, auf die die Aufrufe dann zielen."""
        reply = self._call("GET", "/version", versioned=False)
        if reply.status != 200:
            raise self._fail(reply, "Docker nennt seine Version nicht")
        info = reply.json() or {}
        api = parse_version(info.get("ApiVersion"))
        if api is None:
            raise DockerError("Docker nennt keine Version der Engine API.")
        if api < MIN_API:
            raise DockerError(
                f"Docker ist zu alt: Engine API {api[0]}.{api[1]}, gebraucht wird mindestens "
                f"{MIN_API[0]}.{MIN_API[1]}."
            )
        chosen = min(api, MAX_API)
        floor = parse_version(info.get("MinAPIVersion"))
        if floor is not None and chosen < floor:
            chosen = floor
        self.api = chosen
        return chosen

    # ------------------------------------------------------------------ Container

    def containers(self) -> list[dict[str, Any]]:
        """Alle Container, auch angehaltene (``GET /containers/json?all=1``)."""
        reply = self._call("GET", "/containers/json", {"all": 1})
        if reply.status != 200:
            raise self._fail(reply, "Die Liste der Container fehlt")
        result = reply.json()
        return result if isinstance(result, list) else []

    def container(self, ref: str) -> dict[str, Any] | None:
        """``inspect`` eines Containers; ``None``, wenn es ihn nicht gibt."""
        reply = self._call("GET", f"/containers/{_part(ref)}/json")
        if reply.status == 404:
            return None
        if reply.status != 200:
            raise self._fail(reply, f"Container {ref} lässt sich nicht ansehen")
        return reply.json()

    def stop(self, ref: str, seconds: int) -> None:
        reply = self._call(
            "POST", f"/containers/{_part(ref)}/stop", {"t": seconds}, timeout=seconds + STOP_GRACE_S
        )
        if reply.status not in (204, 304):
            raise self._fail(reply, "Anhalten ging nicht")

    def start(self, ref: str) -> None:
        reply = self._call("POST", f"/containers/{_part(ref)}/start")
        if reply.status not in (204, 304):
            raise self._fail(reply, "Starten ging nicht")

    def rename(self, ref: str, name: str) -> None:
        reply = self._call("POST", f"/containers/{_part(ref)}/rename", {"name": name})
        if reply.status != 204:
            raise self._fail(reply, f"Umbenennen in {name} ging nicht")

    def create(self, name: str, body: Mapping[str, Any]) -> str:
        reply = self._call("POST", "/containers/create", {"name": name}, body)
        if reply.status != 201:
            raise self._fail(reply, "Anlegen ging nicht")
        created = reply.json() or {}
        container_id = created.get("Id")
        if not isinstance(container_id, str):
            raise DockerError("Docker nennt die ID des neuen Containers nicht.")
        return container_id

    def connect(self, network: str, container_id: str, endpoint: Mapping[str, Any]) -> None:
        body = {"Container": container_id, "EndpointConfig": dict(endpoint)}
        reply = self._call("POST", f"/networks/{_part(network)}/connect", None, body)
        if reply.status != 200:
            raise self._fail(reply, f"Verbinden mit dem Netz {network} ging nicht")

    def remove_container(self, ref: str, *, force: bool = False) -> None:
        """Löscht einen Container, nie samt Volumes (kein ``v=1``)."""
        reply = self._call("DELETE", f"/containers/{_part(ref)}", {"force": 1 if force else None})
        if reply.status not in (204, 404):
            raise self._fail(reply, "Löschen ging nicht")

    def logs(self, ref: str, *, tail: int = 50, tty: bool = False) -> str:
        """Das Ende des Logs, stdout und stderr zusammen."""
        reply = self._call("GET", f"/containers/{_part(ref)}/logs", {"stdout": 1, "stderr": 1, "tail": tail})
        if reply.status != 200:
            return f"(Log nicht lesbar: HTTP {reply.status})"
        data = reply.body if tty else demux(reply.body)
        return data.decode("utf-8", "replace")

    # ------------------------------------------------------------------ Images

    def image(self, ref: str) -> dict[str, Any] | None:
        reply = self._call("GET", f"/images/{_quote(ref)}/json")
        if reply.status == 404:
            return None
        if reply.status != 200:
            raise self._fail(reply, f"Image {ref} lässt sich nicht ansehen")
        return reply.json()

    def images(self) -> list[dict[str, Any]]:
        reply = self._call("GET", "/images/json")
        if reply.status != 200:
            raise self._fail(reply, "Die Liste der Images fehlt")
        result = reply.json()
        return result if isinstance(result, list) else []

    def pull(self, repository: str, tag: str) -> None:
        """Lädt ``repository:tag`` und liest den Datenstrom bis zum Ende; ``PullFailed`` bei einem Fehler."""
        try:
            reply = self._call(
                "POST", "/images/create", {"fromImage": repository, "tag": tag}, timeout=PULL_TIMEOUT_S
            )
        except DockerError as exc:
            raise PullFailed(str(exc), exc.status) from None
        if reply.status != 200:
            failure = self._fail(reply, "Laden ging nicht")
            raise PullFailed(str(failure), reply.status)
        problem = pull_error(reply.body)
        if problem is not None:
            raise PullFailed(problem, reply.status)

    def remove_image(self, ref: str) -> bool:
        """Entfernt ein Image (ohne ``force``); ``False``, wenn Docker es behält (etwa noch in Gebrauch)."""
        reply = self._call("DELETE", f"/images/{_quote(ref)}")
        return reply.status == 200
