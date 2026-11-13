import { useCallback, useState, type ReactNode } from "react";

import type { RemovalReason } from "@/contract";

import { LabelsDialog } from "./LabelsDialog";
import { PackagesDialog } from "./PackagesDialog";
import { ProductDialog } from "./ProductDialog";
import { RemoveDialog } from "./RemoveDialog";
import { StoreDialog } from "./StoreDialog";
import type { StockData } from "./useStock";

/** Was sich rund um den Bestand in einem Dialog erledigen lässt. */
export type StockDialogRequest =
  /** Produkt bearbeiten: Name, Marke, Packungsgröße, Vorlaufzeit, Barcodes. */
  | { kind: "product"; product_id: string }
  /** MHD und Zone einer Charge oder einzelner Packungen ändern. */
  | { kind: "packages"; package_ids: readonly string[] }
  /** Entnehmen oder löschen. */
  | { kind: "remove"; package_ids: readonly string[]; selection?: "all" | "none"; reason?: RemovalReason }
  /** Von Hand einlagern. */
  | { kind: "store"; product_id?: string; zone_id?: string | null }
  /** Nachdruck: für eine oder mehrere Packungen ein neues Etikett anfordern. */
  | { kind: "labels"; package_ids: readonly string[] };

export interface StockDialogs {
  open: (request: StockDialogRequest) => void;
  /** Der gerade offene Dialog; gehört einmal in die Ansicht. */
  element: ReactNode;
}

/**
 * Die Dialoge des Bestands für eine Ansicht (Bestand, Warnungen), samt Nachdruck der Etiketten:
 *
 *   const dialogs = useStockDialogs(stock);
 *   <Button onClick={() => dialogs.open({ kind: "store" })}>…</Button>
 *   {dialogs.element}
 *
 * Ein Dialog wird nur gerendert, solange er offen ist: Seine Eingaben beginnen jedes Mal frisch.
 */
export function useStockDialogs(stock: StockData): StockDialogs {
  const [request, setRequest] = useState<StockDialogRequest | null>(null);
  const [serial, setSerial] = useState(0);
  const close = useCallback(() => setRequest(null), []);
  const open = useCallback((next: StockDialogRequest) => {
    setRequest(next);
    setSerial((current) => current + 1);
  }, []);

  let element: ReactNode = null;
  if (request?.kind === "product") {
    element = <ProductDialog key={serial} stock={stock} productId={request.product_id} onClose={close} />;
  } else if (request?.kind === "packages") {
    element = <PackagesDialog key={serial} stock={stock} packageIds={request.package_ids} onClose={close} />;
  } else if (request?.kind === "remove") {
    element = (
      <RemoveDialog
        key={serial}
        stock={stock}
        packageIds={request.package_ids}
        initialSelection={request.selection}
        initialReason={request.reason}
        onClose={close}
      />
    );
  } else if (request?.kind === "store") {
    element = <StoreDialog key={serial} stock={stock} productId={request.product_id} zoneId={request.zone_id} onClose={close} />;
  } else if (request?.kind === "labels") {
    element = <LabelsDialog key={serial} stock={stock} packageIds={request.package_ids} onClose={close} />;
  }

  return { open, element };
}
