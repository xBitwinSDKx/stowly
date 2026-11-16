"""Ein Container als neuer Container mit neuem Image (docs/integrationen.md, 10.7), nach den Regeln
von watchtower. Nur reine Funktionen über die Antworten von ``inspect``; ``run.py`` schickt das Ergebnis
an ``POST /containers/create``.

* **Config:** bleibt nur, was vom **alten Image** abweicht: ``Env`` je Variable, ``Labels`` je Schlüssel,
  ``ExposedPorts``, ``Volumes``, ``Cmd`` und ``Entrypoint``, ``Healthcheck`` je Feld, ``User``,
  ``WorkingDir`` und ``StopSignal``. Was wegfällt, ergänzt Docker beim Anlegen aus dem neuen Image. Die
  Oberfläche von DSM schreibt alle Umgebungsvariablen des Images in den Container; ohne diese Regel
  klebten sie am alten Image (etwa ``PYTHON_VERSION`` oder ``User=stowly``).
* **Hostname** bleibt, außer er ist die alte Kurz-ID (dann vergibt Docker eine neue) oder das Netz gehört
  einem anderen Container.
* **HostConfig** unverändert (bei DSM auch Log-Treiber ``db`` und ``CpuShares``), ``Links`` in der Form
  ``name:alias``. Anonyme Volumes aus ``Mounts`` kommen als ``<Name>:<Ziel>`` in ``Binds``, sonst begänne
  der neue Container mit einem leeren Volume.
* **Netze** nur mit ``IPAMConfig``, ``Aliases`` (ohne die alte Kurz-ID), ``Links`` und ``DriverOpts``.
  Bis Engine API 1.44 nimmt ``create`` nur ein Netz; die übrigen kommen per ``connect``.
"""

import copy
from collections.abc import Mapping
from typing import Any

SHORT_ID = 12
ENDPOINT_KEYS = ("IPAMConfig", "Links", "Aliases", "DriverOpts")
HEALTH_FIELDS = ("Interval", "Timeout", "StartPeriod", "StartInterval", "Retries")
# Ab dieser Engine API legt create einen Container gleich in mehreren Netzen an.
MULTI_NETWORK_API = (1, 44)


def short_id(container_id: str) -> str:
    return container_id[:SHORT_ID]


def _same(first: Any, second: Any) -> bool:
    """Gleich, wobei ``None`` und leer dasselbe sind (so liefert Docker beides)."""
    return (first or None) == (second or None)


def _healthcheck(
    container: Mapping[str, Any] | None, image: Mapping[str, Any] | None
) -> dict[str, Any] | None:
    """Nur die Felder, die vom Image abweichen; nichts davon: ``None`` (Docker nimmt dann das neue Image)."""
    if not container:
        return None
    result = dict(container)
    if image:
        if _same(result.get("Test"), image.get("Test")):
            result.pop("Test", None)
        for field in HEALTH_FIELDS:
            if result.get(field, 0) == image.get(field, 0):
                result.pop(field, None)
    else:
        for field in HEALTH_FIELDS:
            if not result.get(field):
                result.pop(field, None)
    return result or None


def config(
    container: Mapping[str, Any], image_config: Mapping[str, Any] | None, new_image: str
) -> dict[str, Any]:
    """``Config`` des neuen Containers: nur, was vom alten Image abweicht, dazu das neue Image."""
    result = copy.deepcopy(dict(container.get("Config") or {}))
    image = image_config or {}
    host = container.get("HostConfig") or {}

    image_env = set(image.get("Env") or [])
    result["Env"] = [entry for entry in result.get("Env") or [] if entry not in image_env]

    image_labels = image.get("Labels") or {}
    result["Labels"] = {
        key: value
        for key, value in (result.get("Labels") or {}).items()
        if key not in image_labels or image_labels[key] != value
    }

    image_ports = image.get("ExposedPorts") or {}
    exposed = {port: {} for port in result.get("ExposedPorts") or {} if port not in image_ports}
    for port in host.get("PortBindings") or {}:
        exposed[port] = {}
    result["ExposedPorts"] = exposed or None

    image_volumes = image.get("Volumes") or {}
    volumes = {path: {} for path in result.get("Volumes") or {} if path not in image_volumes}
    result["Volumes"] = volumes or None

    if _same(result.get("Entrypoint"), image.get("Entrypoint")):
        result["Entrypoint"] = None
        if _same(result.get("Cmd"), image.get("Cmd")):
            result["Cmd"] = None

    result["Healthcheck"] = _healthcheck(result.get("Healthcheck"), image.get("Healthcheck"))

    for key in ("User", "WorkingDir", "StopSignal"):
        if _same(result.get(key), image.get(key)):
            result.pop(key, None)

    network_mode = str(host.get("NetworkMode") or "")
    if result.get("Hostname") == short_id(str(container.get("Id", ""))) or network_mode.startswith(
        "container:"
    ):
        result.pop("Hostname", None)
    result["Image"] = new_image
    return result


def _bind_target(bind: str) -> str | None:
    """Das Ziel einer Angabe ``quelle:ziel[:optionen]``."""
    parts = bind.split(":")
    return parts[1] if len(parts) >= 2 else None


def host_config(container: Mapping[str, Any]) -> dict[str, Any]:
    """``HostConfig`` unverändert, dazu ``Links`` umgeschrieben und anonyme Volumes in ``Binds``."""
    result = copy.deepcopy(dict(container.get("HostConfig") or {}))
    links = result.get("Links")
    if links:
        rewritten = []
        for link in links:
            name, _, alias = link.partition(":")
            rewritten.append(f"{name.lstrip('/')}:{alias.rsplit('/', 1)[-1]}" if alias else name.lstrip("/"))
        result["Links"] = rewritten
    binds = list(result.get("Binds") or [])
    covered = {_bind_target(bind) for bind in binds}
    covered |= {mount.get("Target") for mount in result.get("Mounts") or [] if isinstance(mount, Mapping)}
    for mount in container.get("Mounts") or []:
        if mount.get("Type") != "volume" or not mount.get("Name") or mount.get("Destination") in covered:
            continue
        mode = "" if mount.get("RW", True) else ":ro"
        binds.append(f"{mount['Name']}:{mount['Destination']}{mode}")
        covered.add(mount.get("Destination"))
    if binds:
        result["Binds"] = binds
    return result


def endpoints(container: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Die Netze des Containers, je nur mit ``IPAMConfig``, ``Aliases`` (ohne alte Kurz-ID), ``Links``
    und ``DriverOpts``."""
    networks = (container.get("NetworkSettings") or {}).get("Networks") or {}
    old = short_id(str(container.get("Id", "")))
    result: dict[str, dict[str, Any]] = {}
    for name, settings in networks.items():
        endpoint = {key: settings.get(key) for key in ENDPOINT_KEYS if settings.get(key)}
        aliases = [alias for alias in endpoint.get("Aliases") or [] if alias != old]
        if aliases:
            endpoint["Aliases"] = aliases
        else:
            endpoint.pop("Aliases", None)
        result[name] = endpoint
    return result


def network_plan(
    container: Mapping[str, Any], api: tuple[int, int]
) -> tuple[dict[str, dict[str, Any]] | None, list[tuple[str, dict[str, Any]]]]:
    """``(EndpointsConfig für create, [(Netz, Endpoint) für connect])``.

    Ohne eigenes Netz (``host``, ``none``, ``container:…``) nichts. Bis API 1.44 nur das Netz aus
    ``NetworkMode`` beim Anlegen, die übrigen danach.
    """
    mode = str((container.get("HostConfig") or {}).get("NetworkMode") or "default")
    if mode in ("host", "none") or mode.startswith("container:"):
        return None, []
    networks = endpoints(container)
    if not networks:
        return None, []
    if api >= MULTI_NETWORK_API:
        return networks, []
    primary = "bridge" if mode == "default" else mode
    if primary not in networks:
        primary = sorted(networks)[0]
    rest = [(name, endpoint) for name, endpoint in sorted(networks.items()) if name != primary]
    return {primary: networks[primary]}, rest


def create_body(
    container: Mapping[str, Any],
    image_config: Mapping[str, Any] | None,
    new_image: str,
    api: tuple[int, int],
) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]:
    """Der Rumpf für ``POST /containers/create`` und die Netze, die danach per ``connect`` kommen."""
    body = config(container, image_config, new_image)
    body["HostConfig"] = host_config(container)
    at_create, later = network_plan(container, api)
    if at_create is not None:
        body["NetworkingConfig"] = {"EndpointsConfig": at_create}
    return body, later


def container_name(container: Mapping[str, Any]) -> str:
    """Der Name ohne ``/`` davor (``inspect`` liefert ``/stowly``)."""
    return str(container.get("Name") or "").lstrip("/")


def repository(image: str | None) -> str | None:
    """Ein Image ohne Tag und Digest (``ghcr.io/beispiel/stowly:0.2.1`` → ``ghcr.io/beispiel/stowly``);
    ``None`` für eine bloße ID (``sha256:…``)."""
    if not image or image.startswith("sha256:"):
        return None
    name = image.split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    if ":" in last:
        name = name[: len(name) - len(last)] + last.split(":", 1)[0]
    return name or None


def tag(image: str | None) -> str | None:
    """Der Tag eines Images (``…:0.2.1`` → ``0.2.1``); ``None`` ohne Tag."""
    if not image or image.startswith("sha256:"):
        return None
    name = image.split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    return last.split(":", 1)[1] if ":" in last else None


def familiar(ref: str) -> str:
    """Ein Repository so, wie Docker es in ``RepoTags`` nennt (ohne ``docker.io/`` und ``library/``)."""
    for prefix in ("docker.io/", "index.docker.io/", "registry-1.docker.io/"):
        if ref.startswith(prefix):
            ref = ref[len(prefix) :]
            break
    return ref.removeprefix("library/")
