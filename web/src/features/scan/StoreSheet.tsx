import { useState, type FormEvent } from "react";

import { formatDate, isPlaceholder, parseBestBefore, productSubtitle, productTitle, todayLocal, willLookUp, type Product } from "@/contract";
import { Button, Dialog, dialogFocusAlways, TextField } from "@/ui/base";

import { QuantityStepper } from "./QuantityStepper";
import styles from "./ScanPage.module.css";
import { STORE_HINTS } from "./texts";

export interface StoreRequest {
  barcode: string;
  /** Das Produkt zum Barcode, wenn die lokale Kopie es kennt. */
  product: Product | undefined;
}

export interface StoreDecision {
  /** MHD "YYYY-MM-DD" oder null = keines. */
  best_before: string | null;
  /** Von Hand eingetragener Name; leer = keiner. */
  name: string;
}

export interface StoreSheetProps {
  /** Der gescannte Barcode; null = geschlossen. */
  request: StoreRequest | null;
  quantity: number;
  onQuantity: (value: number) => void;
  /** Name der Zone, in die eingelagert wird; null, wenn es nur eine Zone gibt. */
  zoneName: string | null;
  /** Schlägt der Server Barcodes nach (`sync.status.lookup_enabled`)? null = noch unbekannt. */
  lookupEnabled: boolean | null;
  busy: boolean;
  onConfirm: (decision: StoreDecision) => void;
  onCancel: () => void;
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Liest die Eingabe; ein Komma der Zifferntastatur zählt als Punkt. */
function readBestBefore(input: string, today: string) {
  return parseBestBefore(input.replace(/,/g, "."), today);
}

/** Zeigt beim Tippen, welches Datum verstanden wurde. */
function understood(input: string, today: string): { text: string; valid: boolean } {
  if (input.trim() === "") {
    return { text: "Tag, Monat, Jahr als Ziffern (250327) oder nur Monat und Jahr (0327).", valid: false };
  }
  const parsed = readBestBefore(input, today);
  if (!parsed) {
    return { text: "Noch kein gültiges Datum.", valid: false };
  }
  const month = MONTHS[Number(parsed.date.slice(5, 7)) - 1] ?? "";
  const ending = parsed.precision === "month" ? ` (Ende ${month} ${parsed.date.slice(0, 4)})` : "";
  const past = parsed.date < today ? " – liegt in der Vergangenheit" : "";
  return { text: `Verstanden: ${formatDate(parsed.date)}${ending}${past}`, valid: true };
}

/**
 * Das Einlagern nach einem Produkt-Barcode: MHD schnell eingeben (oder „kein MHD"), Menge
 * prüfen, bei unbekannten Produkten auf Wunsch gleich den Namen eintragen.
 */
export function StoreSheet({ request, quantity, onQuantity, zoneName, lookupEnabled, busy, onConfirm, onCancel }: StoreSheetProps) {
  return (
    <Dialog open={request !== null} onClose={onCancel} title="Einlagern" variant="sheet" size="sm">
      {request ? (
        <StoreForm key={request.barcode} request={request} quantity={quantity} onQuantity={onQuantity} zoneName={zoneName} lookupEnabled={lookupEnabled} busy={busy} onConfirm={onConfirm} />
      ) : null}
    </Dialog>
  );
}

function StoreForm({ request, quantity, onQuantity, zoneName, lookupEnabled, busy, onConfirm }: Omit<StoreSheetProps, "request" | "onCancel"> & { request: StoreRequest }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const today = todayLocal();
  const feedback = understood(date, today);
  const known = request.product !== undefined && !isPlaceholder(request.product);
  const subtitle = productSubtitle(request.product);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = readBestBefore(date, today);
    if (parsed) {
      onConfirm({ best_before: parsed.date, name });
    }
  }

  return (
    <form className={styles.store} onSubmit={submit} noValidate>
      <div className={styles.storeProduct}>
        <p className={styles.storeTitle}>{known ? productTitle(request.product) : "Neues Produkt"}</p>
        <p className={styles.storeMeta}>
          {known && subtitle !== "" ? `${subtitle} · ` : ""}
          Barcode {request.barcode}
          {zoneName !== null ? ` · nach ${zoneName}` : ""}
        </p>
        {/* Dass Name und Bild nachkommen, steht hier nur, wenn es stimmt (docs/sync-protokoll.md, Abschnitt 10). */}
        {known ? null : <p className={styles.storeMeta}>{willLookUp(request.barcode, lookupEnabled) ? STORE_HINTS.lookup : STORE_HINTS.manual}</p>}
      </div>

      {known ? null : (
        <TextField label="Name (freiwillig)" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="off" placeholder="z. B. Basmati Reis" />
      )}

      <TextField
        label="Mindesthaltbarkeitsdatum"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        placeholder="TTMMJJ"
        hint={feedback.valid || date.trim() === "" ? feedback.text : undefined}
        error={!feedback.valid && date.trim() !== "" ? feedback.text : null}
        ref={dialogFocusAlways}
      />

      <div className={styles.storeQuantity}>
        <span className={styles.storeLabel}>Menge</span>
        <QuantityStepper value={quantity} onChange={onQuantity} />
      </div>

      <div className={styles.storeActions}>
        <Button size="lg" disabled={busy} onClick={() => onConfirm({ best_before: null, name })}>
          Kein MHD
        </Button>
        <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!feedback.valid}>
          Einlagern
        </Button>
      </div>
    </form>
  );
}
