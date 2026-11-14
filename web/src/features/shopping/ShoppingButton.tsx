import { useEffect, useRef, useState } from "react";

import { productTitle, ROUTES, useCore, useLive, type Product } from "@/contract";
import { Button, ButtonLink, useToast, type ButtonSize, type ButtonVariant } from "@/ui/base";
import { AddToListIcon, CheckIcon } from "@/ui/icons";

import { addProductToShopping, openItemFor } from "./actions";
import styles from "./ShoppingButton.module.css";

export interface ShoppingButtonProps {
  /** Das Produkt; ohne (Verweis ins Leere) ist der Knopf gesperrt. */
  product: Product | undefined;
  /** Vorgabe "sm". */
  size?: ButtonSize;
  /** Vorgabe "ghost". */
  variant?: ButtonVariant;
}

/**
 * „Auf die Einkaufsliste" für ein Produkt. Steht es dort schon offen (eigener oder automatischer
 * Eintrag), steht an derselben Stelle ein Verweis zur Liste: So entsteht kein zweiter Eintrag.
 */
export function ShoppingButton({ product, size = "sm", variant = "ghost" }: ShoppingButtonProps) {
  const core = useCore();
  const toast = useToast();
  const items = useLive(core.data.shoppingItems);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  const title = productTitle(product);
  const listed = product !== undefined && openItemFor(items, product.id) !== undefined;

  // Nach dem Tipp wird aus dem Knopf der Verweis: Der Fokus bleibt an dieser Stelle.
  useEffect(() => {
    if (added && listed) {
      slot.current?.querySelector<HTMLElement>("a")?.focus();
      setAdded(false);
    }
  }, [added, listed]);

  async function add() {
    if (!product) {
      return;
    }
    setBusy(true);
    try {
      setAdded((await addProductToShopping(core, toast, product)) !== undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={slot} className={styles.slot}>
      {listed ? (
        <ButtonLink to={ROUTES.shopping} size={size} variant={variant} icon={<CheckIcon />} aria-label={`Steht auf der Einkaufsliste: ${title}`}>
          Steht auf der Einkaufsliste
        </ButtonLink>
      ) : (
        <Button
          size={size}
          variant={variant}
          icon={<AddToListIcon />}
          busy={busy}
          disabled={!product}
          aria-label={`Auf die Einkaufsliste: ${title}`}
          onClick={() => void add()}
        >
          Auf die Einkaufsliste
        </Button>
      )}
    </span>
  );
}
