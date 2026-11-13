/**
 * Die App als Ganzes auf der Attrappe: Anmeldung, Rahmen, Navigation, Hinweise.
 * Zeigt zugleich, wie sich Ansichten mit `renderApp` (createMockCore) testen lassen.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES, type Core } from "@/contract";
import { createMockCore, MOCK_PASSWORD, MockScanPage } from "@/mock";
import { setTestViewport } from "@/ui/testing";

import { App } from "./App";
import { renderApp } from "./render.test-setup";

function mainNavigation(): HTMLElement {
  return screen.getByRole("navigation", { name: "Hauptnavigation" });
}

describe("App", () => {
  it("zeigt angemeldeten Geräten den Bestand im Rahmen", async () => {
    const core = renderApp();
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(screen.getByText("Packungen gesamt").nextElementSibling).toHaveTextContent(String(core.data.packages.get()?.length));
    expect(screen.getByRole("cell", { name: /Basmati Reis/ })).toBeInTheDocument();
    expect(within(mainNavigation()).getByRole("link", { name: "Bestand" })).toHaveAttribute("aria-current", "page");
  });

  it("wechselt über die Navigation die Ansicht", async () => {
    renderApp();
    await userEvent.click(within(mainNavigation()).getByRole("link", { name: "Zonen" }));
    expect(await screen.findByRole("heading", { name: "Zonen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bearbeiten: Gefrierschrank" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(ROUTES.zones);
  });

  it("führt über die kleinen Symbole und das Geräte-Menü in die weiteren Bereiche", async () => {
    renderApp();
    const more = screen.getByRole("navigation", { name: "Weitere Bereiche" });
    expect(within(more).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Warnungen", "Lösch-Historie", "Drucker", "Sync-Status"]);

    await userEvent.click(within(more).getByRole("link", { name: "Lösch-Historie" }));
    expect(await screen.findByRole("heading", { name: "Lösch-Historie" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Dieses Gerät/ }));
    const menu = screen.getByRole("menu", { name: "Geräte-Menü" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Einstellungen", "Sync-Status", "Lösch-Historie", "Drucker", "Abmelden"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Drucker" }));
    expect(await screen.findByRole("heading", { name: "Drucker" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("erreicht jede Adresse aus ROUTES", async () => {
    const titles: Record<string, string> = {
      [ROUTES.stock]: "Bestand",
      [ROUTES.zones]: "Zonen",
      [ROUTES.warnings]: "Warnungen",
      [ROUTES.history]: "Lösch-Historie",
      [ROUTES.printers]: "Drucker",
      [ROUTES.settings]: "Einstellungen",
      [ROUTES.sync]: "Sync-Status",
      [ROUTES.scan]: "Scannen",
    };
    for (const [path, title] of Object.entries(titles)) {
      renderApp({}, path);
      expect(await screen.findByRole("heading", { name: title, level: 1 }), path).toBeInTheDocument();
      cleanup();
    }
  });

  it("öffnet die Scan-Ansicht ohne Rahmen", async () => {
    renderApp({}, ROUTES.scan);
    expect(await screen.findByRole("heading", { name: "Scannen" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).not.toBeInTheDocument();
  });

  it("zeigt für unbekannte Adressen einen Weg zurück", async () => {
    renderApp({}, "/gibt-es-nicht");
    expect(await screen.findByRole("heading", { name: "Seite nicht gefunden", level: 1 })).toBeInTheDocument();
    expect(document.title).toBe("Seite nicht gefunden · Stowly");
    await userEvent.click(screen.getByRole("link", { name: "Zum Bestand" }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
  });

  it("zeigt Änderungen des Kerns sofort an", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const total = () => screen.getByText("Packungen gesamt").nextElementSibling?.textContent;
    const before = Number(total());

    const product = core.data.products.get()?.[0];
    const zone = core.data.zones.get()?.[0];
    await core.stock.store({ product: { kind: "existing", product_id: product?.id ?? "" }, zone_id: zone?.id ?? "", best_before: null, count: 3 });
    await waitFor(() => expect(total()).toBe(String(before + 3)));
  });

  it("zählt in der Pille der Kopfzeile dieselben Packungen wie die Warnliste", async () => {
    renderApp();
    const pill = await screen.findByRole("link", { name: /MHD-Warnungen/ });
    const count = Number(/\d+/.exec(pill.textContent ?? "")?.[0]);
    expect(count).toBeGreaterThan(0);

    await userEvent.click(pill);
    expect(await screen.findByRole("heading", { name: "Warnungen" })).toBeInTheDocument();
    expect(screen.getByText(`${String(count)} Packungen`)).toBeInTheDocument();
  });
});

describe("Anmeldung", () => {
  it("führt nicht angemeldete Geräte zur Anmeldung und nach dem richtigen Passwort in die App", async () => {
    renderApp({ scenarios: ["signed-out"] });
    expect(screen.queryByRole("heading", { name: "Bestand" })).not.toBeInTheDocument();
    // neutraler Vorschlag für den Gerätenamen
    const name = screen.getByLabelText("Name dieses Geräts");
    expect(name).toHaveValue("Rechner");

    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), "falsch");
    await userEvent.clear(name);
    await userEvent.type(name, "Handy Küche");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Passwort stimmt nicht.");

    await userEvent.clear(screen.getByLabelText("Haushalts-Passwort"));
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Handy Küche/ })).toBeInTheDocument();
  });

  it("sagt, wenn das Gerät abgemeldet wurde", () => {
    renderApp({ scenarios: ["revoked"] });
    expect(screen.getByText("Dieses Gerät wurde abgemeldet")).toBeInTheDocument();
    expect(screen.getByText(/werden Änderungen, die noch nicht gesendet waren, nachgereicht/)).toBeInTheDocument();
  });

  it("zeigt die Anmeldung, sobald der Server das Gerät sperrt", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    core.control.revoke();
    expect(await screen.findByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
  });
});

describe("Abmelden", () => {
  it("fragt nach und meldet dann ab", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    const dialog = screen.getByRole("dialog", { name: "Dieses Gerät abmelden?" });
    expect(core.session.state.get()?.status).toBe("signed_in");
    await userEvent.click(within(dialog).getByRole("button", { name: "Abmelden" }));

    expect(await screen.findByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
    expect(core.session.state.get()).toMatchObject({ status: "signed_out", reason: "logout" });
    expect(screen.getByText("Abgemeldet")).toBeInTheDocument();
  });

  it("warnt bei ungesendeten Änderungen und verwirft sie erst nach der Bestätigung", async () => {
    const core = renderApp({ scenarios: ["offline"] });
    const logout = vi.spyOn(core.session, "logout");
    await screen.findByRole("heading", { name: "Bestand" });
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    const dialog = screen.getByRole("dialog", { name: "Ungesendete Änderungen verwerfen?" });
    expect(dialog).toHaveTextContent("4 Änderungen");
    expect(logout).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(core.session.state.get()?.status).toBe("signed_in");

    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen und abmelden" }));
    await waitFor(() => expect(core.session.state.get()).toMatchObject({ status: "signed_out", reason: "logout" }));
    expect(logout).toHaveBeenCalledWith({ discard_pending: true });
  });

  it("fragt noch einmal, wenn der Kern erst beim Abmelden ungesendete Änderungen meldet", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    // Während die Rückfrage offen ist, kommt eine Änderung dazu, die der Sync-Zustand noch nicht zeigt.
    const logout = vi.spyOn(core.session, "logout");
    logout.mockRejectedValueOnce(new CoreError("pending_changes", "Es gibt ungesendete Änderungen.", { pending: 2 }));

    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abmelden" }));
    const dialog = await screen.findByRole("dialog", { name: "Ungesendete Änderungen verwerfen?" });
    expect(dialog).toHaveTextContent("2 Änderungen");
    expect(core.session.state.get()?.status).toBe("signed_in");

    await userEvent.click(within(dialog).getByRole("button", { name: "Verwerfen und abmelden" }));
    await waitFor(() => expect(logout).toHaveBeenLastCalledWith({ discard_pending: true }));
  });
});

describe("Hinweise des Rahmens", () => {
  it("blendet ohne sicheren Kontext alle Zugänge zum Scannen aus und erklärt, warum", async () => {
    renderApp({ scenarios: ["insecure"] });
    await screen.findByRole("heading", { name: "Bestand" });
    expect(screen.queryByRole("link", { name: "Jetzt scannen" })).not.toBeInTheDocument();
    expect(document.querySelector(`a[href="${ROUTES.scan}"]`)).toBeNull();
    expect(screen.getByText("Kein Scannen über diese Adresse")).toBeInTheDocument();
    expect(screen.getByText(/brauchen die HTTPS-Adresse/)).toBeInTheDocument();
    // Von Hand einlagern geht weiterhin.
    expect(screen.getByRole("button", { name: "Von Hand einlagern" })).toBeInTheDocument();
  });

  it("bietet am Handy ohne sicheren Kontext auch keinen schwebenden Scan-Knopf an", async () => {
    setTestViewport(375);
    renderApp({ scenarios: ["insecure"] });
    await screen.findByRole("heading", { name: "Bestand" });
    expect(document.querySelector(`a[href="${ROUTES.scan}"]`)).toBeNull();
  });

  it("meldet eine neue Version und wechselt auf Wunsch", async () => {
    const core = renderApp({ scenarios: ["update"] });
    const applyUpdate = vi.spyOn(core.app, "applyUpdate");
    expect(await screen.findByText("Neue Version")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Jetzt aktualisieren" }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Neue Version")).not.toBeInTheDocument());
  });

  it("zeigt im Sync-Anzeiger, ob der Server erreichbar ist und was noch wartet", async () => {
    const core = renderApp({ scenarios: ["offline"] });
    const indicator = await screen.findByRole("link", { name: "Sync-Status: Offline, 4 ungesendet" });
    expect(indicator).toHaveTextContent("Offline");
    expect(indicator).toHaveTextContent("4");

    core.control.setOnline(true);
    expect(await screen.findByRole("link", { name: "Sync-Status: Aktuell" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Sync-Status: Aktuell" }));
    expect(await screen.findByRole("heading", { name: "Sync-Status" })).toBeInTheDocument();
  });
});

describe("Nur eine Zone", () => {
  it("blendet alles zu Zonen aus", async () => {
    renderApp({ scenarios: ["single-zone"] });
    await screen.findByRole("heading", { name: "Bestand" });

    expect(within(mainNavigation()).queryByRole("link", { name: "Zonen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Zone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Nach Zone filtern" })).not.toBeInTheDocument();
    expect(screen.queryByText("Vorrat")).not.toBeInTheDocument();
    // Der Warnfilter bleibt, als Umschalter über der Liste.
    expect(screen.getByRole("button", { name: /Läuft bald ab/ })).toBeInTheDocument();

    // Auch die Chargen-Ansicht kennt dann keine Zonen.
    await userEvent.click(screen.getByRole("button", { name: "Details: Basmati Reis" }));
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    expect(within(panel).queryByRole("columnheader", { name: "Zone" })).not.toBeInTheDocument();
  });

  it("lässt die Zonenverwaltung über die Einstellungen erreichbar", async () => {
    renderApp({ scenarios: ["single-zone"] }, ROUTES.settings);
    await userEvent.click(await screen.findByRole("link", { name: /Zonen/ }));
    expect(await screen.findByRole("heading", { name: "Zonen" })).toBeInTheDocument();
    expect(screen.getByText("Es gibt nur eine Zone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zone anlegen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Löschen: Vorrat" })).toBeDisabled();
  });

  it("zeigt mit mehreren Zonen Navigationspunkt, Spalte und Zonen-Karten", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    expect(within(mainNavigation()).getByRole("link", { name: "Zonen" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Zone" })).toBeInTheDocument();
    const cards = screen.getByRole("group", { name: "Nach Zone filtern" });
    expect(within(cards).getAllByRole("button").map((button) => button.querySelector("span span")?.textContent)).toEqual([
      "Vorratsregal",
      "Keller",
      "Kühlschrank",
      "Gefrierschrank",
      "Läuft bald ab",
    ]);
  });
});

describe("Rahmen am Handy", () => {
  it("zeigt Suchfeld, Menü und den schwebenden Knopf zum Scannen", async () => {
    setTestViewport(375);
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });

    expect(screen.getByRole("searchbox", { name: "Bestand durchsuchen" })).toBeInTheDocument();
    // der schwebende Knopf und die Schaltfläche neben der Überschrift
    const scanLinks = screen.getAllByRole("link", { name: "Jetzt scannen" });
    expect(scanLinks).toHaveLength(2);
    expect(scanLinks.every((link) => link.getAttribute("href") === ROUTES.scan)).toBe(true);
    // keine Seitenleiste
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Menü" }));
    const menu = screen.getByRole("dialog", { name: "Menü" });
    expect(within(menu).getAllByRole("link").map((link) => link.textContent?.replace(/\d+$/, ""))).toEqual([
      "Bestand",
      "Zonen",
      "Einstellungen",
      "Warnungen",
      "Lösch-Historie",
      "Drucker",
      "Sync-StatusAktuell",
    ]);

    await userEvent.click(within(menu).getByRole("link", { name: /Warnungen/ }));
    expect(await screen.findByRole("heading", { name: "Warnungen" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Menü" })).not.toBeInTheDocument();
  });

  it("hebt die Meldungen über den schwebenden Knopf", async () => {
    setTestViewport(375);
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    expect(document.documentElement.style.getPropertyValue("--toast-offset")).toBe("var(--fab-clearance)");
  });
});

describe("Suche", () => {
  it("filtert die Bestandsliste und wechselt aus anderen Ansichten zum Bestand", async () => {
    renderApp({}, ROUTES.zones);
    await screen.findByRole("heading", { name: "Zonen" });

    await userEvent.type(screen.getByRole("searchbox", { name: "Bestand durchsuchen" }), "spagh");
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details: Spaghetti" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details: Basmati Reis" })).not.toBeInTheDocument();
    // Ein einziger Treffer: Seine Chargen-Ansicht steht gleich offen.
    expect(screen.getByRole("region", { name: "Bestand im Detail: Spaghetti" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Suche leeren" }));
    expect(await screen.findByRole("button", { name: "Details: Basmati Reis" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Bestand im Detail: Spaghetti" })).not.toBeInTheDocument();
  });
});

describe("Fehler beim Zeichnen", () => {
  it("lässt den Weg zurück offen, wenn eine Ansicht scheitert", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", ROUTES.scan);
    function Broken(): never {
      throw new Error("Kamera kaputt");
    }
    render(<App core={createMockCore({ latency: 0 })} scanPage={Broken} />);

    expect(await screen.findByRole("heading", { name: "Diese Ansicht konnte nicht angezeigt werden" })).toBeInTheDocument();
    expect(screen.getByText(/Kamera kaputt/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Zum Bestand" }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    quiet.mockRestore();
  });

  it("zeigt eine Meldung statt einer leeren Seite, wenn schon der Rahmen scheitert", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const core = createMockCore({ latency: 0 });
    const broken: Core = {
      ...core,
      session: {
        ...core.session,
        state: {
          get: () => {
            throw new Error("Zustand unlesbar");
          },
          subscribe: () => () => undefined,
        },
      },
    };
    render(<App core={broken} scanPage={MockScanPage} />);
    expect(screen.getByRole("heading", { name: "Stowly konnte nicht angezeigt werden" })).toBeInTheDocument();
    expect(screen.getByText(/Zustand unlesbar/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeInTheDocument();
    quiet.mockRestore();
  });
});

describe("Titel des Browser-Tabs", () => {
  it("nennt die gezeigte Ansicht", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    expect(document.title).toBe("Bestand · Stowly");

    await userEvent.click(within(mainNavigation()).getByRole("link", { name: "Einstellungen" }));
    await screen.findByRole("heading", { name: "Einstellungen" });
    expect(document.title).toBe("Einstellungen · Stowly");
  });

  it("nennt auch die Scan-Ansicht, die außerhalb des Rahmens liegt", async () => {
    renderApp({}, ROUTES.scan);
    await screen.findByRole("heading", { name: "Scannen", level: 1 });
    expect(document.title).toBe("Scannen · Stowly");
  });
});
