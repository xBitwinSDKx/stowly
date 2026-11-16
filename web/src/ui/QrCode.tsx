import { QRCodeSVG } from "qrcode.react";

import { cx } from "./base";
import styles from "./QrCode.module.css";

export interface QrCodeProps {
  /** Der Inhalt, etwa eine Adresse oder der Inhalt eines Etiketts. */
  value: string;
  /** Was der Code zeigt, für Screenreader und als Tooltip. */
  title: string;
  /** Kantenlänge am Bildschirm in Pixeln. Im Druck bestimmt das Blatt die Größe. Vorgabe 200. */
  size?: number;
  className?: string;
}

/**
 * Ein QR-Code: Fehlerkorrektur Q, mit Ruhezone, immer schwarz auf weiß, auch im dunklen Thema
 * (Tokens --qr-fg und --qr-bg).
 *
 * Bewusst nicht im Fass `@/ui`: direkt importieren (`@/ui/QrCode`). So landet die Bibliothek
 * nur in den nachgeladenen Teilen, die einen QR-Code zeigen, nicht im Hauptpaket.
 */
export function QrCode({ value, title, size = 200, className }: QrCodeProps) {
  return (
    <span className={cx(styles.qr, className)} style={{ width: size }}>
      <QRCodeSVG value={value} level="Q" boostLevel={false} marginSize={4} size={size} bgColor="transparent" fgColor="currentColor" title={title} className={styles.code} />
    </span>
  );
}
