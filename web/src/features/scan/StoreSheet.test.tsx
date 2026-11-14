/**
 * Der Dialog zum Einlagern für sich: was er zeigt, was er vom Nachschlagen übernimmt und welcher
 * Knopf arbeitet.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProductLookup } from "@/contract";
import { sampleBarcode } from "@/mock";
// Die Prüfungen toBeUnavailable() und toBeAvailable() für Schaltflächen.
import "@/ui/base/testing";

import { StoreSheet, type StoreLookup, type StoreSheetProps } from "./StoreSheet";

const BARCODE = sampleBarcode(901);

function props(overrides: Partial<StoreSheetProps> = {}): StoreSheetProps {
  return {
    request: { barcode: BARCODE, product: undefined },
    quantity: 1,
    onQuantity: () => undefined,
    zoneName: null,
    lookupEnabled: true,
    lookup: null,
    imageUrl: (image) => `/api/images/${image}`,
    busy: false,
    onConfirm: () => undefined,
    onCancel: () => undefined,
    ...overrides,
  };
}

function answer(state: ProductLookup["state"], found: Partial<ProductLookup> = {}): StoreLookup {
  return { barcode: BARCODE, state, name: "", brand: "", quantity: "", image_id: null, ...found };
}

describe("Knöpfe", () => {
  it("zeigt den Spinner an dem Knopf, der gedrückt wurde, und sperrt den anderen", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(<StoreSheet {...props({ onConfirm })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });

    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    expect(onConfirm).toHaveBeenCalledWith({ best_before: null, name: "", brand: "", quantity: "" });
    rerender(<StoreSheet {...props({ onConfirm, busy: true })} />);
    const noDate = within(dialog).getByRole("button", { name: "Kein MHD" });
    const store = within(dialog).getByRole("button", { name: "Einlagern" });
    expect(noDate).toHaveAttribute("aria-busy", "true");
    expect(store).not.toHaveAttribute("aria-busy");
    expect(noDate).toBeUnavailable();
    expect(store).toBeUnavailable();

    // Mit Datum und „Einlagern“ arbeitet „Einlagern“.
    rerender(<StoreSheet {...props({ onConfirm, busy: false })} />);
    await user.type(within(dialog).getByLabelText("Mindesthaltbarkeitsdatum"), "250327");
    await user.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    expect(onConfirm).toHaveBeenLastCalledWith({ best_before: "2027-03-25", name: "", brand: "", quantity: "" });
    rerender(<StoreSheet {...props({ onConfirm, busy: true })} />);
    expect(within(dialog).getByRole("button", { name: "Einlagern" })).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Kein MHD" })).not.toHaveAttribute("aria-busy");
    expect(within(dialog).getByRole("button", { name: "Kein MHD" })).toBeUnavailable();
  });

  it("schließt nicht, solange es einlagert: ✕ gesperrt, Escape ohne Wirkung", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { rerender } = render(<StoreSheet {...props({ onCancel, busy: true })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    const close = within(dialog).getByRole("button", { name: "Schließen" });
    expect(close).toHaveAttribute("aria-disabled", "true");
    await user.click(close);
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();

    // Fertig: Jetzt schließt das ✕ wieder.
    rerender(<StoreSheet {...props({ onCancel, busy: false })} />);
    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Nachschlagen beim Scannen", () => {
  it("sagt im Namensfeld, dass nachgeschlagen wird; einlagern geht trotzdem schon", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<StoreSheet {...props({ onConfirm, lookup: { state: "loading" } })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).getByLabelText("Name (freiwillig)")).toHaveAttribute("placeholder", "wird nachgeschlagen …");
    expect(within(dialog).getByText("Wird bei Open Food Facts nachgeschlagen …")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Kein MHD" })).toBeAvailable();
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    expect(onConfirm).toHaveBeenCalledWith({ best_before: null, name: "", brand: "", quantity: "" });
  });

  it("übernimmt einen gefundenen Namen samt Marke und Größe, zeigt Bild und Quelle", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const found = answer("found", { name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg", image_id: "abc.jpg" });
    const { rerender } = render(<StoreSheet {...props({ onConfirm, lookup: { state: "loading" } })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    rerender(<StoreSheet {...props({ onConfirm, lookup: found })} />);
    expect(within(dialog).getByLabelText("Name (freiwillig)")).toHaveValue("Basmati Reis");
    expect(within(dialog).getByText("Kornhaus · 1 kg · Von Open Food Facts (ODbL)")).toBeInTheDocument();
    expect(dialog.querySelector("img")).toHaveAttribute("src", "/api/images/abc.jpg");
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    expect(onConfirm).toHaveBeenCalledWith({ best_before: null, name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg" });
  });

  it("überschreibt nicht, was der Anwender schon eingetragen hat", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(<StoreSheet {...props({ onConfirm, lookup: { state: "loading" } })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await user.type(within(dialog).getByLabelText("Name (freiwillig)"), "Reis");
    rerender(<StoreSheet {...props({ onConfirm, lookup: answer("found", { name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg" }) })} />);
    expect(within(dialog).getByLabelText("Name (freiwillig)")).toHaveValue("Reis");
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    expect(onConfirm).toHaveBeenCalledWith({ best_before: null, name: "Reis", brand: "Kornhaus", quantity: "1 kg" });
  });

  it("sagt, wenn Open Food Facts den Barcode nicht kennt; sonst bleibt der bisherige Hinweis", async () => {
    const { rerender } = render(<StoreSheet {...props({ lookup: answer("not_found") })} />);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).getByText(/Open Food Facts kennt diesen Barcode nicht/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name (freiwillig)")).toHaveValue("");
    for (const state of ["pending", "offline", "failed", "disabled"] as const) {
      rerender(<StoreSheet {...props({ lookup: answer(state) })} />);
      expect(within(dialog).getByText(/Name und Bild ergänzt Stowly/)).toBeInTheDocument();
    }
    rerender(<StoreSheet {...props({ lookup: answer("disabled"), lookupEnabled: false })} />);
    expect(within(dialog).getByText(/schlägt Stowly nicht nach/)).toBeInTheDocument();
  });
});
