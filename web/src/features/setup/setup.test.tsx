/**
 * Die Einrichtung auf der Attrappe: Anmeldeschranke mit Willkommensseite, automatisches Öffnen,
 * der Assistent mit seinen Schritten, die Bausteine dazu und der Abschnitt in den Einstellungen.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, CoreProvider, PI_CERT_WARN_DAYS, ROUTES, setupPath, type SetupStatus, type SyncStatus, type UpdateStatus } from "@/contract";
import { App } from "@/app/App";
import { renderApp } from "@/app/render.test-setup";
import { resetSetupAutoOpen, SETUP_DONE_FLAG, SETUP_LATER_FLAG } from "@/app/setupAutoOpen";
import { certificateWarningTitle, piCertificateWarning } from "@/features/printers/model";
import { countdownText, pairedText, PAIRING_POLL_MS } from "@/features/printers/PairPi";
import { setupProgressText } from "@/features/settings/SetupSection";
import { UPDATE_POLL_MS } from "@/features/settings/UpdateSection";
import { createMockCore, LiveValue, MOCK_PASSWORD, MockScanPage, PRINTER_IDS, type MockCore } from "@/mock";
import { MOCK_UPDATER_COMMAND } from "@/mock/core";
import { COPIED_MS, CopyField } from "@/ui/CopyField";
import { copyText } from "@/ui/copy";
import { ToastProvider } from "@/ui/base";
import { setTestViewport } from "@/ui/testing";

import { navigateAway, securePage, SETUP_MOVED_KEY } from "./navigateAway";
import { certificateUrl, phoneHost, SecureStep } from "./SecureStep";
import { doneCount, firstOpenStep, isOlderVersion, nextStep, previousStep, progressOf, stepNumber, stepOf } from "./steps";
import { guideFor, TrustGuide } from "./TrustGuide";

vi.mock("./navigateAway", async (importOriginal) => {
  const original = await importOriginal<typeof import("./navigateAway")>();
  return { ...original, navigateAway: vi.fn(), securePage: vi.fn(() => false) };
});

const ui = (key: string) => `stowly.ui.${key}`;

beforeEach(() => {
  resetSetupAutoOpen();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(navigateAway).mockClear();
  vi.mocked(securePage).mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Der Stand der Einrichtung, wie ihn die Attrappe mit dieser Ausgangslage liefert. */
async function statusOf(scenarios: Parameters<typeof createMockCore>[0] = {}): Promise<SetupStatus> {
  return createMockCore({ latency: 0, ...scenarios }).setup.load();
}

/** Öffnet einen Schritt der Einrichtung. */
async function openStep(scenarios: Parameters<typeof renderApp>[0], step: Parameters<typeof setupPath>[0]): Promise<MockCore> {
  const core = renderApp(scenarios, setupPath(step));
  await screen.findByRole("heading", { name: "Einrichtung", level: 1 });
  return core;
}

function progress(): HTMLElement {
  return screen.getByRole("navigation", { name: "Fortschritt der Einrichtung" });
}

// ------------------------------------------------------------------------------------------
// Reine Logik
// ------------------------------------------------------------------------------------------

describe("Schritte", () => {
  it("findet den ersten offenen Schritt, blättert und zählt", async () => {
    const open = await statusOf({ scenarios: ["setup-open"] });
    // Mit Beispieldaten gibt es schon Drucker: Dieser Schritt ist erledigt.
    expect(open.steps.map((step) => step.id)).toEqual(["https", "printer", "backup", "updates", "notifications", "home_assistant"]);
    expect(open.steps.map((step) => progressOf(step, false))).toEqual(["open", "done", "open", "open", "open", "open"]);
    expect(firstOpenStep(open)).toBe("https");
    // Über HTTPS ist die sichere Verbindung erledigt.
    expect(firstOpenStep(open, true)).toBe("backup");
    expect(doneCount(open)).toBe(1);
    expect(doneCount(open, true)).toBe(2);
    const skipped = { ...open, steps: open.steps.map((step) => (step.id === "https" || step.id === "backup" ? { ...step, state: "skipped" as const } : step)) };
    expect(firstOpenStep(skipped)).toBe("updates");
    expect(progressOf(stepOf(skipped, "https"), false)).toBe("skipped");
    // Abgeschlossen: immer die Übersicht, auch wenn ein neuer Schritt offen ist (Home Assistant).
    const finished = await statusOf();
    expect(progressOf(stepOf(finished, "home_assistant"), false)).toBe("open");
    expect(firstOpenStep(finished)).toBe("done");

    expect([nextStep("https"), nextStep("printer"), nextStep("backup"), nextStep("notifications"), nextStep("home_assistant"), nextStep("done")]).toEqual([
      "printer",
      "backup",
      "updates",
      "home_assistant",
      "done",
      "done",
    ]);
    expect([previousStep("https"), previousStep("printer"), previousStep("updates"), previousStep("done")]).toEqual([null, "https", "backup", "home_assistant"]);
    expect([stepNumber("https"), stepNumber("backup"), stepNumber("home_assistant"), stepNumber("done")]).toEqual([2, 4, 7, 7]);
    // Ein Schritt, den der Server nicht nennt, gilt als offen.
    expect(stepOf({ ...open, steps: [] }, "printer")).toMatchObject({ id: "printer", state: "open", ready: false });
  });

  it("vergleicht Versionen des Updaters", () => {
    expect(isOlderVersion("0.2.9", "0.3.0")).toBe(true);
    expect(isOlderVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isOlderVersion("1.0.0", "0.9.9")).toBe(false);
    expect(isOlderVersion(null, "0.3.0")).toBe(false);
    expect(isOlderVersion("0.3", "0.3.0")).toBe(false);
  });

  it("nennt den Stand in den Einstellungen und die Restzeit eines Codes", () => {
    expect(setupProgressText(null, 2)).toBe("2 von 6 erledigt");
    expect(setupProgressText("2026-11-16T10:00:00.000Z", 6)).toMatch(/^Abgeschlossen am \d{2}\.\d{2}\.2026$/);
    // Abgeschlossen, aber ein Schritt kam mit einem Update dazu.
    expect(setupProgressText("2026-11-16T10:00:00.000Z", 5)).toMatch(/^Abgeschlossen am \d{2}\.\d{2}\.2026; 5 von 6 erledigt, der Rest lässt sich nachholen$/);
    expect([countdownText(581), countdownText(1800), countdownText(0), countdownText(-3)]).toEqual(["9:41", "30:00", "0:00", "0:00"]);
    expect(pairedText({ hostname: "stowly-pi", addresses: ["192.168.1.10"], model: "QL-570", printer_found: true, version: "0.3.0", not_after: null })).toBe(
      "Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.10)",
    );
    expect(pairedText({ hostname: "stowly-pi", addresses: [], model: null, printer_found: false, version: null, not_after: null })).toBe("Gekoppelt: Drucker am Pi stowly-pi");
  });

  it("findet Adressen fürs Handy und das Zertifikat", () => {
    const addresses = [{ address: "127.0.0.1" }, { address: "192.168.1.10" }];
    expect(phoneHost("192.168.1.20", addresses)).toBe("192.168.1.20");
    expect(phoneHost("localhost", addresses)).toBe("192.168.1.10");
    expect(phoneHost("localhost", [{ address: "fd00::10" }])).toBe("[fd00::10]");
    expect(phoneHost("localhost", [])).toBe("localhost");
    const http = { protocol: "http:", hostname: "192.168.1.10", port: "8010", origin: "http://192.168.1.10:8010" };
    expect(certificateUrl({ http_port: null, addresses: [] }, http)).toBe("http://192.168.1.10:8010/api/setup/ca.crt");
    expect(certificateUrl({ http_port: 8020, addresses: [] }, http)).toBe("http://192.168.1.10:8020/api/setup/ca.crt");
    const https = { protocol: "https:", hostname: "192.168.1.10", port: "8443", origin: "https://192.168.1.10:8443" };
    expect(certificateUrl({ http_port: 8010, addresses: [] }, https)).toBe("http://192.168.1.10:8010/api/setup/ca.crt");
    expect(certificateUrl({ http_port: null, addresses: [] }, https)).toBe("https://192.168.1.10:8443/api/setup/ca.crt");
  });

  it("warnt PI_CERT_WARN_DAYS Tage vor dem Ablauf des Zertifikats eines Pi", () => {
    const now = Date.parse("2026-11-16T10:00:00.000Z");
    const inDays = (days: number) => new Date(now + days * 86_400_000).toISOString();
    expect(PI_CERT_WARN_DAYS).toBe(60);
    expect(piCertificateWarning(inDays(61), now)).toBeNull();
    expect(piCertificateWarning(inDays(59.5), now)).toBe(59);
    expect(piCertificateWarning(inDays(-1), now)).toBe(-1);
    expect(piCertificateWarning(null, now)).toBeNull();
    expect(piCertificateWarning("kaputt", now)).toBeNull();
    expect(certificateWarningTitle("Keller (Pi)", 20, inDays(20.5))).toMatch(/^Das Zertifikat des Pi „Keller \(Pi\)“ läuft in 20 Tagen ab \(\d{2}\.\d{2}\.2026\)\.$/);
    expect(certificateWarningTitle("Keller (Pi)", 0, inDays(0.5))).toBe("Das Zertifikat des Pi „Keller (Pi)“ läuft heute ab.");
    expect(certificateWarningTitle("Keller (Pi)", -1, inDays(-1))).toBe("Das Zertifikat des Pi „Keller (Pi)“ ist abgelaufen.");
  });
});

describe("Kopieren", () => {
  it("nimmt die Zwischenablage im sicheren Kontext, sonst execCommand mit einer textarea", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.stubGlobal("isSecureContext", true);
    expect(await copyText("eins")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("eins");

    // Über http://<LAN-IP>: keine Zwischenablage, also der alte Weg.
    vi.stubGlobal("isSecureContext", false);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const seen: { value: string; readOnly: boolean; selected: string }[] = [];
    const execCommand = vi.fn((command: string) => {
      const area = document.querySelector("textarea");
      seen.push({ value: area?.value ?? "", readOnly: area?.readOnly ?? false, selected: area ? area.value.slice(area.selectionStart, area.selectionEnd) : "" });
      return command === "copy";
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    expect(await copyText("zwei")).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ value: "zwei", readOnly: true, selected: "zwei" }]);
    // Aufgeräumt, und der Fokus ist wieder, wo er war.
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);

    execCommand.mockReturnValue(false);
    expect(await copyText("drei")).toBe(false);
    button.remove();
    vi.unstubAllGlobals();
  });

  it("zeigt im Feld zwei Sekunden „Kopiert“, und markiert den Text, wenn Kopieren nicht geht", async () => {
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    render(<CopyField value="curl -fsSL http://192.168.1.10:8010/api/pi/install.sh" label="Befehl für den Pi" />);
    const field = screen.getByRole("group", { name: "Befehl für den Pi" });
    expect(field).toHaveTextContent("curl -fsSL http://192.168.1.10:8010/api/pi/install.sh");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(within(field).getByRole("button", { name: "Kopieren" }));
    await act(() => Promise.resolve());
    expect(within(field).getByRole("button", { name: "Kopiert" })).toBeInTheDocument();
    expect(within(field).getByRole("status")).toHaveTextContent("Kopiert");
    await act(() => vi.advanceTimersByTimeAsync(COPIED_MS));
    expect(within(field).getByRole("button", { name: "Kopieren" })).toBeInTheDocument();
    vi.useRealTimers();

    // Weder Zwischenablage noch execCommand: Der Text ist markiert, kopieren muss der Anwender.
    vi.stubGlobal("isSecureContext", false);
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    await userEvent.click(within(field).getByRole("button", { name: "Kopieren" }));
    expect(await within(field).findByText("Markiert – jetzt kopieren.")).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe("curl -fsSL http://192.168.1.10:8010/api/pi/install.sh");
    vi.unstubAllGlobals();
  });
});

// ------------------------------------------------------------------------------------------
// Anmeldeschranke und Willkommensseite
// ------------------------------------------------------------------------------------------

describe("Anmeldeschranke", () => {
  it("zeigt ohne Passwort beim Server die Willkommensseite, prüft die Eingaben und beginnt danach die Einrichtung", async () => {
    const core = renderApp({ scenarios: ["unconfigured"] });
    const create = vi.spyOn(core.session, "createPassword");
    expect(await screen.findByRole("heading", { name: "Willkommen bei Stowly" })).toBeInTheDocument();
    expect(screen.getByText("Zuerst das Passwort für den Haushalt festlegen. Damit melden sich alle Geräte an.")).toBeInTheDocument();
    expect(screen.getByLabelText("Haushalts-Passwort")).toHaveAccessibleDescription("Mindestens 8 Zeichen.");
    const submit = screen.getByRole("button", { name: "Passwort festlegen" });

    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), "kurz");
    await userEvent.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Das Passwort braucht mindestens 8 Zeichen.");
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), " und lang");
    await userEvent.type(screen.getByLabelText("Passwort wiederholen"), "etwas anderes");
    await userEvent.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Die beiden Passwörter sind verschieden.");
    expect(create).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("Passwort wiederholen"));
    await userEvent.type(screen.getByLabelText("Passwort wiederholen"), "kurz und lang");
    await userEvent.clear(screen.getByLabelText("Name dieses Geräts"));
    await userEvent.type(screen.getByLabelText("Name dieses Geräts"), "Rechner Büro");
    await userEvent.click(submit);
    expect(create).toHaveBeenCalledWith("kurz und lang", "Rechner Büro");
    // Angemeldet, und es geht mit der Einrichtung weiter, nicht mit dem Bestand.
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe(setupPath("https")));
    expect(screen.queryByRole("heading", { name: "Bestand" })).not.toBeInTheDocument();
    expect(core.session.state.get()).toMatchObject({ status: "signed_in", device: { name: "Rechner Büro" } });

    // Mit dem neuen Passwort meldet sich ein anderes Gerät an.
    await core.session.logout({ discard_pending: true });
    await expect(core.session.login(MOCK_PASSWORD, "Flur")).rejects.toMatchObject({ code: "invalid_password" });
  });

  it("wechselt bei conflict mit einem Hinweis zur Anmeldung", async () => {
    const core = renderApp({ scenarios: ["unconfigured"] });
    vi.spyOn(core.session, "createPassword").mockImplementation(() => {
      // Ein anderes Gerät war schneller.
      core.control.setServerConfigured(true);
      return Promise.reject(new CoreError("conflict", "Es gibt schon ein Haushalts-Passwort."));
    });
    await userEvent.type(await screen.findByLabelText("Haushalts-Passwort"), "ein langes Passwort");
    await userEvent.type(screen.getByLabelText("Passwort wiederholen"), "ein langes Passwort");
    await userEvent.click(screen.getByRole("button", { name: "Passwort festlegen" }));
    expect(await screen.findByText("Inzwischen ist ein Passwort festgelegt. Bitte damit anmelden.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("wartet beim ersten Start höchstens 4 Sekunden auf die Prüfung des Servers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mock = createMockCore({ latency: 0, scenarios: ["signed-out"] });
    const status = new LiveValue<SyncStatus>({ ...(mock.sync.status.get() as SyncStatus), online: null, server_configured: null });
    window.history.replaceState(null, "", "/");
    render(createElement(App, { core: { ...mock, sync: { ...mock.sync, status } }, scanPage: MockScanPage }));
    expect(screen.getByText("Verbindung zum Server wird geprüft …")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Anmelden" })).not.toBeInTheDocument();

    // Antwortet der Server ohne Passwort, kommt die Willkommensseite sofort.
    act(() => status.update((current) => ({ ...current, online: true, server_configured: false })));
    expect(screen.getByRole("heading", { name: "Willkommen bei Stowly" })).toBeInTheDocument();
    cleanup();

    const silent = new LiveValue<SyncStatus>({ ...(mock.sync.status.get() as SyncStatus), online: null, server_configured: null });
    render(createElement(App, { core: { ...mock, sync: { ...mock.sync, status: silent } }, scanPage: MockScanPage }));
    expect(screen.getByText("Verbindung zum Server wird geprüft …")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("zeigt die Willkommensseite auch einem gesperrten Gerät, wenn der Server kein Passwort mehr hat", () => {
    const core = renderApp({ scenarios: ["revoked"] });
    act(() => core.control.setServerConfigured(false));
    expect(screen.getByRole("heading", { name: "Willkommen bei Stowly" })).toBeInTheDocument();
  });
});

describe("Anmeldung im Kontext der Einrichtung", () => {
  it("sagt nach dem Wechsel zur HTTPS-Adresse, dass es danach weitergeht, und nimmt den Namen aus der Adresse", async () => {
    const core = renderApp({ scenarios: ["signed-out", "ios"] }, `${ROUTES.setup}#geraet=Handy%20K%C3%BCche`);
    expect(screen.getByText("Fast geschafft: einmal anmelden, dann geht es weiter.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name dieses Geräts")).toHaveValue("Handy Küche");
    // iPhone in Safari: erst zum Home-Bildschirm, dort hat die App ihren eigenen Speicher.
    expect(screen.getByText(/Erst Teilen → Zum Home-Bildschirm, dann dort anmelden\./)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
    expect(core.session.state.get()).toMatchObject({ status: "signed_in", device: { name: "Handy Küche" } });
  });

  it("nennt nach einem Wechsel, der nicht aufging, die neue Adresse und führt nach der Anmeldung zur Anleitung zurück", async () => {
    const target = "https://192.168.1.10:8443/einrichtung#geraet=Rechner";
    sessionStorage.setItem(SETUP_MOVED_KEY, target);
    renderApp({ scenarios: ["signed-out"] });
    expect(screen.getByText("Stowly läuft jetzt über https://192.168.1.10:8443")).toBeInTheDocument();
    expect(screen.getByText("Ging die Seite nicht auf? Hier wieder anmelden und die Anleitung prüfen.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(navigateAway).toHaveBeenCalledWith(target);

    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() => expect(window.location.pathname).toBe(setupPath("https")));
    expect(sessionStorage.getItem(SETUP_MOVED_KEY)).toBeNull();
  });

  it("bietet ohne Server einen neuen Versuch an und erklärt ein fehlendes Passwort", async () => {
    const core = renderApp({ scenarios: ["signed-out", "offline"] });
    const now = vi.spyOn(core.sync, "now");
    const hint = screen.getByText("Server nicht erreichbar").closest("[role='status']") as HTMLElement;
    expect(hint).toHaveTextContent("Zum Anmelden braucht es eine Verbindung zum Server.");
    await userEvent.click(within(hint).getByRole("button", { name: "Erneut versuchen" }));
    expect(now).toHaveBeenCalledTimes(1);
    act(() => core.control.setOnline(true));
    await waitFor(() => expect(screen.queryByText("Server nicht erreichbar")).not.toBeInTheDocument());

    vi.spyOn(core.session, "login").mockRejectedValueOnce(new CoreError("not_configured"));
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), "irgendwas");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Auf dem Server ist noch kein Haushalts-Passwort gesetzt. Gleich lässt es sich hier festlegen.");
  });
});

// ------------------------------------------------------------------------------------------
// Automatisch öffnen
// ------------------------------------------------------------------------------------------

describe("Automatisch öffnen", () => {
  it("öffnet die Einrichtung, solange sie offen ist; „Später fortsetzen“ lässt dieses Gerät in Ruhe", async () => {
    renderApp({ scenarios: ["setup-open"] });
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe(setupPath("https")));

    await userEvent.click(screen.getByRole("button", { name: "Später fortsetzen" }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(localStorage.getItem(ui(SETUP_LATER_FLAG))).toBe("1");

    cleanup();
    resetSetupAutoOpen();
    const core = renderApp({ scenarios: ["setup-open"] });
    const load = vi.spyOn(core.setup, "load");
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    await act(() => Promise.resolve());
    expect(load).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(ROUTES.stock);
  });

  it("merkt sich eine abgeschlossene Einrichtung und fragt danach nie wieder", async () => {
    const core = renderApp();
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(ui(SETUP_DONE_FLAG))).toBe("1"));
    expect(window.location.pathname).toBe(ROUTES.stock);
    cleanup();

    resetSetupAutoOpen();
    const again = renderApp({ scenarios: ["setup-open"] });
    const load = vi.spyOn(again.setup, "load");
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    await act(() => Promise.resolve());
    expect(load).not.toHaveBeenCalled();
    expect(core).not.toBe(again);
  });

  it("fragt nicht ohne Server und hält einen Server ohne Einrichtung für eingerichtet", async () => {
    const offline = renderApp({ scenarios: ["setup-open", "offline"] });
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    // Kommt der Server zurück, öffnet sie doch noch.
    act(() => offline.control.setOnline(true));
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
    cleanup();

    resetSetupAutoOpen();
    const mock = createMockCore({ latency: 0, scenarios: ["setup-open"] });
    vi.spyOn(mock.setup, "load").mockRejectedValue(new CoreError("not_supported", "Noch nicht umgesetzt."));
    window.history.replaceState(null, "", "/");
    render(createElement(App, { core: mock, scanPage: MockScanPage }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(ui(SETUP_DONE_FLAG))).toBe("1"));
  });
});

// ------------------------------------------------------------------------------------------
// Der Rahmen des Assistenten
// ------------------------------------------------------------------------------------------

describe("Rahmen", () => {
  it("öffnet ohne Kürzel den ersten offenen Schritt, bei abgeschlossener Einrichtung die Übersicht", async () => {
    renderApp({ scenarios: ["setup-open"] }, ROUTES.setup);
    expect(await screen.findByRole("heading", { name: "Sichere Verbindung", level: 2 })).toBeInTheDocument();
    expect(window.location.pathname).toBe(setupPath("https"));
    expect(document.title).toBe("Einrichtung · Stowly");
    cleanup();

    renderApp({}, `${ROUTES.setup}/gibt-es-nicht`);
    expect(await screen.findByRole("heading", { name: "Fertig", level: 2 })).toBeInTheDocument();
    expect(window.location.pathname).toBe(setupPath("done"));
  });

  it("zeigt den Fortschritt und markiert beim Überspringen", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "https");
    const update = vi.spyOn(core.setup, "update");
    expect(within(progress()).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Zugang, erledigt",
      "2Sichere Verbindung",
      "Drucker, erledigt",
      "4Sicherung",
      "5Updates",
      "6Benachrichtigungen",
      "7Home Assistant",
      "Fertig",
    ]);
    expect(within(progress()).getByRole("link", { name: /Sichere Verbindung/ })).toHaveAttribute("aria-current", "step");
    expect(within(progress()).getByRole("link", { name: /Drucker/ })).toHaveAttribute("href", setupPath("printer"));
    // Am ersten Schritt gibt es kein Zurück.
    expect(screen.queryByRole("link", { name: "Zurück" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Überspringen" }));
    expect(update).toHaveBeenCalledWith({ step: { id: "https", state: "skipped" } });
    expect(await screen.findByRole("heading", { name: "Drucker", level: 2 })).toBeInTheDocument();
    expect(within(progress()).getByRole("link", { name: "Sichere Verbindung, übersprungen" })).toBeInTheDocument();
    // Der Drucker ist schon da: weiter statt überspringen.
    expect(screen.getByRole("link", { name: "Weiter" })).toHaveAttribute("href", setupPath("backup"));
    expect(screen.getByRole("link", { name: "Zurück" })).toHaveAttribute("href", setupPath("https"));
    expect(screen.getByRole("heading", { name: "Drucker", level: 2 })).toHaveFocus();
  });

  it("zeigt am Handy „Schritt 2 von 7“ mit Balken", async () => {
    setTestViewport(375);
    await openStep({ scenarios: ["setup-open"] }, "https");
    const bar = screen.getByRole("progressbar", { name: "Fortschritt der Einrichtung" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(screen.getByText("Schritt 2 von 7: Sichere Verbindung")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Fortschritt der Einrichtung" })).not.toBeInTheDocument();
  });

  it("sagt, wenn der Server fehlt, und lädt nach", async () => {
    const core = await openStep({ scenarios: ["setup-open", "offline"] }, "https");
    expect(await screen.findByText("Die Einrichtung braucht den Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    act(() => core.control.setOnline(true));
    expect(await screen.findByRole("heading", { name: "Sichere Verbindung", level: 2 })).toBeInTheDocument();
  });

  it("markiert über HTTPS die sichere Verbindung selbst als erledigt", async () => {
    vi.mocked(securePage).mockReturnValue(true);
    const core = renderApp({ scenarios: ["setup-open"] }, ROUTES.setup);
    const update = vi.spyOn(core.setup, "update");
    // Der erste offene Schritt ist dann der nach dem Drucker.
    expect(await screen.findByRole("heading", { name: "Sicherung", level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(update).toHaveBeenCalledWith({ step: { id: "https", state: "done" } }));
    expect(within(progress()).getByRole("link", { name: "Sichere Verbindung, erledigt" })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------
// Sichere Verbindung
// ------------------------------------------------------------------------------------------

describe("Sichere Verbindung", () => {
  it("führt über http durch Zertifikat, Anleitung und Prüfung, und wechselt dann zur HTTPS-Adresse", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "https");
    const logout = vi.spyOn(core.session, "logout");
    const sync = vi.spyOn(core.sync, "now");
    const load = screen.getByRole("link", { name: "Zertifikat laden" });
    expect(load).toHaveAttribute("href", "/api/setup/ca.crt?download=true");
    expect(screen.getByText("Fingerabdruck prüfen")).toBeInTheDocument();
    expect(screen.getByText(/^3F:2A:1C:7B/)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Anleitung für" })).toBeInTheDocument();

    // Noch kein Vertrauen: Tipps und „Erneut prüfen".
    expect(await screen.findByText("Noch keine sichere Verbindung.")).toBeInTheDocument();
    expect(screen.getByText(/Ist Port 8443 in den Einstellungen des Containers freigegeben/)).toBeInTheDocument();
    core.control.setSecureTrusted(true);
    await userEvent.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    expect(await screen.findByText("Dieses Gerät vertraut Stowly.")).toBeInTheDocument();
    expect(screen.getByText("Dabei wird dieses Gerät hier abgemeldet; unter https://localhost:8443 einmal neu anmelden.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Zur sicheren Adresse wechseln" }));
    const target = "https://localhost:8443/einrichtung#geraet=Dieses%20Ger%C3%A4t";
    await waitFor(() => expect(navigateAway).toHaveBeenCalledWith(target));
    expect(sync).toHaveBeenCalled();
    expect(logout).toHaveBeenCalledWith();
    expect(sessionStorage.getItem(SETUP_MOVED_KEY)).toBe(target);
    // Hier abgemeldet: Die Anmeldung nennt die neue Adresse.
    expect(await screen.findByText("Stowly läuft jetzt über https://localhost:8443")).toBeInTheDocument();
  });

  it("wechselt nicht, solange Änderungen noch nicht beim Server sind", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "https");
    expect(await screen.findByText("Noch keine sichere Verbindung.")).toBeInTheDocument();
    core.control.setSecureTrusted(true);
    await userEvent.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    vi.spyOn(core.session, "logout").mockRejectedValueOnce(new CoreError("pending_changes", "Es gibt ungesendete Änderungen.", { pending: 2 }));
    await userEvent.click(await screen.findByRole("button", { name: "Zur sicheren Adresse wechseln" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Erst abgleichen: 2 Änderungen sind noch nicht beim Server.");
    expect(navigateAway).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SETUP_MOVED_KEY)).toBeNull();
    expect(core.session.state.get()?.status).toBe("signed_in");
  });

  it("prüft bei der Rückkehr auf die Seite noch einmal", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "https");
    const check = vi.spyOn(core.setup, "reachesSecurely");
    expect(await screen.findByText("Noch keine sichere Verbindung.")).toBeInTheDocument();
    core.control.setSecureTrusted(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Dieses Gerät vertraut Stowly.")).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith("https://localhost:8443");
  });

  it("speichert unter „Erweitert“ einen anderen Port und weitere Adressen", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "https");
    const update = vi.spyOn(core.setup, "update");
    const check = vi.spyOn(core.setup, "reachesSecurely");
    await userEvent.click(await screen.findByText("Erweitert"));
    await userEvent.type(screen.getByLabelText("HTTPS-Port"), "70000");
    await userEvent.click(within(screen.getByLabelText("HTTPS-Port").closest("form") as HTMLElement).getByRole("button", { name: "Speichern" }));
    expect(screen.getByLabelText("HTTPS-Port")).toHaveAccessibleDescription("Ein Port ist eine Zahl von 1 bis 65535.");
    await userEvent.clear(screen.getByLabelText("HTTPS-Port"));
    await userEvent.type(screen.getByLabelText("HTTPS-Port"), "8444");
    await userEvent.click(within(screen.getByLabelText("HTTPS-Port").closest("form") as HTMLElement).getByRole("button", { name: "Speichern" }));
    expect(update).toHaveBeenCalledWith({ https_port: 8444 });
    // Mit dem neuen Port wird neu geprüft.
    await waitFor(() => expect(check).toHaveBeenCalledWith("https://localhost:8444"));

    const addresses = screen.getByLabelText("Weitere Adressen");
    await userEvent.type(addresses, "nas.fritz.box, 8.8.8.8");
    await userEvent.click(within(addresses.closest("form") as HTMLElement).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("8.8.8.8: Die Adresse liegt nicht im Heimnetz.")).toBeInTheDocument();
    await userEvent.clear(addresses);
    await userEvent.type(addresses, "nas.fritz.box");
    await userEvent.click(within(addresses.closest("form") as HTMLElement).getByRole("button", { name: "Speichern" }));
    expect(update).toHaveBeenLastCalledWith({ addresses: ["nas.fritz.box"] });
    expect(await screen.findByText("Das Zertifikat gilt für: 192.168.1.10, nas.fritz.box.")).toBeInTheDocument();
  });

  it("zeigt am Desktop den QR-Code fürs Handy mit der Adresse im Heimnetz", async () => {
    await openStep({ scenarios: ["setup-open"] }, "https");
    // Die Tests laufen unter localhost: Das Handy bekommt die Adresse im Heimnetz mit dem HTTP-Port.
    expect(screen.getByTitle("QR-Code: Zertifikat laden")).toBeInTheDocument();
    expect(screen.getByText("http://192.168.1.10:8010/api/setup/ca.crt")).toBeInTheDocument();
    cleanup();
    setTestViewport(375);
    await openStep({ scenarios: ["setup-open"] }, "https");
    expect(screen.queryByTitle("QR-Code: Zertifikat laden")).not.toBeInTheDocument();
  });

  it("verweist ohne eigenes HTTPS auf die Anleitung zum Betrieb", async () => {
    await openStep({ scenarios: ["setup-open", "no-https"] }, "https");
    expect(await screen.findByText("Stowly hat hier kein eigenes HTTPS.")).toBeInTheDocument();
    expect(screen.getByText(/docs\/betrieb\.md/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Zertifikat laden" })).not.toBeInTheDocument();
  });

  it("sagt über HTTPS, dass alles erledigt ist, und zeigt am Desktop die Codes für weitere Geräte", async () => {
    const status = await statusOf({ scenarios: ["setup-open"] });
    render(
      <CoreProvider core={createMockCore({ latency: 0 })}>
        <ToastProvider>
          <SecureStep status={status} update={vi.fn()} secure />
        </ToastProvider>
      </CoreProvider>,
    );
    expect(screen.getByText("Diese Seite läuft über HTTPS.")).toBeInTheDocument();
    expect(screen.getByTitle("QR-Code: Stowly über HTTPS")).toBeInTheDocument();
    expect(screen.getByTitle("QR-Code: Zertifikat laden")).toBeInTheDocument();
  });
});

describe("Anleitung je Gerät", () => {
  it("wählt das Gerät vor, lässt umschalten und nennt Firefox", async () => {
    expect([guideFor("ios"), guideFor("other")]).toEqual(["ios", "windows"]);
    render(<TrustGuide platform="ios" firefox={false} caName="Stowly CA 3F2A1C" />);
    expect(screen.getByRole("radio", { name: "iPhone" })).toBeChecked();
    expect(screen.getByText(/„Zertifikatsvertrauenseinstellungen“ → den Schalter bei „Stowly CA 3F2A1C“ einschalten/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Android" }));
    expect(screen.getByText(/nach „Zertifikat installieren“ suchen → „CA-Zertifikat“ → „Trotzdem installieren“/)).toBeInTheDocument();
    expect(screen.getByText(/Android verlangt dafür eine Displaysperre/)).toBeInTheDocument();
    cleanup();

    render(<TrustGuide platform="windows" firefox caName="Stowly CA 3F2A1C" />);
    expect(screen.getByRole("radio", { name: "Windows" })).toBeChecked();
    expect(screen.getByText(/„Vertrauenswürdige Stammzertifizierungsstellen“/)).toBeInTheDocument();
    expect(screen.getByText(/Ab Version 120 übernimmt Firefox unter Windows und macOS die CA des Systems/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Mac" }));
    expect(screen.getByText(/„Immer vertrauen“/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "iPhone" }));
    expect(screen.queryByText(/Ab Version 120/)).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------
// Drucker
// ------------------------------------------------------------------------------------------

describe("Drucker", () => {
  it("koppelt einen Pi: Befehl mit Restzeit, Zustände, Standarddrucker und Verbindung prüfen", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const core = await openStep({ scenarios: ["setup-open", "empty"] }, "printer");
    const update = vi.spyOn(core.setup, "update");
    expect(screen.getByText(/„Raspberry Pi OS Lite \(64-bit\)“/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    const command = await screen.findByRole("group", { name: "Befehl für den Pi" });
    expect(command).toHaveTextContent(/^curl -fsSL http:\/\/localhost:3000\/api\/pi\/install\.sh \| sudo sh -s -- [0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    expect(screen.getByText(/^Gültig noch (30:00|29:5\d)$/)).toBeInTheDocument();
    expect(screen.getByText(/ssh benutzer@stowly-pi\.local/)).toBeInTheDocument();
    expect(screen.getByText("Wartet auf den Pi …")).toBeInTheDocument();

    core.control.completePairing();
    await act(() => vi.advanceTimersByTimeAsync(PAIRING_POLL_MS));
    expect(await screen.findByText("Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.20)")).toBeInTheDocument();
    expect(await screen.findByText("Ist jetzt Standarddrucker.")).toBeInTheDocument();
    const printer = core.data.printers.get()?.find((candidate) => candidate.connection === "direct");
    expect(core.data.settings.get()?.default_printer_id).toBe(printer?.id);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ step: { id: "printer", state: "done" } }));

    await userEvent.click(screen.getByRole("button", { name: "Verbindung prüfen" }));
    expect(await screen.findByText("Drucker bereit.")).toBeInTheDocument();
    // Die Kopplung übersteht Weiter und Zurück.
    await userEvent.click(screen.getByRole("link", { name: "Weiter" }));
    expect(await screen.findByRole("heading", { name: "Sicherung", level: 2 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Zurück" }));
    expect(await screen.findByText("Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.20)")).toBeInTheDocument();
  });

  it("urteilt beim Koppeln wie die Karte des Druckers: Der Pi antwortet, der Drucker nicht, mit Rat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const core = await openStep({ scenarios: ["setup-open", "empty", "printer-off"] }, "printer");
    await userEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    await screen.findByRole("group", { name: "Befehl für den Pi" });
    core.control.completePairing();
    await act(() => vi.advanceTimersByTimeAsync(PAIRING_POLL_MS));
    expect(await screen.findByText("Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.20)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Verbindung prüfen" }));
    const verdict = await screen.findByText("Der Pi antwortet, der Drucker nicht.");
    expect(verdict.closest("[role=status]")).toHaveTextContent("Drucker einschalten.USB-Kabel an Drucker und Pi prüfen.Dann noch einmal „Verbindung prüfen“.");
    expect(screen.queryByText("Drucker bereit.")).not.toBeInTheDocument();
  });

  it("fragt nur bei sichtbarer Seite nach und gleich wieder, sobald sie sichtbar wird", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const core = await openStep({ scenarios: ["setup-open", "empty"] }, "printer");
    await userEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    await screen.findByRole("group", { name: "Befehl für den Pi" });
    const pairing = vi.spyOn(core.printers, "pairing");
    await act(() => vi.advanceTimersByTimeAsync(2 * PAIRING_POLL_MS));
    expect(pairing).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(3 * PAIRING_POLL_MS));
    expect(pairing).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pairing).toHaveBeenCalledTimes(3);
  });

  it("bietet nach Ablauf einen neuen Code an", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const core = await openStep({ scenarios: ["setup-open", "empty"] }, "printer");
    await userEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    const first = (await screen.findByRole("group", { name: "Befehl für den Pi" })).textContent;
    core.control.expirePairing();
    await act(() => vi.advanceTimersByTimeAsync(PAIRING_POLL_MS));
    expect(await screen.findByText("Der Code ist abgelaufen.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Neuer Code" }));
    const second = await screen.findByRole("group", { name: "Befehl für den Pi" });
    expect(second.textContent).not.toBe(first);
  });

  it("sagt auf dem iPhone, dass dieser Schritt an den PC gehört, und über http, dass Prüfen dort nicht geht", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    const core = await openStep({ scenarios: ["setup-open", "empty", "insecure"] }, "printer");
    await userEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    expect(await screen.findByText("Auf dem iPhone fehlt ein Terminal: diesen Schritt am PC machen.")).toBeInTheDocument();
    core.control.completePairing();
    await act(() => vi.advanceTimersByTimeAsync(PAIRING_POLL_MS));
    expect(await screen.findByText("Prüfen und Drucken gehen nur über die sichere Adresse.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verbindung prüfen" })).not.toBeInTheDocument();
  });
});

describe("Drucker auf der Druckerseite", () => {
  it("koppelt einen Pi auch dort und übernimmt auf Wunsch einen vorhandenen Drucker", async () => {
    const core = renderApp({}, ROUTES.printers);
    const pair = vi.spyOn(core.printers, "pair");
    await userEvent.click(await screen.findByRole("button", { name: "Raspberry Pi koppeln" }));
    const dialog = screen.getByRole("dialog", { name: "Raspberry Pi koppeln" });
    const choice = within(dialog).getByLabelText("Drucker");
    expect(within(choice).getAllByRole("option").map((option) => option.textContent)).toEqual(["Neuen Drucker anlegen", "Vorhandenen Drucker übernehmen: Keller (Pi)"]);
    await userEvent.selectOptions(choice, PRINTER_IDS.cellar);
    // Ein vorhandener Pi braucht keine neue SD-Karte.
    expect(within(dialog).queryByText(/Raspberry Pi Imager/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Code erzeugen" }));
    expect(pair).toHaveBeenCalledWith({ origin: "http://localhost:3000", printer_id: PRINTER_IDS.cellar });
    expect(await within(dialog).findByRole("group", { name: "Befehl für den Pi" })).toBeInTheDocument();
    expect(choice).toBeDisabled();

    // Schließen bricht die wartende Kopplung ab.
    const cancel = vi.spyOn(core.printers, "cancelPairing");
    // Der Knopf unten (oben steht noch das ✕ des Dialogs).
    await userEvent.click(within(dialog).getAllByRole("button", { name: "Schließen" }).at(-1) as HTMLElement);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("warnt vor dem Ablauf des Zertifikats eines Pi, wie der Server ihn meldet; neu gekoppelt ist die Warnung fort", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Ein frisches Gerät ohne eigene Erinnerung: Der Ablauf kommt vom Server (`SetupStatus.paired_printers`).
    const core = renderApp({ scenarios: ["pi-cert-expiring"] }, ROUTES.printers);
    const warning = await screen.findByText(/^Das Zertifikat des Pi „Keller \(Pi\)“ läuft in 20 Tagen ab/);
    const notice = warning.closest("div")?.parentElement as HTMLElement;
    expect(notice).toHaveTextContent("Danach erreicht die App den Pi stowly-pi nicht mehr über HTTPS.");
    await userEvent.click(within(notice).getByRole("button", { name: "Neu koppeln" }));
    const dialog = screen.getByRole("dialog", { name: "Raspberry Pi koppeln" });
    expect(within(dialog).getByLabelText("Drucker")).toHaveValue(PRINTER_IDS.cellar);

    await userEvent.click(within(dialog).getByRole("button", { name: "Code erzeugen" }));
    await within(dialog).findByRole("group", { name: "Befehl für den Pi" });
    core.control.completePairing();
    await act(() => vi.advanceTimersByTimeAsync(PAIRING_POLL_MS));
    expect(await within(dialog).findByText("Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.20)")).toBeInTheDocument();
    // Das neue Zertifikat gilt 825 Tage: keine Warnung mehr.
    await waitFor(() => expect(screen.queryByText(/^Das Zertifikat des Pi/)).not.toBeInTheDocument());
  });

  it("fragt den Ablauf nur mit Verbindung: offline keine Warnung und kein Fehler", async () => {
    // Die Einrichtung ist abgeschlossen: Hier fragt nur die Druckerseite den Server.
    localStorage.setItem(ui(SETUP_DONE_FLAG), "1");
    const core = renderApp({ scenarios: ["pi-cert-expiring", "offline"] }, ROUTES.printers);
    const load = vi.spyOn(core.setup, "load");
    expect(await screen.findByRole("heading", { name: "Drucker", level: 1 })).toBeInTheDocument();
    await act(() => Promise.resolve());
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Das Zertifikat des Pi/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => core.control.setOnline(true));
    expect(await screen.findByText(/^Das Zertifikat des Pi „Keller \(Pi\)“ läuft in 20 Tagen ab/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------
// Updates, Benachrichtigungen, Fertig
// ------------------------------------------------------------------------------------------

function updateStatus(core: MockCore, changes: Partial<UpdateStatus>): void {
  core.control.setIntegrations({
    update: {
      configured: true,
      repo: "beispiel/stowly",
      current: "0.3.0",
      latest: "0.3.0",
      latest_name: null,
      notes: null,
      published_at: null,
      url: null,
      available: false,
      checked_at: null,
      check_error: null,
      updater_ready: false,
      updater_seen_at: null,
      updater_kind: null,
      updater_version: null,
      updater_command: MOCK_UPDATER_COMMAND,
      state: "idle",
      state_version: null,
      state_at: null,
      state_message: null,
      ...changes,
    },
  });
}

describe("Updates", () => {
  it("schaltet die Suche ein, zeigt die Anleitung für DSM und fragt nach, bis der Updater bereit ist", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const core = await openStep({ scenarios: ["setup-open"] }, "updates");
    const toggle = await screen.findByRole("switch", { name: "Nach neuen Versionen suchen" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Überspringen" })).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    // Updates sind an: Der Schritt ist erledigt.
    expect(await screen.findByRole("link", { name: "Weiter" })).toBeInTheDocument();
    expect(await screen.findByText("Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe → Benutzerdefiniertes Skript.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Befehl für den Updater" })).toHaveTextContent(MOCK_UPDATER_COMMAND);

    const load = vi.spyOn(core.integrations, "load");
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_POLL_MS));
    expect(load).toHaveBeenCalledTimes(1);
    updateStatus(core, { updater_ready: true, updater_seen_at: new Date(Date.now() - 60_000).toISOString(), updater_kind: "container", updater_version: "0.3.0" });
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_POLL_MS));
    expect(await screen.findByText(/^Updater-Container bereit, zuletzt /)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3 * UPDATE_POLL_MS));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rät bei einem älteren Updater, den Befehl erneut auszuführen, und sagt, wenn es keinen Befehl gibt", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "updates");
    await userEvent.click(await screen.findByRole("switch", { name: "Nach neuen Versionen suchen" }));
    updateStatus(core, { updater_ready: true, updater_seen_at: new Date().toISOString(), updater_kind: "container", updater_version: "0.2.1" });
    await userEvent.click(screen.getByRole("link", { name: "Weiter" }));
    await userEvent.click(await screen.findByRole("link", { name: "Zurück" }));
    expect(await screen.findByText("Der Updater ist älter als Stowly: Befehl erneut ausführen.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Befehl für den Updater" })).toBeInTheDocument();

    updateStatus(core, { updater_command: null });
    await userEvent.click(screen.getByRole("link", { name: "Weiter" }));
    await userEvent.click(await screen.findByRole("link", { name: "Zurück" }));
    expect(await screen.findByText(/Dieses Image kennt keinen fertigen Befehl für den Updater-Container/)).toBeInTheDocument();
  });

  it("sperrt den Schalter, wenn die Umgebung entscheidet", async () => {
    await openStep({ scenarios: ["setup-env"] }, "updates");
    const toggle = await screen.findByRole("switch", { name: "Nach neuen Versionen suchen" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeUnavailable();
    expect(screen.getByText("Fest eingeschaltet über STOWLY_UPDATE_REPO und nur dort änderbar.")).toBeInTheDocument();
    expect(await screen.findByText(/^Updater-Container bereit, zuletzt/)).toBeInTheDocument();
  });
});

/** Die Zeile „Benachrichtigungen" dieses Geräts. */
function pushRow(): HTMLElement {
  return screen.getByText("Benachrichtigungen", { selector: "div" }).parentElement?.parentElement as HTMLElement;
}

describe("Benachrichtigungen", () => {
  it("speichert die Kontakt-Adresse; danach lässt sich Push auf diesem Gerät einschalten", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "notifications");
    const update = vi.spyOn(core.serverConfig, "update");
    expect(screen.getByText(/Die Push-Dienste von Apple, Google und Mozilla verlangen dafür eine Kontakt-Adresse\./)).toBeInTheDocument();
    expect(await screen.findByText("nicht eingerichtet")).toBeInTheDocument();
    // Im Assistenten selbst führt die Zeile nicht noch einmal hierher.
    expect(within(pushRow()).queryByRole("link", { name: "Einrichten" })).not.toBeInTheDocument();

    const field = await screen.findByLabelText("Kontakt-Adresse (E-Mail)");
    await userEvent.type(field, "kein Kontakt");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Erwartet ist eine E-Mail-Adresse wie haushalt@example.org oder eine https-Adresse.")).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "haushalt@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(update).toHaveBeenLastCalledWith({ push_contact: "haushalt@example.org" });
    expect(await screen.findByText("Kontakt-Adresse gespeichert.")).toBeInTheDocument();
    expect(await within(pushRow()).findByRole("button", { name: "Einschalten" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Weiter" })).toBeInTheDocument();
  });

  it("zeigt einen Kontakt aus der Umgebung nur an und auf dem iPhone die Anleitung für den Home-Bildschirm", async () => {
    await openStep({ scenarios: ["setup-env", "ios"] }, "notifications");
    expect(await screen.findByText("haushalt@example.org")).toBeInTheDocument();
    expect(screen.getByText("Kommt aus der Umgebung (STOWLY_PUSH_CONTACT) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Kontakt-Adresse (E-Mail)")).not.toBeInTheDocument();
    expect(screen.getByText(/Zum Home-Bildschirm/, { selector: "strong" })).toBeInTheDocument();
  });

  it("führt in den Einstellungen ohne Kontakt zur Einrichtung", async () => {
    renderApp({ scenarios: ["push-not-configured"] }, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    const row = screen.getByText("Benachrichtigungen", { selector: "div" }).parentElement?.parentElement as HTMLElement;
    expect(within(row).getByRole("link", { name: "Einrichten" })).toHaveAttribute("href", setupPath("notifications"));
  });
});

describe("Fertig", () => {
  it("zeigt jeden Schritt mit Abzeichen und „Nachholen“ und schließt mit „Zu Stowly“ ab", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "done");
    const update = vi.spyOn(core.setup, "update");
    const rows = screen.getAllByRole("link", { name: /^Nachholen: / });
    expect(rows.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Nachholen: Sichere Verbindung",
      "Nachholen: Sicherung",
      "Nachholen: Updates",
      "Nachholen: Benachrichtigungen",
      "Nachholen: Home Assistant",
    ]);
    expect(rows[0]).toHaveAttribute("href", setupPath("https"));
    expect(screen.getByText("Jedes weitere Gerät braucht das Zertifikat einmal: Einstellungen → Einrichtung und Zugang.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Überspringen" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Zu Stowly" }));
    expect(update).toHaveBeenCalledWith({ finished: true });
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(localStorage.getItem(ui(SETUP_DONE_FLAG))).toBe("1");
    expect((await core.setup.load()).finished_at).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
// Einstellungen: Einrichtung und Zugang
// ------------------------------------------------------------------------------------------

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("Einstellungen: Einrichtung und Zugang", () => {
  beforeEach(() => {
    // Die offene Einrichtung soll hier nicht von selbst aufgehen.
    localStorage.setItem(ui(SETUP_LATER_FLAG), "1");
  });

  it("nennt den Stand und führt zur Einrichtung", async () => {
    renderApp({ scenarios: ["setup-open"] }, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    const setup = section("Einrichtung und Zugang");
    expect(document.getElementById("einrichtung")).toBe(setup);
    expect(await within(setup).findByText("1 von 6 erledigt")).toBeInTheDocument();
    expect(within(setup).getByRole("link", { name: "Öffnen" })).toHaveAttribute("href", ROUTES.setup);
    expect(within(setup).getByRole("link", { name: "Anleitung" })).toHaveAttribute("href", setupPath("https"));
    cleanup();

    renderApp({}, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    // Home Assistant kam mit Stufe B dazu und ist noch offen.
    expect(await within(section("Einrichtung und Zugang")).findByText(/^Abgeschlossen am \d{2}\.\d{2}\.\d{4}; 5 von 6 erledigt, der Rest lässt sich nachholen$/)).toBeInTheDocument();
  });

  it("ändert das Haushalts-Passwort; ein falsches bisheriges meldet nicht ab", async () => {
    const core = renderApp({}, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    await userEvent.click(await within(section("Einrichtung und Zugang")).findByRole("button", { name: "Passwort ändern" }));
    const dialog = screen.getByRole("dialog", { name: "Haushalts-Passwort ändern" });
    const submit = within(dialog).getByRole("button", { name: "Passwort ändern" });

    await userEvent.click(submit);
    expect(within(dialog).getByLabelText("Bisheriges Passwort")).toHaveAccessibleDescription("Bitte das bisherige Passwort eingeben.");
    expect(within(dialog).getByLabelText("Neues Passwort")).toHaveAccessibleDescription("Das neue Passwort braucht mindestens 8 Zeichen.");
    await userEvent.type(within(dialog).getByLabelText("Bisheriges Passwort"), "falsch");
    await userEvent.type(within(dialog).getByLabelText("Neues Passwort"), "ein neues Passwort");
    await userEvent.type(within(dialog).getByLabelText("Neues Passwort wiederholen"), "ein anderes Passwort");
    await userEvent.click(submit);
    expect(within(dialog).getByLabelText("Neues Passwort wiederholen")).toHaveAccessibleDescription("Die beiden Passwörter sind verschieden.");

    await userEvent.clear(within(dialog).getByLabelText("Neues Passwort wiederholen"));
    await userEvent.type(within(dialog).getByLabelText("Neues Passwort wiederholen"), "ein neues Passwort");
    await userEvent.click(submit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Das bisherige Passwort stimmt nicht.");
    expect(core.session.state.get()?.status).toBe("signed_in");

    await userEvent.clear(within(dialog).getByLabelText("Bisheriges Passwort"));
    await userEvent.type(within(dialog).getByLabelText("Bisheriges Passwort"), MOCK_PASSWORD);
    await userEvent.click(submit);
    expect(await screen.findByText("Das Haushalts-Passwort ist geändert. Angemeldete Geräte bleiben angemeldet.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Haushalts-Passwort ändern" })).not.toBeInTheDocument();
    await core.session.logout();
    await expect(core.session.login("ein neues Passwort", "Flur")).resolves.toBeUndefined();
  });

  it("lässt ändern, was aus der Umgebung kommt, nur dort", async () => {
    renderApp({ scenarios: ["setup-env"] }, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    const setup = section("Einrichtung und Zugang");
    expect(await within(setup).findByText("nur dort änderbar")).toBeInTheDocument();
    expect(within(setup).queryByRole("button", { name: "Passwort ändern" })).not.toBeInTheDocument();
    expect(within(setup).getByText("Kommt aus der Umgebung (STOWLY_PUSH_CONTACT) und ist nur dort änderbar.")).toBeInTheDocument();
    // Updates ebenso: der Schalter in „Aktualisierung" ist gesperrt.
    expect(await within(section("Aktualisierung")).findByRole("switch", { name: "Nach neuen Versionen suchen" })).toBeUnavailable();
  });

  it("speichert den Kontakt für Push auch in den Einstellungen", async () => {
    const core = renderApp({ scenarios: ["setup-open"] }, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    const setup = section("Einrichtung und Zugang");
    await userEvent.type(await within(setup).findByLabelText("Kontakt-Adresse (E-Mail)"), "https://example.org/kontakt");
    await userEvent.click(within(setup).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Kontakt-Adresse gespeichert.")).toBeInTheDocument();
    expect((await core.serverConfig.load()).push).toEqual({ contact: "https://example.org/kontakt", source: "app" });
  });

  it("schaltet die Suche nach Updates in „Aktualisierung“ ein", async () => {
    const core = renderApp({ scenarios: ["release-off"] }, ROUTES.settings);
    await screen.findByRole("heading", { name: "Einstellungen" });
    const toggle = await within(section("Aktualisierung")).findByRole("switch", { name: "Nach neuen Versionen suchen" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect((await core.integrations.load()).update.configured).toBe(true);
    expect(await within(section("Aktualisierung")).findByText("Nach Updates suchen")).toBeInTheDocument();
  });
});
