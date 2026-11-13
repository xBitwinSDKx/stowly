/**
 * Anmeldung: Vorschlag für den Gerätenamen, Meldungen zu jedem Fehler, Wartezeit.
 */
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { MOCK_PASSWORD } from "@/mock";
import { setTestViewport } from "@/ui/testing";

import { loginErrorText, suggestDeviceName, waitText } from ".";

afterEach(() => {
  vi.useRealTimers();
});

async function submit(password = MOCK_PASSWORD): Promise<void> {
  await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), password);
  await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
}

describe("Vorschlag für den Gerätenamen", () => {
  it("richtet sich nach Bedienung und Bildschirmgröße und bleibt neutral", () => {
    setTestViewport(1280);
    expect(suggestDeviceName()).toBe("Rechner");
    setTestViewport(375);
    expect(suggestDeviceName()).toBe("Handy");
    setTestViewport(1024, true);
    expect(suggestDeviceName()).toBe("Tablet");
  });
});

describe("waitText", () => {
  it("nennt Sekunden und Minuten", () => {
    expect(waitText(0.2)).toBe("1 Sekunde");
    expect(waitText(42)).toBe("42 Sekunden");
    expect(waitText(60)).toBe("1 Minute");
    expect(waitText(61)).toBe("2 Minuten");
    expect(waitText(300)).toBe("5 Minuten");
  });
});

describe("loginErrorText", () => {
  it("hat für jeden Fehler der Anmeldung einen eigenen Satz", () => {
    expect(loginErrorText(new CoreError("invalid_password"))).toBe("Das Passwort stimmt nicht.");
    expect(loginErrorText(new CoreError("not_configured"))).toContain("noch kein Haushalts-Passwort gesetzt");
    expect(loginErrorText(new CoreError("offline"))).toContain("Der Server ist nicht erreichbar.");
    expect(loginErrorText(new CoreError("protocol_mismatch"))).toContain("passt nicht zum Server");
    expect(loginErrorText(new CoreError("invalid"))).toContain("Bitte das Passwort und einen Namen");
    expect(loginErrorText(new Error("kaputt"))).toBe("Die Anmeldung ist fehlgeschlagen. Bitte noch einmal versuchen.");
  });
});

describe("Anmeldung", () => {
  it("verlangt Passwort und Gerätenamen, bevor sie den Kern fragt", async () => {
    const core = renderApp({ scenarios: ["signed-out"] });
    const login = vi.spyOn(core.session, "login");

    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte das Haushalts-Passwort eingeben.");

    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), "x");
    await userEvent.clear(screen.getByLabelText("Name dieses Geräts"));
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte diesem Gerät einen Namen geben.");
    expect(login).not.toHaveBeenCalled();
  });

  it("zeigt das Passwort auf Wunsch im Klartext", async () => {
    renderApp({ scenarios: ["signed-out"] });
    const password = screen.getByLabelText("Haushalts-Passwort");
    expect(password).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Passwort anzeigen" }));
    expect(password).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "Passwort verbergen" }));
    expect(password).toHaveAttribute("type", "password");
  });

  it("meldet mit dem vorgeschlagenen Gerätenamen an", async () => {
    const core = renderApp({ scenarios: ["signed-out"] });
    await submit();
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(core.session.state.get()).toMatchObject({ status: "signed_in", device: { name: "Rechner" } });
  });

  it("sagt, wenn der Server nicht erreichbar ist", async () => {
    renderApp({ scenarios: ["signed-out", "offline"] });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Server ist nicht erreichbar. Zum Anmelden braucht es eine Verbindung zum Server.");
  });

  it.each([
    ["not_configured", "Auf dem Server ist noch kein Haushalts-Passwort gesetzt."],
    ["protocol_mismatch", "Diese Version der App passt nicht zum Server."],
  ] as const)("erklärt %s", async (code, text) => {
    const core = renderApp({ scenarios: ["signed-out"] });
    vi.spyOn(core.session, "login").mockRejectedValue(new CoreError(code));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("nennt nach zu vielen Fehlversuchen die Wartezeit und sperrt die Schaltfläche so lange", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const core = renderApp({ scenarios: ["signed-out"] });
    vi.spyOn(core.session, "login").mockRejectedValueOnce(new CoreError("rate_limited", "Zu viele Fehlversuche.", { retry_after_s: 42 }));

    await user.type(screen.getByLabelText("Haushalts-Passwort"), "falsch");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Zu viele Fehlversuche");
    expect(screen.getByRole("alert")).toHaveTextContent("Nächster Versuch in 42 Sekunden.");
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Nächster Versuch in 12 Sekunden.");

    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Anmelden" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("weist auf die Folgen einer http-Adresse hin", () => {
    renderApp({ scenarios: ["signed-out", "insecure"] });
    expect(screen.getByText("Kein Scannen über diese Adresse")).toBeInTheDocument();
  });

  it("bestätigt das Abmelden", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await act(async () => {
      await core.session.logout();
    });
    expect(await screen.findByText("Abgemeldet")).toBeInTheDocument();
    expect(screen.getByText("Die lokale Kopie der Daten wurde von diesem Gerät gelöscht.")).toBeInTheDocument();
  });
});
