/**
 * „Was koche ich?" auf der Attrappe (docs/plan-0.6.md): Zutaten mit Vorwahl, Chips zum Ändern, die
 * Such-Links zu Cookidoo und Chefkoch, Vorschläge von Claude mit ihren Karten, die Hinweise ohne
 * Einrichtung und ohne Server und die Sätze, wenn ein Auftrag nicht startet oder scheitert.
 *
 * Beispieldaten (src/mock/sample.ts): bald fällig sind Butter (4 Tage), Passierte Tomaten (9) und
 * Weizenmehl (12), abgelaufen Haferflocken; die Vorwahl nimmt die ersten drei.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, cookPath, isOpenItem, ROUTES, type CookJob, type Live } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { AI_KEY_LOST, sampleUuid, type MockCore, type MockScenario } from "@/mock";
import { setTestViewport } from "@/ui/testing";

import { failureNotice, modelName, startNotice, waitText } from "./texts";

/** Kennungen der Beispielprodukte (src/mock/sample.ts). */
const IDS = {
  rice: sampleUuid(2, 1),
  spaghetti: sampleUuid(2, 2),
  tomatoes: sampleUuid(2, 3),
  flour: sampleUuid(2, 6),
  butter: sampleUuid(2, 9),
};

/** Eine feste Uhr: Abstände der Attrappe (30 Sekunden je Gerät) werden so genau. */
const NOW = Date.parse("2026-11-17T10:00:00.000Z");

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

function open(scenarios: MockScenario[] = [], path: string = ROUTES.cook): MockCore {
  return renderApp({ scenarios, now: () => new Date(NOW) }, path);
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Was koche ich?", level: 1 });
}

/** Die Begriffe der Chips in ihrer Reihenfolge. */
function chips(): string[] {
  return within(screen.getByRole("list", { name: "Gewählte Zutaten" }))
    .queryAllByRole("button", { name: /^Suchbegriff ändern: / })
    .map((button) => button.firstElementChild?.textContent ?? "");
}

function link(name: string): HTMLAnchorElement {
  return screen.getByRole("link", { name }) as HTMLAnchorElement;
}

function claude(): HTMLElement {
  return screen.getByRole("region", { name: "Vorschläge von Claude" });
}

async function ask(): Promise<void> {
  await userEvent.click(await within(claude()).findByRole("button", { name: "Vorschläge von Claude" }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Zutaten und Such-Links", () => {
  it("wählt vor, was bald abläuft, und sucht damit bei Cookidoo und Chefkoch in einem neuen Tab", async () => {
    open();
    await ready();
    expect(chips()).toEqual(["Butter", "Passierte Tomaten", "Weizenmehl"]);
    expect(screen.getByRole("button", { name: "Suchbegriff ändern: Butter, in 4 Tagen" })).toBeInTheDocument();

    const cookidoo = link("Bei Cookidoo suchen");
    const chefkoch = link("Bei Chefkoch suchen");
    expect(cookidoo.href).toBe("https://cookidoo.de/search/de-DE?query=Butter%20Passierte%20Tomaten%20Weizenmehl");
    expect(chefkoch.href).toBe("https://www.chefkoch.de/rs/s0/Butter+Passierte+Tomaten+Weizenmehl/Rezepte.html");
    for (const anchor of [cookidoo, chefkoch]) {
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("ändert einen Begriff auf einen Tipp, nur für diese Seite", async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^Suchbegriff ändern: Weizenmehl/ }));
    const field = screen.getByRole("textbox", { name: "Suchbegriff für Weizenmehl Type 405" });
    expect(field).toHaveValue("Weizenmehl");
    await userEvent.clear(field);
    await userEvent.type(field, "Mehl{Enter}");
    expect(chips()).toEqual(["Butter", "Passierte Tomaten", "Mehl"]);
    expect(link("Bei Chefkoch suchen").href).toBe("https://www.chefkoch.de/rs/s0/Butter+Passierte+Tomaten+Mehl/Rezepte.html");

    // Leer heißt: zurück zum abgeleiteten Begriff; Escape verwirft.
    await userEvent.click(screen.getByRole("button", { name: /^Suchbegriff ändern: Mehl/ }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Suchbegriff für Weizenmehl Type 405" }));
    await userEvent.keyboard("{Enter}");
    expect(chips()).toEqual(["Butter", "Passierte Tomaten", "Weizenmehl"]);
    await userEvent.click(screen.getByRole("button", { name: /^Suchbegriff ändern: Butter/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Suchbegriff für Butter" }), "milch{Escape}");
    expect(chips()).toEqual(["Butter", "Passierte Tomaten", "Weizenmehl"]);
  });

  it("nimmt Zutaten heraus und holt andere aus dem Vorrat dazu, höchstens fünf", async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Entfernen: Passierte Tomaten" }));
    expect(chips()).toEqual(["Butter", "Weizenmehl"]);

    await userEvent.click(screen.getByRole("button", { name: "Zutat hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Zutat hinzufügen" });
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Im Vorrat suchen" }), "spag");
    const options = within(within(dialog).getByRole("list", { name: "Zutaten aus dem Vorrat" })).getAllByRole("button");
    expect(options.map((option) => option.firstElementChild?.textContent)).toEqual(["Spaghetti"]);
    expect(options[0]).toHaveTextContent("Spaghetti · Pastaria · 500 g · MHD");
    await userEvent.click(options[0] as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Zutat hinzufügen" })).not.toBeInTheDocument();
    expect(chips()).toEqual(["Butter", "Weizenmehl", "Spaghetti"]);

    for (const name of ["Reis", "Linsen"]) {
      await userEvent.click(screen.getByRole("button", { name: "Zutat hinzufügen" }));
      const picker = screen.getByRole("dialog", { name: "Zutat hinzufügen" });
      await userEvent.type(within(picker).getByRole("searchbox", { name: "Im Vorrat suchen" }), name);
      await userEvent.click(within(within(picker).getByRole("list", { name: "Zutaten aus dem Vorrat" })).getAllByRole("button")[0] as HTMLElement);
    }
    expect(chips()).toEqual(["Butter", "Weizenmehl", "Spaghetti", "Basmati Reis", "Rote Linsen"]);
    expect(screen.getByRole("button", { name: "Zutat hinzufügen" })).toBeDisabled();
    expect(screen.getByText(/Höchstens 5 Zutaten/)).toBeInTheDocument();

    for (const name of ["Butter", "Weizenmehl", "Spaghetti", "Basmati Reis", "Rote Linsen"]) {
      await userEvent.click(screen.getByRole("button", { name: `Entfernen: ${name}` }));
    }
    expect(chips()).toEqual([]);
    expect(screen.getByText("Erst eine Zutat wählen, dann lässt sich nach Rezepten suchen.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bei Cookidoo suchen" })).not.toBeInTheDocument();
  });

  it("wählt mit ?mit= genau die genannten Produkte vor", async () => {
    open([], cookPath([IDS.spaghetti, IDS.rice]));
    await ready();
    expect(chips()).toEqual(["Spaghetti", "Basmati Reis"]);
  });

  it("kommt von den Warnungen mit den dringendsten Produkten, ohne Platzhalter", async () => {
    open([], ROUTES.warnings);
    await screen.findByRole("heading", { name: "Warnungen", level: 1 });
    const button = screen.getByRole("link", { name: "Was koche ich daraus?" });
    expect(button).toHaveAttribute("href", cookPath([IDS.butter, IDS.tomatoes, IDS.flour]));
    await userEvent.click(button);
    await ready();
    expect(chips()).toEqual(["Butter", "Passierte Tomaten", "Weizenmehl"]);
  });

  it("sagt bei leerem Vorrat, dass es nichts zu kochen gibt", async () => {
    open(["empty", "ai-ready"]);
    await ready();
    expect(screen.getByRole("heading", { name: "Nichts im Vorrat" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Vorschläge von Claude" })).not.toBeInTheDocument();
  });

  it("baut die Links auch ohne Server", async () => {
    open(["offline", "ai-ready"]);
    await ready();
    expect(link("Bei Cookidoo suchen").href).toContain("cookidoo.de");
    expect(await within(claude()).findByText(/gehen nur über den Stowly-Server, und der ist gerade nicht erreichbar/)).toBeInTheDocument();
    expect(within(claude()).queryByRole("button", { name: "Vorschläge von Claude" })).not.toBeInTheDocument();
  });
});

describe("Vorschläge von Claude", () => {
  it("führt ohne Schlüssel in die Einstellungen", async () => {
    open();
    await ready();
    expect(await within(claude()).findByText("Noch nicht eingerichtet")).toBeInTheDocument();
    expect(within(claude()).getByRole("link", { name: "Einrichten" })).toHaveAttribute("href", `${ROUTES.settings}#ki`);
    expect(within(claude()).queryByRole("button", { name: "Vorschläge von Claude" })).not.toBeInTheDocument();
  });

  it("sagt, wenn der Schlüssel nach dem Zurückspielen fehlt", async () => {
    open(["ai-key-missing"]);
    await ready();
    expect(await within(claude()).findByText(AI_KEY_LOST)).toBeInTheDocument();
    expect(within(claude()).getByText("API-Schlüssel fehlt")).toBeInTheDocument();
  });

  it("schickt Wunsch und Zutaten, zeigt drei Karten und zählt die Anfrage", async () => {
    const core = open(["ai-ready"]);
    const start = vi.spyOn(core.ai, "start");
    await ready();
    const region = claude();
    expect(await within(region).findByText("heute 3 von 20")).toBeInTheDocument();
    expect(within(region).getByText("Die Vorratsliste geht an Anthropic.", { exact: false })).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "Was genau?" })).toHaveAttribute("href", `${ROUTES.settings}#ki-datenschutz`);

    const wish = within(region).getByRole("textbox", { name: "Wunsch" });
    await userEvent.type(wish, "vegetarisch, schnell");
    expect(within(region).getByText("20 von 200 Zeichen")).toBeInTheDocument();
    await ask();

    expect(start).toHaveBeenCalledWith({ wish: "vegetarisch, schnell", focus: [IDS.butter, IDS.tomatoes, IDS.flour] });
    const cards = await within(region).findAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(await within(region).findByText("heute 4 von 20")).toBeInTheDocument();

    // Die Karte mit der Butter steht vorn: Sie nutzt die meisten gewählten Zutaten.
    const card = cards[0] as HTMLElement;
    expect(within(card).getByRole("heading", { name: "Spaghetti mit Tomaten-Butter-Soße" })).toBeInTheDocument();
    expect(card).toHaveTextContent("25 Min.");
    expect(card).toHaveTextContent("Aus dem Vorrat");
    const butter = within(card).getByText("Butter").closest("li") as HTMLElement;
    expect(butter).toHaveTextContent("läuft in 4 Tagen ab");
    expect(card).toHaveTextContent("Vorschlag von Claude Opus 5.5; Allergene und Haltbarkeit selbst prüfen.");

    // Ähnliches suchen: nur bei den beiden festen Rechnern, mit dem Suchbegriff des Vorschlags.
    expect((within(card).getByRole("link", { name: "Ähnliches bei Cookidoo" }) as HTMLAnchorElement).href).toBe(
      "https://cookidoo.de/search/de-DE?query=Tomatenso%C3%9Fe%20Butter",
    );
    expect((within(card).getByRole("link", { name: "Ähnliches bei Chefkoch" }) as HTMLAnchorElement).href).toBe(
      "https://www.chefkoch.de/rs/s0/Tomatenso%C3%9Fe+Butter/Rezepte.html",
    );

    // Die Zubereitung klappt auf.
    expect(within(card).queryByRole("list", { name: "Zubereitung" })).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Zubereitung zeigen" }));
    expect(within(within(card).getByRole("list", { name: "Zubereitung" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("setzt das Fehlende auf die Einkaufsliste, nur das Abgehakte, und nichts doppelt", async () => {
    const core = open(["ai-ready"]);
    await ready();
    await ask();
    await within(claude()).findAllByRole("article");
    const card = within(claude()).getByRole("heading", { name: "Lachs mit Erbsenreis" }).closest("article") as HTMLElement;
    const missing = within(card).getAllByRole("checkbox");
    expect(missing.map((box) => box.closest("label")?.textContent)).toEqual(["Zitrone", "Dill"]);
    expect(missing.every((box) => (box as HTMLInputElement).checked)).toBe(true);

    await userEvent.click(missing[1] as HTMLElement);
    await userEvent.click(within(card).getByRole("button", { name: "Fehlendes auf die Einkaufsliste" }));
    expect(await screen.findByText("„Zitrone“ steht jetzt auf der Einkaufsliste.")).toBeInTheDocument();
    const openTexts = () => value(core.data.shoppingItems).filter(isOpenItem).map((item) => item.text);
    expect(openTexts()).toContain("Zitrone");
    expect(openTexts()).not.toContain("Dill");

    // Noch einmal: steht schon da, nichts Doppeltes.
    await userEvent.click(within(card).getByRole("button", { name: "Fehlendes auf die Einkaufsliste" }));
    expect(await screen.findByText("„Zitrone“ steht schon auf der Einkaufsliste.")).toBeInTheDocument();
    expect(openTexts().filter((text) => text === "Zitrone")).toHaveLength(1);

    // Alles abgewählt: nichts zu tun.
    await userEvent.click(missing[0] as HTMLElement);
    expect(within(card).getByRole("button", { name: "Fehlendes auf die Einkaufsliste" })).toBeDisabled();
  });

  it("zeigt Claudes Texte nur als Text und baut keine Verweise daraus", async () => {
    const core = open(["ai-ready"]);
    await ready();
    const job: CookJob = {
      id: "0123456789abcdef0123456789abcdef",
      state: "done",
      started_at: new Date(NOW).toISOString(),
      finished_at: new Date(NOW).toISOString(),
      result: {
        ideas: [
          {
            title: '<img src="x" onerror="alert(1)">',
            summary: "Siehe https://evil.example und [hier](https://evil.example).",
            minutes: null,
            uses: [{ product_id: IDS.butter, name: "Butter" }, { product_id: sampleUuid(2, 99), name: "Weg" }],
            missing: ["<b>Zwiebel</b>"],
            steps: ["<script>alert(1)</script>"],
            search: "../../evil.example?x=1",
          },
        ],
        model: "claude-opus-4-8",
        fallback: true,
        stock_count: 14,
        truncated: false,
      },
      problem: null,
      used_today: 4,
      daily_limit: 20,
    };
    vi.spyOn(core.ai, "start").mockResolvedValue({ ...job, state: "running", finished_at: null, result: null });
    vi.spyOn(core.ai, "wait").mockResolvedValue(job);
    await ask();
    const card = await within(claude()).findByRole("article");
    expect(within(card).getByRole("heading", { name: '<img src="x" onerror="alert(1)">' })).toBeInTheDocument();
    expect(card.querySelector("img, script, b")).toBeNull();
    expect(within(card).getByText("<b>Zwiebel</b>")).toBeInTheDocument();
    // Verweise nur zu den beiden festen Rechnern, keiner aus dem Text.
    const hosts = within(card)
      .getAllByRole("link")
      .map((anchor) => new URL((anchor as HTMLAnchorElement).href).host);
    expect(hosts).toEqual(["cookidoo.de", "www.chefkoch.de"]);
    // Ein Produkt, das es hier nicht (mehr) gibt, steht mit dem Namen vom Server da.
    expect(card).toHaveTextContent("nicht mehr im Bestand");
    // Ein Ersatzmodell wird genannt, auch eins, das die App nicht kennt.
    expect(within(claude()).getByText(/geantwortet hat ein Ersatzmodell: Claude Opus 4\.8/)).toBeInTheDocument();
    expect(card).toHaveTextContent("Vorschlag von Claude Opus 4.8;");
  });

  it("zeigt den Fortschritt, solange Claude überlegt, und findet nach einem Wechsel der Seite zurück", async () => {
    const core = open(["ai-slow"]);
    const wait = vi.spyOn(core.ai, "wait");
    await ready();
    await ask();
    const progress = await within(claude()).findByText("Claude überlegt …");
    expect(progress.closest("[role=status]")).toHaveTextContent("Das dauert bis zu einer Minute.");
    expect(within(claude()).getByRole("button", { name: "Vorschläge von Claude" })).toHaveAttribute("aria-busy", "true");

    // Weg und zurück: Die Seite fragt nach dem letzten Auftrag und wartet weiter.
    await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Bestand" }));
    await screen.findByRole("heading", { name: "Bestand", level: 1 });
    const lastJob = vi.spyOn(core.ai, "lastJob");
    await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Was koche ich?" }));
    await ready();
    expect(await within(claude()).findByText("Claude überlegt …")).toBeInTheDocument();
    expect(lastJob).toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("zeigt nach einem Wechsel der Seite die fertigen Vorschläge wieder", async () => {
    open(["ai-ready"]);
    await ready();
    await ask();
    expect(await within(claude()).findAllByRole("article")).toHaveLength(3);
    await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Einstellungen" }));
    await screen.findByRole("heading", { name: "Einstellungen", level: 1 });
    await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Was koche ich?" }));
    await ready();
    expect(await within(claude()).findAllByRole("article")).toHaveLength(3);
  });
});

describe("Wenn es nicht geht", () => {
  it("sagt beim Tageslimit: morgen wieder", async () => {
    open(["ai-limit"]);
    await ready();
    expect(await within(claude()).findByText("heute 20 von 20")).toBeInTheDocument();
    await ask();
    const alert = await within(claude()).findByRole("alert");
    expect(alert).toHaveTextContent("Für heute ist Schluss");
    expect(alert).toHaveTextContent("Der Haushalt hat heute alle 20 Anfragen gestellt. Morgen wieder.");
  });

  it("nennt die Wartezeit, wenn dasselbe Gerät zu schnell wieder fragt", async () => {
    open(["ai-ready"]);
    await ready();
    await ask();
    await within(claude()).findAllByRole("article");
    await ask();
    const alert = await within(claude()).findByRole("alert");
    expect(alert).toHaveTextContent("Eben erst gefragt");
    expect(alert).toHaveTextContent("Jedes Gerät kann alle 30 Sekunden fragen. Noch einmal in 30 Sekunden.");
  });

  it("rät bei einer Ablehnung, den Wunsch anders zu formulieren", async () => {
    open(["ai-refused"]);
    await ready();
    await ask();
    const alert = await within(claude()).findByRole("alert");
    expect(alert).toHaveTextContent("Claude hat abgelehnt");
    expect(alert).toHaveTextContent("Den Wunsch anders formulieren und noch einmal versuchen.");
    expect(within(alert).queryByRole("link")).not.toBeInTheDocument();
  });

  it("vertröstet, wenn Anthropic bremst, und zählt die Anfrage nicht", async () => {
    open(["ai-busy", "ai-ready"]);
    await ready();
    expect(await within(claude()).findByText("heute 3 von 20")).toBeInTheDocument();
    await ask();
    const alert = await within(claude()).findByRole("alert");
    expect(alert).toHaveTextContent("Anthropic bremst gerade");
    expect(alert).toHaveTextContent("Bitte später noch einmal versuchen, frühestens in 30 Sekunden.");
    expect(await within(claude()).findByText("heute 3 von 20")).toBeInTheDocument();
  });

  it("führt bei einem abgelehnten Schlüssel in die Einstellungen", async () => {
    const core = open(["ai-ready"]);
    core.control.setCookOutcome("key_rejected");
    await ready();
    await ask();
    const alert = await within(claude()).findByRole("alert");
    expect(alert).toHaveTextContent("Schlüssel abgelehnt");
    expect(within(alert).getByRole("link", { name: "Zu den Einstellungen" })).toHaveAttribute("href", `${ROUTES.settings}#ki`);
  });

  it("sagt, wenn der Server einen Fehler meldet, statt still zu bleiben", async () => {
    const core = open(["ai-ready"]);
    await ready();
    vi.spyOn(core.ai, "start").mockRejectedValue(new CoreError("conflict", "Im Bestand ist kein Produkt mit Namen.", { status: 409 }));
    await ask();
    expect(await within(claude()).findByRole("alert")).toHaveTextContent("Nichts im Vorrat");
  });

  it("geht am Handy ebenso", async () => {
    setTestViewport(375);
    open(["ai-ready"]);
    await ready();
    expect(chips()).toHaveLength(3);
    await ask();
    expect(await within(claude()).findAllByRole("article")).toHaveLength(3);
  });
});

describe("Sätze", () => {
  it("nennen Modelle beim Namen, auch unbekannte Ersatzmodelle", () => {
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(modelName("claude-fable-5")).toBe("Claude Fable 5");
    expect(modelName("etwas anderes")).toBe("etwas anderes");
  });

  it("sagen Wartezeiten in Worten", () => {
    expect(waitText(1)).toBe("in einer Sekunde");
    expect(waitText(29.2)).toBe("in 30 Sekunden");
    expect(waitText(600)).toBe("in 10 Minuten");
    expect(waitText(7_200)).toBe("in 2 Stunden");
  });

  it("haben für jeden Grund eines Fehlschlags einen Satz", () => {
    const reasons = ["refused", "key_rejected", "forbidden", "billing", "model_unavailable", "busy", "unavailable", "unreachable", "timeout", "incomplete", "error"] as const;
    for (const reason of reasons) {
      const notice = failureNotice({ reason, retry_after_s: null, message: "Satz des Servers." });
      expect(notice.title, reason).not.toBe("");
      expect(notice.settings, reason).toBe(["key_rejected", "forbidden", "billing", "model_unavailable"].includes(reason));
    }
    for (const reason of ["busy", "unavailable", "timeout"] as const) {
      expect(failureNotice({ reason, retry_after_s: null, message: "" }).text, reason).toContain("später noch einmal");
    }
    expect(failureNotice({ reason: "busy", retry_after_s: 120, message: "" }).text).toContain("später noch einmal versuchen, frühestens in 2 Minuten.");
    expect(failureNotice({ reason: "error", retry_after_s: null, message: "Satz des Servers." }).text).toContain("Satz des Servers.");
  });

  it("erklären, warum ein Auftrag nicht startet", () => {
    const limited = (reason: string, seconds?: number) => new CoreError("rate_limited", "x", { reason, ...(seconds === undefined ? {} : { retry_after_s: seconds }) });
    expect(startNotice(limited("daily_limit", 3_600), 20).text).toBe("Der Haushalt hat heute alle 20 Anfragen gestellt. Morgen wieder.");
    expect(startNotice(limited("busy", 12), 20).text).toContain("Noch einmal in 12 Sekunden.");
    expect(startNotice(limited("too_soon"), 20).text).toContain("Noch einmal gleich.");
    expect(startNotice(new CoreError("not_configured", "x", { reason: "lost" }), 20)).toMatchObject({ title: "API-Schlüssel fehlt", settings: true });
    expect(startNotice(new CoreError("not_configured", "x", { reason: "missing" }), 20)).toMatchObject({ title: "Kein API-Schlüssel", settings: true });
    expect(startNotice(new CoreError("conflict", "x"), 20).title).toBe("Nichts im Vorrat");
    expect(startNotice(new CoreError("offline", "x"), 20).text).toContain("Die Such-Links gehen trotzdem.");
    expect(startNotice(new CoreError("not_supported", "Noch nicht umgesetzt."), 20).text).toBe("Dieser Server kennt noch keine Vorschläge von Claude. Erst Stowly aktualisieren.");
    expect(startNotice(new CoreError("invalid", "Der Wunsch ist zu lang (höchstens 200 Zeichen)."), 20).text).toBe("Der Wunsch ist zu lang (höchstens 200 Zeichen).");
  });
});
