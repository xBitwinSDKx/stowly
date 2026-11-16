"""Ein nachgebildetes Home Assistant mit einer To-do-Liste, die mit Bring! verbunden ist.

Es spricht die REST-Schnittstelle, die der Abgleich braucht (docs/integrationen.md, 5.4), und hat einen
Zustand: Artikel mit ``uid``, ``summary``, ``status`` und ``description``. Jede Annahme aus Abschnitt 9,
die erst die Probe mit dem Anwender klärt, ist in ``Behaviour`` umschaltbar. Dazu führt es Buch über
jeden Aufruf und über das, was Anwender in Bring! getan haben: Daran prüfen die Tests die Regeln, die
in jeder Variante gelten müssen.

Seit Stufe B (docs/plan-einrichtung-b.md, 3) auch, was die Prüfung der Einrichtung fragt: ``/api/``,
``/api/config`` und ``/api/states``. Neben der Liste von Bring! (``entity``, ``items``) gibt es weitere
To-do-Listen (``others``), etwa für einen Wechsel der Liste. ``redirect`` lässt jede Anfrage an HA weiter-
leiten; Anfragen an einen anderen Rechner als ``host`` landen in ``elsewhere``, mit ihren Kopfzeilen.
Daran zeigen die Tests, dass kein Token einen zweiten Rechner erreicht.

Kein Test spricht mit einem echten Home Assistant; die Nachbildung hängt über ``httpx2.MockTransport``
am Abgleich und an der Prüfung.
"""

import itertools
import json
from dataclasses import dataclass
from typing import Any

import httpx2

TOKEN = "ha-token-" + "t" * 48
ENTITY = "todo.einkaufsliste"
HOST = "ha.example"
BASE = f"http://{HOST}:8123"
OPEN, COMPLETED = "needs_action", "completed"
VERSION = "2026.11.2"
LOCATION = "Zuhause"


@dataclass
class Behaviour:
    """Was die Probe mit dem Anwender klären soll (docs/integrationen.md, 9), umschaltbar."""

    # 2. todo.add_item mit einem Namen, der schon offen dasteht: zweiter Artikel, Spezifikation
    #    aktualisiert oder Fehler.
    duplicate: str = "second"  # second | update | error
    # 2. todo.add_item mit einem Namen aus „zuletzt gekauft": wandert zurück oder neuer Artikel.
    recent: str = "back"  # back | new
    # 3. Groß- und Kleinschreibung und Leerzeichen am Rand: für Bring! gleich oder verschieden.
    fold: bool = True
    # 1. todo.get_items mit completed: liefert die Artikel von „zuletzt gekauft" oder nicht.
    completed: bool = True
    # 5. uid: stabil, oder neu nach einem Neustart von HA.
    stable_uid: bool = True
    # 6. Neustart von HA: erst „unavailable", kurz leere Liste, oder gleich vollständig.
    restart: str = "unavailable"  # unavailable | empty | full
    # 8. Namen gekürzt auf so viele Zeichen; None = ganz.
    truncate: int | None = None
    # 7. Neue Artikel erst nach so vielen Abgleichen sichtbar (Bring! aktualisiert sich alle 90 Sekunden).
    delay: int = 0

    def label(self) -> str:
        return (
            f"dup={self.duplicate},recent={self.recent},fold={int(self.fold)},completed={int(self.completed)},"
            f"uid={'stable' if self.stable_uid else 'new'},restart={self.restart},"
            f"cut={self.truncate},delay={self.delay}"
        )


@dataclass
class Item:
    uid: str
    summary: str
    status: str
    description: str | None
    by: str  # „stowly" (über add_item angelegt) oder „user" (in Bring! angelegt)
    hidden: int = 0  # so viele Abrufe noch unsichtbar


@dataclass
class Write:
    """Ein schreibender Aufruf des Abgleichs und der Artikel, den er traf."""

    service: str
    data: dict[str, Any]
    target: Item | None
    created: bool = False
    visible_user_item: bool = False  # add_item für einen Namen, der offen und sichtbar als fremder dastand

    @property
    def entity(self) -> str | None:
        """Die Liste, in die geschrieben wurde."""
        return self.data.get("entity_id")


def bring_key(name: str) -> str:
    return " ".join(name.split()).casefold()


class FakeHA:
    """Das nachgebildete Home Assistant. Als Handler für ``httpx2.MockTransport`` aufrufbar."""

    def __init__(self, behaviour: Behaviour | None = None) -> None:
        self.behaviour = behaviour or Behaviour()
        self.token = TOKEN
        self.host = HOST
        self.entity = ENTITY
        self.items: list[Item] = []
        # Weitere To-do-Listen in HA (entity_id -> Artikel) und die Namen aller Listen.
        self.others: dict[str, list[Item]] = {}
        self.titles: dict[str, str] = {ENTITY: "Einkaufsliste"}
        # Weitere Entitäten unter /api/states (keine To-do-Listen), wie in einem echten HA.
        self.extra_states: list[dict[str, Any]] = [
            {"entity_id": "sun.sun", "state": "above_horizon", "attributes": {"friendly_name": "Sonne"}},
            {"entity_id": "sensor.stowly_bald", "state": "2", "attributes": {"friendly_name": "Stowly bald"}},
        ]
        self.version = VERSION
        self.location = LOCATION
        # Jede Anfrage an HA wird hierhin weitergeleitet (301), etwa „http://anders.example:8123/api/".
        self.redirect: str | None = None
        self.requests: list[httpx2.Request] = []
        self.elsewhere: list[httpx2.Request] = []  # Anfragen an einen anderen Rechner als host
        self.writes: list[Write] = []
        self.reads = 0
        # Fehler für jeden Aufruf: Statuscode oder Ausnahme; je Pfad-Ende (z. B. "add_item") oder "*".
        self.failures: dict[str, int | Exception] = {}
        self.state_override: str | None = None  # Zustand der Entität, etwa "unavailable"
        self.restarting = 0  # so viele Abgleiche wirkt ein Neustart noch nach
        self.actions: list[tuple[str, str]] = []  # (Handlung, Vergleichsform): was Anwender in Bring! taten
        self._uids = (f"uid-{number:04d}" for number in itertools.count(1))
        self._last_visible: set[int] = set()  # id() der Artikel, die der letzte Abruf zeigte

    # ------------------------------------------------------------------ Listen

    def add_list(self, entity: str, title: str) -> list[Item]:
        """Eine weitere To-do-Liste in HA (etwa „Local To-do"); liefert ihre Artikel zum Füllen."""
        self.others[entity] = []
        self.titles[entity] = title
        return self.others[entity]

    def list_items(self, entity: str | None = None) -> list[Item] | None:
        """Die Artikel einer Liste; ``None``, wenn es sie nicht gibt."""
        if entity is None or entity == self.entity:
            return self.items
        return self.others.get(entity)

    # ------------------------------------------------------------------ Anwender in Bring!

    def user_add(
        self, name: str, description: str | None = None, *, status: str = OPEN, entity: str | None = None
    ) -> Item:
        item = Item(next(self._uids), name, status, description, "user")
        self.list_items(entity).append(item)
        self.actions.append(("add", bring_key(name)))
        return item

    def find(self, name: str, status: str | None = None, *, entity: str | None = None) -> Item | None:
        """Der Artikel, den Bring! unter diesem Namen kennt (nach den Regeln von ``fold``)."""
        for item in self.list_items(entity) or []:
            if self._same(item.summary, name) and (status is None or item.status == status):
                return item
        return None

    def user_tick(self, name: str, *, entity: str | None = None) -> None:
        item = self.find(name, OPEN, entity=entity)
        assert item is not None, name
        item.status = COMPLETED
        self.actions.append(("tick", bring_key(name)))

    def user_reopen(self, name: str, *, entity: str | None = None) -> None:
        item = self.find(name, COMPLETED, entity=entity)
        assert item is not None, name
        item.status = OPEN
        self.actions.append(("reopen", bring_key(name)))

    def user_delete(self, name: str, *, entity: str | None = None) -> None:
        item = self.find(name, entity=entity)
        assert item is not None, name
        self.list_items(entity).remove(item)
        self.actions.append(("delete", bring_key(name)))

    def restart(self, runs: int = 1) -> None:
        """Neustart von HA: wirkt je nach ``behaviour.restart`` die nächsten ``runs`` Abgleiche nach."""
        self.restarting = runs
        if not self.behaviour.stable_uid:
            for item in self.items:
                item.uid = next(self._uids)

    # ------------------------------------------------------------------ Blick hinein

    def open_items(self, entity: str | None = None) -> list[Item]:
        return [item for item in self.list_items(entity) or [] if item.status == OPEN]

    def names(self, status: str | None = OPEN, *, entity: str | None = None) -> list[str]:
        return sorted(
            item.summary for item in self.list_items(entity) or [] if status is None or item.status == status
        )

    def calls(self, service: str, *, entity: str | None = None) -> list[dict[str, Any]]:
        """Die Rümpfe der ausgeführten Aufrufe eines Dienstes, etwa ``add_item`` (je Liste, wenn angegeben)."""
        return [
            write.data
            for write in self.writes
            if write.service == service and (entity is None or write.entity == entity)
        ]

    def authorized(self) -> list[httpx2.Request]:
        """Alle Anfragen, an welchen Rechner auch immer, die einen Token trugen."""
        return [request for request in self.requests + self.elsewhere if "authorization" in request.headers]

    def attempts(self, service: str) -> int:
        """Wie oft der Abgleich einen Dienst aufrufen wollte, auch wenn HA mit einem Fehler antwortete."""
        return sum(1 for request in self.requests if request.url.path == f"/api/services/todo/{service}")

    # ------------------------------------------------------------------ Die Schnittstelle

    def _same(self, left: str, right: str) -> bool:
        if self.behaviour.fold:
            return bring_key(left) == bring_key(right)
        return left == right

    def _visible(self, entity: str | None = None) -> list[Item]:
        return [item for item in self.list_items(entity) or [] if item.hidden == 0]

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.host != self.host:
            # Ein zweiter Rechner: Er antwortete wie HA, wenn ihn jemand fragte (der Test sieht es hier).
            self.elsewhere.append(request)
            if request.url.path == "/api/":
                return httpx2.Response(200, json={"message": "API running."})
            return httpx2.Response(200, json=[])
        self.requests.append(request)
        if self.redirect is not None:
            return httpx2.Response(301, headers={"Location": self.redirect}, text="Moved")
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return httpx2.Response(401, text="401: Unauthorized")
        path = request.url.path
        failure = self.failures.get(path.rsplit("/", 1)[-1], self.failures.get("*"))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return httpx2.Response(failure, json={"message": "Fehler"})

        if request.method == "GET" and path == "/api/":
            return httpx2.Response(200, json={"message": "API running."})
        if request.method == "GET" and path == "/api/config":
            return self._config()
        if request.method == "GET" and path == "/api/states":
            return self._states()
        if request.method == "GET" and path.startswith("/api/states/"):
            entity = path.removeprefix("/api/states/")
            if self.list_items(entity) is None:
                return httpx2.Response(404, json={"message": "Entity not found."})
            return self._state(entity)
        if request.method != "POST" or not path.startswith("/api/services/todo/"):
            return httpx2.Response(404, json={"message": "Not found"})
        data = json.loads(request.content)
        if self.list_items(data.get("entity_id")) is None:
            return httpx2.Response(400, json={"message": "Entity not found."})
        service = path.rsplit("/", 1)[-1]
        if service == "get_items":
            assert request.url.query == b"return_response", request.url
            return self._get_items(data)
        assert request.url.query == b"", request.url
        if service == "add_item":
            return self._add_item(data)
        if service == "update_item":
            return self._update_item(data)
        if service == "remove_item":
            return self._remove_item(data)
        return httpx2.Response(400, json={"message": f"Service todo.{service} not found."})

    def _config(self) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "version": self.version,
                "location_name": self.location,
                "time_zone": "Europe/Berlin",
                "components": ["todo", "shopping_list"],
                "unit_system": {"length": "km"},
            },
        )

    def _open_count(self, entity: str) -> str:
        return str(sum(1 for item in self._visible(entity) if item.status == OPEN))

    def _states(self) -> httpx2.Response:
        """Alle Entitäten, wie ``GET /api/states``: die To-do-Listen und ein paar andere."""
        states = [
            {
                "entity_id": entity,
                "state": self._open_count(entity),
                "attributes": {"friendly_name": self.titles.get(entity, entity), "supported_features": 15},
            }
            for entity in [self.entity, *self.others]
        ]
        return httpx2.Response(200, json=[*states, *self.extra_states])

    def _state(self, entity: str) -> httpx2.Response:
        if entity != self.entity:
            return httpx2.Response(200, json={"entity_id": entity, "state": self._open_count(entity)})
        if self.state_override is not None:
            state = self.state_override
        elif self.restarting and self.behaviour.restart == "unavailable":
            self.restarting -= 1
            state = "unavailable"
        elif self.restarting and self.behaviour.restart == "empty":
            state = "0"
        else:
            state = self._open_count(entity)
        return httpx2.Response(200, json={"entity_id": self.entity, "state": state, "attributes": {}})

    def _get_items(self, data: dict[str, Any]) -> httpx2.Response:
        entity = data["entity_id"]
        self.reads += 1
        wanted = set(data.get("status") or (OPEN, COMPLETED))
        if not self.behaviour.completed:
            wanted.discard(COMPLETED)
        shown: list[Item] = []
        if entity == self.entity and self.restarting and self.behaviour.restart == "empty":
            self.restarting -= 1
        else:
            shown = [item for item in self._visible(entity) if item.status in wanted]
        for item in self.list_items(entity) or []:
            if item.hidden:
                item.hidden -= 1
        self._last_visible = {id(item) for item in shown}
        items = []
        for item in shown:
            entry: dict[str, Any] = {"summary": item.summary, "uid": item.uid, "status": item.status}
            if item.description is not None:
                entry["description"] = item.description
            items.append(entry)
        return httpx2.Response(
            200, json={"changed_states": [], "service_response": {entity: {"items": items}}}
        )

    def _add_item(self, data: dict[str, Any]) -> httpx2.Response:
        items = self.list_items(data["entity_id"])
        assert items is not None
        name = data["item"]
        stored = name if self.behaviour.truncate is None else name[: self.behaviour.truncate]
        description = data.get("description")
        existing_open = next(
            (item for item in items if item.status == OPEN and self._same(item.summary, stored)), None
        )
        visible_user = any(
            id(item) in self._last_visible and item.by == "user" and item.status == OPEN
            for item in items
            if bring_key(item.summary) == bring_key(stored)
        )
        write = Write("add_item", data, existing_open, visible_user_item=visible_user)
        self.writes.append(write)
        if existing_open is not None:
            if self.behaviour.duplicate == "error":
                return httpx2.Response(400, json={"message": f"{stored} steht schon auf der Liste."})
            if self.behaviour.duplicate == "update":
                existing_open.description = description
                return httpx2.Response(200, json=[])
        else:
            recent = next(
                (item for item in items if item.status == COMPLETED and self._same(item.summary, stored)),
                None,
            )
            if recent is not None and self.behaviour.recent == "back":
                # Derselbe Artikel kommt zurück auf die Liste; angelegt hat ihn jetzt Stowly.
                recent.status = OPEN
                recent.description = description
                recent.by = "stowly"
                write.target = recent
                return httpx2.Response(200, json=[])
        item = Item(next(self._uids), stored, OPEN, description, "stowly", hidden=self.behaviour.delay)
        items.append(item)
        write.target = item
        write.created = True
        return httpx2.Response(200, json=[])

    def _lookup(self, entity: str, value: str) -> Item | None:
        """Wie HA: die uid oder genau der Name eines Artikels, den HA in dieser Liste schon kennt."""
        for item in self._visible(entity):
            if item.uid == value or item.summary == value:
                return item
        return None

    def _update_item(self, data: dict[str, Any]) -> httpx2.Response:
        item = self._lookup(data["entity_id"], data["item"])
        self.writes.append(Write("update_item", data, item))
        if item is None:
            return httpx2.Response(400, json={"message": "Unable to find To-do item"})
        if "status" in data:
            item.status = data["status"]
        if "description" in data:
            item.description = data["description"]
        return httpx2.Response(200, json=[])

    def _remove_item(self, data: dict[str, Any]) -> httpx2.Response:
        items = self.list_items(data["entity_id"]) or []
        values = data["item"] if isinstance(data["item"], list) else [data["item"]]
        found = [self._lookup(data["entity_id"], value) for value in values]
        self.writes.append(Write("remove_item", data, found[0] if found else None))
        if any(item is None for item in found):
            return httpx2.Response(400, json={"message": "Unable to find To-do item"})
        for item in found:
            if item in items:
                items.remove(item)
        return httpx2.Response(200, json=[])


def violations(ha: FakeHA) -> list[str]:
    """Was in keiner Variante geschehen darf (docs/integrationen.md, 5), in jeder Liste."""
    problems: list[str] = []
    for entity in [ha.entity, *ha.others]:
        keys: dict[str, int] = {}
        for item in ha.open_items(entity):
            if item.by == "stowly":
                keys[bring_key(item.summary)] = keys.get(bring_key(item.summary), 0) + 1
        for key, count in keys.items():
            if count > 1:
                problems.append(f"Stowly hat {key!r} in {entity} {count}-mal offen angelegt")
    for request in ha.elsewhere:
        problems.append(f"Anfrage an einen anderen Rechner: {request.method} {request.url}")
    for write in ha.writes:
        if write.service in ("update_item", "remove_item") and write.target is not None:
            if write.target.by != "stowly":
                problems.append(f"fremder Artikel geschrieben: {write.service} {write.data}")
        if write.service == "add_item" and write.visible_user_item:
            problems.append(f"add_item für einen sichtbaren fremden Artikel: {write.data}")
    return problems
