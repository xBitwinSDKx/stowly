import { useId, useState, type FormEvent } from "react";

import {
  checkMinStock,
  isCoreError,
  isPlaceholder,
  isStoreInternalBarcode,
  LIMITS,
  normalizeBarcode,
  productTitle,
  useCore,
  type Product,
  type ProductChanges,
} from "@/contract";
import { ConfirmDialog, errorText, FieldGroup, focusFirstInvalid, Notice, packagesText } from "@/ui";
import { Button, Dialog, dialogFocus, IconButton, Spinner, TextField, useToast } from "@/ui/base";
import { BarcodeIcon, CloseIcon, InfoIcon, MergeIcon, PlusIcon } from "@/ui/icons";

import styles from "./dialogs.module.css";
import type { StockData } from "./useStock";

/** Der Mindestbestand als Text eines Eingabefelds: leer = keiner. */
export function minStockInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Liest das Feld „Mindestbestand": leer heißt keiner (null). Sonst eine ganze Zahl in den Grenzen
 * des Vertrags (`checkMinStock`); was nicht passt, liefert den Satz für die Anzeige.
 */
export function readMinStock(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { value: null, error: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error: `Bitte eine ganze Zahl von 1 bis ${String(LIMITS.min_stock)} eingeben oder das Feld leer lassen.` };
  }
  const value = Number(trimmed);
  try {
    checkMinStock(value);
  } catch (caught) {
    return { value: null, error: errorText(caught) };
  }
  return { value, error: null };
}

/**
 * Was der Mindestbestand bewirkt, als Hinweis am Feld. Er gilt je Produkt; wer „3 Milch, egal
 * welche Marke" will, führt die Produkte zusammen (Plan von Stufe 2, Entscheidung 1).
 * @param stock Packungen im Bestand; ohne Angabe fehlt der Satz dazu (neues Produkt)
 */
export function minStockHint(stock?: number): string {
  const current = stock === undefined ? "" : ` Im Bestand: ${packagesText(stock)}.`;
  return (
    `Leer = keiner. Liegen weniger Packungen im Bestand (abgelaufene zählen mit), setzt der Server das Produkt auf die Einkaufsliste.${current}` +
    " Der Wert gilt für dieses Produkt: Wer „3 Milch, egal welche Marke“ will, führt die Produkte zusammen; ein Produkt kann mehrere Barcodes haben."
  );
}

export interface ProductDialogProps {
  stock: StockData;
  productId: string;
  onClose: () => void;
}

/** Wo das Nachschlagen bei Open Food Facts für einen Platzhalter steht. */
export function lookupText(product: Pick<Product, "lookup" | "barcodes">): string {
  switch (product.lookup) {
    case "pending":
      return "Name und Bild werden bei Open Food Facts nachgeschlagen, sobald der Server erreichbar ist.";
    case "not_found":
      return "Open Food Facts kennt diesen Barcode nicht. Bitte den Namen von Hand eintragen.";
    case "found":
      return "Open Food Facts kennt den Barcode, aber keinen Namen dazu. Bitte den Namen von Hand eintragen.";
    case "none":
      return product.barcodes.some((code) => isStoreInternalBarcode(code))
        ? "Ladeninterne Barcodes (Präfix 2) werden nicht nachgeschlagen. Bitte den Namen von Hand eintragen."
        : "Dieses Produkt wird nicht nachgeschlagen. Bitte den Namen von Hand eintragen.";
  }
}

interface MergeOffer {
  barcode: string;
  /** Das Produkt, dem der Barcode schon gehört. Es ginge in diesem Produkt auf. */
  owner: Product;
}

/**
 * Produkt bearbeiten: Name, Marke, Packungsgröße, eigene Vorlaufzeit der MHD-Warnung,
 * Mindestbestand, Barcodes.
 *
 * Felder und Barcodes werden mit „Speichern" übernommen. Gehört ein Barcode schon zu einem
 * anderen Produkt, bietet der Dialog das Zusammenführen an; das geschieht nach einer
 * Rückfrage sofort, weil es sich nicht umkehren lässt.
 */
export function ProductDialog({ stock, productId, onClose }: ProductDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const product = stock.products.find((candidate) => candidate.id === productId);

  const [name, setName] = useState(product?.name ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [quantity, setQuantity] = useState(product?.quantity ?? "");
  const [warnDays, setWarnDays] = useState(product?.warn_days === null || product?.warn_days === undefined ? "" : String(product.warn_days));
  const [minStock, setMinStock] = useState(minStockInput(product?.min_stock));
  const [barcodes, setBarcodes] = useState<string[]>(product?.barcodes ?? []);
  const [newBarcode, setNewBarcode] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [offer, setOffer] = useState<MergeOffer | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!product) {
    return (
      <Dialog open onClose={onClose} title="Produkt bearbeiten" variant="sheet" footer={<Button onClick={onClose}>Schließen</Button>}>
        <p className={styles.muted}>Dieses Produkt gibt es nicht mehr. Vielleicht wurde es gerade mit einem anderen zusammengeführt.</p>
      </Dialog>
    );
  }
  const current = product;
  const placeholder = isPlaceholder(current);
  const householdDays = stock.settings?.warn_days;

  const trimmedName = name.trim();
  // Ein Platzhalter darf namenlos bleiben; ein benanntes Produkt nicht wieder namenlos werden.
  const nameError = !placeholder && trimmedName === "" ? "Bitte einen Namen eingeben." : null;
  const parsedDays = warnDays.trim() === "" ? null : Number(warnDays);
  const daysError =
    parsedDays !== null && (!/^\d+$/.test(warnDays.trim()) || parsedDays > 3650) ? "Bitte eine ganze Zahl von 0 bis 3650 eingeben oder das Feld leer lassen." : null;
  const parsedMin = readMinStock(minStock);
  const inStock = stock.entries.filter((entry) => entry.pkg.product_id === current.id).length;

  function ownerOf(barcode: string): Product | undefined {
    return stock.products.find((candidate) => candidate.id !== current.id && candidate.barcodes.includes(barcode));
  }

  function addBarcode() {
    const code = normalizeBarcode(newBarcode);
    setOffer(null);
    if (code === null) {
      setBarcodeError("Kein gültiger Barcode. Erwartet werden 8, 12 oder 13 Ziffern mit stimmender Prüfziffer.");
      return;
    }
    if (barcodes.includes(code)) {
      setBarcodeError("Dieser Barcode ist schon eingetragen.");
      return;
    }
    setBarcodeError(null);
    const owner = ownerOf(code);
    if (owner) {
      setOffer({ barcode: code, owner });
      return;
    }
    setBarcodes((list) => [...list, code].sort());
    setNewBarcode("");
  }

  async function merge() {
    if (!offer) {
      return;
    }
    await core.products.merge(offer.owner.id, current.id);
    // Die Barcodes des aufgegangenen Produkts gehören jetzt hierher.
    setBarcodes((list) => [...new Set([...list, ...offer.owner.barcodes, offer.barcode])].sort());
    toast.show({ message: `„${productTitle(offer.owner)}“ ist in „${productTitle(current)}“ aufgegangen`, tone: "success" });
    setOffer(null);
    setConfirmMerge(false);
    setNewBarcode("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (nameError || daysError || parsedMin.error) {
      focusFirstInvalid(formId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const changes: ProductChanges = {};
      if (trimmedName !== current.name.trim() && trimmedName !== "") {
        changes.name = trimmedName;
      }
      if (brand.trim() !== current.brand.trim()) {
        changes.brand = brand.trim();
      }
      if (quantity.trim() !== current.quantity.trim()) {
        changes.quantity = quantity.trim();
      }
      if (parsedDays !== current.warn_days) {
        changes.warn_days = parsedDays;
      }
      if (parsedMin.value !== current.min_stock) {
        // null entfernt den Mindestbestand.
        changes.min_stock = parsedMin.value;
      }
      if (Object.keys(changes).length > 0) {
        await core.products.update(current.id, changes);
      }
      for (const code of current.barcodes.filter((candidate) => !barcodes.includes(candidate))) {
        await core.products.removeBarcode(current.id, code);
      }
      for (const code of barcodes.filter((candidate) => !current.barcodes.includes(candidate))) {
        try {
          await core.products.addBarcode(current.id, code);
        } catch (caught) {
          if (!isCoreError(caught, "barcode_taken")) {
            throw caught;
          }
          // Der Kern kennt den Barcode inzwischen bei einem anderen Produkt: Zusammenführen anbieten.
          const ownerId = typeof caught.details.product_id === "string" ? caught.details.product_id : "";
          const owner = (await core.data.findProduct(ownerId)) ?? ownerOf(code);
          setBarcodes((list) => list.filter((candidate) => candidate !== code));
          setNewBarcode(code);
          if (owner) {
            setOffer({ barcode: code, owner });
          } else {
            setBarcodeError("Der Barcode gehört schon zu einem anderen Produkt.");
          }
          setBusy(false);
          return;
        }
      }
      toast.show({ message: `„${trimmedName || productTitle(current)}“ gespeichert`, tone: "success" });
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Dieses Produkt gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  const ownerPackages = offer ? stock.entries.filter((entry) => entry.pkg.product_id === offer.owner.id).length : 0;

  return (
    <>
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        title="Produkt bearbeiten"
        variant="sheet"
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" form={formId} variant="primary" busy={busy}>
              Speichern
            </Button>
          </>
        }
      >
        <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
          {placeholder ? (
            <Notice tone="info" icon={current.lookup === "pending" ? <Spinner size={18} /> : <InfoIcon />} title={`Noch ohne Namen${current.barcodes[0] ? `: Barcode ${current.barcodes[0]}` : ""}`}>
              {lookupText(current)}
            </Notice>
          ) : null}

          <TextField
            ref={dialogFocus}
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            placeholder={placeholder ? "Wie auf der Packung" : undefined}
            error={tried ? nameError : null}
          />
          <div className={styles.columns}>
            <TextField label="Marke" value={brand} onChange={(event) => setBrand(event.target.value)} autoComplete="off" />
            <TextField
              label="Packungsgröße"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              autoComplete="off"
              placeholder="z. B. 500 g"
            />
          </div>
          <TextField
            label="Eigene Vorlaufzeit der MHD-Warnung"
            value={warnDays}
            onChange={(event) => setWarnDays(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder={householdDays === undefined ? undefined : String(householdDays)}
            trailing={<span className={styles.unit}>Tage</span>}
            hint={`Leer = Wert des Haushalts${householdDays === undefined ? "" : ` (${String(householdDays)} Tage)`}. So viele Tage vor dem MHD gilt eine Packung als „läuft bald ab“.`}
            error={tried ? daysError : null}
          />
          <TextField
            label="Mindestbestand"
            value={minStock}
            onChange={(event) => setMinStock(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={3}
            placeholder="keiner"
            trailing={<span className={styles.unit}>Packungen</span>}
            hint={minStockHint(inStock)}
            error={tried ? parsedMin.error : null}
          />

          <FieldGroup label="Barcodes" hint="Ein Produkt kann mehrere Barcodes haben, etwa für verschiedene Marken derselben Zutat.">
            {barcodes.length === 0 ? (
              <p className={styles.muted}>Kein Barcode: Dieses Produkt wird von Hand eingelagert.</p>
            ) : (
              <ul className={styles.barcodes}>
                {barcodes.map((code) => (
                  <li key={code} className={styles.barcode}>
                    <BarcodeIcon size={16} aria-hidden="true" />
                    <span className={styles.barcodeText}>{code}</span>
                    <IconButton label={`Barcode ${code} entfernen`} size="sm" onClick={() => setBarcodes((list) => list.filter((candidate) => candidate !== code))}>
                      <CloseIcon />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.addRow}>
              <TextField
                className={styles.grow}
                label="Barcode hinzufügen"
                hideLabel
                placeholder="Barcode hinzufügen"
                value={newBarcode}
                inputMode="numeric"
                autoComplete="off"
                maxLength={14}
                error={barcodeError}
                onChange={(event) => {
                  setNewBarcode(event.target.value);
                  setBarcodeError(null);
                  setOffer(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    // Eingabe im Barcode-Feld fügt hinzu, statt das ganze Formular zu speichern.
                    event.preventDefault();
                    addBarcode();
                  }
                }}
              />
              <Button icon={<PlusIcon />} onClick={addBarcode} disabled={newBarcode.trim() === ""}>
                Hinzufügen
              </Button>
            </div>
            {offer ? (
              <Notice
                tone="warn"
                icon={<MergeIcon />}
                title={`Der Barcode ${offer.barcode} gehört schon zu „${productTitle(offer.owner)}“.`}
                action={
                  <Button size="sm" onClick={() => setConfirmMerge(true)}>
                    Zusammenführen …
                  </Button>
                }
              >
                Sind beide dasselbe Produkt, lassen sie sich zusammenführen.
              </Notice>
            ) : null}
          </FieldGroup>

          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmMerge && offer !== null}
        onClose={() => setConfirmMerge(false)}
        title="Produkte zusammenführen?"
        confirmLabel="Zusammenführen"
        tone="danger"
        onConfirm={merge}
        errorText={(caught) => errorText(caught, { not_found: "Eines der beiden Produkte gibt es nicht mehr." })}
      >
        {offer ? (
          <>
            <p>
              <strong>„{productTitle(offer.owner)}“</strong> geht in <strong>„{trimmedName || productTitle(current)}“</strong> auf:{" "}
              {ownerPackages > 0 ? `${ownerPackages === 1 ? "Seine Packung" : `Seine ${packagesText(ownerPackages)}`} und alle seine Barcodes` : "Alle seine Barcodes"}{" "}
              gehören danach zu diesem Produkt.
            </p>
            <p>Das lässt sich nicht rückgängig machen.</p>
          </>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
