"""Gemeinsames der Tests von ``stowly_print``.

Kein Test spricht ein Gerät oder einen fremden Dienst an. Wo ein Netzwerkdrucker nachgebildet
wird, lauscht ein Socket auf 127.0.0.1 an einem der Ports 8025 bis 8029.
"""

import socket
from collections.abc import Iterator

import pytest

LOCAL_PORTS = range(8025, 8030)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--update-references",
        action="store_true",
        default=False,
        help="Referenzbilder und Referenz-Datenstrom neu schreiben, statt mit ihnen zu vergleichen.",
    )


@pytest.fixture
def update_references(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--update-references"))


@pytest.fixture
def listener() -> Iterator[socket.socket]:
    """Ein lauschender Socket auf einem der eigenen Ports, als nachgebildeter Netzwerkdrucker."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    for port in LOCAL_PORTS:
        try:
            server.bind(("127.0.0.1", port))
        except OSError:
            continue
        server.listen(1)
        server.settimeout(10)
        try:
            yield server
        finally:
            server.close()
        return
    server.close()
    pytest.skip("Keiner der Ports 8025 bis 8029 ist frei.")


@pytest.fixture
def closed_port() -> int:
    """Ein eigener Port, an dem gerade niemand lauscht."""
    for port in reversed(LOCAL_PORTS):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            continue
        finally:
            probe.close()
        return port
    pytest.skip("Keiner der Ports 8025 bis 8029 ist frei.")
