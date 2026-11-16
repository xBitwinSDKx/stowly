import { zoneQr, type Zone } from "@/contract";
import { QrCode } from "@/ui/QrCode";

export interface ZoneQrProps {
  zone: Pick<Zone, "id" | "name">;
  /** Kantenlänge am Bildschirm in Pixeln. Im Druck bestimmt das Blatt die Größe. */
  size?: number;
  className?: string;
}

/**
 * Der QR-Code einer Zone: Inhalt `zoneQr(zone.id)`, Fehlerkorrektur Q, mit Ruhezone.
 * Immer schwarz auf weiß, auch im dunklen Thema (`QrCode`).
 */
export function ZoneQr({ zone, size = 280, className }: ZoneQrProps) {
  return <QrCode value={zoneQr(zone.id)} size={size} title={`QR-Code der Zone ${zone.name}`} className={className} />;
}
