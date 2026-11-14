/**
 * Die Scan-Ansicht mit nachgebildetem Scanner (unter jsdom gibt es keine Kamera): was sie von
 * seinem Zustand zeigt und wann sie ihn anhält und weiterlaufen lässt.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { CoreProvider, ROUTES, type ScanResult } from "@/contract";
import type { ScannerOptions, ScannerState } from "@/core/scanner";
import { createMockCore, sampleBarcode } from "@/mock";
import { ToastProvider } from "@/ui/base";

import { ScanPage } from "./ScanPage";

const NOW = new Date("2026-11-13T10:00:00.000Z");

/** Ein Scanner ohne Kamera: Der Test setzt seinen Zustand und meldet Codes. */
const scanners = vi.hoisted(() => [] as { calls: string[]; set(changes: Partial<ScannerState>): void; scan(result: ScanResult): void }[]);

vi.mock("@/core/scanner", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/scanner")>();
  class FakeScanner {
    readonly calls: string[] = [];
    private value: ScannerState = {
      status: "running",
      error: null,
      engine: "worker",
      cameraId: "cam",
      cameras: [],
      torch: { available: false, on: false },
      zoom: null,
      wake_lock: false,
      too_small: false,
      rescan: false,
    };
    private readonly listeners = new Set<() => void>();
    readonly state = {
      get: () => this.value,
      subscribe: (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    constructor(private readonly options: ScannerOptions) {
      scanners.push(this);
    }

    set(changes: Partial<ScannerState>): void {
      this.value = { ...this.value, ...changes };
      for (const listener of [...this.listeners]) {
        listener();
      }
    }

    scan(result: ScanResult): void {
      this.options.onScan(result);
    }

    async start(): Promise<void> {
      this.calls.push("start");
    }
    stop(): void {
      this.calls.push("stop");
    }
    dispose(): void {
      this.calls.push("dispose");
    }
    pause(): void {
      this.calls.push("pause");
    }
    resume(): void {
      this.calls.push("resume");
    }
    async switchCamera(): Promise<void> {}
    async setTorch(): Promise<void> {}
    async setZoom(): Promise<void> {}
  }
  return { ...original, Scanner: FakeScanner };
});

function setup() {
  const core = createMockCore({ latency: 0, now: () => NOW });
  const router = createMemoryRouter([{ path: ROUTES.scan, element: <ScanPage /> }], { initialEntries: [ROUTES.scan] });
  render(
    <CoreProvider core={core}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </CoreProvider>,
  );
  return { core, user: userEvent.setup() };
}

async function scanner() {
  await waitFor(() => expect(scanners.length).toBeGreaterThan(0));
  const current = scanners.at(-1);
  if (!current) {
    throw new Error("Kein Scanner");
  }
  return current;
}

describe("Nach dem Dialog zum Einlagern", () => {
  it("hält die Auswertung an, solange der Dialog offen ist, und lässt sie danach weiterlaufen", async () => {
    const { user } = setup();
    const fake = await scanner();
    act(() => fake.scan({ kind: "product", barcode: sampleBarcode(1) }));
    let dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await waitFor(() => expect(fake.calls.at(-1)).toBe("pause"));

    // Abbrechen: Es geht weiter.
    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    await waitFor(() => expect(fake.calls.at(-1)).toBe("resume"));

    // Einlagern: ebenso.
    act(() => fake.scan({ kind: "product", barcode: sampleBarcode(1) }));
    dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await waitFor(() => expect(fake.calls.at(-1)).toBe("pause"));
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    await waitFor(() => expect(fake.calls.at(-1)).toBe("resume"));
  });

  it("sagt, dass kurzes Wegschwenken genügt, solange der Barcode von eben noch im Bild ist", async () => {
    setup();
    const fake = await scanner();
    expect(await screen.findByText(/Barcode zum Einlagern/)).toBeInTheDocument();
    act(() => fake.set({ rescan: true }));
    expect(screen.getByText("Zum erneuten Scannen kurz wegschwenken")).toBeInTheDocument();
    expect(screen.queryByText(/Barcode zum Einlagern/)).not.toBeInTheDocument();
    act(() => fake.set({ rescan: false }));
    expect(screen.queryByText("Zum erneuten Scannen kurz wegschwenken")).not.toBeInTheDocument();
    expect(screen.getByText(/Barcode zum Einlagern/)).toBeInTheDocument();
  });
});
