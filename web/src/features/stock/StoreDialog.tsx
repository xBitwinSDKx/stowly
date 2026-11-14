import { useId, useMemo, useState, type FormEvent } from "react";

import {
  formatDate,
  isCoreError,
  MAX_STORE_COUNT,
  normalizeBarcode,
  productSubtitle,
  productTitle,
  useCore,
  useLive,
  type Product,
  type ProductRef,
  type StoreResult,
} from "@/contract";
import { LabelStatus } from "@/features/printers/LabelStatus";
import { useHasPrinter } from "@/features/printers/usePrinting";
import { BestBeforeField, errorText, FieldGroup, focusFirstInvalid, Notice, PackageIds, packagesText, readBestBefore, Select, Stepper } from "@/ui";
import { Button, cx, Dialog, dialogFocus, SegmentedControl, Switch, TextField, useToast } from "@/ui/base";
import { CheckIcon, CircleCheckIcon, PlusIcon, SearchIcon, UndoIcon } from "@/ui/icons";

import styles from "./dialogs.module.css";
import { foldText } from "./model";
import { readMinStock } from "./ProductDialog";
import type { StockData } from "./useStock";

/** Kurz, weil der Dialog ohnehin lang ist; ausführlich steht es im Dialog des Produkts. */
const MIN_STOCK_HINT = "Leer = keiner. Liegen weniger Packungen im Bestand, setzt der Server das Produkt auf die Einkaufsliste.";

export interface StoreDialogProps {
  stock: StockData;
  /** Dieses Produkt ist vorgewählt („Weitere einlagern"). */
  productId?: string;
  /** Diese Zone ist vorgewählt, z. B. die gerade gefilterte. */
  zoneId?: string | null;
  onClose: () => void;
}

type Mode = "existing" | "new";

/** So viele Produkte zeigt die Auswahl höchstens; darüber hilft nur Eintippen. */
const MAX_CHOICES = 40;

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/**
 * Von Hand einlagern, ohne Scanner: Produkt wählen oder neu anlegen, Menge, MHD, Zone.
 * Danach zeigt der Dialog die vergebenen Packungs-IDs, damit sie sich notfalls von Hand
 * auf die Packung schreiben lassen, und sagt, was mit den Etiketten ist.
 */
export function StoreDialog({ stock, productId, zoneId, onClose }: StoreDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const prefs = useLive(core.prefs.value);
  // Etiketten gibt es nur mit einem Drucker; der Schalter folgt der Einstellung dieses Geräts.
  const hasPrinter = useHasPrinter();
  const labels = prefs?.print_labels ?? true;

  const hasProducts = stock.products.length > 0;
  const [mode, setMode] = useState<Mode>(hasProducts ? "existing" : "new");
  const [selectedId, setSelectedId] = useState<string | null>(productId ?? null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [quantity, setQuantity] = useState("");
  const [barcode, setBarcode] = useState("");
  const [minStock, setMinStock] = useState("");
  const [count, setCount] = useState(1);
  const [bestBefore, setBestBefore] = useState("");
  const [zone, setZone] = useState<string>(() => defaultZone());
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StoreResult | null>(null);

  /** Vorgabe der Zone: die gewünschte, sonst die Primärzone bzw. die zuletzt beim Scannen gewählte, sonst die erste. */
  function defaultZone(): string {
    const known = (id: string | null | undefined) => (id && stock.zones.some((candidate) => candidate.id === id) ? id : null);
    const preferred = stock.settings?.zone_mode === "equal" ? known(prefs?.scan_zone_id) : known(stock.settings?.primary_zone_id);
    return known(zoneId) ?? preferred ?? stock.zones[0]?.id ?? "";
  }

  const selected = stock.products.find((candidate) => candidate.id === selectedId);
  const choices = useMemo(() => {
    const needle = foldText(search.trim());
    const digits = /^\d+$/.test(search.trim()) ? search.trim() : null;
    return stock.products
      .filter(
        (product) =>
          needle === "" ||
          foldText(`${product.name} ${product.brand}`).includes(needle) ||
          (digits !== null && product.barcodes.some((code) => code.includes(digits))),
      )
      .sort((a, b) => collator.compare(productTitle(a), productTitle(b)));
  }, [stock.products, search]);

  const input = readBestBefore(bestBefore, stock.today);
  const code = barcode.trim() === "" ? null : normalizeBarcode(barcode);
  const barcodeOwner = code ? stock.products.find((candidate) => candidate.barcodes.includes(code)) : undefined;
  const nameError = mode === "new" && name.trim() === "" ? "Bitte einen Namen eingeben." : null;
  const barcodeError =
    mode === "new" && barcode.trim() !== "" && code === null ? "Kein gültiger Barcode. Erwartet werden 8, 12 oder 13 Ziffern mit stimmender Prüfziffer." : null;
  const productError = mode === "existing" && !selected ? "Bitte ein Produkt auswählen." : null;
  const parsedMin = readMinStock(minStock);
  const minStockError = mode === "new" ? parsedMin.error : null;

  function chooseExisting(product: Product) {
    setMode("existing");
    setSelectedId(product.id);
    setSearch("");
    setBarcode("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (nameError || barcodeError || productError || minStockError || input.kind === "invalid" || zone === "" || (mode === "new" && barcodeOwner)) {
      focusFirstInvalid(formId);
      return;
    }
    const product: ProductRef =
      mode === "existing" && selected
        ? { kind: "existing", product_id: selected.id }
        : { kind: "new", name: name.trim(), brand: brand.trim(), quantity: quantity.trim(), min_stock: parsedMin.value, barcodes: code ? [code] : [] };
    setBusy(true);
    setError(null);
    try {
      const stored = await core.stock.store({ product, zone_id: zone, best_before: input.kind === "date" ? input.date : null, count, labels: hasPrinter && labels });
      setResult(stored);
    } catch (caught) {
      if (isCoreError(caught, "barcode_taken")) {
        setError("Der Barcode gehört schon zu einem anderen Produkt. Bitte dieses Produkt unter „Vorhandenes Produkt“ wählen.");
      } else {
        setError(errorText(caught, { not_found: "Das Produkt oder die Zone gibt es nicht mehr." }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo(stored: StoreResult) {
    setBusy(true);
    try {
      await core.stock.remove(
        stored.packages.map((pkg) => pkg.id),
        "mistake",
      );
      toast.show({ message: `${packagesText(stored.packages.length)} wieder entfernt` });
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  function again() {
    setResult(null);
    setTried(false);
    setError(null);
    setCount(1);
    setBestBefore("");
    if (result) {
      // Meist folgt dasselbe Produkt mit anderem MHD oder in einer anderen Zone.
      setMode("existing");
      setSelectedId(result.product.id);
      setSearch("");
    }
  }

  // Die Schaltflächen der Fußzeile tragen Schlüssel, damit React sie beim Wechsel zum Ergebnis nicht
  // weiterverwendet: Sonst stünde der Fokus von „Einlagern" danach auf „Fertig", und ein schnelles
  // zweites Enter schlösse das Ergebnis samt Packungs-IDs, bevor jemand sie gesehen hat. So geht der
  // Fokus an den Dialog selbst.
  if (result) {
    const zoneName = stock.zones.find((candidate) => candidate.id === result.packages[0]?.zone_id)?.name;
    const date = result.packages[0]?.best_before ?? null;
    return (
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        title="Eingelagert"
        variant="sheet"
        footer={
          <>
            <Button key="again" onClick={again} disabled={busy}>
              Weitere einlagern
            </Button>
            <Button key="done" variant="primary" onClick={onClose} disabled={busy}>
              Fertig
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <div className={styles.done}>
            <CircleCheckIcon size={28} aria-hidden="true" className={styles.doneIcon} />
            <div className={styles.grow}>
              <div className={styles.subjectTitle}>
                {result.packages.length} × {productTitle(result.product)}
              </div>
              <div className={styles.muted}>
                {[stock.multiZone ? zoneName : null, date ? `MHD ${formatDate(date)}` : "ohne MHD"].filter(Boolean).join(" · ")}
              </div>
            </div>
            <Button size="sm" variant="ghost" icon={<UndoIcon />} onClick={() => void undo(result)} busy={busy}>
              Rückgängig
            </Button>
          </div>
          <FieldGroup
            label={result.packages.length === 1 ? "Packungs-ID" : "Packungs-IDs"}
            hint={
              result.print_jobs.length > 0
                ? "Bis das Etikett klebt, hilft die ID von Hand auf der Packung."
                : hasPrinter
                  ? "Etiketten sind auf diesem Gerät ausgeschaltet. Die ID von Hand auf jede Packung schreiben, damit sie sich später ausbuchen lässt."
                  : "Ohne Drucker gibt es keine Etiketten. Die ID von Hand auf jede Packung schreiben, damit sie sich später ausbuchen lässt."
            }
          >
            <PackageIds ids={result.packages.map((pkg) => pkg.id)} large />
          </FieldGroup>
          {result.print_jobs.length > 0 ? (
            <FieldGroup label={result.print_jobs.length === 1 ? "Etikett" : "Etiketten"}>
              <LabelStatus jobIds={result.print_jobs.map((job) => job.id)} />
            </FieldGroup>
          ) : null}
          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Von Hand einlagern"
      variant="sheet"
      footer={
        <>
          <Button key="cancel" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button key="store" type="submit" form={formId} variant="primary" busy={busy}>
            {count === 1 ? "Einlagern" : `${String(count)} Packungen einlagern`}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {hasProducts ? (
          <SegmentedControl<Mode>
            label="Produkt"
            block
            value={mode}
            onChange={setMode}
            options={[
              { value: "existing", label: "Vorhandenes Produkt" },
              { value: "new", label: "Neues Produkt" },
            ]}
          />
        ) : null}

        {mode === "existing" ? (
          <FieldGroup label="Produkt" error={tried ? productError : null}>
            {selected ? (
              <div className={styles.chosen}>
                <div className={styles.chosenText}>
                  <div className={styles.subjectTitle}>{productTitle(selected)}</div>
                  {productSubtitle(selected) !== "" ? <div className={styles.muted}>{productSubtitle(selected)}</div> : null}
                </div>
                <Button size="sm" onClick={() => setSelectedId(null)}>
                  Ändern
                </Button>
              </div>
            ) : (
              <>
                <TextField
                  ref={dialogFocus}
                  label="Produkt suchen"
                  hideLabel
                  placeholder="Name, Marke oder Barcode"
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  leading={<SearchIcon aria-hidden="true" />}
                />
                {choices.length === 0 ? (
                  <div className={styles.noChoice}>
                    <span className={styles.muted}>Kein Produkt gefunden.</span>
                    <Button
                      size="sm"
                      icon={<PlusIcon />}
                      onClick={() => {
                        setMode("new");
                        setName(search.trim());
                      }}
                    >
                      Als neues Produkt anlegen
                    </Button>
                  </div>
                ) : (
                  <ul className={styles.choices} aria-label="Produkte">
                    {choices.slice(0, MAX_CHOICES).map((product) => (
                      <li key={product.id}>
                        <button type="button" className={styles.choice} onClick={() => setSelectedId(product.id)}>
                          <span className={styles.choiceTitle}>{productTitle(product)}</span>
                          {productSubtitle(product) !== "" ? <span className={styles.choiceSub}>{productSubtitle(product)}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {choices.length > MAX_CHOICES ? (
                  <p className={styles.muted}>{String(choices.length - MAX_CHOICES)} weitere: bitte die Suche eingrenzen.</p>
                ) : null}
              </>
            )}
          </FieldGroup>
        ) : (
          <>
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              placeholder="Wie auf der Packung"
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
              label="Barcode (freiwillig)"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              maxLength={14}
              hint="Mit Barcode erkennt der Scanner das Produkt beim nächsten Mal."
              error={tried || code !== null ? barcodeError : null}
            />
            <TextField
              label="Mindestbestand (freiwillig)"
              value={minStock}
              onChange={(event) => setMinStock(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              maxLength={3}
              placeholder="keiner"
              trailing={<span className={styles.unit}>Packungen</span>}
              hint={MIN_STOCK_HINT}
              error={tried ? minStockError : null}
            />
            {barcodeOwner ? (
              <Notice
                tone="warn"
                title={`Diesen Barcode hat schon „${productTitle(barcodeOwner)}“.`}
                action={
                  <Button size="sm" icon={<CheckIcon />} onClick={() => chooseExisting(barcodeOwner)}>
                    Dieses Produkt verwenden
                  </Button>
                }
              >
                Ein Barcode gehört zu genau einem Produkt.
              </Notice>
            ) : null}
          </>
        )}

        <div className={cx(styles.columns, styles.alignEnd)}>
          <Stepper label="Menge" value={count} onChange={setCount} min={1} max={MAX_STORE_COUNT} hint="Jede Packung bekommt eine eigene ID." />
          {stock.multiZone ? (
            <Select label="Zone" value={zone} onChange={setZone} options={stock.zones.map((candidate) => ({ value: candidate.id, label: candidate.name }))} />
          ) : null}
        </div>

        <BestBeforeField value={bestBefore} onChange={setBestBefore} today={stock.today} showError={tried} />

        {hasPrinter ? (
          <Switch
            label="Etiketten"
            hint={count === 1 ? "Für die Packung ein Etikett drucken" : "Für jede Packung ein Etikett drucken"}
            checked={labels}
            onChange={(print_labels) => void core.prefs.update({ print_labels }).catch((caught: unknown) => setError(errorText(caught)))}
          />
        ) : null}

        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
