import { useState, type FormEvent } from "react";

import { formatDate, isPlaceholder, parseBestBefore, productSubtitle, productTitle, todayLocal, willLookUp, type Product, type ProductLookup } from "@/contract";
import { Button, Dialog, dialogFocusAlways, TextField } from "@/ui/base";

import { QuantityStepper } from "./QuantityStepper";
import styles from "./ScanPage.module.css";
import { STORE_HINTS } from "./texts";

export interface StoreRequest {
  barcode: string;
  /** Das Produkt zum Barcode, wenn die lokale Kopie es kennt. */
  product: Product | undefined;
}

/**
 * Was das Nachschlagen beim Scannen ergeben hat (`products.lookup`): "loading", solange es läuft.
 * null heißt: Es wird nicht nachgeschlagen (bekanntes Produkt, ladeninterner Code, Nachschlagen
 * am Server aus, Server nicht erreichbar).
 */
export type StoreLookup = { state: "loading" } | ProductLookup;

export interface StoreDecision {
  /** MHD "YYYY-MM-DD" oder null = keines. */
  best_before: string | null;
  /** Name für ein neues Produkt: von Hand eingetragen oder nachgeschlagen; leer = keiner. */
  name: string;
  /** Marke und Packungsgröße aus dem Nachschlagen; leer = keine. */
  brand: string;
  quantity: string;
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
  /** Was das Nachschlagen beim Scannen ergeben hat; null = nichts nachgeschlagen. */
  lookup: StoreLookup | null;
  /** Adresse eines Produktbilds (`data.imageUrl`). */
  imageUrl: (image: string) => string;
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
 * prüfen, bei unbekannten Produkten auf Wunsch gleich den Namen eintragen. Den schlägt die App
 * beim Scannen nach, wo das geht; einlagern lässt sich trotzdem sofort.
 */
export function StoreSheet({ request, onCancel, ...rest }: StoreSheetProps) {
  // Während des Einlagerns (`busy`) schließt das Blatt nicht: ✕ gesperrt, Escape und Tippen daneben ohne Wirkung.
  return (
    <Dialog open={request !== null} onClose={onCancel} title="Einlagern" variant="sheet" size="sm" busy={rest.busy}>
      {request ? <StoreForm key={request.barcode} request={request} {...rest} /> : null}
    </Dialog>
  );
}

function StoreForm({ request, quantity, onQuantity, zoneName, lookupEnabled, lookup, imageUrl, busy, onConfirm }: Omit<StoreSheetProps, "request" | "onCancel"> & { request: StoreRequest }) {
  const [date, setDate] = useState("");
  /** Was der Anwender ins Namensfeld geschrieben hat; null = noch nichts. */
  const [typedName, setTypedName] = useState<string | null>(null);
  /** Welcher Knopf das Einlagern ausgelöst hat: Er zeigt, dass es läuft. */
  const [pressed, setPressed] = useState<"no_date" | "store">("store");
  const today = todayLocal();
  const feedback = understood(date, today);
  const known = request.product !== undefined && !isPlaceholder(request.product);
  const subtitle = productSubtitle(request.product);
  const found = lookup?.state === "found" && lookup.barcode === request.barcode ? lookup : null;
  // Ein gefundener Name steht im Feld, solange der Anwender nichts eingetragen hat.
  const name = typedName ?? found?.name ?? "";
  const details = found ? [found.brand, found.quantity].filter((part) => part !== "").join(" · ") : "";

  function decision(bestBefore: string | null): StoreDecision {
    return { best_before: bestBefore, name, brand: found?.brand ?? "", quantity: found?.quantity ?? "" };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = readBestBefore(date, today);
    if (parsed && !busy) {
      setPressed("store");
      onConfirm(decision(parsed.date));
    }
  }

  function withoutDate() {
    setPressed("no_date");
    onConfirm(decision(null));
  }

  /** Was unter dem Titel über Name und Bild steht (docs/sync-protokoll.md, Abschnitt 10). */
  function lookupHint(): string {
    if (lookup?.state === "loading") {
      return STORE_HINTS.looking;
    }
    if (lookup?.state === "not_found") {
      return STORE_HINTS.not_found;
    }
    // Wartend, ausgelassen, abgeschaltet, nicht erreichbar: wie bisher.
    return willLookUp(request.barcode, lookupEnabled) ? STORE_HINTS.lookup : STORE_HINTS.manual;
  }

  return (
    <form className={styles.store} onSubmit={submit} noValidate>
      <div className={styles.storeHead}>
        {found?.image_id ? <img className={styles.storeImage} src={imageUrl(found.image_id)} alt="" /> : null}
        <div className={styles.storeProduct}>
          <p className={styles.storeTitle}>{known ? productTitle(request.product) : "Neues Produkt"}</p>
          <p className={styles.storeMeta}>
            {known && subtitle !== "" ? `${subtitle} · ` : ""}
            Barcode {request.barcode}
            {zoneName !== null ? ` · nach ${zoneName}` : ""}
          </p>
          {/* Dass Name und Bild nachkommen, steht hier nur, wenn es stimmt (docs/sync-protokoll.md, Abschnitt 10). */}
          {known ? null : found ? (
            <p className={styles.storeMeta}>{details !== "" ? `${details} · ${STORE_HINTS.source}` : STORE_HINTS.source}</p>
          ) : (
            <p className={styles.storeMeta} aria-live="polite">
              {lookupHint()}
            </p>
          )}
        </div>
      </div>

      {known ? null : (
        <TextField
          label="Name (freiwillig)"
          value={name}
          onChange={(event) => setTypedName(event.target.value)}
          maxLength={120}
          autoComplete="off"
          placeholder={lookup?.state === "loading" ? STORE_HINTS.looking_placeholder : "z. B. Basmati Reis"}
        />
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

      {/* Der gedrückte Knopf zeigt, dass eingelagert wird; der andere ist solange gesperrt. */}
      <div className={styles.storeActions}>
        <Button size="lg" busy={busy && pressed === "no_date"} disabled={busy} onClick={withoutDate}>
          Kein MHD
        </Button>
        <Button type="submit" variant="primary" size="lg" busy={busy && pressed === "store"} disabled={busy || !feedback.valid}>
          Einlagern
        </Button>
      </div>
    </form>
  );
}
