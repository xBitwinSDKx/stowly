import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  formatTimestamp,
  isOpenItem,
  productSubtitle,
  productTitle,
  ROUTES,
  shoppingItemTitle,
  shoppingQuantityLabel,
  stockCounts,
  useCore,
  useLive,
  type Product,
  type ShoppingItem,
} from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { Checkbox, ConfirmDialog, EmptyState, errorText, FieldGroup, Notice, plural, Section, TextLink, timeAgo, useNow, useUiFlag } from "@/ui";
import { Badge, Button, cx, IconButton, TextField, useToast } from "@/ui/base";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, CloudOffIcon, PencilIcon, PlusIcon, ShoppingIcon, TrashIcon } from "@/ui/icons";

import { ItemDialog, readQuantity, textError } from "./ItemDialog";
import { findDuplicate, isAutomatic, splitItems, suggestProducts, type ShoppingDraft } from "./model";
import styles from "./ShoppingPage.module.css";

/** Kennung des Eingabefelds für neue Einträge: Dorthin geht der Fokus, wenn sonst nichts bleibt. */
const ADD_INPUT_ID = "shopping-add";

/** Ein Ankreuzfeld, sobald sein Eintrag im genannten Zustand dasteht, oder das Eingabefeld. */
type FocusTarget = { id: string; done: boolean } | "add";

/** Was über ein Produkt neben seinem Namen steht: Marke und Größe, Bestand, Mindestbestand. */
function productFacts(product: Product | undefined, stock: number, automatic: boolean): string {
  if (!product) {
    return "";
  }
  const parts = [productSubtitle(product), `im Bestand: ${String(stock)}`];
  if (automatic && product.min_stock !== null) {
    parts.push(`Mindestbestand: ${String(product.min_stock)}`);
  }
  return parts.filter((part) => part !== "").join(" · ");
}

interface AddFormProps {
  items: readonly ShoppingItem[];
  products: readonly Product[];
  counts: ReadonlyMap<string, number>;
}

/**
 * Neuer Eintrag: ein Produkt (Vorschläge beim Eintippen) oder freier Text, dazu eine Menge, wenn
 * man will. Steht dasselbe schon offen auf der Liste, sagt das Formular das, statt einen zweiten
 * Eintrag anzulegen; bewusst geht es trotzdem.
 */
function AddForm({ items, products, counts }: AddFormProps) {
  const core = useCore();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ item: ShoppingItem; title: string } | null>(null);
  const [status, setStatus] = useState("");
  /** Das Eingabefeld kommt erst mit dem nächsten Zeichnen wieder (nach der Wahl eines Produkts): dann fokussieren. */
  const [refocus, setRefocus] = useState(false);

  const suggestions = useMemo(() => (product ? [] : suggestProducts(products, text)), [products, product, text]);
  const parsed = readQuantity(quantity);
  const problem = product ? null : textError(text);

  useEffect(() => {
    if (refocus) {
      inputRef.current?.focus();
      setRefocus(false);
    }
  }, [refocus]);

  function choose(next: Product) {
    setProduct(next);
    setDuplicate(null);
    setError(null);
    // Das Suchfeld weicht dem gewählten Produkt; weiter geht es mit der Menge.
    quantityRef.current?.focus();
  }

  function unchoose() {
    setProduct(null);
    setDuplicate(null);
    setRefocus(true);
  }

  async function add(force: boolean) {
    setTried(true);
    if (problem || parsed.error) {
      (problem ? inputRef : quantityRef).current?.focus();
      return;
    }
    const draft: ShoppingDraft = product ? { product } : { text: text.trim() };
    const title = product ? productTitle(product) : text.trim();
    const existing = force ? undefined : findDuplicate(items, products, draft);
    if (existing) {
      setDuplicate({ item: existing, title });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.shopping.create(product ? { product_id: product.id, quantity: parsed.value } : { text: text.trim(), quantity: parsed.value });
      setText("");
      setProduct(null);
      setQuantity("");
      setTried(false);
      setDuplicate(null);
      setStatus(`„${title}“ steht jetzt auf der Liste.`);
      // Gleich den nächsten Eintrag tippen können.
      setRefocus(true);
    } catch (caught) {
      setError(errorText(caught, { not_found: "Dieses Produkt gibt es nicht mehr." }));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void add(false);
  }

  /** Pfeil nach unten springt aus dem Eingabefeld in die Vorschläge, oben und unten wandert darin. */
  function moveInList(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const buttons = Array.from(document.getElementById(listId)?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (buttons.length === 0) {
      return;
    }
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) {
      buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === "ArrowUp" && current === 0) {
      inputRef.current?.focus();
    } else {
      buttons[Math.min(buttons.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))]?.focus();
    }
  }

  const duplicateText = duplicate ? shoppingQuantityLabel(duplicate.item) : "";

  return (
    <form className={styles.add} onSubmit={submit} noValidate aria-label="Neuer Eintrag">
      <div className={styles.addRow}>
        <div className={styles.what}>
          {product ? (
            <FieldGroup label="Was fehlt?" hint="Mit Produkt erledigt sich der Eintrag beim Einlagern von selbst.">
              <div className={styles.chosen}>
                <span className={styles.chosenText}>
                  <span className={styles.chosenTitle}>{productTitle(product)}</span>
                  {productSubtitle(product) !== "" ? <span className={styles.muted}>{productSubtitle(product)}</span> : null}
                </span>
                <IconButton size="sm" label="Anderes Produkt oder freien Text wählen" onClick={unchoose}>
                  <CloseIcon />
                </IconButton>
              </div>
            </FieldGroup>
          ) : (
            <TextField
              ref={inputRef}
              id={ADD_INPUT_ID}
              label="Was fehlt?"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setDuplicate(null);
                setError(null);
              }}
              onKeyDown={moveInList}
              autoComplete="off"
              enterKeyHint="done"
              placeholder="Produkt suchen oder frei eintippen"
              hint="Mit Produkt erledigt sich der Eintrag beim Einlagern von selbst."
              error={tried ? problem : null}
              aria-controls={suggestions.length > 0 ? listId : undefined}
            />
          )}
          {/* Gleich unter dem Feld, auch am Handy: Dort stehen Menge und Knopf erst darunter. */}
          {suggestions.length > 0 ? (
            <ul id={listId} className={styles.suggestions} aria-label="Passende Produkte" onKeyDown={moveInList}>
              {suggestions.map((candidate) => {
                const listed = items.some((item) => item.product_id === candidate.id && isOpenItem(item));
                return (
                  <li key={candidate.id}>
                    <button type="button" className={styles.suggestion} onClick={() => choose(candidate)}>
                      <span className={styles.suggestionTitle}>{productTitle(candidate)}</span>
                      <span className={styles.muted}>
                        {productFacts(candidate, counts.get(candidate.id) ?? 0, false)}
                        {listed ? " · steht schon auf der Liste" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <TextField
          ref={quantityRef}
          className={styles.quantity}
          label="Menge"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          maxLength={3}
          placeholder="–"
          error={tried ? parsed.error : null}
        />
        <Button type="submit" variant="primary" icon={<PlusIcon />} busy={busy} className={styles.addButton}>
          Hinzufügen
        </Button>
      </div>

      {duplicate ? (
        <Notice
          tone="info"
          role="status"
          title={`„${duplicate.title}“ steht schon auf der Liste${duplicateText !== "" ? ` (${duplicateText})` : ""}.`}
          action={
            <Button size="sm" onClick={() => void add(true)}>
              Trotzdem hinzufügen
            </Button>
          }
        >
          Ein zweiter Eintrag ist nur nötig, wenn er etwas anderes meint.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <p className="sr-only" role="status">
        {status}
      </p>
    </form>
  );
}

interface ItemRowProps {
  item: ShoppingItem;
  product: Product | undefined;
  stock: number;
  now: number;
  onToggle: (item: ShoppingItem, done: boolean) => void;
  onEdit: (item: ShoppingItem) => void;
  onRemove: (item: ShoppingItem) => void;
  /** Für den Fokus nach dem Abhaken: das Ankreuzfeld dieses Eintrags. */
  register: (id: string, element: HTMLInputElement | null) => void;
}

/** Ein Eintrag: Ankreuzfeld mit Name und Menge, darunter Angaben zum Produkt, rechts Ändern und Löschen. */
function ItemRow({ item, product, stock, now, onToggle, onEdit, onRemove, register }: ItemRowProps) {
  const title = shoppingItemTitle(item, product);
  const amount = shoppingQuantityLabel(item);
  const automatic = isAutomatic(item);
  const done = item.done_at !== null;
  const facts = item.product_id === null ? "" : productFacts(product, stock, automatic);
  const when = done && item.done_at ? `erledigt ${timeAgo(item.done_at, now)}` : "";
  return (
    <li className={cx(styles.item, done && styles.itemDone)}>
      <Checkbox
        className={styles.check}
        checked={done}
        label={amount !== "" ? `${title}, ${amount}` : title}
        onChange={(checked) => onToggle(item, checked)}
        inputRef={(element) => register(item.id, element)}
      >
        <span className={styles.itemText}>
          <span className={styles.itemHead}>
            <span className={styles.itemTitle}>{title}</span>
            {amount !== "" ? <span className={cx(styles.amount, automatic && styles.amountAuto)}>{amount}</span> : null}
            {automatic ? (
              <Badge tone="info" title="Vom Server: Der Bestand liegt unter dem Mindestbestand.">
                automatisch
              </Badge>
            ) : null}
          </span>
          {facts !== "" || when !== "" ? (
            <span className={styles.itemFacts}>
              {[facts, when].filter((part) => part !== "").join(" · ")}
              {when !== "" && item.done_at ? <span className="sr-only"> ({formatTimestamp(item.done_at)})</span> : null}
            </span>
          ) : null}
        </span>
      </Checkbox>
      <div className={styles.itemActions}>
        {!automatic && !done ? (
          <IconButton size="sm" label={`Ändern: ${title}`} onClick={() => onEdit(item)}>
            <PencilIcon />
          </IconButton>
        ) : null}
        <IconButton size="sm" label={`Löschen: ${title}`} onClick={() => onRemove(item)}>
          <TrashIcon />
        </IconButton>
      </div>
    </li>
  );
}

/**
 * Die Einkaufsliste: offene Einträge oben, erledigte darunter. Eigene Einträge (Produkt oder
 * freier Text, mit oder ohne Menge) legt jedes Gerät an, auch offline. Automatische Einträge
 * („fehlt 2") legt der Server an, wenn ein Produkt unter seinen Mindestbestand fällt; ihre Menge
 * führt er nach. Abhaken, wieder öffnen, ändern und löschen geht wie bei allem anderen sofort
 * auf diesem Gerät und erreicht den Server mit dem nächsten Abgleich.
 */
export function ShoppingPage() {
  const core = useCore();
  const toast = useToast();
  const items = useLive(core.data.shoppingItems);
  const products = useLive(core.data.products);
  const packages = useLive(core.data.packages);
  const settings = useLive(core.data.settings);
  const sync = useLive(core.sync.status);
  const now = useNow();
  const [showDone, setShowDone] = useUiFlag("shopping.done", true);
  const [editing, setEditing] = useState<{ item: ShoppingItem; title: string } | null>(null);
  const [removing, setRemoving] = useState<{ item: ShoppingItem; title: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  /**
   * Wohin der Fokus geht, wenn sein Element verschwindet: Abgehakt oder geöffnet wandert ein Eintrag
   * in den anderen Abschnitt, gelöscht ist er fort. Dann übernimmt das Ankreuzfeld des Nachbarn,
   * sobald es im genannten Zustand dasteht, sonst das Eingabefeld.
   */
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const boxes = useRef(new Map<string, HTMLInputElement>());

  const productById = useMemo(() => new Map((products ?? []).map((product) => [product.id, product])), [products]);
  const counts = useMemo(() => stockCounts(packages ?? []), [packages]);
  const sections = useMemo(() => splitItems(items ?? []), [items]);

  useEffect(() => {
    if (focusTarget === null) {
      return;
    }
    if (focusTarget === "add") {
      document.getElementById(ADD_INPUT_ID)?.focus();
      setFocusTarget(null);
      return;
    }
    const item = items?.find((candidate) => candidate.id === focusTarget.id);
    if (item && (item.done_at !== null) !== focusTarget.done) {
      // Noch nicht umgezogen: auf die nächste Fassung der Liste warten.
      return;
    }
    // Fehlt das Ankreuzfeld (gelöscht, oder die erledigten sind verborgen), dann das Eingabefeld.
    ((item ? boxes.current.get(item.id) : undefined) ?? document.getElementById(ADD_INPUT_ID))?.focus();
    setFocusTarget(null);
  }, [focusTarget, items]);

  if (!items || !products) {
    return (
      <Page title="Einkaufsliste">
        <PageLoading label="Einkaufsliste wird geladen …" />
      </Page>
    );
  }

  const { open, done } = sections;
  const titleOf = (item: ShoppingItem) => shoppingItemTitle(item, item.product_id === null ? undefined : productById.get(item.product_id));

  function register(id: string, element: HTMLInputElement | null) {
    if (element) {
      boxes.current.set(id, element);
    } else {
      boxes.current.delete(id);
    }
  }

  /**
   * Wer den Fokus bekommt, wenn `item` seinen Abschnitt verlässt: der nächste Eintrag im selben
   * Abschnitt, sonst der vorige, sonst `alone` (der Eintrag am neuen Platz, oder das Eingabefeld).
   */
  function neighbour(item: ShoppingItem, alone: FocusTarget): FocusTarget {
    const isDone = item.done_at !== null;
    const list = isDone ? done : open;
    const index = list.findIndex((candidate) => candidate.id === item.id);
    const next = list[index + 1] ?? list[index - 1];
    return next ? { id: next.id, done: isDone } : alone;
  }

  /** Hatte gerade ein Element dieses Eintrags den Fokus (Ankreuzfeld, Ändern, Löschen)? */
  function focusedIn(item: ShoppingItem): boolean {
    const box = boxes.current.get(item.id);
    const active = document.activeElement;
    return box !== undefined && active !== null && (active === box || (box.closest("li")?.contains(active) ?? false));
  }

  function toggle(item: ShoppingItem, toDone: boolean) {
    const title = titleOf(item);
    const target = focusedIn(item) ? neighbour(item, { id: item.id, done: toDone }) : null;
    core.shopping
      .update(item.id, { done: toDone })
      .then(() => {
        if (target) {
          setFocusTarget(target);
        }
        toast.show({
          id: "shopping-toggle",
          message: toDone ? `„${title}“ abgehakt` : `„${title}“ ist wieder offen`,
          action: { label: "Rückgängig", onAction: () => void core.shopping.update(item.id, { done: !toDone }).catch(report) },
        });
      })
      .catch(report);
  }

  function report(caught: unknown) {
    toast.show({ message: errorText(caught, { not_found: "Diesen Eintrag gibt es nicht mehr." }), tone: "danger" });
  }

  /** Löschen ist endgültig. Bei einem offenen automatischen Eintrag hat es Folgen; das sagt vorher eine Rückfrage. */
  function remove(item: ShoppingItem) {
    const title = titleOf(item);
    if (isAutomatic(item) && item.done_at === null) {
      setRemoving({ item, title });
      return;
    }
    const target = focusedIn(item) ? neighbour(item, "add") : null;
    core.shopping
      .remove(item.id)
      .then(() => {
        if (target) {
          setFocusTarget(target);
        }
        // Ein offener eigener Eintrag lässt sich neu anlegen; das ist das Rückgängig.
        const again = !isAutomatic(item) && item.done_at === null;
        toast.show({
          id: "shopping-removed",
          message: `„${title}“ gelöscht`,
          action: again
            ? {
                label: "Rückgängig",
                onAction: () =>
                  void core.shopping
                    .create(item.product_id === null ? { text: item.text, quantity: item.quantity } : { product_id: item.product_id, quantity: item.quantity })
                    .catch(report),
              }
            : undefined,
        });
      })
      .catch(report);
  }

  async function confirmRemove(item: ShoppingItem, title: string) {
    // Der Knopf, der die Rückfrage geöffnet hat, ist danach fort: Der Fokus geht an den Nachbarn.
    const target = neighbour(item, "add");
    await core.shopping.remove(item.id);
    setRemoving(null);
    setFocusTarget(target);
    toast.show({ id: "shopping-removed", message: `„${title}“ gelöscht` });
  }

  async function clearDone() {
    const count = done.length;
    for (const item of done) {
      await core.shopping.remove(item.id);
    }
    setClearing(false);
    // Der Abschnitt samt Knopf ist danach fort.
    setFocusTarget("add");
    toast.show({ message: `${plural(count, "erledigter Eintrag", "erledigte Einträge")} gelöscht`, tone: "success" });
  }

  const row = (item: ShoppingItem) => {
    const product = item.product_id === null ? undefined : productById.get(item.product_id);
    return (
      <ItemRow
        key={item.id}
        item={item}
        product={product}
        stock={item.product_id === null ? 0 : (counts.get(item.product_id) ?? 0)}
        now={now}
        onToggle={toggle}
        onEdit={(target) => setEditing({ item: target, title: titleOf(target) })}
        onRemove={remove}
        register={register}
      />
    );
  };

  const automatic = open.filter(isAutomatic).length;
  const retention = settings?.trash_retention_days;

  return (
    <Page
      title="Einkaufsliste"
      narrow
      description="Was im Haus fehlt. Eintragen und Abhaken gehen auf jedem Gerät, auch ohne Netz; was unter seinen Mindestbestand fällt, setzt der Server von selbst dazu."
    >
      {sync?.online === false ? (
        <Notice tone="warn" icon={<CloudOffIcon />} role="status" title="Der Server ist nicht erreichbar">
          Die Liste funktioniert trotzdem. Änderungen gehen beim nächsten Abgleich an den Server; neue automatische Einträge kommen erst dann.
        </Notice>
      ) : null}

      <AddForm items={items} products={products} counts={counts} />

      <Section
        title="Offen"
        description={
          open.length === 0
            ? undefined
            : `${plural(open.length, "Eintrag", "Einträge")}${automatic > 0 ? `, davon ${String(automatic)} automatisch` : ""}. Abhaken, wenn es im Wagen liegt.`
        }
      >
        {open.length === 0 ? (
          <EmptyState icon={<ShoppingIcon size={26} />} title="Nichts auf der Liste">
            Was fehlt, oben eintragen. Produkte mit Mindestbestand setzt der Server von selbst auf die Liste, sobald weniger im Bestand sind.
          </EmptyState>
        ) : (
          <ul className={styles.list} aria-label="Offene Einträge">
            {open.map(row)}
          </ul>
        )}
      </Section>

      {done.length > 0 ? (
        <Section
          title="Erledigt"
          description={`${plural(done.length, "Eintrag", "Einträge")}. Wieder öffnen mit einem Tipp aufs Häkchen${retention ? `; nach ${plural(retention, "Tag", "Tagen")} verschwinden sie von selbst` : ""}.`}
          actions={
            <>
              <Button size="sm" variant="ghost" iconRight={showDone ? <ChevronUpIcon /> : <ChevronDownIcon />} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                {showDone ? "Verbergen" : "Zeigen"}
              </Button>
              <Button size="sm" variant="ghost" icon={<TrashIcon />} onClick={() => setClearing(true)}>
                Erledigte löschen
              </Button>
            </>
          }
        >
          {showDone ? (
            <ul className={styles.list} aria-label="Erledigte Einträge">
              {done.map(row)}
            </ul>
          ) : null}
        </Section>
      ) : null}

      <div className={styles.foot}>
        <p>
          <strong>Automatische Einträge</strong> („fehlt 2“) kommen vom Server, sobald ein Produkt unter seinen Mindestbestand fällt: mit Verbindung Sekunden nach dem
          Entnehmen, ohne Verbindung nach dem nächsten Abgleich. Reicht der Bestand wieder, verschwinden sie. Abgehakt oder gelöscht kommen sie erst wieder, wenn das
          Produkt eingelagert oder sein Mindestbestand geändert wird.
        </p>
        <p>
          <strong>Eigene Einträge</strong> mit Produkt sind erledigt, sobald dieses Produkt eingelagert wird; freier Text bleibt offen, bis ihn jemand abhakt. Den
          Mindestbestand gibt es im <TextLink to={ROUTES.stock}>Bestand</TextLink> bei jedem Produkt unter „Bearbeiten“.
        </p>
      </div>

      {editing ? (
        <ItemDialog
          key={editing.item.id}
          item={editing.item}
          title={editing.title}
          onClose={() => setEditing(null)}
          onSaved={(title) => toast.show({ id: "shopping-saved", message: `„${title}“ gespeichert`, tone: "success" })}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`„${removing?.title ?? ""}“ löschen?`}
        confirmLabel="Löschen"
        tone="danger"
        onConfirm={() => (removing ? confirmRemove(removing.item, removing.title) : undefined)}
        errorText={(caught) => errorText(caught, { not_found: "Diesen Eintrag gibt es nicht mehr." })}
      >
        <p>
          Den Eintrag hat der Server angelegt, weil weniger im Bestand ist als der Mindestbestand. Gelöscht kommt er erst wieder, wenn „{removing?.title ?? ""}“
          eingelagert oder sein Mindestbestand geändert wird.
        </p>
        <p>Wer es schon gekauft hat, hakt es besser ab: Das lässt sich wieder öffnen.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title={done.length === 1 ? "Den erledigten Eintrag löschen?" : `Alle ${String(done.length)} erledigten Einträge löschen?`}
        confirmLabel="Löschen"
        tone="danger"
        onConfirm={clearDone}
        errorText={(caught) => errorText(caught)}
      >
        <p>Sie verschwinden von allen Geräten. An offenen Einträgen und am Bestand ändert das nichts.</p>
      </ConfirmDialog>
    </Page>
  );
}
