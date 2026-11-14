"""Ein nachgebildetes Home Assistant mit einer To-do-Liste, die mit Bring! verbunden ist.

Es spricht die REST-Schnittstelle, die der Abgleich braucht (docs/integrationen.md, 5.4), und hat einen
Zustand: Artikel mit ``uid``, ``summary``, ``status`` und ``description``. Jede Annahme aus Abschnitt 9,
die erst die Probe mit dem Anwender klärt, ist in ``Behaviour`` umschaltbar. Dazu führt es Buch über
jeden Aufruf und über das, was Anwender in Bring! getan haben: Daran prüfen die Tests die Regeln, die
in jeder Variante gelten müssen.

Kein Test spricht mit einem echten Home Assistant; die Nachbildung hängt über ``httpx2.MockTransport``
am Abgleich.
"""

import itertools
import json
from dataclasses import dataclass
from typing import Any

import httpx2

TOKEN = "ha-token-" + "t" * 48
ENTITY = "todo.einkaufsliste"
BASE = "http://ha.example:8123"
OPEN, COMPLETED = "needs_action", "completed"


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


def bring_key(name: str) -> str:
    return " ".join(name.split()).casefold()


class FakeHA:
    """Das nachgebildete Home Assistant. Als Handler für ``httpx2.MockTransport`` aufrufbar."""

    def __init__(self, behaviour: Behaviour | None = None) -> None:
        self.behaviour = behaviour or Behaviour()
        self.token = TOKEN
        self.entity = ENTITY
        self.items: list[Item] = []
        self.requests: list[httpx2.Request] = []
        self.writes: list[Write] = []
        self.reads = 0
        # Fehler für jeden Aufruf: Statuscode oder Ausnahme; je Pfad-Ende (z. B. "add_item") oder "*".
        self.failures: dict[str, int | Exception] = {}
        self.state_override: str | None = None  # Zustand der Entität, etwa "unavailable"
        self.restarting = 0  # so viele Abgleiche wirkt ein Neustart noch nach
        self.actions: list[tuple[str, str]] = []  # (Handlung, Vergleichsform): was Anwender in Bring! taten
        self._uids = (f"uid-{number:04d}" for number in itertools.count(1))
        self._last_visible: set[int] = set()  # id() der Artikel, die der letzte Abruf zeigte

    # ------------------------------------------------------------------ Anwender in Bring!

    def user_add(self, name: str, description: str | None = None, *, status: str = OPEN) -> Item:
        item = Item(next(self._uids), name, status, description, "user")
        self.items.append(item)
        self.actions.append(("add", bring_key(name)))
        return item

    def find(self, name: str, status: str | None = None) -> Item | None:
        """Der Artikel, den Bring! unter diesem Namen kennt (nach den Regeln von ``fold``)."""
        for item in self.items:
            if self._same(item.summary, name) and (status is None or item.status == status):
                return item
        return None

    def user_tick(self, name: str) -> None:
        item = self.find(name, OPEN)
        assert item is not None, name
        item.status = COMPLETED
        self.actions.append(("tick", bring_key(name)))

    def user_reopen(self, name: str) -> None:
        item = self.find(name, COMPLETED)
        assert item is not None, name
        item.status = OPEN
        self.actions.append(("reopen", bring_key(name)))

    def user_delete(self, name: str) -> None:
        item = self.find(name)
        assert item is not None, name
        self.items.remove(item)
        self.actions.append(("delete", bring_key(name)))

    def restart(self, runs: int = 1) -> None:
        """Neustart von HA: wirkt je nach ``behaviour.restart`` die nächsten ``runs`` Abgleiche nach."""
        self.restarting = runs
        if not self.behaviour.stable_uid:
            for item in self.items:
                item.uid = next(self._uids)

    # ------------------------------------------------------------------ Blick hinein

    def open_items(self) -> list[Item]:
        return [item for item in self.items if item.status == OPEN]

    def names(self, status: str | None = OPEN) -> list[str]:
        return sorted(item.summary for item in self.items if status is None or item.status == status)

    def calls(self, service: str) -> list[dict[str, Any]]:
        """Die Rümpfe der ausgeführten Aufrufe eines Dienstes, etwa ``add_item``."""
        return [write.data for write in self.writes if write.service == service]

    def attempts(self, service: str) -> int:
        """Wie oft der Abgleich einen Dienst aufrufen wollte, auch wenn HA mit einem Fehler antwortete."""
        return sum(1 for request in self.requests if request.url.path == f"/api/services/todo/{service}")

    # ------------------------------------------------------------------ Die Schnittstelle

    def _same(self, left: str, right: str) -> bool:
        if self.behaviour.fold:
            return bring_key(left) == bring_key(right)
        return left == right

    def _visible(self) -> list[Item]:
        return [item for item in self.items if item.hidden == 0]

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        assert request.url.host == "ha.example", request.url
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return httpx2.Response(401, text="401: Unauthorized")
        path = request.url.path
        failure = self.failures.get(path.rsplit("/", 1)[-1], self.failures.get("*"))
        if isinstance(failure, Exception):
            raise failure
        if failure is not None:
            return httpx2.Response(failure, json={"message": "Fehler"})

        if request.method == "GET" and path == f"/api/states/{self.entity}":
            return self._state()
        if request.method == "GET" and path.startswith("/api/states/"):
            return httpx2.Response(404, json={"message": "Entity not found."})
        if request.method != "POST" or not path.startswith("/api/services/todo/"):
            return httpx2.Response(404, json={"message": "Not found"})
        data = json.loads(request.content)
        if data.get("entity_id") != self.entity:
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

    def _state(self) -> httpx2.Response:
        if self.state_override is not None:
            state = self.state_override
        elif self.restarting and self.behaviour.restart == "unavailable":
            self.restarting -= 1
            state = "unavailable"
        elif self.restarting and self.behaviour.restart == "empty":
            state = "0"
        else:
            state = str(sum(1 for item in self._visible() if item.status == OPEN))
        return httpx2.Response(200, json={"entity_id": self.entity, "state": state, "attributes": {}})

    def _get_items(self, data: dict[str, Any]) -> httpx2.Response:
        self.reads += 1
        wanted = set(data.get("status") or (OPEN, COMPLETED))
        if not self.behaviour.completed:
            wanted.discard(COMPLETED)
        shown: list[Item] = []
        if self.restarting and self.behaviour.restart == "empty":
            self.restarting -= 1
        else:
            shown = [item for item in self._visible() if item.status in wanted]
        for item in self.items:
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
            200, json={"changed_states": [], "service_response": {self.entity: {"items": items}}}
        )

    def _add_item(self, data: dict[str, Any]) -> httpx2.Response:
        name = data["item"]
        stored = name if self.behaviour.truncate is None else name[: self.behaviour.truncate]
        description = data.get("description")
        existing_open = next(
            (item for item in self.items if item.status == OPEN and self._same(item.summary, stored)), None
        )
        visible_user = any(
            id(item) in self._last_visible and item.by == "user" and item.status == OPEN
            for item in self.items
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
                (
                    item
                    for item in self.items
                    if item.status == COMPLETED and self._same(item.summary, stored)
                ),
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
        self.items.append(item)
        write.target = item
        write.created = True
        return httpx2.Response(200, json=[])

    def _lookup(self, value: str) -> Item | None:
        """Wie HA: die uid oder genau der Name eines Artikels, den HA schon kennt."""
        for item in self._visible():
            if item.uid == value or item.summary == value:
                return item
        return None

    def _update_item(self, data: dict[str, Any]) -> httpx2.Response:
        item = self._lookup(data["item"])
        self.writes.append(Write("update_item", data, item))
        if item is None:
            return httpx2.Response(400, json={"message": "Unable to find To-do item"})
        if "status" in data:
            item.status = data["status"]
        if "description" in data:
            item.description = data["description"]
        return httpx2.Response(200, json=[])

    def _remove_item(self, data: dict[str, Any]) -> httpx2.Response:
        values = data["item"] if isinstance(data["item"], list) else [data["item"]]
        found = [self._lookup(value) for value in values]
        self.writes.append(Write("remove_item", data, found[0] if found else None))
        if any(item is None for item in found):
            return httpx2.Response(400, json={"message": "Unable to find To-do item"})
        for item in found:
            if item in self.items:
                self.items.remove(item)
        return httpx2.Response(200, json=[])


def violations(ha: FakeHA) -> list[str]:
    """Was in keiner Variante geschehen darf (docs/integrationen.md, 5)."""
    problems: list[str] = []
    keys: dict[str, int] = {}
    for item in ha.open_items():
        if item.by == "stowly":
            keys[bring_key(item.summary)] = keys.get(bring_key(item.summary), 0) + 1
    for key, count in keys.items():
        if count > 1:
            problems.append(f"Stowly hat {key!r} {count}-mal offen angelegt")
    for write in ha.writes:
        if write.service in ("update_item", "remove_item") and write.target is not None:
            if write.target.by != "stowly":
                problems.append(f"fremder Artikel geschrieben: {write.service} {write.data}")
        if write.service == "add_item" and write.visible_user_item:
            problems.append(f"add_item für einen sichtbaren fremden Artikel: {write.data}")
    return problems
