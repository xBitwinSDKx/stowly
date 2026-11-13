import { QRCodeSVG } from "qrcode.react";

import { zoneQr, type Zone } from "@/contract";
import { cx } from "@/ui/base";

import styles from "./ZoneQr.module.css";

export interface ZoneQrProps {
  zone: Pick<Zone, "id" | "name">;
  /** Kantenlänge am Bildschirm in Pixeln. Im Druck bestimmt das Blatt die Größe. */
  size?: number;
  className?: string;
}

/**
 * Der QR-Code einer Zone: Inhalt `zoneQr(zone.id)`, Fehlerkorrektur Q, mit Ruhezone.
 * Immer schwarz auf weiß, auch im dunklen Thema (Tokens --qr-fg und --qr-bg).
 */
export function ZoneQr({ zone, size = 280, className }: ZoneQrProps) {
  return (
    <span className={cx(styles.qr, className)} style={{ width: size }}>
      <QRCodeSVG
        value={zoneQr(zone.id)}
        level="Q"
        boostLevel={false}
        marginSize={4}
        size={size}
        bgColor="transparent"
        fgColor="currentColor"
        title={`QR-Code der Zone ${zone.name}`}
        className={styles.code}
      />
    </span>
  );
}
