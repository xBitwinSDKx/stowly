/**
 * Die Nahtstelle der Scan-Ansicht (index.tsx): Die Ansicht wird erst beim Aufruf nachgeladen,
 * das Entsperren des Tons hängt dagegen schon am Hauptpaket.
 */
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { CoreProvider, ROUTES } from "@/contract";
import { createMockCore } from "@/mock";
import { ToastProvider } from "@/ui/base";

import { ScanPage } from ".";

describe("Scan-Ansicht nachladen", () => {
  it("entsperrt den Ton mit der ersten Berührung, auch bevor die Ansicht geladen ist", () => {
    const contexts: { resumed: number }[] = [];
    class FakeAudioContext {
      state = "suspended";
      resumed = 0;
      constructor() {
        contexts.push(this);
      }
      resume() {
        this.resumed += 1;
        this.state = "running";
        return Promise.resolve();
      }
      suspend() {
        this.state = "suspended";
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    try {
      document.dispatchEvent(new Event("pointerdown"));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.resumed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("zeigt eine Ladeanzeige, bis die Ansicht da ist, und danach sofort die Ansicht", async () => {
    const core = createMockCore({ latency: 0 });
    const renderScan = () => {
      const router = createMemoryRouter([{ path: ROUTES.scan, element: <ScanPage /> }], { initialEntries: [ROUTES.scan] });
      return render(
        <CoreProvider core={core}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </CoreProvider>,
      );
    };
    const first = renderScan();
    expect(screen.getByRole("status", { name: "Die Scan-Ansicht wird geladen" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Scannen" })).toBeInTheDocument();
    first.unmount();

    // Einmal geladen, zeichnet sie ohne Umweg.
    renderScan();
    expect(screen.getByRole("heading", { name: "Scannen" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Die Scan-Ansicht wird geladen" })).not.toBeInTheDocument();
    await expect(ScanPage.preload()).resolves.toBeUndefined();
  });
});
