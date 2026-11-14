import { useId, useState, type FormEvent } from "react";

import { checkShoppingQuantity, checkShoppingText, LIMITS, useCore, type ShoppingItem, type ShoppingItemChanges } from "@/contract";
import { errorText } from "@/ui";
import { Button, Dialog, dialogFocus, TextField } from "@/ui/base";

import styles from "./ShoppingPage.module.css";

/**
 * Liest das Feld „Menge": leer heißt ohne Angabe (null). Sonst eine ganze Zahl in den Grenzen des
 * Vertrags (`checkShoppingQuantity`); was nicht passt, liefert den Satz für die Anzeige.
 */
export function readQuantity(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { value: null, error: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error: `Bitte eine ganze Zahl von 1 bis ${String(LIMITS.shopping_quantity)} eingeben oder das Feld leer lassen.` };
  }
  const value = Number(trimmed);
  try {
    checkShoppingQuantity(value);
  } catch (caught) {
    return { value: null, error: errorText(caught) };
  }
  return { value, error: null };
}

/** Prüft den freien Text eines Eintrags; null, wenn er passt, sonst der Satz des Vertrags. */
export function textError(text: string): string | null {
  try {
    checkShoppingText(text);
    return null;
  } catch (caught) {
    return errorText(caught);
  }
}

export interface ItemDialogProps {
  item: ShoppingItem;
  /** Anzeigename des Eintrags (`shoppingItemTitle`). */
  title: string;
  onClose: () => void;
  /** Nach dem Speichern, mit dem Namen danach. */
  onSaved: (title: string) => void;
}

/**
 * Einen eigenen Eintrag ändern: den Text (nur ohne Produkt) und die Menge. Automatische Einträge
 * kommen hier nicht her: Ihre Menge führt der Server, einen Text haben sie nicht.
 */
export function ItemDialog({ item, title, onClose, onSaved }: ItemDialogProps) {
  const core = useCore();
  const formId = useId();
  const withText = item.product_id === null;
  const [text, setText] = useState(item.text);
  const [quantity, setQuantity] = useState(item.quantity === null ? "" : String(item.quantity));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = readQuantity(quantity);
  const problem = withText ? textError(text) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (problem || parsed.error) {
      return;
    }
    const changes: ShoppingItemChanges = {};
    if (withText && text.trim() !== item.text) {
      changes.text = text.trim();
    }
    if (parsed.value !== item.quantity) {
      changes.quantity = parsed.value;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.shopping.update(item.id, changes);
      onSaved(withText ? text.trim() : title);
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Diesen Eintrag gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Eintrag ändern"
      size="sm"
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
      <form id={formId} className={styles.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
        {withText ? (
          <TextField ref={dialogFocus} label="Text" value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" error={tried ? problem : null} />
        ) : (
          <p className={styles.dialogSubject}>{title}</p>
        )}
        <TextField
          ref={withText ? undefined : dialogFocus}
          label="Menge"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          maxLength={3}
          placeholder="ohne Angabe"
          hint="In Packungen; leer = ohne Angabe."
          error={tried ? parsed.error : null}
        />
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
