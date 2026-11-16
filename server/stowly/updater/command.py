"""Der Befehl, der den Updater-Container anlegt oder erneuert (docs/integrationen.md, 10.7).

Der Server kennt dafür die Herkunft seines Images (``STOWLY_IMAGE_REF``), seine Version und die ID
seines eigenen Containers. Die ID steht in ``/proc/self/mountinfo``: Docker bindet ``/etc/hostname``,
``/etc/hosts`` und ``/etc/resolv.conf`` aus ``…/containers/<64 hex>/`` ein. Der Hostname taugt nicht
dafür; DSM setzt ihn auf den Namen des Containers. Der Updater-Container selbst findet seine ID auf
demselben Weg (``own_container_id``).
"""

import re
from pathlib import Path

from stowly import __version__
from stowly.config import Settings

MOUNTINFO = Path("/proc/self/mountinfo")
NAME = "stowly-updater"
DOCKER = "/usr/local/bin/docker"
# So viel liest der Server höchstens aus mountinfo; ein Container hat dort ein paar Dutzend Zeilen.
MOUNTINFO_MAX = 256 * 1024
_CONTAINER = re.compile(r"/containers/([0-9a-f]{64})/")


def own_container_id(mountinfo: Path = MOUNTINFO) -> str | None:
    """Die ID des Containers, in dem dieser Prozess läuft; ``None`` außerhalb eines Containers."""
    try:
        with mountinfo.open("rb") as handle:
            text = handle.read(MOUNTINFO_MAX).decode("utf-8", "replace")
    except OSError:
        return None
    match = _CONTAINER.search(text)
    return match.group(1) if match else None


def build(image_ref: str, tag: str, container_id: str) -> str:
    """Der Befehl wie in docs/integrationen.md, 10.7: erst den alten Updater löschen, dann neu anlegen.

    ``--user 0:0``, weil nur root den Socket öffnen darf; ``--network none``, weil Docker selbst das
    Image lädt; ``--no-healthcheck``, weil der Healthcheck des Images den Port 8010 fragt.
    """
    return (
        f"{DOCKER} rm -f {NAME}; "
        f"{DOCKER} run -d --name {NAME} --restart unless-stopped --user 0:0 --network none --read-only "
        "--tmpfs /tmp --no-healthcheck -v /var/run/docker.sock:/var/run/docker.sock "
        f"--volumes-from {container_id} {image_ref}:{tag} python -m stowly.updater"
    )


def updater_command(settings: Settings, *, mountinfo: Path = MOUNTINFO) -> str | None:
    """Der fertige Befehl für ``UpdateStatus.updater_command``; ``None`` ohne ``STOWLY_IMAGE_REF``
    oder ohne erkannte eigene Container-ID.

    Das Image nennt er mit dem Tag, unter dem es veröffentlicht wurde (``STOWLY_IMAGE_TAG``). Eine
    Vorabversion meldet sich nämlich mit der Nummer der fertigen Version (0.3.0), liegt aber unter
    ``:0.3.0-rc.4``; ein Image ``:0.3.0`` gibt es zu der Zeit noch nicht. Ohne Tag gilt die Version.
    """
    if settings.image_ref is None:
        return None
    container_id = own_container_id(mountinfo)
    if container_id is None:
        return None
    return build(settings.image_ref, settings.image_tag or __version__, container_id)
