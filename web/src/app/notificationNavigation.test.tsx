/**
 * Tipp auf eine Mitteilung bei offener App: Der Service Worker schickt das Ziel als Nachricht,
 * die App wechselt die Ansicht ohne Neuladen (docs/integrationen.md, 4.5).
 */
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NAVIGATE_MESSAGE } from "@/contract";

import { renderApp } from "./render.test-setup";

/** Nachgebildeter `navigator.serviceWorker`: nur Nachrichten. */
class FakeContainer extends EventTarget {
  started = 0;
  startMessages() {
    this.started += 1;
  }
  send(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

afterEach(() => {
  if (original) {
    Object.defineProperty(navigator, "serviceWorker", original);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

function install(): FakeContainer {
  const container = new FakeContainer();
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return container;
}

describe("Tipp auf eine Mitteilung bei offener App", () => {
  it("wechselt zur Ansicht aus der Nachricht des Service Workers", async () => {
    const container = install();
    renderApp();
    await screen.findByRole("heading", { name: "Bestand", level: 1 });
    expect(container.started).toBeGreaterThan(0);

    act(() => container.send({ type: NAVIGATE_MESSAGE, url: `${window.location.origin}/warnungen` }));
    expect(await screen.findByRole("heading", { name: "Warnungen", level: 1 })).toBeInTheDocument();
  });

  it("übergeht fremde Ziele und andere Nachrichten", async () => {
    const container = install();
    renderApp();
    await screen.findByRole("heading", { name: "Bestand", level: 1 });

    act(() => {
      container.send({ type: NAVIGATE_MESSAGE, url: "https://example.org/warnungen" });
      container.send({ type: "SKIP_WAITING" });
      container.send("stowly:navigate");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { name: "Bestand", level: 1 })).toBeInTheDocument();
  });
});
