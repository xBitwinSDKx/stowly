/**
 * Die App als Ganzes auf der Attrappe: Anmeldung, Rahmen, Navigation.
 * Zeigt zugleich, wie sich Ansichten mit `createMockCore` testen lassen.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "@/contract";
import { createMockCore, MOCK_PASSWORD, MockScanPage, type MockOptions } from "@/mock";

import { App } from "./App";

function renderApp(options: MockOptions = {}, path: string = ROUTES.stock) {
  window.history.replaceState(null, "", path);
  const core = createMockCore({ latency: 0, ...options });
  render(<App core={core} scanPage={MockScanPage} />);
  return core;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("App", () => {
  it("zeigt angemeldeten Geräten den Bestand im Rahmen", async () => {
    const core = renderApp();
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(screen.getByText("Packungen gesamt").nextElementSibling).toHaveTextContent(String(core.data.packages.get()?.length));
    expect(screen.getByRole("cell", { name: "Basmati Reis" })).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Hauptnavigation" }).length).toBeGreaterThan(0);
  });

  it("wechselt über die Navigation die Ansicht", async () => {
    renderApp();
    const [navigation] = await screen.findAllByRole("navigation", { name: "Hauptnavigation" });
    if (!navigation) {
      throw new Error("Navigation fehlt");
    }
    await userEvent.click(within(navigation).getByRole("link", { name: "Zonen" }));
    expect(await screen.findByRole("heading", { name: "Zonen" })).toBeInTheDocument();
    expect(screen.getByText("Gefrierschrank")).toBeInTheDocument();
    expect(window.location.pathname).toBe(ROUTES.zones);
  });

  it("öffnet die Scan-Ansicht ohne Rahmen", async () => {
    renderApp({}, ROUTES.scan);
    expect(await screen.findByRole("heading", { name: "Scannen" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).not.toBeInTheDocument();
  });

  it("führt nicht angemeldete Geräte zur Anmeldung", async () => {
    renderApp({ scenarios: ["signed-out"] });
    expect(screen.queryByRole("heading", { name: "Bestand" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), "falsch");
    await userEvent.type(screen.getByLabelText("Name dieses Geräts"), "Handy Küche");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Passwort stimmt nicht.");

    await userEvent.clear(screen.getByLabelText("Haushalts-Passwort"));
    await userEvent.type(screen.getByLabelText("Haushalts-Passwort"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("heading", { name: "Bestand" })).toBeInTheDocument();
    expect(screen.getByText("Handy Küche")).toBeInTheDocument();
  });

  it("zeigt Änderungen des Kerns sofort an", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const total = () => screen.getByText("Packungen gesamt").nextElementSibling?.textContent;
    const before = Number(total());

    const product = core.data.products.get()?.[0];
    const zone = core.data.zones.get()?.[0];
    await core.stock.store({ product: { kind: "existing", product_id: product?.id ?? "" }, zone_id: zone?.id ?? "", best_before: null, count: 3 });
    expect(await screen.findByText(String(before + 3))).toBeInTheDocument();
  });

  it("blendet den Scan-Knopf aus, wo der Browser kein Scannen erlaubt", async () => {
    renderApp({ scenarios: ["insecure"] });
    await screen.findByRole("heading", { name: "Bestand" });
    // der schwebende Knopf des Rahmens
    expect(document.querySelector('button[aria-label="Jetzt scannen"]')).toBeNull();
  });
});
