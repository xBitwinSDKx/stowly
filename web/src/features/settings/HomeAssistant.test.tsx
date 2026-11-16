/**
 * Home Assistant aus der App, auf der Attrappe (docs/plan-einrichtung-b.md, 3): Adresse und Token
 * eintragen, Verbindung prüfen, Liste wählen (oder von Hand), speichern; der Token gilt nur für
 * seine Adresse; Rückfrage vor einem Wechsel der Liste; Verbindung entfernen; Umgebung nur zu sehen;
 * der Sensor-Token mit fertigem YAML.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { HA_TOKEN_MISSING, MOCK_HA_URL } from "@/mock";

import { checkTone, listLabel, normalizeHaUrl, switchListText } from "./HaConnectionForm";
import { ENV_TOKEN_PLACEHOLDER } from "./haSnippet";

afterEach(() => {
  vi.restoreAllMocks();
});

async function haSection(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Einstellungen" });
  return screen.getByRole("region", { name: "Home Assistant und Bring!" });
}

describe("Bausteine", () => {
  it("schreiben Adresse, Listen und Rückfrage wie der Server", () => {
    expect(normalizeHaUrl(" HTTP://HomeAssistant.Local:8123/ ")).toBe("http://homeassistant.local:8123");
    expect(normalizeHaUrl("https://[FD00::1]:8123")).toBe("https://[fd00::1]:8123");
    expect(listLabel({ entity_id: "todo.a", name: "Einkaufsliste", open: 4 })).toBe("Einkaufsliste (4 offen)");
    expect(listLabel({ entity_id: "todo.b", name: "Baumarkt", open: null })).toBe("Baumarkt");
    expect(checkTone({ state: "ok" })).toBe("success");
    expect(checkTone({ state: "token_needed" })).toBe("info");
    expect(checkTone({ state: "unreachable" })).toBe("warn");
    expect(checkTone({ state: "unauthorized" })).toBe("danger");
    expect(switchListText(1)).toMatch(/^Gerade steht 1 Eintrag der Einkaufsliste in der bisherigen Liste\. Sie bleiben dort stehen; Stowly hakt nichts ab/);
    expect(switchListText(3)).toMatch(/^Gerade stehen 3 Einträge/);
  });
});

describe("Verbindung zu Home Assistant", () => {
  it("prüft Adresse und Token, bietet die Listen zur Auswahl und speichert; der Token ist danach nur „gespeichert“", async () => {
    // Die Uhr der Attrappe: Zwischen zwei Prüfungen müssen drei Sekunden liegen.
    let nowMs = Date.parse("2026-11-16T10:00:00.000Z");
    const core = renderApp({ now: () => new Date(nowMs) }, ROUTES.settings);
    const check = vi.spyOn(core.haConfig, "check");
    const update = vi.spyOn(core.haConfig, "update");
    const ha = await haSection();
    const url = await within(ha).findByLabelText("Adresse von Home Assistant");
    expect(within(ha).getByRole("button", { name: "Verbindung prüfen" })).toBeDisabled();

    // Ohne Token: HA antwortet, aber die Listen gibt es erst mit Token.
    await userEvent.type(url, MOCK_HA_URL);
    await userEvent.click(within(ha).getByRole("button", { name: "Verbindung prüfen" }));
    expect(await within(ha).findByText("Home Assistant antwortet; für die Listen braucht es den Token.")).toBeInTheDocument();
    expect(check).toHaveBeenLastCalledWith({ url: MOCK_HA_URL });

    const token = within(ha).getByLabelText("Zugangs-Token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveValue("");
    await userEvent.type(token, "ein-langer-token");
    nowMs += 5_000;
    await userEvent.click(within(ha).getByRole("button", { name: "Verbindung prüfen" }));
    expect(await within(ha).findByText("Verbindung zu Home Assistant steht; 2 To-do-Listen gefunden.")).toBeInTheDocument();
    expect(check).toHaveBeenLastCalledWith({ url: MOCK_HA_URL, token: "ein-langer-token" });

    const list = within(ha).getByRole("combobox", { name: "Liste in Home Assistant" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["Bitte wählen …", "Baumarkt (0 offen)", "Einkaufsliste (4 offen)", "Von Hand eingeben …"]);
    await userEvent.selectOptions(list, "todo.einkaufsliste");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ url: MOCK_HA_URL, entity: "todo.einkaufsliste", token: "ein-langer-token" }));
    expect(await screen.findByText("Verbindung zu Home Assistant gespeichert.")).toBeInTheDocument();
    expect(await within(ha).findByRole("button", { name: "Ersetzen" })).toBeInTheDocument();
    expect(within(ha).queryByLabelText("Zugangs-Token")).not.toBeInTheDocument();
    expect(await within(ha).findByText("verbunden")).toBeInTheDocument();
    expect(ha).not.toHaveTextContent("ein-langer-token");
  });

  it("nimmt eine Liste auch von Hand und sagt, was fehlt", async () => {
    const core = renderApp({}, ROUTES.settings);
    const update = vi.spyOn(core.haConfig, "update");
    const ha = await haSection();
    await userEvent.click(await within(ha).findByRole("button", { name: "Speichern" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Bitte die Adresse von Home Assistant eingeben");
    await userEvent.type(within(ha).getByLabelText("Adresse von Home Assistant"), MOCK_HA_URL);
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Bitte den Zugangs-Token aus dem Profil von Home Assistant einfügen.");
    await userEvent.type(within(ha).getByLabelText("Zugangs-Token"), "token");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Bitte eine Liste wählen");
    // Ohne Prüfung steht das Feld für die Liste da.
    await userEvent.type(within(ha).getByLabelText("Liste in Home Assistant"), "Einkaufsliste");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Eine Liste heißt in Home Assistant todo.…");
    await userEvent.clear(within(ha).getByLabelText("Liste in Home Assistant"));
    await userEvent.type(within(ha).getByLabelText("Liste in Home Assistant"), "todo.vorrat");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ url: MOCK_HA_URL, entity: "todo.vorrat", token: "token" }));
  });

  it("verlangt für eine neue Adresse den Token noch einmal", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    const update = vi.spyOn(core.haConfig, "update");
    const ha = await haSection();
    const url = await within(ha).findByLabelText("Adresse von Home Assistant");
    expect(url).toHaveValue(MOCK_HA_URL);
    // Dieselbe Adresse, nur anders geschrieben: Der Token bleibt.
    await userEvent.clear(url);
    await userEvent.type(url, "HTTP://HomeAssistant.local:8123/");
    expect(within(ha).queryByLabelText("Zugangs-Token")).not.toBeInTheDocument();

    await userEvent.clear(url);
    await userEvent.type(url, "http://ha.example:8123");
    const token = within(ha).getByLabelText("Zugangs-Token");
    expect(ha).toHaveTextContent("Für eine neue Adresse braucht es den Token noch einmal");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Für eine neue Adresse braucht es den Token noch einmal.");
    expect(update).not.toHaveBeenCalled();
    await userEvent.type(token, "neu");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ url: "http://ha.example:8123", entity: "todo.einkaufsliste", token: "neu" }));
  });

  it("fragt vor einem Wechsel der Liste nach, wenn Einträge in Bring! stehen", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    // In den Beispielen stehen schon Einträge in Bring!.
    const linked = (await core.integrations.load()).ha.linked;
    expect(linked).toBeGreaterThan(1);
    const update = vi.spyOn(core.haConfig, "update");
    const ha = await haSection();
    await userEvent.click(await within(ha).findByRole("button", { name: "Verbindung prüfen" }));
    await within(ha).findByText(/To-do-Listen gefunden/);
    await userEvent.selectOptions(within(ha).getByRole("combobox", { name: "Liste in Home Assistant" }), "todo.baumarkt");
    await userEvent.click(within(ha).getByRole("button", { name: "Speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Liste wechseln?" });
    expect(dialog).toHaveTextContent(`Gerade stehen ${String(linked)} Einträge der Einkaufsliste in der bisherigen Liste. Sie bleiben dort stehen; Stowly hakt nichts ab`);
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Wechseln" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ url: MOCK_HA_URL, entity: "todo.baumarkt" }));
  });

  it("entfernt die Verbindung nach Rückfrage", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    const update = vi.spyOn(core.haConfig, "update");
    const ha = await haSection();
    await userEvent.click(await within(ha).findByRole("button", { name: "Verbindung entfernen" }));
    const dialog = await screen.findByRole("dialog", { name: "Verbindung entfernen?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ url: null, entity: null, token: null }));
    expect(await within(ha).findByText(/^Nicht eingerichtet\. Unten Adresse, Token und Liste eintragen\./)).toBeInTheDocument();
  });

  it("zeigt eine Verbindung aus der Umgebung nur an und prüft sie", async () => {
    const core = renderApp({ scenarios: ["ha-env"] }, ROUTES.settings);
    const check = vi.spyOn(core.haConfig, "check");
    const ha = await haSection();
    expect(await within(ha).findByText("Kommt aus der Umgebung (STOWLY_HA_URL, STOWLY_HA_TOKEN, STOWLY_HA_TODO_ENTITY) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(within(ha).getByText(MOCK_HA_URL)).toBeInTheDocument();
    expect(within(ha).queryByLabelText("Adresse von Home Assistant")).not.toBeInTheDocument();
    expect(within(ha).queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    await userEvent.click(within(ha).getByRole("button", { name: "Verbindung prüfen" }));
    expect(check).toHaveBeenCalledWith({});
    const lists = await within(ha).findByRole("list", { name: "Listen in Home Assistant" });
    expect(within(lists).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Baumarkt (0 offen) · todo.baumarkt", "Einkaufsliste (4 offen) · todo.einkaufsliste"]);
  });

  it("sagt nach einem Zurückspielen, dass der Token fehlt, und fragt ihn ab", async () => {
    renderApp({ scenarios: ["ha-token-missing"] }, ROUTES.settings);
    const ha = await haSection();
    expect(await within(ha).findByText("Der Abgleich mit Bring! ist aus")).toBeInTheDocument();
    expect(await within(ha).findByLabelText("Zugangs-Token")).toHaveValue("");
    // Der Satz des Servers steht einmal da, nicht doppelt.
    expect(within(ha).getAllByText(HA_TOKEN_MISSING)).toHaveLength(1);
  });

  it("nennt eine Störung beim Prüfen", async () => {
    const core = renderApp({}, ROUTES.settings);
    vi.spyOn(core.haConfig, "check").mockRejectedValue(new CoreError("rate_limited", "", { retry_after_s: 2 }));
    const ha = await haSection();
    await userEvent.type(await within(ha).findByLabelText("Adresse von Home Assistant"), MOCK_HA_URL);
    await userEvent.click(within(ha).getByRole("button", { name: "Verbindung prüfen" }));
    expect(await within(ha).findByRole("alert")).toHaveTextContent("Gerade erst geprüft. Bitte ein paar Sekunden warten.");
  });
});

describe("Sensor für Home Assistant", () => {
  it("erzeugt den Sensor-Token und zeigt das YAML für diese Adresse", async () => {
    const core = renderApp({}, ROUTES.settings);
    const create = vi.spyOn(core.haConfig, "createSensorToken");
    const ha = await haSection();
    await userEvent.click(await within(ha).findByRole("button", { name: "Sensor-Token erzeugen" }));
    const token = await create.mock.results[0]?.value;
    const secrets = await within(ha).findByRole("group", { name: "secrets.yaml für Home Assistant" });
    expect(secrets).toHaveTextContent(`stowly_summary_auth: "Bearer ${String(token)}"`);
    const configuration = within(ha).getByRole("group", { name: "configuration.yaml für Home Assistant" });
    expect(configuration).toHaveTextContent(`resource: ${window.location.origin}/api/ha/summary`);
    expect(configuration).toHaveTextContent(`resource: ${window.location.origin}/api/ha/stock`);
    expect(configuration).toHaveTextContent("sensor.stowly_bestand");
    // Über http: kein verify_ssl, aber ein Hinweis auf die unverschlüsselte Verbindung.
    expect(configuration).not.toHaveTextContent("verify_ssl");
  });

  it("zeigt einen gespeicherten Token erst auf Wunsch, erzeugt neu und entfernt nach Rückfrage", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    const remove = vi.spyOn(core.haConfig, "deleteSensorToken");
    const ha = await haSection();
    expect(within(ha).queryByRole("group", { name: "secrets.yaml für Home Assistant" })).not.toBeInTheDocument();
    await userEvent.click(await within(ha).findByRole("button", { name: "YAML zeigen" }));
    const first = (await within(ha).findByRole("group", { name: "secrets.yaml für Home Assistant" })).textContent;
    await userEvent.click(within(ha).getByRole("button", { name: "Neu erzeugen" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Neuen Sensor-Token erzeugen?" })).getByRole("button", { name: "Neu erzeugen" }));
    await waitFor(() => expect(within(ha).getByRole("group", { name: "secrets.yaml für Home Assistant" }).textContent).not.toBe(first));
    await userEvent.click(within(ha).getByRole("button", { name: "Entfernen" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Sensor-Token entfernen?" })).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(await within(ha).findByRole("button", { name: "Sensor-Token erzeugen" })).toBeInTheDocument();
  });

  it("setzt bei einem Token aus der Umgebung einen Platzhalter ein", async () => {
    renderApp({ scenarios: ["ha-env"] }, ROUTES.settings);
    const ha = await haSection();
    expect(await within(ha).findByText("Kommt aus der Umgebung (STOWLY_HA_SUMMARY_TOKEN) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(within(ha).getByRole("group", { name: "secrets.yaml für Home Assistant" })).toHaveTextContent(`"Bearer ${ENV_TOKEN_PLACEHOLDER}"`);
    expect(ha).toHaveTextContent("Den Platzhalter durch den Token aus STOWLY_HA_SUMMARY_TOKEN ersetzen.");
    expect(within(ha).queryByRole("button", { name: "Sensor-Token erzeugen" })).not.toBeInTheDocument();
  });
});
