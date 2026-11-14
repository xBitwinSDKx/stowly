/**
 * Die Bausteine oberhalb der Grundbausteine: Texte, MHD-Feld, Mengenwähler, Menü, Rückfrage, Hooks.
 */
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError } from "@/contract";

import {
  BestBeforeField,
  Checkbox,
  ConfirmDialog,
  describeBestBefore,
  EmptyState,
  errorText,
  ExpiryLabel,
  expiryText,
  FilterCard,
  formatBytes,
  LIST_FIRST,
  LIST_STEP,
  Menu,
  PackageIds,
  packagesText,
  plural,
  readBestBefore,
  relativeDays,
  Select,
  StatCard,
  Stepper,
  TextLink,
  timeAgo,
  useMediaQuery,
  useProgressiveCount,
  useUiFlag,
  ZoneLabel,
} from ".";
import { setTestViewport } from "./testing";

const TODAY = "2026-11-13";

/** Rendert Bausteine, die Verweise enthalten, in einem Router. */
function renderInRouter(element: ReactNode, routes: { path: string; element: ReactNode }[] = []) {
  const router = createMemoryRouter([{ path: "/", element }, ...routes]);
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Texte", () => {
  it("zählt in Worten", () => {
    expect(plural(1, "Zone", "Zonen")).toBe("1 Zone");
    expect(plural(0, "Zone", "Zonen")).toBe("0 Zonen");
    expect(packagesText(1)).toBe("1 Packung");
    expect(packagesText(12)).toBe("12 Packungen");
  });

  it("nennt Abstände in Tagen, Monaten und Jahren", () => {
    expect(relativeDays(0)).toBe("heute");
    expect(relativeDays(1)).toBe("morgen");
    expect(relativeDays(-1)).toBe("gestern");
    expect(relativeDays(9)).toBe("in 9 Tagen");
    expect(relativeDays(-3)).toBe("vor 3 Tagen");
    expect(relativeDays(132)).toBe("in etwa 4 Monaten");
    expect(relativeDays(900)).toBe("in etwa 2 Jahren");
  });

  it("sagt, was eine Warnstufe für eine Packung heißt", () => {
    expect(expiryText("expired", -1)).toBe("seit gestern abgelaufen");
    expect(expiryText("expired", -3)).toBe("seit 3 Tagen abgelaufen");
    expect(expiryText("expired", -90)).toBe("seit etwa 3 Monaten abgelaufen");
    expect(expiryText("soon", 0)).toBe("läuft heute ab");
    expect(expiryText("soon", 1)).toBe("läuft morgen ab");
    expect(expiryText("soon", 9)).toBe("läuft in 9 Tagen ab");
    expect(expiryText("ok", 132)).toBe("in etwa 4 Monaten");
    expect(expiryText("none", null)).toBe("");
  });

  it("nennt, wie lange etwas her ist", () => {
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    expect(timeAgo("2026-11-13T11:59:40.000Z", now)).toBe("gerade eben");
    expect(timeAgo("2026-11-13T11:59:00.000Z", now)).toBe("vor einer Minute");
    expect(timeAgo("2026-11-13T11:15:00.000Z", now)).toBe("vor 45 Minuten");
    expect(timeAgo("2026-11-13T10:30:00.000Z", now)).toBe("vor einer Stunde");
    expect(timeAgo("2026-11-13T05:00:00.000Z", now)).toBe("vor 7 Stunden");
    // Ab 24 Stunden zählen Kalendertage des Geräts: „gestern" ist nur der Tag davor. Die Zeitpunkte
    // stehen deshalb in der Zeitzone, in der der Test läuft.
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
    const at = local(14, 12, 19).getTime();
    expect(timeAgo(local(13, 10).toISOString(), at)).toBe("gestern");
    expect(timeAgo(local(2, 12, 19).toISOString(), at)).toBe("vor 12 Tagen");
    expect(timeAgo(local(12, 19, 19).toISOString(), at)).toBe("vor 2 Tagen");
    expect(timeAgo(local(13, 11, 0).toISOString(), at)).toBe("gestern");
    expect(timeAgo(local(13, 0, 5).toISOString(), local(14, 23, 55).getTime())).toBe("gestern");
    expect(timeAgo(local(13, 23, 0).toISOString(), at)).toBe("vor 13 Stunden");
    // Die Uhr des anderen Geräts geht vor: kein „in der Zukunft"
    expect(timeAgo("2026-11-13T12:05:00.000Z", now)).toBe("gerade eben");
    expect(timeAgo("kein Zeitstempel", now)).toBe("");
  });

  it("nennt Dateigrößen mit Dezimalpräfix und Komma", () => {
    expect(formatBytes(0)).toBe("0 Byte");
    expect(formatBytes(812)).toBe("812 Byte");
    expect(formatBytes(1000)).toBe("1 kB");
    expect(formatBytes(1460)).toBe("1,5 kB");
    expect(formatBytes(51_874)).toBe("52 kB");
    expect(formatBytes(1_400_000)).toBe("1,4 MB");
    expect(formatBytes(230_000_000)).toBe("230 MB");
    expect(formatBytes(5_000_000_000_000_000)).toBe("5.000 TB");
    expect(formatBytes(Number.NaN)).toBe("0 Byte");
  });

  it("übersetzt Fehler des Kerns nach ihrem Code", () => {
    expect(errorText(new CoreError("offline"))).toBe("Der Server ist gerade nicht erreichbar.");
    expect(errorText(new CoreError("last_zone"))).toBe("Die letzte Zone lässt sich nicht löschen.");
    expect(errorText(new CoreError("offline"), { offline: "Die Sicherung braucht den Server." })).toBe("Die Sicherung braucht den Server.");
    // Der Text des Kerns ist nur der Rückfall; die Oberfläche zeigt ihren eigenen Satz.
    expect(errorText(new CoreError("not_found", "package 4711 missing"))).toBe("Der Eintrag existiert nicht mehr.");
    // Ausnahme "invalid": Dort ist der Satz des Kerns der genaue Grund und wird gezeigt, auch gegen einen eigenen Satz.
    expect(errorText(new CoreError("invalid", "Der Name ist zu lang (höchstens 60 Zeichen)."))).toBe("Der Name ist zu lang (höchstens 60 Zeichen).");
    expect(errorText(new CoreError("invalid", "Die Menge muss zwischen 1 und 50 liegen."), { invalid: "Eigener Satz" })).toBe("Die Menge muss zwischen 1 und 50 liegen.");
    expect(errorText(new CoreError("invalid"))).toBe("Die Eingabe ist ungültig.");
    expect(errorText(new CoreError("invalid"), { invalid: "Eigener Satz" })).toBe("Eigener Satz");
    // Ebenso "not_supported": Nur der Kern weiß, warum es hier nicht geht (keine lokale Datenbank, ein anderer Tab).
    const blocked = "Ein anderer Tab mit einer älteren Version von Stowly hält die lokalen Daten fest. Schließe ihn, dann geht es hier weiter.";
    expect(errorText(new CoreError("not_supported", blocked))).toBe(blocked);
    expect(errorText(new CoreError("not_supported"))).toBe("Das ist in dieser Ausbaustufe noch nicht verfügbar.");
    expect(errorText(new TypeError("x is undefined"))).toBe("Unerwarteter Fehler. Bitte noch einmal versuchen.");
  });
});

describe("BestBeforeField", () => {
  function Example({ initial = "" }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <BestBeforeField value={value} onChange={setValue} today={TODAY} />
        <output>{JSON.stringify(readBestBefore(value, TODAY))}</output>
      </>
    );
  }

  it("zeigt beim Tippen, welches Datum verstanden wurde", async () => {
    render(<Example />);
    const field = screen.getByLabelText("MHD");
    expect(field).toHaveAccessibleDescription("Leer lassen = kein MHD");
    expect(field).toHaveAttribute("inputmode", "numeric");

    await userEvent.type(field, "250327");
    expect(field).toHaveAccessibleDescription("Verstanden: 25.03.2027 · in etwa 4 Monaten");
    expect(screen.getByRole("status")).toHaveTextContent('{"kind":"date","date":"2027-03-25","precision":"day"}');
  });

  it("versteht Monatsangaben als letzten Tag des Monats und sagt das dazu", async () => {
    render(<Example />);
    const field = screen.getByLabelText("MHD");
    await userEvent.type(field, "02/28");
    expect(field).toHaveAccessibleDescription("Verstanden: 29.02.2028 (Ende Februar 2028) · in etwa 16 Monaten");
  });

  it("nimmt Tag und Monat als nächstes Vorkommen", async () => {
    render(<Example />);
    await userEvent.type(screen.getByLabelText("MHD"), "2011");
    expect(screen.getByLabelText("MHD")).toHaveAccessibleDescription("Verstanden: 20.11.2026 · in 7 Tagen");
  });

  it("meldet unlesbare Eingaben erst beim Verlassen des Felds als Fehler", async () => {
    render(<Example />);
    const field = screen.getByLabelText("MHD");
    await userEvent.type(field, "25.");
    expect(field).not.toBeInvalid();
    expect(field).toHaveAccessibleDescription(/Noch kein Datum erkannt/);

    await userEvent.tab();
    expect(field).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("Kein Datum erkannt. Beispiele: 25.03.27, 2503 oder 03/27");

    // Weitertippen nimmt den Fehler zurück.
    await userEvent.type(field, "03.27");
    expect(field).not.toBeInvalid();
    expect(field).toHaveAccessibleDescription(/Verstanden: 25\.03\.2027/);
  });

  it("leert das Feld über das Kreuz", async () => {
    render(<Example initial="25.03.2027" />);
    await userEvent.click(screen.getByRole("button", { name: "MHD leeren" }));
    expect(screen.getByLabelText("MHD")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent('{"kind":"empty"}');
    expect(screen.queryByRole("button", { name: "MHD leeren" })).not.toBeInTheDocument();
  });

  it("beschreibt nur gültige Daten", () => {
    expect(describeBestBefore({ kind: "empty" }, TODAY)).toBeNull();
    expect(describeBestBefore({ kind: "invalid" }, TODAY)).toBeNull();
    expect(describeBestBefore({ kind: "date", date: "2026-11-10", precision: "day" }, TODAY)).toBe("Verstanden: 10.11.2026 · vor 3 Tagen");
    expect(readBestBefore("  ", TODAY)).toEqual({ kind: "empty" });
    expect(readBestBefore("31.02.2027", TODAY)).toEqual({ kind: "invalid" });
  });
});

describe("Stepper", () => {
  function Example() {
    const [value, setValue] = useState(1);
    return (
      <>
        <Stepper label="Menge" value={value} onChange={setValue} min={1} max={50} />
        <output>{value}</output>
      </>
    );
  }

  it("zählt mit Plus und Minus innerhalb der Grenzen", async () => {
    render(<Example />);
    expect(screen.getByRole("button", { name: "Weniger" })).toBeUnavailable();
    await userEvent.click(screen.getByRole("button", { name: "Mehr" }));
    await userEvent.click(screen.getByRole("button", { name: "Mehr" }));
    expect(screen.getByLabelText("Menge")).toHaveValue("3");
    await userEvent.click(screen.getByRole("button", { name: "Weniger" }));
    expect(screen.getByRole("status")).toHaveTextContent("2");
  });

  it("lässt den Fokus auf Minus, wenn es bis an die Grenze zählt", async () => {
    render(<Example />);
    const less = screen.getByRole("button", { name: "Weniger" });
    // Ohne Fokus ganz gesperrt: Die Tabulatortaste überspringt Minus.
    expect(less).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Mehr" }));
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(less).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("1");
    // An der Grenze gesperrt, aber mit dem Fokus: Ein weiteres Enter tut nichts.
    expect(less).toHaveFocus();
    expect(less).not.toBeDisabled();
    expect(less).toBeUnavailable();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("1");
  });

  it("nimmt getippte Zahlen und bringt sie beim Verlassen in den erlaubten Bereich", async () => {
    render(<Example />);
    const input = screen.getByLabelText("Menge");
    await userEvent.clear(input);
    await userEvent.type(input, "12");
    expect(screen.getByRole("status")).toHaveTextContent("12");

    await userEvent.clear(input);
    await userEvent.type(input, "99");
    // „9" gilt sofort, „99" liegt außerhalb: Das zählt erst nach dem Verlassen, dann als Höchstwert.
    expect(screen.getByRole("status")).toHaveTextContent("9");
    await userEvent.tab();
    expect(input).toHaveValue("50");
    expect(screen.getByRole("status")).toHaveTextContent("50");
    expect(screen.getByRole("button", { name: "Mehr" })).toBeUnavailable();

    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await userEvent.tab();
    expect(input).toHaveValue("50");
  });
});

describe("Select und Checkbox", () => {
  it("Select meldet die Wahl und verbindet Hinweis und Fehler mit dem Feld", async () => {
    const onChange = vi.fn();
    const options = [
      { value: "a", label: "Keller" },
      { value: "b", label: "Garage" },
    ];
    const { rerender } = render(<Select label="Zone" value="a" onChange={onChange} options={options} hint="Wohin damit?" />);
    const select = screen.getByLabelText("Zone");
    expect(select).toHaveAccessibleDescription("Wohin damit?");
    await userEvent.selectOptions(select, "Garage");
    expect(onChange).toHaveBeenCalledWith("b");

    rerender(<Select label="Zone" value="a" onChange={onChange} options={options} error="Bitte wählen" />);
    expect(screen.getByLabelText("Zone")).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte wählen");
  });

  it("Checkbox kennt „einige, nicht alle“", async () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} indeterminate onChange={onChange}>
        Alle 4 Packungen
      </Checkbox>,
    );
    const box = screen.getByRole("checkbox", { name: "Alle 4 Packungen" });
    expect(box).toBePartiallyChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Menu", () => {
  function Example({ onLogout }: { onLogout: () => void }) {
    return (
      <Menu
        label="Geräte-Menü"
        header="Angemeldet als Handy"
        items={[
          { key: "settings", label: "Einstellungen", to: "/einstellungen" },
          { key: "sync", label: "Sync-Status", to: "/sync" },
          { key: "logout", label: "Abmelden", onSelect: onLogout, tone: "danger", separated: true },
        ]}
      >
        Handy
      </Menu>
    );
  }

  it("öffnet sich an der Schaltfläche und lässt sich mit der Tastatur bedienen", async () => {
    const onLogout = vi.fn();
    renderInRouter(<Example onLogout={onLogout} />);
    const trigger = screen.getByRole("button", { name: "Handy" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const items = within(screen.getByRole("menu", { name: "Geräte-Menü" })).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Einstellungen", "Sync-Status", "Abmelden"]);
    expect(items[0]).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(items[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(items[2]).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("schließt mit Escape und beim Klick daneben", async () => {
    renderInRouter(
      <>
        <Example onLogout={() => undefined} />
        <p>daneben</p>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Handy" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByText("daneben"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("führt über Verweise zu anderen Ansichten", async () => {
    const { router } = renderInRouter(<Example onLogout={() => undefined} />, [{ path: "/sync", element: <h1>Sync</h1> }]);
    await userEvent.click(screen.getByRole("button", { name: "Handy" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Sync-Status" }));
    expect(await screen.findByRole("heading", { name: "Sync" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sync");
  });
});

describe("ConfirmDialog", () => {
  function Example({ action }: { action: () => Promise<void> }) {
    const [open, setOpen] = useState(true);
    return (
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Zone löschen?"
        confirmLabel="Löschen"
        tone="danger"
        onConfirm={async () => {
          await action();
          setOpen(false);
        }}
        errorText={(error) => errorText(error)}
      >
        <p>Das lässt sich nicht rückgängig machen.</p>
      </ConfirmDialog>
    );
  }

  it("führt die Aktion aus und schließt", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    render(<Example action={action} />);
    const dialog = screen.getByRole("dialog", { name: "Zone löschen?" });
    expect(within(dialog).getByRole("button", { name: "Löschen" })).toHaveClass("danger");
    await userEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Das lässt sich nicht rückgängig machen.")).not.toBeInTheDocument();
  });

  it("bleibt offen und sagt, warum, wenn die Aktion scheitert", async () => {
    const action = vi.fn().mockRejectedValue(new CoreError("last_zone"));
    render(<Example action={action} />);
    await userEvent.click(screen.getByRole("button", { name: "Löschen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die letzte Zone lässt sich nicht löschen.");
    expect(screen.getByRole("button", { name: "Löschen" })).toBeAvailable();

    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText("Das lässt sich nicht rückgängig machen.")).not.toBeInTheDocument();
  });
});

describe("Karten und Marken", () => {
  it("StatCard zeigt Beschriftung, Zahl und Zusatz und wird auf Wunsch zum Verweis", () => {
    renderInRouter(<StatCard label="Läuft bald ab" value={8} note="(1 abgelaufen)" tone="warn" to="/warnungen" />);
    const link = screen.getByRole("link", { name: "Läuft bald ab 8 (1 abgelaufen)" });
    expect(link).toHaveAttribute("href", "/warnungen");
    expect(link).toHaveClass("stat", "warn", "link");
    expect(screen.getByText("Läuft bald ab").nextElementSibling).toHaveTextContent("8 (1 abgelaufen)");
  });

  it("FilterCard ist ein Umschalter mit Name, Balken und „Status“", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<FilterCard label="Keller" icon={<svg />} color="var(--palette-blue)" count={21} share={0.4667} active={false} onClick={onClick} />);
    const card = screen.getByRole("button", { name: /Keller/ });
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(card).toHaveTextContent("Status: 21");
    expect(card).toHaveAttribute("title", "Keller: 21 Packungen");
    expect(card.querySelector(".fill")).toHaveStyle({ width: "47%" });
    await userEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<FilterCard label="Keller" icon={<svg />} color="var(--palette-blue)" count={0} share={0} active onClick={onClick} />);
    expect(screen.getByRole("button", { name: /Keller/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Keller/ })).toHaveClass("active");
    // leere Zone: kein Balken
    expect(screen.getByRole("button", { name: /Keller/ }).querySelector(".fill")).toBeNull();

    // genau eine: Einzahl, für Screenreader und Tooltip
    rerender(<FilterCard label="Keller" icon={<svg />} color="var(--palette-blue)" count={1} share={0.1} active={false} onClick={onClick} />);
    expect(screen.getByRole("button", { name: /Keller/ })).toHaveAttribute("title", "Keller: 1 Packung");
    expect(screen.getByRole("button", { name: /Keller/ })).toHaveTextContent("Status: 1 Packung");
    expect(screen.getByRole("button", { name: /Keller/ })).not.toHaveTextContent("Packungen");
  });

  it("ExpiryLabel setzt die Warnstufen ab", () => {
    const { rerender, container } = render(<ExpiryLabel date="2026-11-10" state="expired" days={-3} detail />);
    expect(container).toHaveTextContent("10.11.2026");
    expect(container).toHaveTextContent("seit 3 Tagen abgelaufen");
    expect(container.firstElementChild).toHaveClass("expired");

    rerender(<ExpiryLabel date="2026-11-22" state="soon" days={9} />);
    expect(container.firstElementChild).toHaveClass("soon");
    expect(container).toHaveTextContent("läuft bald ab");

    rerender(<ExpiryLabel date={null} state="none" days={null} />);
    expect(container).toHaveTextContent("–kein MHD");
    rerender(<ExpiryLabel date={null} state="none" days={null} emptyText="ohne MHD" />);
    expect(container).toHaveTextContent("ohne MHD");
  });

  it("ZoneLabel und PackageIds kommen mit Lücken zurecht", () => {
    const { container, rerender } = render(<ZoneLabel zone={undefined} />);
    expect(container).toHaveTextContent("Unbekannte Zone");
    rerender(<ZoneLabel zone={{ name: "Keller", icon: "gibt-es-nicht", color: "blue" }} />);
    expect(container).toHaveTextContent("Keller");

    rerender(<PackageIds ids={["A2B3C", "B7K9M", "C1C1C"]} max={2} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["A2B3C", "B7K9M", "+ 1"]);
  });

  it("EmptyState trägt den Titel als Überschrift, auf Wunsch als die der ganzen Ansicht", () => {
    const { rerender } = render(
      <EmptyState title="Noch nichts eingelagert" actions={<button type="button">Einlagern</button>}>
        Hier erscheint der Bestand.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "Noch nichts eingelagert", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("Hier erscheint der Bestand.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Einlagern" })).toBeInTheDocument();

    rerender(<EmptyState pageTitle title="Seite nicht gefunden" />);
    expect(screen.getByRole("heading", { name: "Seite nicht gefunden", level: 1 })).toBeInTheDocument();
  });

  it("TextLink ist ein Verweis im Fließtext und führt zur genannten Ansicht", async () => {
    const { router } = renderInRouter(
      <p>
        Gewarnt wird 14 Tage vor dem MHD. <TextLink to="/einstellungen">Vorlaufzeit ändern</TextLink>
      </p>,
      [{ path: "/einstellungen", element: <h1>Einstellungen</h1> }],
    );
    const link = screen.getByRole("link", { name: "Vorlaufzeit ändern" });
    expect(link).toHaveAttribute("href", "/einstellungen");
    expect(link).toHaveClass("link");
    await userEvent.click(link);
    expect(router.state.location.pathname).toBe("/einstellungen");
    expect(await screen.findByRole("heading", { name: "Einstellungen" })).toBeInTheDocument();
  });
});

describe("Hooks", () => {
  it("useMediaQuery folgt der Breite des Fensters", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 64rem)"));
    expect(result.current).toBe(true);
    act(() => setTestViewport(375));
    expect(result.current).toBe(false);
    act(() => setTestViewport(1024));
    expect(result.current).toBe(true);
  });

  it("useUiFlag merkt sich Ansichts-Vorlieben unter stowly.ui.*", () => {
    const { result, unmount } = renderHook(() => useUiFlag("test.flag", false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("stowly.ui.test.flag")).toBe("1");
    unmount();

    const again = renderHook(() => useUiFlag("test.flag", false));
    expect(again.result.current[0]).toBe(true);
  });

  it("useProgressiveCount zeichnet lange Listen in Abschnitten und beginnt bei neuem Schlüssel wieder vorn", async () => {
    const total = LIST_FIRST + 2 * LIST_STEP + 10;
    const seen: number[] = [];
    const { result, rerender } = renderHook(
      ({ total, key }) => {
        const count = useProgressiveCount(total, key);
        seen.push(count);
        return count;
      },
      { initialProps: { total, key: "a" } },
    );
    expect(result.current).toBe(LIST_FIRST);
    await waitFor(() => expect(result.current).toBe(total));
    // Abschnitt für Abschnitt, nie mehr als LIST_STEP auf einmal.
    const steps = seen.filter((count, index) => index === 0 || count !== seen[index - 1]);
    expect(steps).toEqual([LIST_FIRST, LIST_FIRST + LIST_STEP, LIST_FIRST + 2 * LIST_STEP, total]);
    // Neue Auswahl (Suche, Filter, Reihenfolge): sofort wieder nur der Anfang, der Rest folgt.
    rerender({ total, key: "b" });
    expect(result.current).toBe(LIST_FIRST);
    await waitFor(() => expect(result.current).toBe(total));
    // Kurze Listen stehen sofort ganz da.
    rerender({ total: 5, key: "c" });
    expect(result.current).toBe(5);
  });
});
