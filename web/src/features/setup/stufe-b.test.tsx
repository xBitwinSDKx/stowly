/**
 * Die Schritte von Stufe B im Assistenten und das Wiederherstellen beim ersten Start, auf der
 * Attrappe (docs/plan-einrichtung-b.md, „So sieht es für dich aus"): „Sicherung" mit Schlüssel,
 * Probe und Weiter; „Home Assistant" mit Prüfen, Speichern und Sensor; „Aus einer Sicherung
 * wiederherstellen" auf der Willkommensseite.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupPath } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { resetSetupAutoOpen } from "@/app/setupAutoOpen";
import { MOCK_BACKUP_SECRET, MOCK_HA_URL, MOCK_PASSWORD, type MockCore } from "@/mock";

import { securePage } from "./navigateAway";

vi.mock("./navigateAway", async (importOriginal) => {
  const original = await importOriginal<typeof import("./navigateAway")>();
  return { ...original, navigateAway: vi.fn(), securePage: vi.fn(() => false) };
});

beforeEach(() => {
  resetSetupAutoOpen();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(securePage).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openStep(scenarios: Parameters<typeof renderApp>[0], step: Parameters<typeof setupPath>[0]): Promise<MockCore> {
  const core = renderApp(scenarios, setupPath(step));
  await screen.findByRole("heading", { name: "Einrichtung", level: 1 });
  return core;
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Keine Dateiauswahl gefunden");
  }
  return input;
}

describe("Schritt „Sicherung“", () => {
  it("beginnt ohne Schlüssel mit dem Erzeugen, und nach der Probe geht es weiter", async () => {
    const core = await openStep({ scenarios: ["setup-open"] }, "backup");
    const update = vi.spyOn(core.serverConfig, "update");
    expect(await screen.findByRole("heading", { name: "Sicherung", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Stowly sichert den Bestand jede Nacht verschlüsselt in einen Ordner auf dem Server\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Überspringen" })).toBeInTheDocument();

    // Ohne Schlüssel beginnt der Schritt gleich mit einem neuen.
    const secret = await screen.findByRole("group", { name: "Geheimer Schlüssel" });
    expect(secret).toHaveTextContent(/AGE-SECRET-KEY-1/);
    await userEvent.click(screen.getByRole("checkbox", { name: "Ich habe ihn gesichert." }));
    // Ein neuer Schlüssel braucht das Haushalts-Passwort, auch im Assistenten.
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Schlüssel übernehmen" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ backup_recipients: [expect.stringMatching(/^age1/)], current_password: MOCK_PASSWORD }));
    expect(await screen.findByRole("list", { name: "Öffentliche Schlüssel" })).toBeInTheDocument();

    // Uhrzeit und Ordner
    expect(screen.getByLabelText("Uhrzeit der Sicherung")).toHaveValue("03:30");
    expect(screen.getByText("/data/backups")).toBeInTheDocument();
    expect(screen.getByText("Sicherungen außerhalb des Datenordners")).toBeInTheDocument();

    // Die Probe: Danach ist der Schritt erledigt.
    await userEvent.click(screen.getByRole("button", { name: "Jetzt sichern" }));
    expect(await screen.findByText("Die Sicherung ist eingerichtet, und die letzte ist gelungen.")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Weiter" })).toHaveAttribute("href", setupPath("updates"));
    expect(screen.getByText("Schlüssel prüfen")).toBeInTheDocument();
  });

  it("ist mit einer Sicherung aus der Umgebung schon erledigt und zeigt sie nur an", async () => {
    await openStep({}, "backup");
    expect(await screen.findByText("Kommt aus der Umgebung (STOWLY_BACKUP_RECIPIENTS) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Geheimer Schlüssel" })).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Weiter" })).toBeInTheDocument();
  });
});

describe("Schritt „Home Assistant“", () => {
  it("prüft die Verbindung, speichert die Liste und bietet danach den Sensor an", async () => {
    let nowMs = Date.parse("2026-11-16T10:00:00.000Z");
    const core = renderApp({ scenarios: ["setup-open"], now: () => new Date(nowMs) }, setupPath("home_assistant"));
    const update = vi.spyOn(core.haConfig, "update");
    expect(await screen.findByRole("heading", { name: "Home Assistant", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Wer kein Home Assistant hat, überspringt diesen Schritt\./)).toBeInTheDocument();

    await userEvent.type(await screen.findByLabelText("Adresse von Home Assistant"), MOCK_HA_URL);
    await userEvent.type(screen.getByLabelText("Zugangs-Token"), "ein-token");
    await userEvent.click(screen.getByRole("button", { name: "Verbindung prüfen" }));
    expect(await screen.findByText("Verbindung zu Home Assistant steht; 2 To-do-Listen gefunden.")).toBeInTheDocument();
    nowMs += 5_000;
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Liste in Home Assistant" }), "todo.einkaufsliste");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ url: MOCK_HA_URL, entity: "todo.einkaufsliste", token: "ein-token" }));
    expect(await screen.findByRole("link", { name: "Weiter" })).toHaveAttribute("href", setupPath("done"));
    expect(await screen.findByText("Verbunden: Der Abgleich mit Bring! läuft.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sensor-Token erzeugen" }));
    expect(await screen.findByRole("group", { name: "configuration.yaml für Home Assistant" })).toHaveTextContent("unique_id: stowly_summary");
  });
});

describe("Aus einer Sicherung wiederherstellen", () => {
  it("bietet es neben dem ersten Passwort an, beginnt mit der gewählten Datei und kehrt mit „Andere Datei“ und Abbrechen zurück", async () => {
    renderApp({ scenarios: ["unconfigured"] });
    expect(await screen.findByRole("heading", { name: "Willkommen bei Stowly" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Aus einer Sicherung wiederherstellen", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/^Umzug oder neues NAS\?/)).toBeInTheDocument();
    // Ohne Filter: Das iPhone böte sonst keine .age-Datei an.
    expect(fileInput(screen.getByRole("main"))).not.toHaveAttribute("accept");
    await userEvent.upload(fileInput(screen.getByRole("main")), new File(["age-encryption.org/v1\n"], "stowly.sqlite3.gz.age"));
    expect(screen.getByRole("heading", { name: "Aus einer Sicherung wiederherstellen", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Schlüssel eingeben" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Andere Datei" }));
    expect(screen.getByRole("heading", { name: "Sicherungsdatei wählen" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByRole("heading", { name: "Willkommen bei Stowly" })).toBeInTheDocument();
  });

  it("bleibt während des Neustarts stehen, auch wenn der Server schon ein Passwort meldet: keine Anmeldung dazwischen", async () => {
    const core = renderApp({ scenarios: ["unconfigured"] });
    let finish: () => void = () => undefined;
    const restarted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(core.restore, "apply").mockImplementation(async (input) => {
      // Der Server ist nach dem Neustart eingerichtet, die Anmeldung mit dem Zugang läuft noch.
      core.control.setServerConfigured(true);
      await restarted;
      await core.session.login(MOCK_PASSWORD, input.device_name ?? "");
    });
    await screen.findByRole("heading", { name: "Willkommen bei Stowly" });
    await userEvent.upload(fileInput(screen.getByRole("main")), new File(["SQLite format 3\u0000"], "alt.sqlite3"));
    expect(await screen.findByRole("heading", { name: "Was in der Sicherung steckt" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Passwort aus der Sicherung"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(await screen.findByText("Stowly spielt die Sicherung ein und startet neu. Danach ist dieses Gerät angemeldet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Anmelden" })).not.toBeInTheDocument();
    finish();
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
  });

  it("lädt die Sicherung hoch, zeigt was drin ist, und meldet nach dem Neustart mit dem Passwort der Sicherung an", async () => {
    const core = renderApp({ scenarios: ["unconfigured"] });
    const apply = vi.spyOn(core.restore, "apply");
    await screen.findByRole("heading", { name: "Willkommen bei Stowly" });
    await userEvent.upload(fileInput(screen.getByRole("main")), new File(["age-encryption.org/v1\n-> X25519 …\n"], "stowly-2026-11-15-0330.sqlite3.gz.age"));
    const main = screen.getByRole("main");
    expect(await screen.findByRole("heading", { name: "Schlüssel eingeben" })).toBeInTheDocument();

    const keyFile = new File([`# created: 2026-11-16T20:00:00+01:00\n${MOCK_BACKUP_SECRET}\n`], "stowly-schluessel.txt");
    await userEvent.upload(fileInput(main), keyFile);
    expect(await screen.findByText("stowly-schluessel.txt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Prüfen" }));
    expect(await screen.findByRole("heading", { name: "Was in der Sicherung steckt" })).toBeInTheDocument();
    expect(main).toHaveTextContent("Haushalts-Passwortenthalten");

    // Das Passwort aus der Sicherung, nicht ein neues.
    expect(screen.queryByLabelText("Passwort wiederholen")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitte das Passwort aus der Sicherung eingeben.");
    await userEvent.type(screen.getByLabelText("Passwort aus der Sicherung"), "falsch");
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Passwort stimmt nicht mit dem aus der Sicherung überein.");

    await userEvent.clear(screen.getByLabelText("Passwort aus der Sicherung"));
    await userEvent.type(screen.getByLabelText("Passwort aus der Sicherung"), MOCK_PASSWORD);
    await userEvent.clear(screen.getByLabelText("Name dieses Geräts"));
    await userEvent.type(screen.getByLabelText("Name dieses Geräts"), "Neues Handy");
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(apply).toHaveBeenLastCalledWith({ restore_id: expect.any(String), password: MOCK_PASSWORD, device_name: "Neues Handy" });
    // Angemeldet, und die Einrichtung beginnt (auf einem neuen NAS ist die sichere Verbindung neu).
    expect(await screen.findByRole("heading", { name: "Einrichtung", level: 1 })).toBeInTheDocument();
    expect(core.session.state.get()).toMatchObject({ status: "signed_in", device: { name: "Neues Handy" } });
  });
});
