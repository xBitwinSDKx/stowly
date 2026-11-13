import { cx } from "./base";
import styles from "./PackageIds.module.css";

export interface PackageIdsProps {
  ids: readonly string[];
  /** Größer und kräftiger: zum Abschreiben aufs Etikett. */
  large?: boolean;
  /** Höchstens so viele zeigen, der Rest als „+ n". */
  max?: number;
  className?: string;
}

/** Packungs-IDs als kleine Marken in gleich breiter Schrift, wie auf dem Etikett. */
export function PackageIds({ ids, large = false, max, className }: PackageIdsProps) {
  const shown = max !== undefined && ids.length > max ? ids.slice(0, max) : ids;
  const rest = ids.length - shown.length;
  return (
    <ul className={cx(styles.ids, large && styles.large, className)} aria-label="Packungs-IDs">
      {shown.map((id) => (
        <li key={id} className={styles.id}>
          {id}
        </li>
      ))}
      {rest > 0 ? (
        <li className={styles.rest} title={ids.slice(shown.length).join(", ")}>
          + {rest}
        </li>
      ) : null}
    </ul>
  );
}

/** Eine einzelne Packungs-ID im selben Aussehen, für Fließtext und Tabellenzellen. */
export function PackageId({ id, className }: { id: string; className?: string }) {
  return <span className={cx(styles.id, className)}>{id}</span>;
}
