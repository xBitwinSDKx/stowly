import { useState } from "react";

import { ROUTES, useCore, useLive } from "@/contract";
import { Notice, useUiFlag } from "@/ui";
import { Button, ButtonLink } from "@/ui/base";
import { InstallIcon, ShareIcon } from "@/ui/icons";

import { refocusContent } from "./focus";
import styles from "./Shell.module.css";

/**
 * Einmaliger, ausblendbarer Hinweis, Stowly als App zu installieren.
 *
 * - Bietet der Browser die Installation an (`can_install`, Android und Desktop): eine Schaltfläche.
 * - Auf dem iPhone gibt es keine Aufforderung (`manual_install: "ios"`): die Anleitung in Kurzform,
 *   mit dem Grund, warum es sich dort besonders lohnt.
 * - Installiert, oder einmal ausgeblendet: nichts. Die Einstellungen zeigen dasselbe dauerhaft.
 */
export function InstallHint() {
  const core = useCore();
  const app = useLive(core.app.state);
  const [dismissed, setDismissed] = useUiFlag("install-hint.dismissed", false);
  const [busy, setBusy] = useState(false);

  if (!app || app.installed || dismissed) {
    return null;
  }

  async function install() {
    setBusy(true);
    try {
      await core.app.promptInstall();
    } finally {
      setBusy(false);
      refocusContent();
    }
  }

  function later() {
    setDismissed(true);
    refocusContent();
  }

  if (app.can_install) {
    return (
      <Notice
        banner
        tone="accent"
        icon={<InstallIcon />}
        title="Stowly als App installieren"
        action={
          <div className={styles.bannerActions}>
            <Button size="sm" variant="primary" busy={busy} onClick={() => void install()}>
              Installieren
            </Button>
            <Button size="sm" variant="ghost" onClick={later}>
              Später
            </Button>
          </div>
        }
      >
        Installiert startet Stowly vom Home-Bildschirm wie eine App, und der Browser behält die Daten für den Betrieb ohne Netz.
      </Notice>
    );
  }
  if (app.manual_install === "ios") {
    return (
      <Notice
        banner
        tone="accent"
        icon={<ShareIcon />}
        title="Stowly zum Home-Bildschirm hinzufügen"
        action={
          <div className={styles.bannerActions}>
            <ButtonLink size="sm" to={{ pathname: ROUTES.settings, hash: "#app" }}>
              Anleitung
            </ButtonLink>
            <Button size="sm" variant="ghost" onClick={later}>
              Später
            </Button>
          </div>
        }
      >
        In Safari auf „Teilen“ tippen, dann auf „Zum Home-Bildschirm“. Ohne Installation löscht Safari die lokalen Daten nach sieben Tagen ohne Nutzung.
      </Notice>
    );
  }
  return null;
}
