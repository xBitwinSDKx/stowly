import { useId, useState, type FormEvent } from "react";

import { useCore, type Zone } from "@/contract";
import { errorText, Notice, packagesText, Select } from "@/ui";
import { Button, Dialog, useToast } from "@/ui/base";

import styles from "./ZoneDialog.module.css";

export interface DeleteZoneDialogProps {
  zone: Zone;
  /** Alle Zonen in ihrer Reihenfolge (auch die zu löschende). */
  zones: readonly Zone[];
  /** Packungen im Bestand, die in dieser Zone liegen. */
  packageCount: number;
  /** Diese Zone ist gerade die Primärzone. */
  primary: boolean;
  onClose: () => void;
}

/** Zone löschen: Ihre Packungen wandern in eine Zielzone, die hier gewählt wird. */
export function DeleteZoneDialog({ zone, zones, packageCount, primary, onClose }: DeleteZoneDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const targets = zones.filter((candidate) => candidate.id !== zone.id);
  const [moveTo, setMoveTo] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = targets.find((candidate) => candidate.id === moveTo);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.zones.remove(zone.id, target.id);
      toast.show({
        message: packageCount > 0 ? `Zone „${zone.name}“ gelöscht, ${packagesText(packageCount)} nach „${target.name}“ verschoben` : `Zone „${zone.name}“ gelöscht`,
        tone: "success",
      });
      onClose();
    } catch (caught) {
      setError(
        errorText(caught, {
          last_zone: "Die letzte Zone lässt sich nicht löschen: Jede Packung braucht einen Lagerort.",
          not_found: "Diese Zone oder die Zielzone gibt es nicht mehr.",
          invalid: "Die Packungen müssen in eine andere Zone wandern.",
        }),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={`Zone „${zone.name}“ löschen`}
      size="sm"
      variant="sheet"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="danger" busy={busy} disabled={!target}>
            Zone löschen
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)}>
        {targets.length === 0 ? (
          <Notice tone="warn">Die letzte Zone lässt sich nicht löschen: Jede Packung braucht einen Lagerort.</Notice>
        ) : (
          <>
            <Select
              label={packageCount > 0 ? `Wohin mit ${packageCount === 1 ? "der Packung" : `den ${packagesText(packageCount)}`}?` : "Zielzone"}
              value={moveTo}
              onChange={setMoveTo}
              options={targets.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              hint={
                packageCount > 0
                  ? "Alle Packungen dieser Zone wandern in die Zielzone, auch die in der Lösch-Historie."
                  : "In dieser Zone liegt nichts. Die Zielzone übernimmt nur, was sich später noch auf diese Zone bezieht."
              }
            />
            {primary ? <Notice tone="info">Diese Zone ist die Primärzone. Nach dem Löschen übernimmt die Zielzone diese Rolle.</Notice> : null}
          </>
        )}
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
