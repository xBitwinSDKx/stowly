import { useId, useState } from "react";

import { useCore, type CookIdea } from "@/contract";
import type { ProductGroup } from "@/features/stock/model";
import { addTextsToShopping } from "@/features/shopping/actions";
import { Checkbox, ExpiryLabel } from "@/ui";
import { Badge, Button, useToast } from "@/ui/base";
import { AddToListIcon, ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon } from "@/ui/icons";

import styles from "./CookPage.module.css";
import { chefkochUrl, cookidooUrl } from "./terms";
import { modelName } from "./texts";

export interface IdeaCardProps {
  idea: CookIdea;
  /** Das Modell, das geantwortet hat (`CookIdeas.model`). */
  model: string;
  /** Der Bestand je Produkt: Name und MHD kommen von hier, nicht aus der Antwort. */
  groups: ReadonlyMap<string, ProductGroup>;
}

/**
 * Ein Vorschlag von Claude als Karte: Titel, Zeit, Kurzbeschreibung; was aus dem Vorrat hineinkommt
 * (mit dem MHD aus dem Bestand), was fehlt (zum Abhaken und für die Einkaufsliste), die Zubereitung
 * zum Aufklappen und die Suche nach Ähnlichem bei Cookidoo und Chefkoch.
 *
 * Alles von Claude steht als Text da (React maskiert es). Verweise gibt es nur die, die die App selbst
 * baut, zu den beiden festen Rechnern.
 */
export function IdeaCard({ idea, model, groups }: IdeaCardProps) {
  const core = useCore();
  const toast = useToast();
  const titleId = useId();
  const stepsId = useId();
  const [checked, setChecked] = useState<boolean[]>(() => idea.missing.map(() => true));
  const [showSteps, setShowSteps] = useState(false);
  const [adding, setAdding] = useState(false);
  const cookidoo = cookidooUrl([idea.search]);
  const chefkoch = chefkochUrl([idea.search]);
  const picked = idea.missing.filter((_, index) => checked[index] === true);

  async function addMissing() {
    setAdding(true);
    try {
      await addTextsToShopping(core, toast, picked);
    } finally {
      setAdding(false);
    }
  }

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <header className={styles.cardHead}>
        <h3 id={titleId} className={styles.cardTitle}>
          {idea.title}
        </h3>
        {idea.minutes !== null ? <Badge tone="neutral">{idea.minutes} Min.</Badge> : null}
      </header>
      {idea.summary !== "" ? <p className={styles.summary}>{idea.summary}</p> : null}

      {idea.uses.length > 0 ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>Aus dem Vorrat</h4>
          <ul className={styles.uses}>
            {idea.uses.map((use) => {
              const group = groups.get(use.product_id);
              return (
                <li key={use.product_id} className={styles.use}>
                  <span>{group?.title ?? use.name}</span>
                  {group ? (
                    <ExpiryLabel date={group.critical} state={group.state} days={group.days} detail={group.state === "soon" || group.state === "expired"} emptyText="ohne MHD" />
                  ) : (
                    <span className={styles.small}>nicht mehr im Bestand</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {idea.missing.length > 0 ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>Fehlt</h4>
          <ul className={styles.missing}>
            {idea.missing.map((text, index) => (
              <li key={`${String(index)}-${text}`}>
                <Checkbox checked={checked[index] === true} onChange={(value) => setChecked((current) => current.map((entry, at) => (at === index ? value : entry)))}>
                  {text}
                </Checkbox>
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" icon={<AddToListIcon />} busy={adding} disabled={picked.length === 0} onClick={() => void addMissing()}>
              Fehlendes auf die Einkaufsliste
            </Button>
          </div>
        </div>
      ) : null}

      {idea.steps.length > 0 ? (
        <div className={styles.part}>
          <div>
            <Button
              size="sm"
              variant="ghost"
              iconRight={showSteps ? <ChevronUpIcon /> : <ChevronDownIcon />}
              aria-expanded={showSteps}
              aria-controls={showSteps ? stepsId : undefined}
              onClick={() => setShowSteps(!showSteps)}
            >
              {showSteps ? "Zubereitung verbergen" : "Zubereitung zeigen"}
            </Button>
          </div>
          {showSteps ? (
            <ol id={stepsId} className={styles.steps} aria-label="Zubereitung">
              {idea.steps.map((step, index) => (
                <li key={`${String(index)}-${step}`}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {cookidoo !== null && chefkoch !== null ? (
        <div className={styles.cardLinks}>
          <a className={styles.textLink} href={cookidoo} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon size={16} aria-hidden="true" />
            Ähnliches bei Cookidoo
          </a>
          <a className={styles.textLink} href={chefkoch} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon size={16} aria-hidden="true" />
            Ähnliches bei Chefkoch
          </a>
        </div>
      ) : null}

      <p className={styles.cardFoot}>Vorschlag von {modelName(model)}; Allergene und Haltbarkeit selbst prüfen.</p>
    </article>
  );
}
