import type { Zone } from "@/contract";
import { PrintSheet, useReturnFocus } from "@/ui";
import { Button, Dialog } from "@/ui/base";
import { PrinterIcon } from "@/ui/icons";

import { ZoneQr } from "./ZoneQr";
import styles from "./ZoneQrDialog.module.css";

export interface ZoneQrDialogProps {
  /** Eine Zone: ihr Code groß zum Abscannen vom Bildschirm. Mehrere: alle Codes zum Drucken. */
  zones: readonly Zone[];
  onClose: () => void;
}

/**
 * Zeigt den QR-Code einer Zone groß genug, um ihn vom Bildschirm zu scannen, und druckt
 * ihn über den Browser. Der Druck auf dem Etikettendrucker folgt in Runde 2.
 */
export function ZoneQrDialog({ zones, onClose }: ZoneQrDialogProps) {
  useReturnFocus();
  const single = zones.length === 1 ? zones[0] : undefined;

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={single ? `QR-Code: ${single.name}` : "QR-Codes aller Zonen"}
        size={single ? "sm" : "lg"}
        variant="sheet"
        footer={
          <>
            <Button onClick={onClose}>Schließen</Button>
            <Button variant="primary" icon={<PrinterIcon />} onClick={() => window.print()}>
              Drucken
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          {single ? (
            <ZoneQr zone={single} size={288} className={styles.single} />
          ) : (
            <ul className={styles.grid}>
              {zones.map((zone) => (
                <li key={zone.id} className={styles.cell}>
                  <ZoneQr zone={zone} size={168} />
                  <span className={styles.name}>{zone.name}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.hint}>
            {single
              ? `Beim Scannen erfasst, wechselt dieser Code in die Zone „${single.name}“. Ausgedruckt und am Lagerort aufgehängt, geht das mit einer Hand.`
              : "Beim Scannen erfasst, wechselt ein Code in seine Zone. Ausgedruckt und am Lagerort aufgehängt, geht das mit einer Hand."}
          </p>
        </div>
      </Dialog>

      <PrintSheet>
        <div className={styles.sheet}>
          {zones.map((zone) => (
            <div key={zone.id} className={styles.label}>
              <ZoneQr zone={zone} className={styles.printCode} />
              <div className={styles.printName}>{zone.name}</div>
              <div className={styles.printSub}>Stowly · Lagerzone</div>
            </div>
          ))}
        </div>
      </PrintSheet>
    </>
  );
}
