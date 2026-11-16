"""Zwei Listener mit echten Sockets (docs/integrationen.md, 11.4; ``stowly.__main__.Listeners``).

HTTP und HTTPS laufen in einer Ereignisschleife mit derselben App; der Lebenszyklus der App umschließt
beide. Ein neues Zertifikat sehen neue Verbindungen, eine laufende behält das alte. Die Listener laufen
in einem eigenen Thread, wie ``python -m stowly`` sie startet (ohne Signale: die gibt es nur im
Haupt-Thread).
"""

import asyncio
import contextlib
import dataclasses
import json
import signal
import socket
import ssl
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.client import HTTPConnection, HTTPSConnection
from typing import Any

import pytest
from support import TEST_PASSWORD

from stowly.__main__ import STARTUP_FAILURE, Listeners
from stowly.app import create_app
from stowly.config import Settings


def wait_for(condition: Callable[[], bool], timeout_s: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("Die Bedingung trat nicht ein.")
        time.sleep(0.02)


@dataclass
class Running:
    settings: Settings
    listeners: Listeners
    thread: threading.Thread
    result: dict[str, Any] = field(default_factory=dict)

    @property
    def http_port(self) -> int:
        return self.listeners.http.servers[0].sockets[0].getsockname()[1]

    @property
    def https_port(self) -> int:
        assert self.listeners.https is not None
        return self.listeners.https.servers[0].sockets[0].getsockname()[1]

    def stop(self) -> int:
        self.listeners.stop()
        self.thread.join(timeout=15)
        assert not self.thread.is_alive()
        return self.result["code"]

    # ------------------------------------------------------------------ Aufrufe

    def trusting(self, *, check_hostname: bool = True) -> ssl.SSLContext:
        """Ein Client, der nur der CA von Stowly vertraut."""
        context = ssl.create_default_context(cafile=str(self.settings.tls_dir / "ca.crt"))
        context.check_hostname = check_hostname
        return context

    def plain(self) -> HTTPConnection:
        return HTTPConnection("127.0.0.1", self.http_port, timeout=15)

    def secure(self, **context: Any) -> HTTPSConnection:
        return HTTPSConnection("127.0.0.1", self.https_port, timeout=15, context=self.trusting(**context))


def call(
    connection: HTTPConnection,
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """Ein Aufruf auf einer (womöglich offen gehaltenen) Verbindung; liefert ``(status, json)``."""
    sent = dict(headers or {})
    if body is not None:
        sent["Content-Type"] = "application/json"
    if token is not None:
        sent["Authorization"] = f"Bearer {token}"
    connection.request(method, path, body=None if body is None else json.dumps(body), headers=sent)
    response = connection.getresponse()
    return response.status, json.loads(response.read() or b"null")


def once(connection: HTTPConnection, method: str, path: str, **more: Any) -> tuple[int, Any]:
    try:
        return call(connection, method, path, **more)
    finally:
        connection.close()


def start(
    settings: Settings, *, prepare: Callable[[Listeners], None] | None = None, wait_https: bool = True
) -> Running:
    app = create_app(settings)
    listeners = Listeners(app, settings)
    if prepare is not None:
        prepare(listeners)
    result: dict[str, Any] = {}

    def run() -> None:
        result["code"] = asyncio.run(listeners.serve())

    thread = threading.Thread(target=run, name="stowly-test-listeners")
    thread.start()
    running = Running(settings, listeners, thread, result)
    wait_for(lambda: listeners.http.started or not thread.is_alive())
    if wait_https and listeners.https is not None and thread.is_alive():
        wait_for(lambda: listeners.https.started or app.state.tls.info()["problem"] is not None)
    return running


@pytest.fixture
def both(settings) -> Settings:
    """Beide Listener auf freien Ports (0)."""
    return dataclasses.replace(settings, port=0, https_port=0)


@pytest.fixture
def running(both) -> Iterator[Running]:
    server = start(both)
    try:
        yield server
    finally:
        if server.thread.is_alive():
            server.stop()


def login(server: Running) -> str:
    status, body = once(
        server.plain(), "POST", "/api/auth/login", body={"password": TEST_PASSWORD, "device_name": "Handy"}
    )
    assert status == 200, body
    return body["token"]


# --- Beide Listener ------------------------------------------------------------------------------


def test_both_listeners_answer_and_only_https_counts_as_https(running):
    for connection in (running.plain(), running.secure()):
        status, body = once(connection, "GET", "/api/health")
        assert (status, body["app"], body["configured"]) == (200, "stowly", True)
    token = login(running)

    status, plain = once(running.plain(), "GET", "/api/setup", token=token)
    assert status == 200
    assert plain["https"]["via_https"] is False
    assert (plain["https"]["enabled"], plain["https"]["listening"], plain["https"]["problem"]) == (
        True,
        True,
        None,
    )
    https_step = next(step for step in plain["steps"] if step["id"] == "https")
    assert https_step["ready"] is False

    # Proxy-Kopfzeilen zählen nicht: Ob HTTPS, sagt nur der Listener.
    status, proxied = once(
        running.plain(), "GET", "/api/setup", token=token, headers={"X-Forwarded-Proto": "https"}
    )
    assert proxied["https"]["via_https"] is False

    status, secure = once(running.secure(), "GET", "/api/setup", token=token)
    assert status == 200
    assert secure["https"]["via_https"] is True
    assert secure["https"]["seen_at"] is not None
    assert next(step for step in secure["steps"] if step["id"] == "https")["ready"] is True
    # Der externe Port kommt aus Host der Anfrage über HTTPS.
    assert (secure["https"]["port"], secure["https"]["port_source"]) == (running.https_port, "learned")

    assert running.stop() == 0


def test_a_new_certificate_reaches_new_connections_while_an_open_one_keeps_the_old(running):
    token = login(running)
    kept = running.secure()
    try:
        assert call(kept, "GET", "/api/health")[0] == 200
        before = kept.sock.getpeercert()
        assert ("IP Address", "127.0.0.1") in before["subjectAltName"]

        status, answer = once(
            running.plain(), "PATCH", "/api/setup", token=token, body={"addresses": ["nas.local"]}
        )
        assert status == 200, answer
        assert answer["https"]["certificate"]["addresses"] == ["nas.local"]

        def fresh_names() -> tuple:
            connection = running.secure(check_hostname=False)
            try:
                connection.connect()
                return connection.sock.getpeercert()["subjectAltName"]
            finally:
                connection.close()

        # Der Wechsel läuft in der Ereignisschleife; eine neue Verbindung sieht ihn gleich danach.
        wait_for(lambda: fresh_names() == (("DNS", "nas.local"),), timeout_s=5)
        # Die offene Verbindung behält ihr Zertifikat und antwortet weiter.
        assert call(kept, "GET", "/api/health")[0] == 200
        assert kept.sock.getpeercert() == before
    finally:
        kept.close()


def test_the_lifespan_ends_only_after_both_listeners(both):
    seen: list[tuple[str, Any]] = []

    def watch(listeners: Listeners) -> None:
        original = listeners.app.router.lifespan_context

        @contextlib.asynccontextmanager
        async def watched(app):
            async with original(app) as state:
                # Die Dienste stehen, bevor ein Port aufgeht.
                seen.append(
                    ("start", [server.started for server in listeners.servers], app.state.push is not None)
                )
                yield state
                seen.append(("ende", [server.servers[0].is_serving() for server in listeners.servers]))

        listeners.app.router.lifespan_context = watched

    server = start(both, prepare=watch)
    assert login(server)
    assert server.stop() == 0
    assert seen == [("start", [False, False], True), ("ende", [False, False])]
    assert server.listeners.app.state.push is None  # danach heruntergefahren


def test_without_https_port_there_is_only_http(settings):
    plain = dataclasses.replace(settings, port=0)
    server = start(plain)
    try:
        assert server.listeners.https is None
        token = login(server)
        status, body = once(server.plain(), "GET", "/api/setup", token=token)
        assert (body["https"]["enabled"], body["https"]["listening"], body["https"]["port"]) == (
            False,
            False,
            None,
        )
    finally:
        assert server.stop() == 0


# --- Belegte Ports -------------------------------------------------------------------------------


@contextlib.contextmanager
def occupied() -> Iterator[int]:
    """Ein Port, auf dem schon jemand lauscht."""
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        yield blocker.getsockname()[1]
    finally:
        blocker.close()


def test_a_busy_https_port_leaves_http_running(settings):
    with occupied() as busy:
        server = start(dataclasses.replace(settings, port=0, https_port=busy))
        try:
            assert server.thread.is_alive()
            assert server.listeners.http.started
            assert server.listeners.https is not None and not server.listeners.https.started
            token = login(server)
            status, body = once(server.plain(), "GET", "/api/setup", token=token)
            assert status == 200
            https = body["https"]
            assert (https["enabled"], https["listening"]) == (True, False)
            assert f"Port {busy}" in https["problem"] and "HTTP läuft weiter" in https["problem"]
        finally:
            assert server.stop() == 0


def test_a_busy_http_port_ends_with_exit_3_and_https_never_starts(settings):
    with occupied() as busy:
        server = start(dataclasses.replace(settings, port=busy, https_port=0))
        server.thread.join(timeout=15)
    assert server.result["code"] == STARTUP_FAILURE == 3
    assert server.listeners.http.started is False
    assert server.listeners.https is not None and server.listeners.https.started is False
    assert not hasattr(server.listeners.https, "servers")  # nie gebunden
    assert server.listeners.app.state.push is None  # der Lebenszyklus ist sauber zu Ende


# --- Signale -------------------------------------------------------------------------------------


def test_a_signal_stops_both_and_a_second_ctrl_c_does_not_wait(both):
    listeners = Listeners(create_app(both), both)
    listeners._on_signal(signal.SIGTERM, None)
    assert [(server.should_exit, server.force_exit) for server in listeners.servers] == [(True, False)] * 2
    listeners._on_signal(signal.SIGINT, None)
    assert [(server.should_exit, server.force_exit) for server in listeners.servers] == [(True, True)] * 2


def test_both_configs_are_without_lifespan_and_proxy_headers(both):
    listeners = Listeners(create_app(both), both)
    for server in listeners.servers:
        config = server.config
        assert (config.lifespan, config.proxy_headers, config.timeout_graceful_shutdown) == ("off", False, 5)
    assert listeners.https is not None
    assert listeners.https.config.log_config is None
    assert listeners.https.config.ssl_context_factory is not None
