import { cx } from "./base";
import { JarIcon } from "./icons";
import styles from "./Logo.module.css";

export interface LogoProps {
  /** "lg" für die Anmeldung. Vorgabe "md". */
  size?: "md" | "lg";
  className?: string;
}

/** Glas-Symbol und Produktname. Das Glas folgt der Akzentfarbe. */
export function Logo({ size = "md", className }: LogoProps) {
  return (
    <span className={cx(styles.logo, styles[size], className)}>
      <span className={styles.mark}>
        <JarIcon size={size === "lg" ? 28 : 22} />
      </span>
      <span className={styles.name}>Stowly</span>
    </span>
  );
}
