/**
 * Einstellungen → „KI-Vorschläge" auf der Attrappe (docs/plan-0.6.md, 3): Schlüssel eintragen (mit
 * derselben Vorprüfung wie am Server), ersetzen, entfernen; „Prüfen" mit Abstand; das Modell, sofort
 * gespeichert; der Tageszähler; ein Schlüssel aus der Umgebung ist gesperrt; der Hinweis zum
 * Datenschutz steht immer da; die Zeile unter „Über".
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { AI_KEY_LOST, type MockCore, type MockScenario } from "@/mock";

import { describeAi } from ".";
import { AI_PRIVACY, aiCheckTone, ANTHROPIC_CONSOLE } from "./AiSection";

/** Ein Schlüssel in der richtigen Form; ausgedacht. */
const KEY = "sk-ant-api03-attrappe-0123456789abcdefghijklmnopqrstuvwxyz";

let nowMs = Date.parse("2026-11-17T10:00:00.000Z");

function open(scenarios: MockScenario[] = []): MockCore {
  nowMs = Date.parse("2026-11-17T10:00:00.000Z");
  return renderApp({ scenarios, now: () => new Date(nowMs) }, ROUTES.settings);
}

/** Der Abschnitt, sobald er nachgeladen ist und die Einrichtung vom Server kennt. */
async function section(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Einstellungen", level: 1 });
  const region = await screen.findByRole("region", { name: "KI-Vorschläge" });
  await within(region).findByText("Vorschläge von Claude");
  return region;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Schlüssel", () => {
  it("prüft die Form vorab wie der Server, speichert und zeigt danach nur noch „gespeichert“", async () => {
    const core = open();
    const update = vi.spyOn(core.ai, "update");
    const region = await section();
    expect(within(region).getByText("aus")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Prüfen" })).toBeDisabled();

    const field = within(region).getByLabelText("API-Schlüssel von Anthropic");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveValue("");

    await userEvent.type(field, "sk-falsch");
    await userEvent.click(within(region).getByRole("button", { name: "Speichern" }));
    expect(await within(region).findByText(/beginnt mit sk-ant- und enthält weder Leerzeichen noch Umlaute/)).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "sk-ant-admin01-abc");
    await userEvent.click(within(region).getByRole("button", { name: "Speichern" }));
    expect(await within(region).findByText(/Das ist ein Admin-Schlüssel/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    await userEvent.clear(field);
    await userEvent.type(field, `  ${KEY}  `);
    await userEvent.click(within(region).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ key: KEY }));
    expect(await screen.findByText("API-Schlüssel gespeichert. „Prüfen“ zeigt, ob Anthropic ihn annimmt.")).toBeInTheDocument();
    expect(await within(region).findByRole("button", { name: "Ersetzen" })).toBeInTheDocument();
    expect(within(region).queryByLabelText("API-Schlüssel von Anthropic")).not.toBeInTheDocument();
    expect(within(region).getByText("eingerichtet")).toBeInTheDocument();
    expect(within(region).getByText(/Er liegt nur auf dem Server und in keiner Sicherung\./)).toBeInTheDocument();
    expect(region).not.toHaveTextContent(KEY);
  });

  it("ersetzt und entfernt den Schlüssel, Entfernen erst nach Rückfrage", async () => {
    const core = open(["ai-ready"]);
    const update = vi.spyOn(core.ai, "update");
    const region = await section();
    await userEvent.click(within(region).getByRole("button", { name: "Ersetzen" }));
    expect(within(region).getByLabelText("API-Schlüssel von Anthropic")).toHaveValue("");
    await userEvent.click(within(region).getByRole("button", { name: "Abbrechen" }));
    expect(within(region).queryByLabelText("API-Schlüssel von Anthropic")).not.toBeInTheDocument();

    await userEvent.click(within(region).getByRole("button", { name: "Entfernen" }));
    const dialog = screen.getByRole("dialog", { name: "API-Schlüssel entfernen?" });
    expect(dialog).toHaveTextContent("die Such-Links zu Cookidoo und Chefkoch bleiben");
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ key: null }));
    expect(await within(region).findByLabelText("API-Schlüssel von Anthropic")).toBeInTheDocument();
    expect(within(region).getByText("aus")).toBeInTheDocument();
  });

  it("sperrt einen Schlüssel aus der Umgebung; Prüfen und Modell gehen trotzdem", async () => {
    const core = open(["ai-env"]);
    const check = vi.spyOn(core.ai, "check");
    const region = await section();
    expect(within(region).getByText("Kommt aus der Umgebung (STOWLY_ANTHROPIC_API_KEY) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(within(region).getByText("gesetzt")).toBeInTheDocument();
    expect(within(region).queryByLabelText("API-Schlüssel von Anthropic")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Ersetzen" })).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Entfernen" })).not.toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: "Prüfen" }));
    expect(await within(region).findByText("Schlüssel und Modell passen (Claude Opus 5.5).")).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith({});
    expect(within(region).getByRole("combobox", { name: "Modell" })).toBeEnabled();
  });

  it("sagt, wenn der Schlüssel nach dem Zurückspielen fehlt", async () => {
    open(["ai-key-missing"]);
    const region = await section();
    expect(within(region).getByText(AI_KEY_LOST)).toBeInTheDocument();
    expect(within(region).getByLabelText("API-Schlüssel von Anthropic")).toBeInTheDocument();
  });
});

describe("Prüfen", () => {
  it("prüft den eingegebenen oder den gespeicherten Schlüssel, mit drei Sekunden Abstand", async () => {
    const core = open();
    const check = vi.spyOn(core.ai, "check");
    const region = await section();
    await userEvent.type(within(region).getByLabelText("API-Schlüssel von Anthropic"), KEY);
    expect(within(region).getByText("prüft den eingegebenen Schlüssel; kostet keine Tokens")).toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: "Prüfen" }));
    expect(await within(region).findByText("Schlüssel und Modell passen (Claude Opus 5.5).")).toBeInTheDocument();
    expect(check).toHaveBeenLastCalledWith({ key: KEY });
    // Nichts gespeichert: Prüfen ist nur Prüfen.
    expect(within(region).getByText("aus")).toBeInTheDocument();

    await userEvent.click(within(region).getByRole("button", { name: "Prüfen" }));
    expect(await within(region).findByText("Gerade erst geprüft. Bitte ein paar Sekunden warten.")).toBeInTheDocument();

    core.control.setAiCheckResult("key_rejected");
    nowMs += 5_000;
    await userEvent.click(within(region).getByRole("button", { name: "Prüfen" }));
    const result = await within(region).findByText("Anthropic lehnt den API-Schlüssel ab.");
    expect(result.closest("[role=status]")).toBeInTheDocument();
  });

  it("färbt das Ergebnis nach seinem Zustand", () => {
    expect(aiCheckTone({ state: "ok" })).toBe("success");
    expect(aiCheckTone({ state: "busy" })).toBe("warn");
    expect(aiCheckTone({ state: "unreachable" })).toBe("warn");
    expect(aiCheckTone({ state: "key_rejected" })).toBe("danger");
    expect(aiCheckTone({ state: "model_unavailable" })).toBe("danger");
  });
});

describe("Modell und Zähler", () => {
  it("speichert das Modell sofort und nennt Zähler und Hinweis", async () => {
    const core = open(["ai-ready"]);
    const update = vi.spyOn(core.ai, "update");
    const region = await section();
    expect(within(region).getByText("3 von 20")).toBeInTheDocument();
    const select = within(region).getByRole("combobox", { name: "Modell" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Opus 5.5: beste Vorschläge, etwa 7 Cent je Anfrage",
      "Claude Sonnet 5.5: etwa halb so teuer",
      "Claude Haiku 5.5: unter einem Cent je Anfrage",
    ]);
    expect(select).toHaveValue("claude-opus-5-5");
    await userEvent.selectOptions(select, "claude-haiku-5-5");
    await waitFor(() => expect(update).toHaveBeenCalledWith({ model: "claude-haiku-5-5" }));
    expect(await screen.findByText("Modell gespeichert: Claude Haiku 5.5.")).toBeInTheDocument();
    expect(within(region).getByRole("combobox", { name: "Modell" })).toHaveValue("claude-haiku-5-5");
    expect(region).toHaveTextContent("Claude Haiku 5.5: unter einem Cent je Anfrage. Gilt ab der nächsten Anfrage.");
  });
});

describe("Datenschutz und Über", () => {
  it("zeigt den Hinweis zum Datenschutz immer, auch ohne Schlüssel und ohne Server", async () => {
    open(["offline"]);
    await screen.findByRole("heading", { name: "Einstellungen", level: 1 });
    const region = await screen.findByRole("region", { name: "KI-Vorschläge" });
    expect(await within(region).findByText("Die Einrichtung der KI-Vorschläge kennt nur der Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(region).getByText(AI_PRIVACY)).toBeInTheDocument();
    expect(document.getElementById("ki-datenschutz")).toHaveTextContent("Nicht dabei: Zonen, Barcodes, Bilder, Packungs-IDs, Geräte, Einkaufsliste.");
    const console = within(region).getByRole("link", { name: "console.anthropic.com" });
    expect(console).toHaveAttribute("href", ANTHROPIC_CONSOLE);
    expect(console).toHaveAttribute("target", "_blank");
    expect(console).toHaveAttribute("rel", "noopener noreferrer");
    expect(region).toHaveTextContent("am besten einen eigenen mit Ausgabenlimit.");
  });

  it("nennt unter „Über“, ob Vorschläge von Claude eingerichtet sind", async () => {
    expect(describeAi(null).value).toBe("unbekannt");
    expect(describeAi({ configured: false, model: "claude-opus-5-5" }).value).toBe("aus");
    expect(describeAi({ configured: true, model: "claude-sonnet-5-5" })).toMatchObject({ value: "Anthropic (Claude Sonnet 5.5)" });

    open(["ai-ready"]);
    await section();
    const about = screen.getByRole("region", { name: "Über" });
    await waitFor(() => expect(about).toHaveTextContent("KI-Vorschläge"));
    expect(about).toHaveTextContent("Anthropic (Claude Opus 5.5)");
    expect(about).toHaveTextContent("dabei geht die Vorratsliste an Anthropic");
  });
});
