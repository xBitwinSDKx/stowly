import { useState } from "react";

import { formatTimestamp, isCoreError, useCore, type RestoreStatus } from "@/contract";
import { useLoaded } from "@/features/settings/loaded";
import { ConfirmDialog, errorText, List, ListRow, Notice } from "@/ui";
import { Button, Dialog, Spinner } from "@/ui/base";
import { RestoreIcon, TrashIcon, UndoIcon, WarningIcon } from "@/ui/icons";

import styles from "./Backup.module.css";
import { reloadPage } from "./files";
import { RestoreFlow } from "./RestoreFlow";

const OFFLINE = "Den Stand des Zurückspielens kennt nur der Server, und der ist gerade nicht erreichbar.";

/** Geht „Rückgängig" noch? Bis `undo_until`, nach der Uhr dieses Geräts. */
export function canUndo(status: Pick<RestoreStatus, "undo_until"> | null, now: number = Date.now()): boolean {
  return status?.undo_until != null && Date.parse(status.undo_until) > now;
}

/**
 * „Zurückspielen" in den Einstellungen eines laufenden Stowly: der Knopf öffnet die Schritte
 * (`RestoreFlow`) in einem Dialog; nach einem Zurückspielen sieben Tage lang „Rückgängig" und
 * „Alte Datenbank löschen". Ist es gescheitert, steht der Grund da.
 */
export function RestorePanel() {
  const core = useCore();
  const restore = useLoaded(() => core.restore.status(), OFFLINE);
  const [open, setOpen] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = restore.state.status === "ready" ? restore.state.value : null;
  // Ein Server ohne Zurückspielen (vor Stufe B) kennt den Aufruf nicht: Dann gibt es hier nichts.
  const unsupported = restore.state.status === "error" && restore.state.code === "not_supported";

  async function undo() {
    await core.restore.undo();
    setUndoing(false);
    setRestarting(true);
    try {
      const after = await core.restore.waitForRestart();
      if (after.state === "failed") {
        setRestarting(false);
        restore.set(after);
        return;
      }
      reloadPage();
    } catch (caught) {
      setRestarting(false);
      setError(errorText(caught, { offline: "Stowly ist nach dem Neustart nicht wieder erreichbar. Bitte die Seite später neu laden." }));
    }
  }

  async function discard() {
    await core.restore.discardPrevious();
    setDiscarding(false);
    restore.reload();
  }

  return (
    <div className={styles.stack}>
      {status?.state === "failed" ? (
        <Notice tone="danger" icon={<WarningIcon />} title="Das Zurückspielen ist gescheitert" role="alert">
          {status.message ?? "Die bisherige Datenbank läuft weiter."}
        </Notice>
      ) : null}
      {restarting ? (
        <Notice tone="info" icon={<Spinner />} title="Stowly startet neu …" role="status">
          Die Datenbank von vor dem Zurückspielen kommt zurück. Danach lädt die Seite neu.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <List>
        <ListRow
          label="Sicherung zurückspielen"
          hint="Der Bestand aus einer Sicherung ersetzt den jetzigen. Geräte, Passwort und Einstellungen bleiben; alle Geräte laden danach neu."
        >
          <Button icon={<RestoreIcon />} disabled={unsupported || restarting} onClick={() => setOpen(true)}>
            Zurückspielen …
          </Button>
        </ListRow>
        {status && canUndo(status) && status.at ? (
          <ListRow
            label={status.state === "undone" ? `Rückgängig gemacht am ${formatTimestamp(status.at)}` : `Zurückgespielt am ${formatTimestamp(status.at)}`}
            hint={`Bis ${formatTimestamp(status.undo_until ?? "")} lässt sich das umkehren; danach löscht Stowly die Datenbank von davor.`}
          >
            <div className={styles.actions}>
              <Button icon={<UndoIcon />} disabled={restarting} onClick={() => setUndoing(true)}>
                Rückgängig
              </Button>
              <Button variant="ghost" icon={<TrashIcon />} disabled={restarting} onClick={() => setDiscarding(true)}>
                Alte Datenbank löschen
              </Button>
            </div>
          </ListRow>
        ) : null}
      </List>
      {unsupported ? <p className={styles.small}>Dieser Server kann noch keine Sicherung zurückspielen. Erst Stowly aktualisieren.</p> : null}

      <Dialog open={open} onClose={() => setOpen(false)} busy={flowBusy} title="Sicherung zurückspielen" size="md">
        <RestoreFlow mode="running" framed={false} onCancel={() => setOpen(false)} onBusyChange={setFlowBusy} />
      </Dialog>
      <ConfirmDialog
        open={undoing}
        onClose={() => setUndoing(false)}
        title="Zurückspielen rückgängig machen?"
        confirmLabel="Rückgängig machen"
        tone="danger"
        onConfirm={undo}
        errorText={(caught) => (isCoreError(caught, "not_found") ? "Es gibt nichts mehr zurückzunehmen." : errorText(caught, { offline: OFFLINE }))}
      >
        <p>Stowly holt die Datenbank von vor dem Zurückspielen zurück und startet neu. Was seitdem geändert wurde, geht dabei verloren; auch das lässt sich wieder umkehren.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title="Alte Datenbank löschen?"
        confirmLabel="Löschen"
        tone="danger"
        onConfirm={discard}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>Danach lässt sich das Zurückspielen nicht mehr rückgängig machen.</p>
      </ConfirmDialog>
    </div>
  );
}
