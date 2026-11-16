/**
 * Einstellungen auf der Attrappe: Darstellung, dieses Gerät, Haushalt (samt Uhrzeit der
 * Tagesnachricht), Geräte, Sicherung, Home Assistant und Bring!, Aktualisierung, Über, Abmelden.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoreError,
  formatDate,
  formatTimestamp,
  HA_MIRROR_DELAY_S,
  PUSH_TEST_INTERVAL_S,
  ROUTES,
  toLocalDate,
  type Device,
  type HaState,
  type HaStatus,
  type Live,
  type UpdateStatus,
} from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { DEVICE_IDS, type MockCore } from "@/mock";
import { deviceTimeZone } from "@/ui";
import { resetThemeForTests, THEME_STORAGE_KEY } from "@/ui/theme";

import { describeConnection, describeLookup } from ".";
import { backupTimeText, backupWarningText } from "./BackupSection";
import { sortDevices } from "./DevicesSection";
import { describeHa, durationText, linkedText } from "./HomeAssistantSection";
import { notifyTimeHint, readTime } from "./NotifyTimeSetting";
import { describePush, testMessage } from "./PushSetting";
import { checkIntervalText, checkResult, describeLatest, describeUpdateState, INSTALL_WARNING, installErrorText, UPDATE_POLL_MS } from "./UpdateSection";

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
    // Der Stand des Bauens unterscheidet zwei Builds derselben Version (in deutscher Ortszeit).
    expect(about).toHaveTextContent(/Stand vom \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
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

/** Die Zeile „Benachrichtigungen" unter „Dieses Gerät". */
function pushRow(): HTMLElement {
  // Beschriftung -> Textspalte -> Zeile
  const row = within(section("Dieses Gerät")).getByText("Benachrichtigungen").parentElement?.parentElement;
  if (!row) {
    throw new Error("Zeile Benachrichtigungen fehlt");
  }
  return row;
}

describe("Benachrichtigungen (Push)", () => {
  it("fragt die Erlaubnis unmittelbar im Klick und zeigt danach Testnachricht und Ausschalten", async () => {
    const core = renderApp({}, ROUTES.settings);
    const enable = vi.spyOn(core.push, "enable");
    await ready();
    expect(pushRow()).toHaveTextContent("Höchstens eine Nachricht am Tag, zur Uhrzeit unter „Haushalt“, und nur, wenn seit der letzten etwas neu bald abläuft oder abgelaufen ist.");
    const button = within(pushRow()).getByRole("button", { name: "Einschalten" });

    // Synchron im Klick, ohne vorher zu warten: Sonst fragt der Browser nicht.
    fireEvent.click(button);
    expect(enable).toHaveBeenCalledTimes(1);

    expect(await screen.findByText("Benachrichtigungen sind auf diesem Gerät eingeschaltet.")).toBeInTheDocument();
    expect(value(core.push.state)).toBe("on");
    const test = within(pushRow()).getByRole("button", { name: "Testnachricht senden" });
    await waitFor(() => expect(test).toHaveFocus());
    expect(within(pushRow()).getByRole("button", { name: "Ausschalten" })).toBeInTheDocument();
  });

  it("sagt, wenn die Erlaubnis verweigert wird, und wie man sie wieder erteilt", async () => {
    const core = renderApp({}, ROUTES.settings);
    core.control.setPushPermission("denied");
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Einschalten" }));
    expect(await within(pushRow()).findByText("Keine Erlaubnis")).toBeInTheDocument();
    expect(value(core.push.state)).toBe("denied");
    expect(pushRow()).toHaveTextContent("Die Erlaubnis für Benachrichtigungen ist in diesem Browser verweigert.");
    expect(pushRow()).toHaveTextContent("auf dem iPhone unter Einstellungen › Mitteilungen › Stowly");
    expect(within(pushRow()).queryByRole("button", { name: "Einschalten" })).not.toBeInTheDocument();
  });

  it("sagt, wenn die Frage des Browsers ohne Antwort geschlossen wurde", async () => {
    const core = renderApp({}, ROUTES.settings);
    core.control.setPushPermission("default");
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Einschalten" }));
    expect(await within(pushRow()).findByText(/Die Frage des Browsers wurde ohne Antwort geschlossen/)).toBeInTheDocument();
    expect(within(pushRow()).getByRole("button", { name: "Einschalten" })).toBeInTheDocument();
  });

  it("schickt eine Testnachricht, nennt das Ergebnis und lässt den Knopf ruhen", async () => {
    const core = renderApp({ scenarios: ["push-on"] }, ROUTES.settings);
    const test = vi.spyOn(core.push, "test");
    await ready();
    // Was der Server weiß: die letzte Tagesnachricht (vor 41 Stunden). Nach Kalendertagen des
    // Geräts ist das gestern oder vorgestern, je nach Uhrzeit des Laufs (`timeAgo`).
    expect(await within(pushRow()).findByText(/Letzte Tagesnachricht: (gestern|vor 2 Tagen) /)).toBeInTheDocument();

    const button = within(pushRow()).getByRole("button", { name: "Testnachricht senden" });
    await userEvent.click(button);
    expect(await within(pushRow()).findByText("Testnachricht verschickt")).toBeInTheDocument();
    expect(pushRow()).toHaveTextContent("Der Push-Dienst hat sie angenommen");
    expect(pushRow()).toHaveTextContent(`Nächste Testnachricht in ${String(PUSH_TEST_INTERVAL_S)} s`);
    // Der Knopf ruht, behält aber den Fokus.
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(test).toHaveBeenCalledTimes(1);
  });

  it("nennt abgelehnte und erloschene Abos beim Namen", async () => {
    const core = renderApp({ scenarios: ["push-on"] }, ROUTES.settings);
    core.control.setPushTestResult("rejected");
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Testnachricht senden" }));
    expect(await within(pushRow()).findByText("Vom Push-Dienst abgelehnt")).toBeInTheDocument();
    expect(pushRow()).toHaveTextContent("Der Push-Dienst hat die Nachricht abgelehnt (403). Meldung des Servers: Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?");
  });

  it("schaltet nach einem erloschenen Abo auf „aus“ und bietet Einschalten an", async () => {
    const core = renderApp({ scenarios: ["push-on"] }, ROUTES.settings);
    core.control.setPushTestResult("gone");
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Testnachricht senden" }));
    expect(await within(pushRow()).findByText("Das Abo ist erloschen")).toBeInTheDocument();
    const enable = within(pushRow()).getByRole("button", { name: "Einschalten" });
    await waitFor(() => expect(enable).toHaveFocus());
    expect(value(core.push.state)).toBe("off");
  });

  it("wartet nach „zu viele Testnachrichten“ so lange, wie der Server sagt", async () => {
    const core = renderApp({ scenarios: ["push-on"] }, ROUTES.settings);
    vi.spyOn(core.push, "test").mockRejectedValue(new CoreError("rate_limited", "Zu viele Testnachrichten.", { retry_after_s: 7 }));
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Testnachricht senden" }));
    expect(await within(pushRow()).findByText("Gerade erst geschickt")).toBeInTheDocument();
    expect(pushRow()).toHaveTextContent("Nächste Testnachricht in 7 s");
  });

  it("wartet auch mit der Ausgangslage der Attrappe so lange, wie der Server sagt, und schickt danach", async () => {
    const core = renderApp({ scenarios: ["push-rate-limited"] }, ROUTES.settings);
    await ready();
    const button = within(pushRow()).getByRole("button", { name: "Testnachricht senden" });
    await userEvent.click(button);
    expect(await within(pushRow()).findByText("Gerade erst geschickt")).toBeInTheDocument();
    // Eben ging eine hinaus: Es bleiben einige der PUSH_TEST_INTERVAL_S Sekunden.
    const left = Number(/Nächste Testnachricht in (\d+) s/.exec(pushRow().textContent ?? "")?.[1]);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(PUSH_TEST_INTERVAL_S);
    expect(button).toBeUnavailable();
    expect(value(core.push.state)).toBe("on");
  });

  it("schaltet aus, auch ohne Server", async () => {
    const core = renderApp({ scenarios: ["push-on", "offline"] }, ROUTES.settings);
    await ready();
    expect(pushRow()).toHaveTextContent("Gerade ist der Server nicht erreichbar: Einschalten und Testnachricht gehen erst wieder mit ihm.");
    expect(within(pushRow()).getByRole("button", { name: "Testnachricht senden" })).toBeUnavailable();

    await userEvent.click(within(pushRow()).getByRole("button", { name: "Ausschalten" }));
    expect(await screen.findByText("Benachrichtigungen sind auf diesem Gerät aus.")).toBeInTheDocument();
    expect(value(core.push.state)).toBe("off");
    // Einschalten braucht den Server.
    expect(within(pushRow()).getByRole("button", { name: "Einschalten" })).toBeUnavailable();
  });

  it("sagt, wenn der Server beim Einschalten nicht erreichbar ist", async () => {
    const core = renderApp({}, ROUTES.settings);
    vi.spyOn(core.push, "enable").mockRejectedValue(new CoreError("offline"));
    await ready();
    await userEvent.click(within(pushRow()).getByRole("button", { name: "Einschalten" }));
    expect(await within(pushRow()).findByText("Zum Einschalten braucht es den Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
  });

  it("erklärt auf dem iPhone im Browser, dass es erst installiert sein muss, statt einen Knopf zu zeigen", async () => {
    renderApp({ scenarios: ["ios"] }, ROUTES.settings);
    await ready();
    expect(pushRow()).toHaveTextContent("Auf iPhone und iPad kommen Benachrichtigungen nur zu Stowly auf dem Home-Bildschirm (ab iOS 16.4).");
    expect(within(pushRow()).queryByRole("button", { name: "Einschalten" })).not.toBeInTheDocument();
    expect(within(pushRow()).getByRole("link", { name: "Anleitung unter „Diese App“" })).toHaveAttribute("href", `${ROUTES.settings}#app`);
  });

  it("nennt den Grund, wenn es nicht geht: kein Push im Browser, keine HTTPS-Adresse, Server nicht eingerichtet, blockiert", async () => {
    const cases: [Parameters<typeof renderApp>[0], string, string][] = [
      [{ scenarios: ["push-unsupported"] }, "nicht möglich", "Dieser Browser kann hier keine Benachrichtigungen empfangen."],
      [{ scenarios: ["insecure"] }, "nicht möglich", "Über eine http-Adresse lässt der Browser keine Benachrichtigungen zu."],
      [{ scenarios: ["push-not-configured"] }, "nicht eingerichtet", "Wer ihn betreibt, setzt dafür STOWLY_PUSH_CONTACT"],
      [{ scenarios: ["push-denied"] }, "blockiert", "Die Erlaubnis für Benachrichtigungen ist in diesem Browser verweigert."],
    ];
    for (const [options, short, hint] of cases) {
      renderApp(options, ROUTES.settings);
      await ready();
      expect(pushRow(), short).toHaveTextContent(short);
      expect(pushRow(), short).toHaveTextContent(hint);
      expect(within(pushRow()).queryByRole("button")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("beschreibt jeden Zustand und jedes Ergebnis der Testnachricht in einem Satz", () => {
    for (const state of ["unsupported", "ios_install", "not_configured", "off", "on", "denied", undefined] as const) {
      const text = describePush(state, true);
      expect(text.value, String(state)).not.toBe("");
      expect(text.hint, String(state)).toMatch(/\.$/);
    }
    expect(testMessage({ status: "failed", http_status: null, message: "Zeitüberschreitung." }).text).toBe(
      "Der Push-Dienst war nicht erreichbar oder überlastet. Später noch einmal versuchen. Meldung des Servers: Zeitüberschreitung.",
    );
    expect(testMessage({ status: "sent", http_status: 201, message: "" }).tone).toBe("success");
  });
});

describe("Zustand der automatischen Sicherung", () => {
  it("zeigt Uhrzeit, letzte gelungene Sicherung mit Größe, nächsten Versuch und die gekürzten Schlüssel", async () => {
    // Die Beispiele der Attrappe folgen der Uhr: heute um 03:30 in Berlin gelungen (02:30 UTC).
    // Nur `Date` steht still, die Zeitgeber laufen wie sonst.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T09:30:00.000Z") });
    try {
      renderApp({}, ROUTES.settings);
      await ready();
      const backup = section("Sicherung");
      expect(await within(backup).findByText(/täglich um 03:30/)).toBeInTheDocument();
      expect(backup).toHaveTextContent(/Letzte gelungene.*vor 7 Stunden · 52 kB · stowly-2026-11-14-0330\.sqlite3\.gz\.age/);
      expect(backup).toHaveTextContent("Nächster Versuch");
      const keys = within(backup).getByRole("list", { name: "Öffentliche Schlüssel" });
      expect(within(keys).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["age1ql3z…ac8p", "age1x7m2…9kqd"]);
      expect(within(backup).queryByRole("alert")).not.toBeInTheDocument();
      // Daneben die Kopie zum Herunterladen
      expect(within(backup).getByRole("button", { name: "Herunterladen" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warnt nach 48 Stunden ohne gelungene Sicherung und nennt den letzten Fehler", async () => {
    renderApp({ scenarios: ["backup-warning"] }, ROUTES.settings);
    await ready();
    const backup = section("Sicherung");
    const alert = await within(backup).findByRole("alert");
    expect(alert).toHaveTextContent("Seit mehr als 48 Stunden keine Sicherung");
    expect(backup).toHaveTextContent("Letzter Fehler");
    expect(backup).toHaveTextContent("Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001).");
    // Drei Läufe um 03:30 zurück: nach Kalendertagen des Geräts drei oder, vor 03:30, vier Tage.
    expect(backup).toHaveTextContent(/vor [34] Tagen/);
  });

  it("sagt, wenn die Sicherung nur halb eingerichtet ist", async () => {
    renderApp({ scenarios: ["backup-problem"] }, ROUTES.settings);
    await ready();
    const backup = section("Sicherung");
    expect(await within(backup).findByText("Die automatische Sicherung ist aus")).toBeInTheDocument();
    expect(backup).toHaveTextContent("STOWLY_BACKUP_RECIPIENTS fehlt.");
    expect(backup).toHaveTextContent("Nicht eingerichtet. Wer den Server betreibt, richtet sie mit STOWLY_BACKUP_DIR und STOWLY_BACKUP_RECIPIENTS ein");
  });

  it("sagt offline, dass der Zustand fehlt, und lädt ihn, sobald der Server wieder da ist", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    await ready();
    const backup = section("Sicherung");
    expect(await within(backup).findByText("Den Zustand kennt nur der Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(backup).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    core.control.setOnline(true);
    expect(await within(backup).findByText(/täglich um 03:30/)).toBeInTheDocument();
  });

  it("zeigt die Zeitzone des Servers, wenn sie von der des Geräts abweicht", () => {
    expect(backupTimeText("03:30", "Europe/Berlin", "Europe/Berlin")).toBe("täglich um 03:30");
    expect(backupTimeText("03:30", "Europe/Berlin", "America/New_York")).toBe("täglich um 03:30 (Zeit des Servers, Europe/Berlin)");
    expect(backupTimeText("03:30", "Europe/Berlin", "")).toBe("täglich um 03:30");
    expect(backupWarningText({ last_ok_at: null }).title).toBe("Noch keine Sicherung gelungen");
  });

  it("zeigt Zeiten in der Zeitzone des Geräts", async () => {
    const core = renderApp({}, ROUTES.settings);
    const status = await core.integrations.load();
    await ready();
    expect(await within(section("Sicherung")).findByText(formatTimestamp(status.backup.last_ok_at ?? ""))).toBeInTheDocument();
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

/** Eine Zeitzone, die sicher nicht die des Geräts ist. */
function otherZone(): string {
  return deviceTimeZone() === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";
}

/** Öffnet die Einstellungen vom Bestand aus: So gilt, was der Test vorher am Kern eingerichtet hat, schon für das erste Laden. */
async function openSettings(): Promise<void> {
  await screen.findByRole("heading", { name: "Bestand" });
  await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Einstellungen" }));
  await ready();
}

const HA = "Home Assistant und Bring!";

describe("Home Assistant und Bring!", () => {
  const base: HaStatus = {
    configured: true,
    problem: null,
    entity: "todo.einkaufsliste",
    state: "ok",
    last_ok_at: "2026-11-14T10:00:00.000Z",
    last_error: null,
    last_error_at: null,
    linked: 2,
    sensor: true,
  };
  const now = Date.parse("2026-11-14T10:05:00.000Z");

  it("beschreibt jeden Zustand des Abgleichs in einem Satz", () => {
    const states: HaState[] = ["pending", "ok", "unauthorized", "not_found", "unavailable", "unreachable", "error"];
    expect(states.map((state) => describeHa({ ...base, state }, now).value)).toEqual([
      "eingerichtet",
      "verbunden",
      "Token abgelehnt",
      "Liste fehlt",
      "Liste nicht verfügbar",
      "nicht erreichbar",
      "Fehler",
    ]);
    for (const state of states) {
      expect(describeHa({ ...base, state }, now).hint, state).toMatch(/\.$/);
    }
    expect(describeHa(base, now).hint).toBe(`Zuletzt gelungen vor 5 Minuten (${formatTimestamp(base.last_ok_at ?? "")}). Gerade stehen 2 Einträge in Bring!.`);
    expect(describeHa({ ...base, state: "not_found" }, now).hint).toContain("Die Liste todo.einkaufsliste gibt es in Home Assistant nicht.");
    expect(describeHa({ ...base, state: "unreachable", last_ok_at: null }, now).hint).toContain("Seit dem Start des Servers ist noch keiner gelungen.");
    // Störungen bekommen einen Hinweis über der Liste: rot, wo am Server etwas zu ändern ist.
    expect(describeHa({ ...base, state: "unauthorized" }, now).notice?.tone).toBe("danger");
    expect(describeHa({ ...base, state: "not_found" }, now).notice?.tone).toBe("danger");
    expect(describeHa({ ...base, state: "unavailable" }, now).notice?.tone).toBe("warn");
    expect(describeHa({ ...base, state: "unreachable" }, now).notice?.tone).toBe("warn");
    expect(describeHa(base, now).notice).toBeNull();
    expect(describeHa({ ...base, state: "pending", last_ok_at: null }, now).notice).toBeNull();

    const off: HaStatus = { ...base, configured: false, entity: null, state: "off", last_ok_at: null, linked: 0, sensor: false };
    expect(describeHa(off, now)).toMatchObject({ value: "aus", notice: null });
    expect(describeHa({ ...off, problem: "STOWLY_HA_TOKEN fehlt." }, now).notice).toEqual({ tone: "warn", title: "Der Abgleich mit Bring! ist aus", text: "STOWLY_HA_TOKEN fehlt." });

    expect(linkedText(0)).toBe("Gerade steht kein Eintrag in Bring!.");
    expect(linkedText(1)).toBe("Gerade steht 1 Eintrag in Bring!.");
    expect(linkedText(4)).toBe("Gerade stehen 4 Einträge in Bring!.");

    // Die Zeiten kommen aus dem Vertrag (HA_MIRROR_DELAY_S, HA_SYNC_INTERVAL_S).
    expect(durationText(HA_MIRROR_DELAY_S)).toBe("zwei Minuten");
    expect(describeHa({ ...base, state: "unreachable" }, now).hint).toContain("versucht es alle zwei Minuten wieder.");
    expect([durationText(60), durationText(90), durationText(600)]).toEqual(["eine Minute", "90 Sekunden", "zehn Minuten"]);
  });

  it("sagt ohne Home Assistant, dass es nicht eingerichtet ist und wie es geht, und erklärt den Abgleich", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const ha = section(HA);
    expect(await within(ha).findByText("Bring! über Home Assistant")).toBeInTheDocument();
    expect(ha).toHaveTextContent("Nicht eingerichtet. Wer den Server betreibt, richtet es mit STOWLY_HA_URL, STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY ein");
    expect(ha).toHaveTextContent("Ohne Home Assistant funktioniert die Einkaufsliste genauso, nur ohne Bring!.");
    expect(ha).toHaveTextContent("Nicht eingerichtet. Wer den Server betreibt, setzt dafür STOWLY_HA_SUMMARY_TOKEN");
    expect(within(ha).queryByText("Liste in Home Assistant")).not.toBeInTheDocument();
    expect(within(ha).queryByRole("status")).not.toBeInTheDocument();
    // Was der Abgleich tut, kurz
    expect(ha).toHaveTextContent("Ein Eintrag der Einkaufsliste erscheint in Bring!, sobald er zwei Minuten offen ist.");
    expect(ha).toHaveTextContent("Wer ihn in Bring! abhakt, erledigt ihn in Stowly.");
    expect(ha).toHaveTextContent("Eigene Artikel in Bring! bleiben unberührt: Stowly übernimmt sie nicht und hakt sie nie ab.");
  });

  it("zeigt nach einem gelungenen Abgleich Zeit, Einträge in Bring!, Liste und Sensor, aber nie Adresse oder Token", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    await ready();
    const ha = section(HA);
    expect(await within(ha).findByText("verbunden")).toBeInTheDocument();
    const status = await core.integrations.load();
    expect(ha).toHaveTextContent(`Zuletzt gelungen vor einer Minute (${formatTimestamp(status.ha.last_ok_at ?? "")}).`);
    expect(ha).toHaveTextContent(linkedText(status.ha.linked));
    expect(within(ha).getByText("todo.einkaufsliste")).toBeInTheDocument();
    expect(ha).toHaveTextContent("Home Assistant liest eine Zusammenfassung (bald fällig, abgelaufen, Einkaufsliste)");
    expect(within(ha).getByText("eingerichtet")).toBeInTheDocument();
    expect(within(ha).queryByRole("status")).not.toBeInTheDocument();
    expect(ha).not.toHaveTextContent(/https?:\/\/|Bearer|Token:/);
  });

  it("sagt, solange seit dem Start des Servers noch kein Abgleich lief", async () => {
    renderApp({ scenarios: ["ha-pending"] }, ROUTES.settings);
    await ready();
    const ha = section(HA);
    expect(await within(ha).findByText("Seit dem Start des Servers lief noch kein Abgleich; der erste folgt in wenigen Minuten.")).toBeInTheDocument();
    expect(within(ha).getAllByText("eingerichtet")).toHaveLength(2);
  });

  it("nennt eine Störung mit Satz, dem Fehler des Servers und seiner Zeit", async () => {
    const cases: [Parameters<typeof renderApp>[0], string, string][] = [
      [{ scenarios: ["ha-unreachable"] }, "nicht erreichbar", "Home Assistant ist nicht erreichbar"],
      [{ scenarios: ["ha-unauthorized"] }, "Token abgelehnt", "Home Assistant lehnt den Token ab"],
    ];
    for (const [options, value, title] of cases) {
      const core = renderApp(options, ROUTES.settings);
      await ready();
      const ha = section(HA);
      expect(await within(ha).findByText(value)).toBeInTheDocument();
      const notice = within(ha).getByRole("status");
      expect(notice, value).toHaveTextContent(title);
      expect(notice, value).toHaveTextContent("Die Einkaufsliste in Stowly bleibt vollständig");
      const status = await core.integrations.load();
      expect(ha, value).toHaveTextContent(`Letzter Fehler${status.ha.last_error ?? ""}`);
      expect(ha, value).toHaveTextContent(formatTimestamp(status.ha.last_error_at ?? ""));
      expect(ha, value).toHaveTextContent(`Zuletzt gelungen vor 3 Stunden (${formatTimestamp(status.ha.last_ok_at ?? "")}).`);
      cleanup();
    }
  });

  it("sagt, wenn Home Assistant nur halb eingerichtet ist", async () => {
    renderApp({ scenarios: ["ha-problem"] }, ROUTES.settings);
    await ready();
    const ha = section(HA);
    expect(await within(ha).findByText("Der Abgleich mit Bring! ist aus")).toBeInTheDocument();
    expect(within(ha).getByRole("status")).toHaveTextContent("STOWLY_HA_TOKEN fehlt.");
    expect(ha).toHaveTextContent("Nur halb eingerichtet. Für den Abgleich braucht der Server STOWLY_HA_URL, STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY");
  });

  it("folgt dem Zustand, sobald er neu geladen ist", async () => {
    const core = renderApp({ scenarios: ["ha-ok"] }, ROUTES.settings);
    await ready();
    const ha = section(HA);
    await within(ha).findByText("verbunden");
    const states: [HaState, string][] = [
      ["not_found", "Liste fehlt"],
      ["unavailable", "Liste nicht verfügbar"],
      ["error", "Fehler"],
      ["ok", "verbunden"],
    ];
    for (const [state, text] of states) {
      core.control.setHaState(state);
      // Kurz ohne Server: Der Zustand fehlt; mit ihm kommt der neue.
      act(() => core.control.setOnline(false));
      expect(await within(ha).findByText("Zustand von Home Assistant fehlt")).toBeInTheDocument();
      expect(ha).toHaveTextContent("Den Zustand kennt nur der Server, und der ist gerade nicht erreichbar.");
      act(() => core.control.setOnline(true));
      expect(await within(ha).findByText(text), state).toBeInTheDocument();
    }
  });
});

describe("Uhrzeit der Tagesnachricht", () => {
  function field(): HTMLElement {
    return within(section("Haushalt")).getByLabelText("Uhrzeit der Tagesnachricht");
  }

  it("liest Uhrzeiten, wie sie getippt werden", () => {
    expect(readTime("17:00")).toBe("17:00");
    expect(readTime("1700")).toBe("17:00");
    expect(readTime("17")).toBe("17:00");
    expect(readTime(" 8 ")).toBe("08:00");
    expect(readTime("7:30")).toBe("07:30");
    expect(readTime("730")).toBe("07:30");
    expect(readTime("17.30")).toBe("17:30");
    // Keine Uhrzeit: unverändert, die Prüfung lehnt es ab.
    expect(readTime("25:00")).toBe("25:00");
    expect(readTime("17:5")).toBe("17:5");
    expect(readTime("")).toBe("");
  });

  it("erklärt, wann die Nachricht kommt, und nennt eine abweichende Zeitzone des Servers", () => {
    expect(notifyTimeHint("17:00", "Europe/Berlin", true, "Europe/Berlin")).toBe(
      "Täglich um 17:00 an die Geräte mit eingeschalteten Benachrichtigungen, aber nur, wenn seit der letzten Nachricht etwas neu bald abläuft oder abgelaufen ist. War der Server zu dieser Zeit aus, kommt sie später, aber nur bis 21 Uhr.",
    );
    expect(notifyTimeHint("17:00", "Europe/Berlin", true, "America/New_York")).toMatch(/^Täglich um 17:00 \(Zeit des Servers, Europe\/Berlin\) an die Geräte/);
    // Unbekannte Zeitzone des Servers (offline): kein Hinweis darauf.
    expect(notifyTimeHint("17:00", null, null, "America/New_York")).toMatch(/^Täglich um 17:00 an/);
    expect(notifyTimeHint("21:00", null, null, "Europe/Berlin")).toContain("kommt sie höchstens eine Stunde später und nicht nach Mitternacht.");
    expect(notifyTimeHint("20:59", null, null, "Europe/Berlin")).toContain("aber nur bis 21 Uhr.");
    expect(notifyTimeHint("17:00", null, false, "Europe/Berlin")).toContain("Der Server ist noch nicht für Benachrichtigungen eingerichtet (STOWLY_PUSH_CONTACT): Bis dahin kommt keine.");
  });

  it("zeigt die Vorgabe 17:00 und ändert sie beim Verlassen des Felds", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    expect(field()).toHaveValue("17:00");
    expect(field()).toHaveAttribute("type", "time");
    // Läuft der Test nicht in der Zeitzone der Attrappe (Europe/Berlin), steht sie dabei.
    expect(section("Haushalt")).toHaveTextContent(/Täglich um 17:00 (\(Zeit des Servers, Europe\/Berlin\) )?an die Geräte mit eingeschalteten Benachrichtigungen/);
    expect(section("Haushalt")).toHaveTextContent("kommt sie später, aber nur bis 21 Uhr.");

    await userEvent.clear(field());
    await userEvent.type(field(), "21:30");
    expect(value(core.data.settings).notify_time).toBe("17:00");
    await userEvent.tab();
    await waitFor(() => expect(value(core.data.settings).notify_time).toBe("21:30"));
    expect(await screen.findByText("Einstellung gespeichert")).toBeInTheDocument();
    expect(section("Haushalt")).toHaveTextContent("Täglich um 21:30");
    expect(section("Haushalt")).toHaveTextContent("kommt sie höchstens eine Stunde später und nicht nach Mitternacht.");
  });

  it("übernimmt mit Enter und lehnt eine leere Uhrzeit mit dem Satz des Vertrags ab", async () => {
    const core = renderApp({}, ROUTES.settings);
    const update = vi.spyOn(core.settings, "update");
    await ready();
    await userEvent.clear(field());
    await userEvent.tab();
    expect(await within(section("Haushalt")).findByRole("alert")).toHaveTextContent("Die Uhrzeit muss als HH:MM angegeben sein, etwa 17:00.");
    expect(update).not.toHaveBeenCalled();

    await userEvent.type(field(), "06:45{Enter}");
    await waitFor(() => expect(value(core.data.settings).notify_time).toBe("06:45"));
    expect(update).toHaveBeenCalledWith({ notify_time: "06:45" });
    expect(within(section("Haushalt")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ändert sie auch ohne Server: Die Änderung geht mit dem nächsten Abgleich hinaus", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    await ready();
    const before = value(core.sync.status).pending;
    await userEvent.clear(field());
    await userEvent.type(field(), "07:15");
    await userEvent.tab();
    await waitFor(() => expect(value(core.data.settings).notify_time).toBe("07:15"));
    expect(value(core.sync.status).pending).toBe(before + 1);
    // Ohne Server kennt die App seine Zeitzone nicht: kein Hinweis darauf, aber die Erklärung bleibt.
    expect(section("Haushalt")).toHaveTextContent("Täglich um 07:15 an die Geräte");
  });

  it("nennt die Zeitzone des Servers, wenn sie von der des Geräts abweicht", async () => {
    const core: MockCore = renderApp();
    const zone = otherZone();
    core.control.setIntegrations({ timezone: zone });
    await openSettings();
    expect(await within(section("Haushalt")).findByText(new RegExp(`^Täglich um 17:00 \\(Zeit des Servers, ${zone.replace("/", "\\/")}\\)`))).toBeInTheDocument();
  });

  it("sagt, solange der Server nicht für Benachrichtigungen eingerichtet ist", async () => {
    renderApp({ scenarios: ["push-not-configured"] }, ROUTES.settings);
    await ready();
    expect(await within(section("Haushalt")).findByText(/Der Server ist noch nicht für Benachrichtigungen eingerichtet \(STOWLY_PUSH_CONTACT\)/)).toBeInTheDocument();
  });

  it("folgt einer Änderung von einem anderen Gerät", async () => {
    const core = renderApp({}, ROUTES.settings);
    await ready();
    await act(() => core.settings.update({ notify_time: "18:05" }));
    await waitFor(() => expect(field()).toHaveValue("18:05"));
  });
});

const UPDATE = "Aktualisierung";

/** Ein Zustand der Updates: eingerichtet, eine neue Version mit Änderungen, der Updater bereit. */
function updateStatus(changes: Partial<UpdateStatus> = {}): UpdateStatus {
  const now = Date.now();
  return {
    configured: true,
    repo: "beispiel/stowly",
    current: "0.1.0",
    latest: "0.2.0",
    latest_name: "Updates aus den Einstellungen",
    notes: "## Neu\n\n- Updates <b>direkt</b> installieren\n- Zweite Zeile",
    published_at: "2026-11-12T09:00:00.000Z",
    url: "https://github.com/beispiel/stowly/releases/tag/v0.2.0",
    available: true,
    checked_at: new Date(now - 2 * 3_600_000).toISOString(),
    check_error: null,
    updater_ready: true,
    updater_seen_at: new Date(now - 60_000).toISOString(),
    state: "idle",
    state_version: null,
    state_at: null,
    state_message: null,
    ...changes,
  };
}

/** Öffnet die Einstellungen mit diesem Zustand der Updates; er gilt schon beim ersten Laden. */
async function settingsWithUpdate(update: UpdateStatus): Promise<MockCore> {
  const core = renderApp();
  core.control.setIntegrations({ update });
  await openSettings();
  return core;
}

/** Was die Statuszeile des Abschnitts für Screenreader ansagt. */
function announced(): string {
  return section(UPDATE).querySelector("p.sr-only[role='status']")?.textContent ?? "";
}

describe("Aktualisierung", () => {
  it("nennt ohne STOWLY_UPDATE_REPO nur die installierte Version und warum", async () => {
    renderApp({ scenarios: ["release-off"] }, ROUTES.settings);
    await ready();
    const update = section(UPDATE);
    expect(document.getElementById("aktualisierung")).toBe(update);
    expect(await within(update).findByText("Installierte Version")).toBeInTheDocument();
    expect(update).toHaveTextContent("Installierte VersionUpdates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO).0.1.0");
    expect(within(update).queryByText("Neueste Version")).not.toBeInTheDocument();
    expect(within(update).queryByRole("button")).not.toBeInTheDocument();
  });

  it("zeigt eine aktuelle Version und die letzte Suche, ohne etwas zum Installieren anzubieten", async () => {
    renderApp({}, ROUTES.settings);
    await ready();
    const update = section(UPDATE);
    expect(await within(update).findByText("Neueste Version")).toBeInTheDocument();
    expect(update).toHaveTextContent("Neue Versionen kommen aus beispiel/stowly auf GitHub.");
    expect(update).toHaveTextContent("Stowly ist auf dem neuesten Stand.");
    expect(update).toHaveTextContent(/Gelungen vor 2 Stunden \(\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\)\. Der Server sucht von selbst alle 6 Stunden\./);
    expect(within(update).getByRole("button", { name: "Nach Updates suchen" })).toBeInTheDocument();
    expect(within(update).queryByRole("button", { name: "Update installieren" })).not.toBeInTheDocument();
    expect(within(update).queryByText("neu")).not.toBeInTheDocument();
    expect(announced()).toBe("");
  });

  it("zeigt eine neue Version mit Datum und ihre Änderungen aufklappbar als Klartext", async () => {
    const status = updateStatus();
    await settingsWithUpdate(status);
    const update = section(UPDATE);
    expect(await within(update).findByText("neu")).toBeInTheDocument();
    const day = formatDate(toLocalDate(new Date(status.published_at ?? "")));
    expect(update).toHaveTextContent(`„Updates aus den Einstellungen“, erschienen am ${day}. Neuer als die installierte Version 0.1.0.`);
    expect(within(update).getByRole("button", { name: "Update installieren" })).toBeInTheDocument();

    const toggle = within(update).getByRole("button", { name: "Änderungen zeigen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(update).queryByText(/Zweite Zeile/)).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Änderungen verbergen");
    const notes = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    // Klartext: Nichts davon wird als HTML gelesen, und die Zeilenumbrüche bleiben.
    expect(notes?.textContent).toBe(status.notes);
    expect(notes?.querySelector("b")).toBeNull();
    expect(notes).toHaveTextContent("Updates <b>direkt</b> installieren");

    const link = within(update).getByRole("link", { name: "Auf GitHub ansehen" });
    expect(link).toHaveAttribute("href", status.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(update).queryByText(/Zweite Zeile/)).not.toBeInTheDocument();
  });

  it("verlinkt nur Seiten auf GitHub und lässt die Änderungen ohne Inhalt weg", async () => {
    await settingsWithUpdate(updateStatus({ url: "https://example.org/release" }));
    expect(await within(section(UPDATE)).findByRole("button", { name: "Änderungen zeigen" })).toBeInTheDocument();
    expect(within(section(UPDATE)).queryByRole("link")).not.toBeInTheDocument();
    cleanup();

    await settingsWithUpdate(updateStatus({ notes: null, url: null }));
    expect(await within(section(UPDATE)).findByText("Neueste Version")).toBeInTheDocument();
    expect(within(section(UPDATE)).queryByText(/Änderungen in/)).not.toBeInTheDocument();
  });

  it("sucht auf Knopfdruck, meldet das Ergebnis und wartet danach so lange, wie der Server sagt", async () => {
    const core = renderApp({}, ROUTES.settings);
    const check = vi.spyOn(core.update, "check");
    await ready();
    const update = section(UPDATE);
    const button = await within(update).findByRole("button", { name: "Nach Updates suchen" });
    await userEvent.click(button);
    expect(await screen.findByText("Stowly ist auf dem neuesten Stand.")).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(update).toHaveTextContent("Gelungen gerade eben"));

    // Gleich noch einmal: höchstens einmal je Minute.
    await userEvent.click(button);
    expect(await within(update).findByText("Gerade erst gesucht")).toBeInTheDocument();
    expect(update).toHaveTextContent("Nach Updates suchen geht höchstens einmal je Minute. Bitte kurz warten.");
    const left = Number(/Nächste Suche in (\d+) s/.exec(update.textContent ?? "")?.[1]);
    expect(left).toBeGreaterThan(50);
    expect(left).toBeLessThanOrEqual(60);
    // Der Knopf ruht, behält aber den Fokus.
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("nimmt die Wartezeit des Servers und sagt, wenn er fehlt", async () => {
    const core = renderApp({}, ROUTES.settings);
    const check = vi.spyOn(core.update, "check").mockRejectedValueOnce(new CoreError("offline"));
    await ready();
    const update = section(UPDATE);
    await userEvent.click(await within(update).findByRole("button", { name: "Nach Updates suchen" }));
    expect(await within(update).findByText("Gesucht wird über den Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();

    // Was fehlt, sagt der Server selbst.
    check.mockRejectedValueOnce(new CoreError("not_configured", "Die Abfrage bei GitHub ist gerade nicht verfügbar."));
    await userEvent.click(within(update).getByRole("button", { name: "Nach Updates suchen" }));
    expect(await within(update).findByText("Die Abfrage bei GitHub ist gerade nicht verfügbar.")).toBeInTheDocument();

    check.mockRejectedValueOnce(new CoreError("rate_limited", "Zu oft.", { retry_after_s: 42 }));
    await userEvent.click(within(update).getByRole("button", { name: "Nach Updates suchen" }));
    expect(await within(update).findByText("Nächste Suche in 42 s")).toBeInTheDocument();
  });

  it("meldet nach der Suche eine neue Version oder den Fehler bei GitHub", async () => {
    const core = renderApp({}, ROUTES.settings);
    const check = vi.spyOn(core.update, "check").mockResolvedValueOnce(updateStatus({ checked_at: new Date().toISOString() }));
    await ready();
    const update = section(UPDATE);
    await userEvent.click(await within(update).findByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByText("Neue Version gefunden: Stowly 0.2.0")).toBeInTheDocument();
    expect(within(update).getByRole("button", { name: "Update installieren" })).toBeInTheDocument();

    check.mockResolvedValueOnce(updateStatus({ check_error: "GitHub ist nicht erreichbar." }));
    await userEvent.click(within(update).getByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByText("Die Suche ist gescheitert: GitHub ist nicht erreichbar.")).toBeInTheDocument();
    expect(update).toHaveTextContent("Die letzte Suche ist gescheitert: GitHub ist nicht erreichbar.");
  });

  it("fordert ein Update erst nach der Rückfrage an; Abbrechen lässt alles, wie es war", async () => {
    const core = renderApp({ scenarios: ["release-new"] }, ROUTES.settings);
    const install = vi.spyOn(core.update, "install");
    await ready();
    const update = section(UPDATE);
    const button = await within(update).findByRole("button", { name: "Update installieren" });
    expect(update).toHaveTextContent("Update auf 0.2.0");

    await userEvent.click(button);
    const title = "Update auf 0.2.0 installieren?";
    expect(screen.getByRole("dialog", { name: title })).toHaveTextContent(INSTALL_WARNING);
    await userEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toHaveFocus());

    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: "Installieren" }));
    expect(install).toHaveBeenCalledWith("0.2.0");
    const state = await within(update).findByText("Angefordert");
    expect(update).toHaveTextContent("Der Updater übernimmt in den nächsten Minuten.");
    expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
    expect(within(update).queryByRole("button", { name: "Update installieren" })).not.toBeInTheDocument();
    // Der Fokus geht an den neuen Stand, und die Statuszeile sagt ihn an.
    const target = state.closest<HTMLElement>("[tabindex='-1']");
    expect(target).not.toBeNull();
    await waitFor(() => expect(target).toHaveFocus());
    expect(announced()).toBe("Angefordert. Der Updater übernimmt in den nächsten Minuten.");
  });

  it("zeigt in der Rückfrage, was der Server gegen das Anfordern hat, und lädt seinen Stand neu", async () => {
    const core = renderApp({ scenarios: ["release-new"] }, ROUTES.settings);
    const install = vi.spyOn(core.update, "install").mockRejectedValueOnce(new CoreError("conflict", "Ein Update ist schon angefordert."));
    const load = vi.spyOn(core.integrations, "load");
    await ready();
    await userEvent.click(await within(section(UPDATE)).findByRole("button", { name: "Update installieren" }));
    const dialog = screen.getByRole("dialog", { name: "Update auf 0.2.0 installieren?" });
    const loads = load.mock.calls.length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Installieren" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Ein Update ist schon angefordert.");
    expect(load.mock.calls.length).toBeGreaterThan(loads);

    const cases: [CoreError, string][] = [
      [new CoreError("not_configured", "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9)."), "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9)."],
      [new CoreError("conflict", "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen."), "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen."],
      [new CoreError("offline"), "Zum Anfordern braucht es den Server, und der ist gerade nicht erreichbar."],
    ];
    for (const [error, text] of cases) {
      install.mockRejectedValueOnce(error);
      await userEvent.click(within(dialog).getByRole("button", { name: "Installieren" }));
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(text));
    }
  });

  it("nennt jeden Stand eines Updates und bietet währenddessen nichts zum Installieren an", async () => {
    const at = "2026-11-16T09:02:00.000Z";
    const stale = "Der Updater hat die Anforderung noch nicht abgeholt. Läuft die Aufgabe auf dem Rechner?";
    const silent = "Der Updater meldet sich seit 15 Minuten nicht. Bitte auf dem Rechner nachsehen.";
    const back = "Die neue Version startete nicht, zurück auf 0.1.0.";
    const installing = "Der Updater holt Stowly 0.2.0 und startet Stowly neu; dabei ist es kurz nicht erreichbar.";
    const cases: { changes: Partial<UpdateStatus>; title: string; text: string; announcement: string; offered: boolean }[] = [
      {
        changes: { state: "requested", state_version: "0.2.0", state_at: at },
        title: "Angefordert",
        text: "Der Updater übernimmt in den nächsten Minuten.",
        announcement: "Angefordert. Der Updater übernimmt in den nächsten Minuten.",
        offered: false,
      },
      {
        changes: { state: "requested", state_version: "0.2.0", state_at: at, updater_ready: false, state_message: stale },
        title: "Angefordert",
        text: `Der Updater übernimmt in den nächsten Minuten. ${stale}`,
        announcement: `Angefordert. Der Updater übernimmt in den nächsten Minuten. ${stale}`,
        offered: false,
      },
      { changes: { state: "installing", state_version: "0.2.0", state_at: at }, title: "Wird installiert …", text: installing, announcement: `Wird installiert … ${installing}`, offered: false },
      {
        changes: { state: "installing", state_version: "0.2.0", state_at: at, state_message: silent },
        title: "Wird installiert …",
        text: `${installing} ${silent}`,
        announcement: `Wird installiert … ${installing} ${silent}`,
        offered: false,
      },
      {
        changes: { state: "done", state_version: "0.2.0", state_at: at, current: "0.2.0", available: false },
        title: "Aktualisiert auf 0.2.0",
        text: `Am ${formatTimestamp(at)}.`,
        announcement: `Aktualisiert auf 0.2.0. Am ${formatTimestamp(at)}.`,
        offered: false,
      },
      // Nach einem gescheiterten Update geht ein neuer Versuch.
      {
        changes: { state: "failed", state_version: "0.2.0", state_at: at, state_message: back },
        title: "Update auf 0.2.0 gescheitert",
        text: back,
        announcement: `Update auf 0.2.0 gescheitert. ${back}`,
        offered: true,
      },
    ];
    for (const { changes, title, text, announcement, offered } of cases) {
      await settingsWithUpdate(updateStatus(changes));
      const update = section(UPDATE);
      expect(await within(update).findByText(title), title).toBeInTheDocument();
      expect(update, title).toHaveTextContent(text);
      expect(announced(), title).toBe(announcement);
      expect(Boolean(within(update).queryByRole("button", { name: "Update installieren" })), title).toBe(offered);
      cleanup();
    }

    // Ohne Stand, aber mit einem Satz des Servers: der Satz.
    await settingsWithUpdate(updateStatus({ state_message: "Hinweis des Servers." }));
    await waitFor(() => expect(announced()).toBe("Hinweis des Servers."));
    // Sichtbar als Hinweis, dazu in der Statuszeile.
    expect(within(section(UPDATE)).getAllByText("Hinweis des Servers.")).toHaveLength(2);
  });

  it("sagt, wenn sich der Updater auf dem Rechner nicht meldet, statt das Installieren anzubieten", async () => {
    renderApp({ scenarios: ["release-no-updater"] }, ROUTES.settings);
    await ready();
    const update = section(UPDATE);
    expect(await within(update).findByText("Stowly 0.2.0 lässt sich nicht installieren")).toBeInTheDocument();
    expect(update).toHaveTextContent("Der Updater auf dem Rechner meldet sich nicht. Anleitung: docs/betrieb.md, Abschnitt 9.");
    expect(update).toHaveTextContent(/Zuletzt hat er sich am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} gemeldet\./);
    expect(within(update).getByText("neu")).toBeInTheDocument();
    expect(within(update).queryByRole("button", { name: "Update installieren" })).not.toBeInTheDocument();
  });

  it("fragt während eines Updates alle 10 Sekunden nach und sagt „Server startet neu …“, solange der Server fehlt", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const core = await settingsWithUpdate(updateStatus({ state: "installing", state_version: "0.2.0", state_at: new Date().toISOString() }));
      const load = vi.spyOn(core.integrations, "load");
      const update = section(UPDATE);
      expect(await within(update).findByText("Wird installiert …")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(UPDATE_POLL_MS));
      expect(load).toHaveBeenCalledTimes(1);

      // Stowly startet neu: Der Server fehlt, das ist hier kein Fehler.
      act(() => core.control.setOnline(false));
      await waitFor(() => expect(announced()).toBe("Server startet neu …"));
      expect(within(update).getAllByText("Server startet neu …")).toHaveLength(2);
      expect(within(update).queryByText("Zustand der Updates fehlt")).not.toBeInTheDocument();
      // Auch beim nächsten Nachfragen bleibt es dabei.
      await act(() => vi.advanceTimersByTimeAsync(UPDATE_POLL_MS));
      expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(announced()).toBe("Server startet neu …");

      // Die neue Version läuft: danach fragt der Abschnitt nicht mehr nach.
      core.control.setIntegrations({ update: updateStatus({ current: "0.2.0", available: false, state: "done", state_version: "0.2.0", state_at: new Date().toISOString() }) });
      act(() => core.control.setOnline(true));
      expect(await within(update).findByText("Aktualisiert auf 0.2.0")).toBeInTheDocument();
      expect(announced()).toMatch(/^Aktualisiert auf 0\.2\.0\. Am /);
      const calls = load.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(3 * UPDATE_POLL_MS));
      expect(load).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fragt nur nach, solange die Einstellungen offen sind", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const core = await settingsWithUpdate(updateStatus({ state: "requested", state_version: "0.2.0", state_at: new Date().toISOString() }));
      const load = vi.spyOn(core.integrations, "load");
      expect(await within(section(UPDATE)).findByText("Angefordert")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2 * UPDATE_POLL_MS));
      expect(load).toHaveBeenCalledTimes(2);

      await userEvent.click(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Bestand" }));
      await screen.findByRole("heading", { name: "Bestand" });
      await act(() => vi.advanceTimersByTimeAsync(3 * UPDATE_POLL_MS));
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sagt ohne laufendes Update und ohne Server, dass der Zustand fehlt, und lädt ihn, sobald er wieder da ist", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    await ready();
    const update = section(UPDATE);
    expect(await within(update).findByText("Zustand der Updates fehlt")).toBeInTheDocument();
    expect(update).toHaveTextContent("Den Zustand kennt nur der Server, und der ist gerade nicht erreichbar.");
    expect(within(update).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(update).not.toHaveTextContent("Server startet neu");
    act(() => core.control.setOnline(true));
    expect(await within(update).findByText("Neueste Version")).toBeInTheDocument();
  });

  it("beschreibt Versionen, Stände und Ergebnisse in Sätzen", () => {
    expect(checkIntervalText(21_600)).toBe("alle 6 Stunden");
    expect(checkIntervalText(3_600)).toBe("jede Stunde");
    expect(checkIntervalText(120)).toBe("alle zwei Minuten");

    expect(describeLatest(updateStatus({ latest: null, checked_at: null }))).toEqual({
      value: "noch nicht gefragt",
      hint: "Der Server fragt GitHub kurz nach seinem Start und danach alle 6 Stunden.",
    });
    // Gefragt, aber es gibt noch kein Release (404).
    expect(describeLatest(updateStatus({ latest: null }))).toEqual({ value: "noch keine Version veröffentlicht", hint: "Im Repository beispiel/stowly gibt es noch kein Release." });
    expect(describeLatest(updateStatus({ latest: "0.1.0", available: false, latest_name: null, published_at: null }))).toEqual({ value: "0.1.0", hint: "Stowly ist auf dem neuesten Stand." });

    expect(describeUpdateState(updateStatus())).toBeNull();
    expect(describeUpdateState(updateStatus({ state: "failed", state_version: "0.2.0" }))).toEqual({ tone: "danger", title: "Update auf 0.2.0 gescheitert", text: "Die bisherige Version läuft weiter." });
    expect(describeUpdateState(updateStatus({ state: "requested", state_version: "0.2.0" }))?.tone).toBe("info");
    expect(describeUpdateState(updateStatus({ state: "requested", state_version: "0.2.0", state_message: "Läuft die Aufgabe?" }))?.tone).toBe("warn");
    expect(describeUpdateState(updateStatus({ state: "done", state_version: "0.2.0", state_at: null }))).toEqual({ tone: "success", title: "Aktualisiert auf 0.2.0", text: "" });
    // Einen Stand, den die App nicht kennt (ein neuerer Server), übergeht sie bis auf den Satz dazu.
    const unknown = "downloading" as UpdateStatus["state"];
    expect(describeUpdateState(updateStatus({ state: unknown }))).toBeNull();
    expect(describeUpdateState(updateStatus({ state: unknown, state_message: "Lädt." }))).toEqual({ tone: "neutral", title: "", text: "Lädt." });

    expect(checkResult(updateStatus({ latest: null, available: false }))).toEqual({ tone: "neutral", message: "Auf GitHub ist noch keine Version veröffentlicht." });
    expect(checkResult(updateStatus({ latest: "0.1.0", available: false }))).toEqual({ tone: "success", message: "Stowly ist auf dem neuesten Stand." });

    expect(installErrorText(new CoreError("not_configured"))).toBe("Updates sind auf dem Rechner nicht vollständig eingerichtet (docs/betrieb.md, Abschnitt 9).");
    expect(installErrorText(new CoreError("conflict", "Diese Version ist schon installiert."))).toBe("Diese Version ist schon installiert.");
    expect(installErrorText(new CoreError("invalid", "Die Anfrage entspricht nicht dem Vertrag."))).toBe("Die Anfrage entspricht nicht dem Vertrag.");
  });
});
