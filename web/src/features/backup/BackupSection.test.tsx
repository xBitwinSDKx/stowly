/**
 * Sicherung und Zurückspielen in den Einstellungen, auf der Attrappe (docs/plan-einrichtung-b.md,
 * „Einstellungen"): Schlüssel erzeugen, hinzufügen, entfernen und prüfen, Uhrzeit und Schalter, der
 * Ordner, „Jetzt sichern" mit den Dateien, Zurückspielen mit Rückfrage und Neustart, Rückgängig.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { MOCK_BACKUP_KEYS, MOCK_BACKUP_SECRET, MOCK_PASSWORD } from "@/mock";

import { BackupFolder } from "./BackupParts";
import { reloadPage } from "./files";
import { generateKeyPair } from "./keys";
import { canUndo } from "./RestorePanel";
import { folderText, insecureNetwork, keyErrorText, previewRows, restoreErrorText, scheduleHint, uploadPercent } from "./texts";

vi.mock("./files", async (importOriginal) => {
  const original = await importOriginal<typeof import("./files")>();
  return { ...original, reloadPage: vi.fn() };
});

afterEach(() => {
  vi.mocked(reloadPage).mockClear();
  vi.restoreAllMocks();
});

async function backupSection(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Einstellungen" });
  return screen.getByRole("region", { name: "Sicherung" });
}

/** Die versteckte Dateiauswahl hinter „Datei wählen" bzw. „Schlüsseldatei wählen". */
function fileInput(container: HTMLElement, index = 0): HTMLInputElement {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const input = inputs[index];
  if (!input) {
    throw new Error("Keine Dateiauswahl gefunden");
  }
  expect(input).not.toHaveAttribute("accept");
  return input;
}

const AGE_FILE = () => new File(["age-encryption.org/v1\n-> X25519 …\n--- …\n"], "stowly-2026-11-15-0330.sqlite3.gz.age");

describe("Texte", () => {
  it("sagen, woher der Ordner kommt, wie weit das Hochladen ist und was ein Fehler heißt", () => {
    expect(folderText({ folder: "/backups", folder_source: "env" })).toBe("Kommt aus der Umgebung (STOWLY_BACKUP_DIR).");
    expect(folderText({ folder: "/data/backups", folder_source: "data" })).toMatch(/^Im Datenordner von Stowly\./);
    expect([uploadPercent(null), uploadPercent({ loaded: 1, total: 3 }), uploadPercent({ loaded: 5, total: 0 })]).toEqual([0, 33, 0]);
    // Der Satz des Servers gilt; ohne ihn der Satz zum Grund.
    expect(restoreErrorText(new CoreError("invalid", "Das ist der öffentliche Schlüssel; gebraucht wird der geheime.", { reason: "not_a_key" }))).toBe(
      "Das ist der öffentliche Schlüssel; gebraucht wird der geheime.",
    );
    expect(restoreErrorText(new CoreError("invalid", "invalid", { reason: "wrong_key" }))).toMatch(/^Der Schlüssel passt nicht zu dieser Sicherung\./);
    expect(restoreErrorText(new CoreError("internal", "internal", { status: 413 }))).toBe("Die Datei ist zu groß: Eine Sicherung darf höchstens 512 MiB haben.");
    expect(restoreErrorText(new CoreError("not_configured", "Stowly kann sich hier nicht selbst neu starten."))).toBe("Stowly kann sich hier nicht selbst neu starten.");
    expect(restoreErrorText(new CoreError("conflict", "Gerade läuft ein Update. Zurückspielen geht erst danach."))).toBe("Gerade läuft ein Update. Zurückspielen geht erst danach.");
    expect(restoreErrorText(new CoreError("invalid_password"), true)).toBe("Das Passwort stimmt nicht mit dem aus der Sicherung überein.");
    expect(restoreErrorText(new CoreError("rate_limited", "", { retry_after_s: 90 }))).toBe("Zu viele Versuche. Nächster Versuch in 2 Minuten.");
    expect(restoreErrorText(new CoreError("not_found"))).toMatch(/abgelaufen/);
    expect(insecureNetwork({ protocol: "http:", hostname: "192.168.1.10" })).toBe(true);
    expect(insecureNetwork({ protocol: "http:", hostname: "localhost" })).toBe(false);
    expect(insecureNetwork({ protocol: "https:", hostname: "192.168.1.10" })).toBe(false);
    expect(canUndo({ undo_until: "2026-11-20T00:00:00.000Z" }, Date.parse("2026-11-19T00:00:00.000Z"))).toBe(true);
    expect(canUndo({ undo_until: "2026-11-20T00:00:00.000Z" }, Date.parse("2026-11-21T00:00:00.000Z"))).toBe(false);
    expect(canUndo({ undo_until: null })).toBe(false);
    // Ein neuer Schlüssel braucht das Haushalts-Passwort; ein falsches zählt wie bei der Anmeldung.
    expect(keyErrorText(new CoreError("invalid_password"))).toBe("Das Haushalts-Passwort stimmt nicht.");
    expect(keyErrorText(new CoreError("rate_limited", "", { retry_after_s: 45 }))).toBe("Zu viele Fehlversuche. Nächster Versuch in 45 Sekunden.");
    expect(keyErrorText(new CoreError("invalid", "Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort."))).toBe(
      "Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort.",
    );
    expect(keyErrorText(new CoreError("offline"))).toBe("Zum Speichern braucht es den Server, und der ist gerade nicht erreichbar.");
  });

  it("beschreiben Schalter und Vorschau", () => {
    const base = { enabled: true, enabled_source: "app" as const, recipients: [], time: "03:30" };
    expect(scheduleHint(base, null)).toBe("An, täglich um 03:30, sobald es einen Schlüssel gibt.");
    expect(scheduleHint({ ...base, enabled: false }, null)).toMatch(/^Aus: Stowly sichert nicht von selbst\./);
    expect(scheduleHint({ ...base, enabled_source: "env" }, null)).toMatch(/^Fest an, täglich um 03:30: Die Schlüssel kommen aus der Umgebung/);
    const rows = previewRows({
      restore_id: "0".repeat(32),
      expires_at: "2026-11-16T10:30:00.000Z",
      kind: "age",
      schema_version: 4,
      current_schema_version: 5,
      last_activity_at: null,
      has_password: false,
      devices: 2,
      counts: { products: 12, items: 1, zones: 3, shopping: 0 },
    });
    expect(rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      "Stand: unbekannt",
      "Produkte: 12",
      "Vorräte: 1 Packung",
      "Zonen: 3",
      "Einkaufsliste: leer",
      "Geräte: 2",
      "Haushalts-Passwort: keins",
      "Version: 4, wird beim Einspielen auf 5 gebracht",
    ]);
  });
});

describe("Ordner", () => {
  it("nennt einen eingebundenen Ordner, der nicht taugt, und dass die Sicherungen im Datenordner landen", () => {
    const hint = "Der eigene Ordner /backups ist eingebunden, taugt aber nicht: Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001). Die Sicherungen gehen deshalb in den Datenordner.";
    render(
      createElement(BackupFolder, {
        config: {
          enabled: true,
          enabled_source: "default",
          recipients: [],
          recipients_source: "default",
          time: "03:30",
          time_source: "default",
          folder: "/data/backups",
          folder_source: "data",
          folder_problem: null,
          folder_hint: hint,
        },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(`Der eigene Ordner wird nicht benutzt${hint}`);
    expect(screen.getByText("/data/backups")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Schlüssel in den Einstellungen", () => {
  it("erzeugt ein Schlüsselpaar: geheimer Teil zum Sichern, erst nach dem Haken geht der öffentliche an Stowly", async () => {
    const core = renderApp({ scenarios: ["backup-none"] }, ROUTES.settings);
    const update = vi.spyOn(core.serverConfig, "update");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const backup = await backupSection();
    expect(await within(backup).findByText(/Noch kein Schlüssel\./)).toBeInTheDocument();

    await userEvent.click(within(backup).getByRole("button", { name: "Schlüssel erzeugen" }));
    const secret = await within(backup).findByRole("group", { name: "Geheimer Schlüssel" });
    expect(secret).toHaveTextContent(/^AGE-SECRET-KEY-1[0-9A-Z]{58}/);
    expect(within(backup).getByText("Den geheimen Schlüssel jetzt sichern")).toBeInTheDocument();
    expect(backup).toHaveTextContent("an zwei Orten aufheben, etwa auf einem USB-Stick und im Passwort-Manager");
    const take = within(backup).getByRole("button", { name: "Schlüssel übernehmen" });
    expect(take).toBeDisabled();

    // Als Datei im Format von age-keygen.
    await userEvent.click(within(backup).getByRole("button", { name: "Als Datei speichern" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect((clicked.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toMatch(/^stowly-schluessel-\d{4}-\d{2}-\d{2}\.txt$/);

    await userEvent.click(within(backup).getByRole("checkbox", { name: "Ich habe ihn gesichert." }));
    // Ohne das Haushalts-Passwort geht nichts an Stowly: Ein neuer Schlüssel öffnet jede künftige Sicherung.
    await userEvent.click(take);
    expect(await within(backup).findByText("Bitte das Haushalts-Passwort eingeben.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    const password = within(backup).getByLabelText("Haushalts-Passwort");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    // Ein falsches: der Satz dazu, und der geheime Schlüssel bleibt stehen.
    await userEvent.type(password, "falsch");
    await userEvent.click(take);
    expect(await within(backup).findByText("Das Haushalts-Passwort stimmt nicht.")).toBeInTheDocument();
    expect(within(backup).getByRole("group", { name: "Geheimer Schlüssel" })).toBeInTheDocument();
    await userEvent.clear(password);
    await userEvent.type(password, `${MOCK_PASSWORD}{Enter}`);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const sent = update.mock.calls[1]?.[0];
    expect(sent?.backup_recipients).toHaveLength(1);
    expect(sent?.backup_recipients?.[0]).toMatch(/^age1/);
    expect(sent?.current_password).toBe(MOCK_PASSWORD);
    expect(JSON.stringify(sent)).not.toMatch(/AGE-SECRET-KEY/i);
    // Danach ist der geheime Schlüssel weg, der öffentliche steht in der Liste.
    await waitFor(() => expect(within(backup).queryByRole("group", { name: "Geheimer Schlüssel" })).not.toBeInTheDocument());
    const keys = within(backup).getByRole("list", { name: "Öffentliche Schlüssel" });
    expect(within(keys).getAllByRole("listitem")).toHaveLength(1);
    expect(await screen.findByText("Schlüssel übernommen: Die nächste Sicherung ist für ihn verschlüsselt.")).toBeInTheDocument();
  });

  it("fügt einen öffentlichen Schlüssel hinzu, schickt nie einen geheimen und entfernt nach Rückfrage", async () => {
    const core = renderApp({ scenarios: ["backup-app"] }, ROUTES.settings);
    const update = vi.spyOn(core.serverConfig, "update");
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Öffentlichen Schlüssel hinzufügen" }));
    const field = within(backup).getByLabelText("Öffentlicher Schlüssel");

    await userEvent.type(field, MOCK_BACKUP_SECRET);
    await userEvent.click(within(backup).getByRole("button", { name: "Hinzufügen" }));
    expect(await within(backup).findByText(/Das ist ein geheimer Schlüssel\. Hierher gehört nur der öffentliche/)).toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(update).not.toHaveBeenCalled();

    await userEvent.type(field, "age1kaputt");
    await userEvent.click(within(backup).getByRole("button", { name: "Hinzufügen" }));
    expect(await within(backup).findByText(/Das ist kein öffentlicher Schlüssel von age\./)).toBeInTheDocument();

    await userEvent.clear(field);
    await userEvent.type(field, ` ${MOCK_BACKUP_KEYS[1].toUpperCase()} `);
    await userEvent.click(within(backup).getByRole("button", { name: "Hinzufügen" }));
    expect(await within(backup).findByText("Bitte das Haushalts-Passwort eingeben.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await userEvent.type(within(backup).getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(within(backup).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ backup_recipients: [MOCK_BACKUP_KEYS[0], MOCK_BACKUP_KEYS[1]], current_password: MOCK_PASSWORD }));
    const keys = await within(backup).findByRole("list", { name: "Öffentliche Schlüssel" });
    await waitFor(() => expect(within(keys).getAllByRole("listitem")).toHaveLength(2));

    await userEvent.click(within(keys).getByRole("button", { name: "Schlüssel age1wd93…dxjq entfernen" }));
    const dialog = await screen.findByRole("dialog", { name: "Schlüssel entfernen?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    // Entfernen braucht kein Passwort.
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ backup_recipients: [MOCK_BACKUP_KEYS[1]] }));
  });

  it("sagt bei zu vielen falschen Passwörtern, wie lange es zu warten gilt", async () => {
    const core = renderApp({ scenarios: ["backup-app"] }, ROUTES.settings);
    vi.spyOn(core.serverConfig, "update").mockRejectedValue(new CoreError("rate_limited", "Zu viele Fehlversuche.", { retry_after_s: 60 }));
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Öffentlichen Schlüssel hinzufügen" }));
    await userEvent.type(within(backup).getByLabelText("Öffentlicher Schlüssel"), MOCK_BACKUP_KEYS[1]);
    await userEvent.type(within(backup).getByLabelText("Haushalts-Passwort"), "irgendwas");
    await userEvent.click(within(backup).getByRole("button", { name: "Hinzufügen" }));
    expect(await within(backup).findByRole("alert")).toHaveTextContent("Zu viele Fehlversuche. Nächster Versuch in 1 Minute.");
  });

  it("prüft einen gesicherten Schlüssel nur im Browser: eingefügt oder als Datei", async () => {
    const core = renderApp({ scenarios: ["backup-app"] }, ROUTES.settings);
    const update = vi.spyOn(core.serverConfig, "update");
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByText("Schlüssel prüfen"));
    const field = within(backup).getByLabelText("Geheimer Schlüssel");
    expect(field).toHaveAttribute("type", "password");

    await userEvent.type(field, MOCK_BACKUP_SECRET);
    await userEvent.click(within(backup).getByRole("button", { name: "Prüfen" }));
    expect(await within(backup).findByText("Der Schlüssel passt")).toBeInTheDocument();
    expect(field).toHaveValue("");

    await userEvent.type(field, generateKeyPair().secret);
    await userEvent.click(within(backup).getByRole("button", { name: "Prüfen" }));
    expect(await within(backup).findByText("Der Schlüssel passt nicht")).toBeInTheDocument();

    await userEvent.type(field, "kein Schlüssel");
    await userEvent.click(within(backup).getByRole("button", { name: "Prüfen" }));
    expect(await within(backup).findByText("Kein geheimer Schlüssel")).toBeInTheDocument();

    const keyFile = new File([`# created: 2026-11-16T20:00:00+01:00\n# public key: ${MOCK_BACKUP_KEYS[0]}\n${MOCK_BACKUP_SECRET}\n`], "key.txt");
    await userEvent.upload(fileInput(backup), keyFile);
    expect(await within(backup).findByText("Der Schlüssel passt")).toBeInTheDocument();
    expect(backup).toHaveTextContent("key.txt");
    // Nichts davon ging an den Server.
    expect(update).not.toHaveBeenCalled();
  });

  it("sperrt Schlüssel, Schalter und Uhrzeit aus der Umgebung und sagt es", async () => {
    renderApp({}, ROUTES.settings);
    const backup = await backupSection();
    expect(await within(backup).findByText("Kommt aus der Umgebung (STOWLY_BACKUP_RECIPIENTS) und ist nur dort änderbar.")).toBeInTheDocument();
    expect(within(backup).queryByRole("button", { name: "Schlüssel erzeugen" })).not.toBeInTheDocument();
    expect(within(backup).queryByRole("button", { name: /entfernen$/ })).not.toBeInTheDocument();
    expect(within(backup).getByRole("switch", { name: "Automatische Sicherung" })).toBeUnavailable();
    expect(within(backup).queryByLabelText("Uhrzeit der Sicherung")).not.toBeInTheDocument();
    expect(backup).toHaveTextContent("Kommt aus der Umgebung (STOWLY_BACKUP_TIME) und ist nur dort änderbar.");
    expect(backup).toHaveTextContent("Kommt aus der Umgebung (STOWLY_BACKUP_DIR).");
  });
});

describe("Uhrzeit, Schalter und Ordner", () => {
  it("ändert Uhrzeit und Schalter in der App und erklärt den Datenordner", async () => {
    const core = renderApp({ scenarios: ["backup-none"] }, ROUTES.settings);
    const update = vi.spyOn(core.serverConfig, "update");
    const backup = await backupSection();
    const time = await within(backup).findByLabelText("Uhrzeit der Sicherung");
    expect(time).toHaveValue("03:30");
    await userEvent.clear(time);
    await userEvent.type(time, "04:15");
    await userEvent.tab();
    await waitFor(() => expect(update).toHaveBeenCalledWith({ backup_time: "04:15" }));

    await userEvent.click(within(backup).getByRole("switch", { name: "Automatische Sicherung" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ backup_enabled: false }));
    expect(await within(backup).findByText(/^Aus: Stowly sichert nicht von selbst\./)).toBeInTheDocument();

    expect(within(backup).getByText("/data/backups")).toBeInTheDocument();
    await userEvent.click(within(backup).getByText("Sicherungen außerhalb des Datenordners"));
    expect(backup).toHaveTextContent("Einhängepfad /backups");
    expect(backup).toHaveTextContent("Hyper Backup oder Cloud Sync");
  });
});

describe("Jetzt sichern und herunterladen", () => {
  it("legt eine Sicherung an, zeigt sie in der Liste und lädt sie verschlüsselt herunter", async () => {
    const core = renderApp({ scenarios: ["backup-app"] }, ROUTES.settings);
    const run = vi.spyOn(core.backup, "run");
    const file = vi.spyOn(core.backup, "file");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Jetzt sichern" }));
    expect(run).toHaveBeenCalledTimes(1);
    const created = await run.mock.results[0]?.value;
    expect(await screen.findByText(`Sicherung angelegt: ${created?.name ?? ""}`)).toBeInTheDocument();
    const list = await within(backup).findByRole("list", { name: "Sicherungen im Ordner" });
    await waitFor(() => expect(within(list).getByText(created?.name ?? "–")).toBeInTheDocument());

    await userEvent.click(within(list).getByRole("button", { name: `Herunterladen: ${created?.name ?? ""}` }));
    await waitFor(() => expect(file).toHaveBeenCalledWith(created?.name));
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
    expect((clicked.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe(created?.name);

    // Gleich noch einmal: höchstens eine je Minute.
    await userEvent.click(within(backup).getByRole("button", { name: "Jetzt sichern" }));
    expect(await within(backup).findByText("Jetzt sichern geht höchstens einmal je Minute. Bitte kurz warten.")).toBeInTheDocument();
    expect(within(backup).getByText(/^Nächste in \d+ s$/)).toBeInTheDocument();
  });

  it("sagt ohne Schlüssel, was fehlt, und offline, dass der Zustand fehlt", async () => {
    renderApp({ scenarios: ["backup-none"] }, ROUTES.settings);
    let backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Jetzt sichern" }));
    expect(await within(backup).findByText("Für die Sicherung fehlt ein öffentlicher Schlüssel.")).toBeInTheDocument();

    renderApp({ scenarios: ["offline"] }, ROUTES.settings);
    backup = (await screen.findAllByRole("region", { name: "Sicherung" })).at(-1) as HTMLElement;
    expect(await within(backup).findByText("Zustand der Sicherung fehlt")).toBeInTheDocument();
    expect(within(backup).queryByRole("button", { name: "Jetzt sichern" })).not.toBeInTheDocument();
  });
});

describe("Zurückspielen in den Einstellungen", () => {
  it("lädt hoch, prüft den Schlüssel, zeigt die Vorschau und spielt nach Passwort und Rückfrage ein; dann lädt die Seite neu", async () => {
    const core = renderApp({}, ROUTES.settings);
    const apply = vi.spyOn(core.restore, "apply");
    const check = vi.spyOn(core.restore, "check");
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Zurückspielen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Sicherung zurückspielen" });
    expect(within(dialog).getByRole("heading", { name: "Sicherungsdatei wählen" })).toBeInTheDocument();

    await userEvent.upload(fileInput(dialog), AGE_FILE());
    expect(await within(dialog).findByRole("heading", { name: "Schlüssel eingeben" })).toBeInTheDocument();
    // Über localhost gilt die Verbindung als sicher: kein Hinweis auf http.
    expect(within(dialog).queryByText("Unverschlüsselte Verbindung")).not.toBeInTheDocument();

    // Ein falscher Schlüssel: der Satz dazu, der Schritt bleibt.
    await userEvent.type(within(dialog).getByLabelText("Geheimer Schlüssel"), generateKeyPair().secret);
    await userEvent.click(within(dialog).getByRole("button", { name: "Prüfen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Schlüssel passt nicht zu dieser Sicherung.");
    expect(within(dialog).getByLabelText("Geheimer Schlüssel")).toHaveValue("");

    await userEvent.type(within(dialog).getByLabelText("Geheimer Schlüssel"), MOCK_BACKUP_SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: "Prüfen" }));
    expect(await within(dialog).findByRole("heading", { name: "Was in der Sicherung steckt" })).toBeInTheDocument();
    expect(check).toHaveBeenLastCalledWith(expect.any(String), MOCK_BACKUP_SECRET);
    expect(dialog).toHaveTextContent("Haushalts-Passwortenthalten");

    await userEvent.click(within(dialog).getByRole("button", { name: "Zurückspielen …" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Bitte das jetzige Haushalts-Passwort eingeben.");
    await userEvent.type(within(dialog).getByLabelText("Jetziges Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(within(dialog).getByRole("button", { name: "Zurückspielen …" }));
    const confirm = await screen.findByRole("dialog", { name: "Sicherung jetzt einspielen?" });
    expect(confirm).toHaveTextContent("ersetzt alles, was jetzt in Stowly steht");
    expect(confirm).toHaveTextContent("Sieben Tage lang lässt es sich rückgängig machen.");
    await userEvent.click(within(confirm).getByRole("button", { name: "Einspielen" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ restore_id: expect.any(String), password: MOCK_PASSWORD }));
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });

  it("zeigt in der Rückfrage ein falsches Passwort und lässt sie offen", async () => {
    renderApp({}, ROUTES.settings);
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Zurückspielen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Sicherung zurückspielen" });
    await userEvent.upload(fileInput(dialog), new File(["SQLite format 3\u0000 …"], "alt.sqlite3"));
    // Unverschlüsselt: gleich die Vorschau, ohne Schlüssel.
    expect(await within(dialog).findByRole("heading", { name: "Was in der Sicherung steckt" })).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Jetziges Haushalts-Passwort"), "falsch");
    await userEvent.click(within(dialog).getByRole("button", { name: "Zurückspielen …" }));
    const confirm = await screen.findByRole("dialog", { name: "Sicherung jetzt einspielen?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Einspielen" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Das Passwort stimmt nicht.");
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("sagt, was keine Sicherung ist", async () => {
    renderApp({}, ROUTES.settings);
    const backup = await backupSection();
    await userEvent.click(await within(backup).findByRole("button", { name: "Zurückspielen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Sicherung zurückspielen" });
    await userEvent.upload(fileInput(dialog), new File(["PK\u0003\u0004"], "fotos.zip"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Das ist keine Sicherung von Stowly.");
    expect(within(dialog).getByRole("heading", { name: "Sicherungsdatei wählen" })).toBeInTheDocument();
  });

  it("bietet nach einem Zurückspielen sieben Tage lang Rückgängig und das Löschen der alten Datenbank", async () => {
    const core = renderApp({ scenarios: ["restore-preview"] }, ROUTES.settings);
    const undo = vi.spyOn(core.restore, "undo");
    const discard = vi.spyOn(core.restore, "discardPrevious");
    const backup = await backupSection();
    expect(await within(backup).findByText(/^Zurückgespielt am /)).toBeInTheDocument();
    expect(backup).toHaveTextContent(/lässt sich das umkehren; danach löscht Stowly die Datenbank von davor\./);

    await userEvent.click(within(backup).getByRole("button", { name: "Alte Datenbank löschen" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Alte Datenbank löschen?" })).getByRole("button", { name: "Abbrechen" }));
    expect(discard).not.toHaveBeenCalled();

    await userEvent.click(within(backup).getByRole("button", { name: "Rückgängig" }));
    const confirm = await screen.findByRole("dialog", { name: "Zurückspielen rückgängig machen?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Rückgängig machen" }));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });
});
