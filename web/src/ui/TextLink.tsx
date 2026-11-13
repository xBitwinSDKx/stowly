import { Link, type LinkProps } from "react-router";

import { cx } from "./base";
import styles from "./TextLink.module.css";

/**
 * Verweis mitten im Fließtext („Vorlaufzeit ändern"). Sieht aus wie jeder Verweis, ist am
 * Handy aber so hoch antippbar wie eine Schaltfläche, ohne dass der Satz verrutscht.
 */
export function TextLink({ className, ...rest }: LinkProps) {
  return <Link {...rest} className={cx(styles.link, className)} />;
}
