import { cx } from "@/ui/base";
import { ExternalLinkIcon } from "@/ui/icons";

import styles from "./CookPage.module.css";
import { chefkochUrl, cookidooUrl, searchWords } from "./terms";

/**
 * „Bei Cookidoo suchen" und „Bei Chefkoch suchen" mit den Begriffen der gewählten Zutaten. Die App
 * baut die Adressen selbst, auch offline; geöffnet wird in einem neuen Tab, ohne Verweis zurück.
 */
export function SearchLinks({ terms }: { terms: readonly string[] }) {
  const cookidoo = cookidooUrl(terms);
  const chefkoch = chefkochUrl(terms);
  if (cookidoo === null || chefkoch === null) {
    return <p className={styles.muted}>Erst eine Zutat wählen, dann lässt sich nach Rezepten suchen.</p>;
  }
  return (
    <div>
      <div className={styles.links}>
        <a className={styles.external} href={cookidoo} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon size={16} aria-hidden="true" />
          Bei Cookidoo suchen
        </a>
        <a className={styles.external} href={chefkoch} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon size={16} aria-hidden="true" />
          Bei Chefkoch suchen
        </a>
      </div>
      <p className={cx(styles.small, styles.linkFoot)}>Gesucht wird nach „{searchWords(terms).join(" ")}“. Die Seite öffnet sich in einem neuen Tab.</p>
    </div>
  );
}
