/**
 * Die App als Ganzes auf der Attrappe: Anmeldung, Rahmen, Navigation, Hinweise.
 * Zeigt zugleich, wie sich Ansichten mit `renderApp` (createMockCore) testen lassen.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES, type Core } from "@/contract";
import { createMockCore, createSampleData, DEVICE_IDS, MOCK_PASSWORD, MockScanPage, sampleUuid } from "@/mock";
import { setTestViewport } from "@/ui/testing";

import { App } from "./App";
import { isLoadError, lazyPage } from "./pages";
import { renderApp } from "./render.test-setup";
import { RouteError } from "./RouteError";

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
    expect(within(more).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual([
      "Warnungen",
      "Lösch-Historie",
      "Statistik",
      "Drucker: 4 Etiketten offen",
      "Sync-Status",
    ]);

    await userEvent.click(within(more).getByRole("link", { name: "Lösch-Historie" }));
    expect(await screen.findByRole("heading", { name: "Lösch-Historie" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Dieses Gerät/ }));
    const menu = screen.getByRole("menu", { name: "Geräte-Menü" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Einstellungen", "Sync-Status", "Lösch-Historie", "Statistik", "Drucker", "Abmelden"]);
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
      [ROUTES.shopping]: "Einkaufsliste",
      [ROUTES.stats]: "Statistik",
    };
    // Jede Adresse hat hier einen Titel: Eine neue Ansicht fehlt sonst in diesem Test.
    expect(Object.keys(titles).sort()).toEqual(Object.values(ROUTES).sort());
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
    expect(screen.getByRole("button", { name: "Löschen: Vorrat" })).toBeUnavailable();
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
      "Einkaufsliste4 offen",
      "Zonen",
      "Einstellungen",
      "Warnungen",
      "Lösch-Historie",
      "Statistik",
      "Drucker4 offen",
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

describe("Etiketten im Rahmen", () => {
  it("zeigt die Zahl der offenen Etiketten am Drucker-Symbol und im Menü am Handy", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const more = screen.getByRole("navigation", { name: "Weitere Bereiche" });
    const link = within(more).getByRole("link", { name: "Drucker: 4 Etiketten offen" });
    expect(link).toHaveTextContent("4");

    // Ein Etikett weniger offen: Die Zahl folgt.
    await core.print.cancel(sampleUuid(4, 1));
    expect(await within(more).findByRole("link", { name: "Drucker: 3 Etiketten offen" })).toBeInTheDocument();
    cleanup();

    // Ohne offene Etiketten steht dort nur das Symbol.
    renderApp({ data: { printJobs: [] } });
    await screen.findByRole("heading", { name: "Bestand" });
    expect(within(screen.getByRole("navigation", { name: "Weitere Bereiche" })).getByRole("link", { name: "Drucker" })).toBeInTheDocument();
    cleanup();

    setTestViewport(375);
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await userEvent.click(screen.getByRole("button", { name: "Menü" }));
    expect(within(screen.getByRole("dialog", { name: "Menü" })).getByRole("link", { name: /Drucker/ })).toHaveTextContent("4 offen");
  });

  it("fragt unter der Kopfzeile, ob ein Etikett gedruckt wurde: Ja vermerkt es", async () => {
    const core = renderApp();
    const banner = (await screen.findByText("Wurde das Etikett gedruckt?")).closest('[role="status"]') as HTMLElement;
    // Kurz, auch am Handy: welches Etikett, an welchem Drucker.
    const pkg = core.data.printJobs.get()?.find((job) => job.id === sampleUuid(4, 3))?.package_id ?? "";
    expect(banner).toHaveTextContent(`Basmati Reis · Packung ${pkg} · Keller (Pi)`);
    await userEvent.click(within(banner).getByRole("button", { name: "Ja" }));
    await waitFor(() => expect(core.data.printJobs.get()?.find((job) => job.id === sampleUuid(4, 3))?.state).toBe("printed"));
    expect(screen.queryByText("Wurde das Etikett gedruckt?")).not.toBeInTheDocument();
    // Mit dem Hinweis ist die Schaltfläche fort: Der Fokus geht an den Inhalt, nicht verloren.
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("zeigt beim Antworten den Spinner an der gedrückten Antwort, die den Fokus behält, und sperrt die andere", async () => {
    const core = renderApp();
    const banner = (await screen.findByText("Wurde das Etikett gedruckt?")).closest('[role="status"]') as HTMLElement;
    // Das Vermerken wartet, bis der Test es freigibt.
    let release: () => void = () => undefined;
    const resolveUnknown = core.print.resolveUnknown.bind(core.print);
    vi.spyOn(core.print, "resolveUnknown").mockImplementation(async (id, printed) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return resolveUnknown(id, printed);
    });
    const no = within(banner).getByRole("button", { name: "Nein" });
    await userEvent.click(no);
    expect(no).toHaveFocus();
    expect(no).toHaveAttribute("aria-busy", "true");
    expect(no).toBeUnavailable();
    const yes = within(banner).getByRole("button", { name: "Ja" });
    expect(yes).toBeUnavailable();
    expect(yes).not.toHaveAttribute("aria-busy");

    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByText("Wurde das Etikett gedruckt?")).not.toBeInTheDocument());
  });

  it("bietet nach einem Nein an, erneut zu drucken", async () => {
    const core = renderApp();
    const banner = (await screen.findByText("Wurde das Etikett gedruckt?")).closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(banner).getByRole("button", { name: "Nein" }));
    await waitFor(() => expect(core.data.printJobs.get()?.find((job) => job.id === sampleUuid(4, 3))).toMatchObject({ state: "failed", error: "not_printed" }));
    const before = core.data.printJobs.get()?.length ?? 0;
    await userEvent.click(await screen.findByRole("button", { name: "Erneut drucken" }));
    await waitFor(() => expect(core.data.printJobs.get()).toHaveLength(before + 1));
  });

  it("fasst mehrere unklare Etiketten zusammen und führt zum Klären in die Drucker-Ansicht", async () => {
    const data = createSampleData();
    const printJobs = data.printJobs.map((job) => (job.id === sampleUuid(4, 1) ? { ...job, state: "unknown" as const, error: "handoff" } : job));
    const core = renderApp({ data: { printJobs } });
    const banner = (await screen.findByText("Wurden 2 Etiketten gedruckt?")).closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(banner).getByRole("link", { name: "Einzeln klären" }));
    expect(await screen.findByRole("heading", { name: "Drucker", level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe("#etiketten");
    // In der Drucker-Ansicht steht die Frage bei den Etiketten; der Hinweis im Rahmen entfällt dort.
    expect(screen.queryByText("Wurden 2 Etiketten gedruckt?")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Wurden diese Etiketten gedruckt?" })).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Bestand" }));
    const again = (await screen.findByText("Wurden 2 Etiketten gedruckt?")).closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(again).getByRole("button", { name: "Alle gedruckt" }));
    await waitFor(() => expect(core.data.printJobs.get()?.some((job) => job.state === "unknown")).toBe(false));
    expect(screen.queryByText("Wurden 2 Etiketten gedruckt?")).not.toBeInTheDocument();
  });

  it("unterbricht das Scannen nicht: Die Scan-Ansicht liegt außerhalb des Rahmens", async () => {
    renderApp({}, ROUTES.scan);
    await screen.findByRole("heading", { name: "Scannen", level: 1 });
    expect(screen.queryByText("Wurde das Etikett gedruckt?")).not.toBeInTheDocument();
  });
});

describe("App-Lebenslauf", () => {
  it("sperrt die ganze App, wenn ein anderer Tab aktualisiert hat: eine einzige Schaltfläche", async () => {
    const core = renderApp({ scenarios: ["update-required", "update"] });
    const applyUpdate = vi.spyOn(core.app, "applyUpdate");
    const lock = await screen.findByRole("dialog", { name: "Stowly wurde aktualisiert" });
    expect(lock).toHaveTextContent("Stowly wurde in einem anderen Tab aktualisiert.");
    expect(within(lock).getAllByRole("button")).toHaveLength(1);
    expect(within(lock).queryByRole("button", { name: "Schließen" })).not.toBeInTheDocument();
    // Der ruhige Hinweis „Neue Version" tritt hinter die Sperre zurück.
    expect(screen.queryByText("Neue Version")).not.toBeInTheDocument();

    // Escape schließt die Sperre nicht.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Stowly wurde aktualisiert" })).toBeInTheDocument();

    await userEvent.click(within(lock).getByRole("button", { name: "Neu laden" }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stowly wurde aktualisiert" })).not.toBeInTheDocument());
  });

  it("legt die Sperre auch über die Anmeldung und die Scan-Ansicht", async () => {
    renderApp({ scenarios: ["update-required", "signed-out"] });
    expect(await screen.findByRole("dialog", { name: "Stowly wurde aktualisiert" })).toBeInTheDocument();
    cleanup();
    renderApp({ scenarios: ["update-required"] }, ROUTES.scan);
    expect(await screen.findByRole("dialog", { name: "Stowly wurde aktualisiert" })).toBeInTheDocument();
  });

  it("bietet die Installation einmalig an und lässt sich ausblenden", async () => {
    const core = renderApp({ scenarios: ["installable"] });
    const promptInstall = vi.spyOn(core.app, "promptInstall");
    const hint = (await screen.findByText("Stowly als App installieren")).closest("div[class]")?.parentElement as HTMLElement;
    expect(hint).toHaveTextContent("Installiert startet Stowly vom Home-Bildschirm wie eine App");
    await userEvent.click(screen.getByRole("button", { name: "Später" }));
    expect(screen.queryByText("Stowly als App installieren")).not.toBeInTheDocument();
    expect(localStorage.getItem("stowly.ui.install-hint.dismissed")).toBe("1");
    expect(promptInstall).not.toHaveBeenCalled();
    cleanup();

    // Ausgeblendet bleibt ausgeblendet; die Einstellungen bieten die Installation weiter an.
    localStorage.setItem("stowly.ui.install-hint.dismissed", "1");
    renderApp({ scenarios: ["installable"] });
    await screen.findByRole("heading", { name: "Bestand" });
    expect(screen.queryByText("Stowly als App installieren")).not.toBeInTheDocument();
  });

  it("installiert auf Wunsch aus dem Hinweis heraus", async () => {
    const core = renderApp({ scenarios: ["installable"] });
    await screen.findByText("Stowly als App installieren");
    await userEvent.click(screen.getByRole("button", { name: "Installieren" }));
    await waitFor(() => expect(core.app.state.get()?.installed).toBe(true));
    expect(screen.queryByText("Stowly als App installieren")).not.toBeInTheDocument();
  });

  it("zeigt auf dem iPhone die Anleitung in Kurzform und führt zur ausführlichen", async () => {
    renderApp({ scenarios: ["ios"] });
    expect(await screen.findByText("Stowly zum Home-Bildschirm hinzufügen")).toBeInTheDocument();
    expect(screen.getByText(/In Safari auf „Teilen“ tippen, dann auf „Zum Home-Bildschirm“\./)).toBeInTheDocument();
    expect(screen.getByText(/löscht Safari die lokalen Daten nach sieben Tagen ohne Nutzung/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Anleitung" }));
    expect(await screen.findByRole("heading", { name: "Einstellungen" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Diese App" })).toHaveTextContent("Installation auf dem iPhone");
  });

  it("zeigt nichts davon, wenn Stowly installiert ist oder der Browser nichts anbietet", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    expect(screen.queryByText("Stowly als App installieren")).not.toBeInTheDocument();
    expect(screen.queryByText("Stowly zum Home-Bildschirm hinzufügen")).not.toBeInTheDocument();
  });
});

describe("Ende der Sitzung", () => {
  it("schließt offene Meldungen samt „Rückgängig“, wenn das Gerät gesperrt wird", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    // Eine Packung entnehmen: Die Meldung bietet „Rückgängig" an.
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Butter" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Alle 2 Packungen/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /2 entnehmen/ }));
    expect(await screen.findByRole("button", { name: "Rückgängig" })).toBeInTheDocument();

    act(() => core.control.revoke());
    expect(await screen.findByText("Dieses Gerät wurde abgemeldet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rückgängig" })).not.toBeInTheDocument();
    expect(screen.queryByText(/verbraucht/)).not.toBeInTheDocument();
    // Der Vorschlag für den Namen ist der bisherige.
    expect(screen.getByLabelText("Name dieses Geräts")).toHaveValue("Dieses Gerät");
    expect(core.session.state.get()).toMatchObject({ status: "signed_out", reason: "revoked", last_device_name: "Dieses Gerät" });
    void DEVICE_IDS;
  });

  it("schließt sie auch beim Abmelden", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await core.print.cancel(sampleUuid(4, 1));
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Olivenöl" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Entnehmen" }));
    expect(await screen.findByRole("button", { name: "Rückgängig" })).toBeInTheDocument();
    await core.session.logout({ discard_pending: true });
    expect(await screen.findByText("Abgemeldet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rückgängig" })).not.toBeInTheDocument();
  });
});

describe("Nachgeladene Ansichten", () => {
  it("erkennt, wenn ein Teil der App nicht geladen werden konnte", () => {
    expect(isLoadError(new TypeError("Failed to fetch dynamically imported module: https://stowly.home/assets/zones-abc.js"))).toBe(true);
    expect(isLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isLoadError(new Error("Unable to preload CSS for /assets/zones-abc.css"))).toBe(true);
    expect(isLoadError(new Error("Kamera kaputt"))).toBe(false);
    expect(isLoadError("irgendwas")).toBe(false);
  });

  it("zeigt eine Meldung mit „Neu laden“ statt eines leeren Schirms, wenn ein Teil nicht lädt", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = lazyPage(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://stowly.home/assets/zones-abc.js")));
    const router = createMemoryRouter([
      {
        path: "/",
        errorElement: <RouteError />,
        element: (
          <Suspense fallback={<p>Lädt …</p>}>
            <Broken />
          </Suspense>
        ),
      },
      { path: ROUTES.stock, element: <p>Bestand</p> },
    ]);
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Dieser Teil der App ließ sich nicht laden" })).toBeInTheDocument();
    expect(screen.getByText(/„Neu laden“ holt den aktuellen Stand; die Daten sind davon nicht betroffen\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zum Bestand" })).toBeInTheDocument();
    // Die rohe Fehlermeldung des Browsers bleibt dem Anwender erspart.
    expect(screen.queryByText(/dynamically imported module/)).not.toBeInTheDocument();
    quiet.mockRestore();
  });

  it("zeichnet eine vorab geholte Ansicht sofort, ohne Ladeanzeige", async () => {
    const Ready = lazyPage(() => Promise.resolve(() => <p>Inhalt der Ansicht</p>));
    await Ready.preload();
    render(
      <Suspense fallback={<p>Lädt …</p>}>
        <Ready />
      </Suspense>,
    );
    expect(screen.getByText("Inhalt der Ansicht")).toBeInTheDocument();
    cleanup();

    // Nicht vorab geholt: erst die Ladeanzeige, dann der Inhalt.
    const Late = lazyPage(() => Promise.resolve(() => <p>Später Inhalt</p>));
    render(
      <Suspense fallback={<p>Lädt …</p>}>
        <Late />
      </Suspense>,
    );
    expect(screen.getByText("Lädt …")).toBeInTheDocument();
    expect(await screen.findByText("Später Inhalt")).toBeInTheDocument();
  });

  it("versucht es beim Aufruf noch einmal, wenn das Vorabholen gescheitert ist", async () => {
    let attempts = 0;
    const Flaky = lazyPage(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://stowly.home/assets/zones-abc.js"))
        : Promise.resolve(() => <p>Inhalt nach dem zweiten Versuch</p>);
    });
    await expect(Flaky.preload()).rejects.toThrow(TypeError);
    render(<Flaky />);
    expect(screen.getByText("Lädt …")).toBeInTheDocument();
    expect(await screen.findByText("Inhalt nach dem zweiten Versuch")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});
