/**
 * Einstellungen auf der Attrappe: Darstellung, dieses Gerät, Haushalt, Geräte, Sicherung, Über, Abmelden.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTES, type Device, type Live } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { DEVICE_IDS } from "@/mock";
import { resetThemeForTests, THEME_STORAGE_KEY } from "@/ui/theme";

import { describeConnection, describeLookup } from ".";
import { sortDevices } from "./DevicesSection";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Einstellungen" });
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
});

describe("Darstellung", () => {
  it("schaltet das Thema um und merkt es sich", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const theme = within(section("Darstellung")).getByRole("radiogroup", { name: "Thema" });
    expect(within(theme).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Dunkel", "Hell", "Wie das Gerät"]);
    expect(within(theme).getByRole("radio", { name: "Dunkel" })).toBeChecked();

    await userEvent.click(within(theme).getByRole("radio", { name: "Hell" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(within(theme).getByRole("radio", { name: "Hell" })).toBeChecked();
  });

  it("wählt die Akzentfarbe", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const accents = within(section("Darstellung")).getByRole("radiogroup", { name: "Akzentfarbe" });
    expect(within(accents).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Mint", "Blau", "Violett", "Rosé", "Limette"]);
    expect(within(accents).getByRole("radio", { name: "Mint" })).toBeChecked();

    await userEvent.click(within(accents).getByRole("radio", { name: "Violett" }));
    expect(document.documentElement).toHaveAttribute("data-accent", "violet");
    expect(within(accents).getByRole("radio", { name: "Violett" })).toBeChecked();
  });
});

describe("Dieses Gerät", () => {
  it("schaltet Etiketten, Ton und Vibration", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    const device = section("Dieses Gerät");
    const labels = within(device).getByRole("switch", { name: "Etiketten" });
    expect(labels).toBeChecked();

    await userEvent.click(labels);
    await userEvent.click(within(device).getByRole("switch", { name: "Ton beim Scannen" }));
    await waitFor(() => expect(value(core.prefs.value)).toMatchObject({ print_labels: false, scan_sound: false, scan_vibration: true }));
    expect(labels).not.toBeChecked();

    await userEvent.click(within(device).getByRole("switch", { name: "Vibration beim Scannen" }));
    await waitFor(() => expect(value(core.prefs.value).scan_vibration).toBe(false));
  });
});

describe("Haushalt", () => {
  it("ändert Vorlaufzeit und Aufbewahrungsdauer beim Verlassen des Felds", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    const household = section("Haushalt");
    const warn = within(household).getByLabelText("Vorlaufzeit der MHD-Warnung");
    expect(warn).toHaveValue("14");

    await userEvent.clear(warn);
    await userEvent.type(warn, "21");
    expect(value(core.data.settings).warn_days).toBe(14);
    await userEvent.tab();
    await waitFor(() => expect(value(core.data.settings).warn_days).toBe(21));

    const retention = within(household).getByLabelText("Aufbewahrung der Lösch-Historie");
    await userEvent.clear(retention);
    await userEvent.type(retention, "90{Enter}");
    await waitFor(() => expect(value(core.data.settings).trash_retention_days).toBe(90));
    expect(await screen.findByText("Einstellung gespeichert")).toBeInTheDocument();
  });

  it("weist ungültige Zahlen zurück", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    const retention = within(section("Haushalt")).getByLabelText("Aufbewahrung der Lösch-Historie");
    await userEvent.clear(retention);
    await userEvent.type(retention, "0");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitte eine ganze Zahl von 1 bis 3650 eingeben.");
    expect(value(core.data.settings).trash_retention_days).toBe(30);
  });

  it("folgt Änderungen von anderen Geräten", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    await core.settings.update({ warn_days: 7 });
    await waitFor(() => expect(within(section("Haushalt")).getByLabelText("Vorlaufzeit der MHD-Warnung")).toHaveValue("7"));
  });

  it("führt zur Zonenverwaltung und zu den Druckern", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const zones = within(section("Haushalt")).getByRole("link", { name: /Zonen/ });
    expect(zones).toHaveTextContent("4 Zonen");
    expect(zones).toHaveTextContent("Primärzone: Vorratsregal");
    expect(within(section("Haushalt")).getByRole("link", { name: /Drucker/ })).toHaveAttribute("href", ROUTES.printers);
    await userEvent.click(zones);
    expect(await screen.findByRole("heading", { name: "Zonen", level: 1 })).toBeInTheDocument();
  });
});

describe("Geräte", () => {
  it("sortiert: eigenes Gerät, dann zuletzt gesehene, dann abgemeldete", () => {
    const device = (id: string, extra: Partial<Device>): Device => ({ id, name: id, created_at: "", last_seen_at: null, revoked_at: null, current: false, ...extra });
    const sorted = sortDevices([
      device("gesperrt", { revoked_at: "2026-01-01T00:00:00.000Z" }),
      device("alt", { last_seen_at: "2026-10-01T00:00:00.000Z" }),
      device("neu", { last_seen_at: "2026-11-01T00:00:00.000Z" }),
      device("ich", { current: true }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["ich", "neu", "alt", "gesperrt"]);
  });

  it("listet die Geräte mit „zuletzt gesehen“ und markiert das eigene", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const devices = section("Geräte");
    expect(await within(devices).findByText("Handy Küche")).toBeInTheDocument();
    expect(within(devices).getAllByText("Dieses Gerät")).toHaveLength(2);
    expect(devices).toHaveTextContent(/Zuletzt gesehen vor 7 Stunden/);
    expect(devices).toHaveTextContent(/Abgemeldet am/);
    // Abgemeldete Geräte haben keine Aktionen mehr.
    expect(within(devices).queryByRole("button", { name: "Abmelden: Altes Tablet" })).not.toBeInTheDocument();
  });

  it("benennt ein Gerät um", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Umbenennen: Handy Küche" }));
    const dialog = screen.getByRole("dialog", { name: "Gerät umbenennen" });
    const name = within(dialog).getByLabelText("Name des Geräts");
    await userEvent.clear(name);
    await userEvent.type(name, "Handy Keller");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    expect(await within(section("Geräte")).findByText("Handy Keller")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(core.control.snapshot().devices.find((device) => device.id === DEVICE_IDS.phone)?.name).toBe("Handy Keller");
  });

  it("meldet ein anderes Gerät nach Rückfrage ab", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Abmelden: Handy Küche" }));
    const dialog = screen.getByRole("dialog", { name: "„Handy Küche“ abmelden?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Abmelden" }));

    await waitFor(() => expect(core.control.snapshot().devices.find((device) => device.id === DEVICE_IDS.phone)?.revoked_at).not.toBeNull());
    expect(await screen.findByText("„Handy Küche“ ist abgemeldet")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Abmelden: Handy Küche" })).not.toBeInTheDocument());
    // Dieses Gerät bleibt angemeldet.
    expect(value(core.session.state).status).toBe("signed_in");
  });

  it("sagt verständlich, wenn der Server fehlt, und lädt nach, sobald er wieder da ist", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    await ready();
    const devices = section("Geräte");
    expect(await within(devices).findByText("Die Geräteliste liegt auf dem Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(devices).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();

    core.control.setOnline(true);
    expect(await within(devices).findByText("Handy Küche")).toBeInTheDocument();
  });
});

describe("Sicherung", () => {
  it("lädt die Kopie der Datenbank und speichert sie als Datei", async () => {
    const core = renderApp({}, ROUTES.settings);
    const download = vi.spyOn(core.backup, "download");
    const created = vi.spyOn(URL, "createObjectURL");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      expect(this.download).toMatch(/^stowly-\d{4}-\d{2}-\d{2}\.sqlite3$/);
    });
    await ready();

    await userEvent.click(within(section("Sicherung")).getByRole("button", { name: "Herunterladen" }));
    expect(await screen.findByText(/Sicherung heruntergeladen: stowly-/)).toBeInTheDocument();
    expect(download).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    clicked.mockRestore();
    created.mockRestore();
  });

  it("sagt, wenn der Server fehlt", async () => {
    renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    await ready();
    await userEvent.click(within(section("Sicherung")).getByRole("button", { name: "Herunterladen" }));
    expect(await within(section("Sicherung")).findByRole("alert")).toHaveTextContent("Die Sicherung kommt vom Server, und der ist gerade nicht erreichbar.");
  });
});

describe("Über und Abmelden", () => {
  it("nennt Version, Speicher, Verbindung und die Quelle der Produktdaten", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const about = section("Über");
    expect(about).toHaveTextContent("Stowly 0.0.0-test · Server 0.1.0");
    // Die Tests laufen unter http://localhost: Das ist eine lokale, für den Browser sichere Adresse.
    expect(about).toHaveTextContent("lokal (Entwicklung)");
    expect(about).toHaveTextContent("Open Food Facts (ODbL)");
    const appSection = section("Diese App");
    expect(appSection).toHaveTextContent("Lokaler Speicher");
    expect(appSection).toHaveTextContent("unbekannt");
  });

  it("sagt, wenn die Adresse kein Scannen erlaubt", async () => {
    renderApp({ scenarios: ["insecure"] }, ROUTES.settings);
    await ready();
    // Maßgeblich ist, was der Kern meldet: ohne sicheren Kontext kein Scannen, auch wenn die Adresse lokal ist.
    expect(section("Über")).toHaveTextContent("ohne sicheren Kontext");
    expect(section("Über")).toHaveTextContent("Scannen, Offline-Betrieb und Installation verweigert der Browser hier");
    expect(section("Diese App")).toHaveTextContent("Über eine http-Adresse lässt der Browser keine Installation zu.");
  });

  it("meldet nach Rückfrage ab", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    await userEvent.click(within(section("Abmelden")).getByRole("button", { name: "Abmelden" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Dieses Gerät abmelden?" })).getByRole("button", { name: "Abmelden" }));
    await waitFor(() => expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "logout" }));
    // Die nächste Anmeldung beginnt wieder beim Bestand.
    await waitFor(() => expect(window.location.pathname).toBe(ROUTES.stock));
  });
});

describe("Diese App: Installation und Speicher", () => {
  it("bietet die Installation an, wenn der Browser sie anbietet, und zeigt danach nichts mehr davon", async () => {
    const core = renderApp({ scenarios: ["installable"] }, ROUTES.settings);
    const promptInstall = vi.spyOn(core.app, "promptInstall");
    await ready();
    await userEvent.click(within(section("Diese App")).getByRole("button", { name: "Stowly installieren" }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(section("Diese App")).toHaveTextContent("Stowly läuft als installierte App."));
    expect(within(section("Diese App")).queryByRole("button", { name: "Stowly installieren" })).not.toBeInTheDocument();
    // Auch der einmalige Hinweis im Rahmen ist damit fort.
    expect(screen.queryByText("Stowly als App installieren")).not.toBeInTheDocument();
  });

  it("zeigt auf dem iPhone die Anleitung mit dem Grund", async () => {
    renderApp({ scenarios: ["ios"] }, ROUTES.settings);
    await ready();
    const app = section("Diese App");
    expect(app).toHaveTextContent("Installation auf dem iPhone");
    expect(app).toHaveTextContent("Ohne Installation löscht Safari die lokalen Daten nach sieben Tagen ohne Nutzung.");
    const steps = within(app).getAllByRole("listitem").map((item) => item.textContent);
    expect(steps[0]).toContain("Teilen");
    expect(steps[1]).toContain("Zum Home-Bildschirm");
    expect(within(app).queryByRole("button", { name: "Stowly installieren" })).not.toBeInTheDocument();
  });

  it("sagt ohne Angebot des Browsers, wo die Installation zu finden ist", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    expect(section("Diese App")).toHaveTextContent("Dieser Browser bietet gerade keine Installation an.");
    expect(section("Diese App")).toHaveTextContent("nicht installiert");
  });

  it("erklärt nicht zugesagten Speicher und fragt auf Wunsch erneut an", async () => {
    const base = renderApp({}, ROUTES.settings);
    await ready();
    // Der Browser hat abgelehnt (das meldet der Kern; die Attrappe kennt die Lage nicht von sich aus).
    const state = base.app.state as unknown as { update(change: (value: object) => object): void };
    state.update((current) => ({ ...current, storage_persistent: false }));
    const app = section("Diese App");
    expect(await within(app).findByText(/Der Browser darf die Kopie auf diesem Gerät löschen/)).toBeInTheDocument();

    const request = vi.spyOn(base.app, "requestPersistence");
    await userEvent.click(within(app).getByRole("button", { name: "Erneut anfragen" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Der Browser behält die Daten auf diesem Gerät jetzt dauerhaft.")).toBeInTheDocument();
    expect(section("Diese App")).toHaveTextContent("dauerhaft");
    expect(within(section("Diese App")).queryByRole("button", { name: "Erneut anfragen" })).not.toBeInTheDocument();
  });

  it("sagt, wenn der Browser auch auf Nachfrage nicht zusagt", async () => {
    const base = renderApp({}, ROUTES.settings);
    await ready();
    (base.app.state as unknown as { update(change: (value: object) => object): void }).update((current) => ({ ...current, storage_persistent: false }));
    vi.spyOn(base.app, "requestPersistence").mockResolvedValue(false);
    await userEvent.click(await within(section("Diese App")).findByRole("button", { name: "Erneut anfragen" }));
    expect(await screen.findByText("Der Browser hat nicht zugesagt. Als installierte App stehen die Chancen besser.")).toBeInTheDocument();
  });
});

describe("Zeilen „Verbindung“ und „Produktdaten“", () => {
  it("nennt die Verbindung beim Namen: HTTPS, lokal oder http", () => {
    expect(describeConnection({ protocol: "https:", hostname: "stowly.home" }, true)).toEqual({
      value: "HTTPS",
      hint: "Über die HTTPS-Adresse sind Scannen und Offline-Betrieb möglich.",
    });
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) {
      expect(describeConnection({ protocol: "http:", hostname }, true).value, hostname).toBe("lokal (Entwicklung)");
    }
    expect(describeConnection({ protocol: "http:", hostname: "localhost" }, true).hint).toContain("wie eine sichere Adresse");
    const lan = describeConnection({ protocol: "http:", hostname: "192.168.1.20" }, false);
    expect(lan.value).toBe("http (eingeschränkt)");
    expect(lan.hint).toContain("Scannen, Offline-Betrieb und Installation verweigert der Browser hier");
    expect(lan.hint).toContain("Die HTTPS-Adresse von Stowly hebt das auf.");
  });

  it("lässt den Kern entscheiden, ob Scannen und Offline-Betrieb gehen", () => {
    // Die Adresse sagt „sicher", der Kern meldet das Gegenteil: Dann gilt der Kern.
    expect(describeConnection({ protocol: "https:", hostname: "stowly.home" }, false).hint).toContain("verweigert der Browser hier");
    expect(describeConnection({ protocol: "http:", hostname: "localhost" }, false).hint).toContain("ohne sicheren Kontext");
    // Noch unbekannt (der Kern lädt): kein falsches Versprechen bei http.
    expect(describeConnection({ protocol: "http:", hostname: "192.168.1.20" }, undefined).hint).toContain("verweigert der Browser hier");
  });

  it("richtet die Produktdaten danach, ob der Server nachschlägt", async () => {
    expect(describeLookup(true)).toEqual({ value: "Open Food Facts (ODbL)", hint: "Namen und Bilder zu unbekannten Barcodes schlägt der Server dort nach." });
    expect(describeLookup(false).hint).toContain("Der Server schlägt keine Produktdaten nach (abgeschaltet).");
    expect(describeLookup(null)).toEqual({ value: "noch unbekannt", hint: "Ob der Server Produktdaten nachschlägt, steht nach dem nächsten Abgleich fest." });
    expect(describeLookup(undefined).value).toBe("noch unbekannt");

    const core = renderApp({ scenarios: ["no-lookup"] }, ROUTES.settings);
    await ready();
    expect(section("Über")).toHaveTextContent("Der Server schlägt keine Produktdaten nach (abgeschaltet).");
    expect(section("Über")).not.toHaveTextContent("Open Food Facts");
    core.control.setLookupEnabled(true);
    await waitFor(() => expect(section("Über")).toHaveTextContent("Open Food Facts (ODbL)"));
  });
});

describe("Ungültige Eingaben in den Einstellungen", () => {
  it("zeigt beim Umbenennen eines Geräts den genauen Satz des Kerns", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    await userEvent.click(await within(section("Geräte")).findByRole("button", { name: "Umbenennen: Handy Küche" }));
    const dialog = screen.getByRole("dialog", { name: "Gerät umbenennen" });
    await userEvent.clear(within(dialog).getByLabelText("Name des Geräts"));
    await userEvent.type(within(dialog).getByLabelText("Name des Geräts"), "n".repeat(61));
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Name des Geräts ist zu lang (höchstens 60 Zeichen).");
  });
});
