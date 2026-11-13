import { useState } from "react";

import { useCore, type Zone } from "@/contract";
import { LabelImage } from "@/features/printers/LabelImage";
import { LabelStatus } from "@/features/printers/LabelStatus";
import { printerForZone } from "@/features/printers/model";
import { usePrinting } from "@/features/printers/usePrinting";
import { errorText, Notice, PrintSheet } from "@/ui";
import { Button, Dialog } from "@/ui/base";
import { EyeIcon, PrinterIcon, TagIcon } from "@/ui/icons";

import { ZoneQr } from "./ZoneQr";
import styles from "./ZoneQrDialog.module.css";

export interface ZoneQrDialogProps {
  /** Eine Zone: ihr Code groß zum Abscannen vom Bildschirm. Mehrere: alle Codes zum Drucken. */
  zones: readonly Zone[];
  onClose: () => void;
}

/**
 * Zeigt den QR-Code einer Zone groß genug, um ihn vom Bildschirm zu scannen, und druckt ihn:
 * als Etikett auf dem Etikettendrucker (wenn es einen gibt) oder über den Browser auf Papier.
 */
export function ZoneQrDialog({ zones, onClose }: ZoneQrDialogProps) {
  const core = useCore();
  const printing = usePrinting();
  const single = zones.length === 1 ? zones[0] : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  /** Die hier angeforderten Etiketten: Darunter steht, was aus ihnen wird. */
  const [jobs, setJobs] = useState<readonly string[]>([]);

  const target = single ? printerForZone(single.id, printing.data) : undefined;

  async function printLabels() {
    setBusy(true);
    setError(null);
    try {
      const created: string[] = [];
      for (const zone of zones) {
        created.push((await core.print.requestZoneLabel(zone.id)).id);
      }
      setJobs(created);
    } catch (caught) {
      setError(errorText(caught, { not_found: "Die Zone gibt es nicht mehr, oder es ist kein Drucker mehr eingerichtet." }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        title={single ? `QR-Code: ${single.name}` : "QR-Codes aller Zonen"}
        size={single ? "sm" : "lg"}
        variant="sheet"
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              Schließen
            </Button>
            {printing.hasPrinter ? (
              <Button variant="primary" icon={<TagIcon />} busy={busy} onClick={() => void printLabels()}>
                {/* Kurz genug für die Fußzeile am Handy; daneben steht der Druck über den Browser. */}
                {single ? "Etikett drucken" : "Etiketten drucken"}
              </Button>
            ) : (
              <Button variant="primary" icon={<PrinterIcon />} onClick={() => window.print()}>
                Drucken
              </Button>
            )}
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

          {printing.hasPrinter ? (
            <>
              {/* Was aus dem Etikett wird, steht gleich unter dem Code: dort, wo der Blick nach dem Drucken ist. */}
              {jobs.length > 0 ? (
                <LabelStatus jobIds={jobs} className={styles.status} />
              ) : single ? (
                <p className={styles.hint}>
                  {target ? `Das Etikett druckt „${target.name}“.` : "Dieser Zone ist kein Drucker zugeordnet: Das Etikett bliebe ausstehend, bis es einen Standarddrucker gibt."}
                </p>
              ) : null}
              <div className={styles.tools}>
                {single ? (
                  <Button size="sm" variant="ghost" icon={<EyeIcon />} aria-expanded={preview} onClick={() => setPreview(!preview)}>
                    Vorschau des Etiketts
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" icon={<PrinterIcon />} onClick={() => window.print()}>
                  Über den Browser drucken
                </Button>
              </div>
              {single && preview ? (
                <LabelImage load={() => core.print.preview({ kind: "zone", zone_id: single.id })} source={single.id} alt={`Vorschau des Etiketts für die Zone ${single.name}`} />
              ) : null}
            </>
          ) : null}
          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
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
