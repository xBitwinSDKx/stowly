import { useState } from "react";

import { useCore, useLive } from "@/contract";
import { Button, Dialog, dialogFocus } from "@/ui/base";
import { RefreshIcon } from "@/ui/icons";

import styles from "./SessionGate.module.css";

/**
 * Sperre über der ganzen App, wenn dieser Tab nicht weiterarbeiten kann (`update_required`):
 * Ein anderer Tab läuft schon mit einer neueren Version und hat die lokale Datenbank
 * übernommen. Der modale Dialog macht alles dahinter unbedienbar, auch offene Dialoge; er
 * lässt sich nicht schließen und hat genau eine Schaltfläche.
 */
export function UpdateRequired() {
  const core = useCore();
  const required = useLive(core.app.state)?.update_required === true;
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    try {
      await core.app.applyUpdate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={required}
      onClose={() => undefined}
      dismissable={false}
      size="sm"
      title="Stowly wurde aktualisiert"
      footer={
        <Button ref={dialogFocus} variant="primary" block icon={<RefreshIcon />} busy={busy} onClick={() => void reload()}>
          Neu laden
        </Button>
      }
    >
      <div className={styles.lock}>
        <p>Stowly wurde in einem anderen Tab aktualisiert. Dieser Tab arbeitet noch mit der alten Version und kann nichts mehr speichern, bis er neu geladen ist.</p>
        <p className={styles.muted}>Was in einem Formular stand und noch nicht gespeichert war, geht dabei verloren.</p>
      </div>
    </Dialog>
  );
}
