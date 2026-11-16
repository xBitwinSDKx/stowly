import { useEffect } from "react";
import { useNavigate } from "react-router";

import { isCoreError, ROUTES, useCore, useLive, type SetupStatus } from "@/contract";
import { useUiFlag } from "@/ui";

/** Ansichts-Vorlieben dieses Geräts (`useUiFlag`): Die Einrichtung ist abgeschlossen bzw. auf später verschoben. */
export const SETUP_DONE_FLAG = "setup.done";
export const SETUP_LATER_FLAG = "setup.later";

/** Die eine Nachfrage dieser Seite beim Server; geteilt, damit ein zweites Zeichnen nicht noch einmal fragt. */
let check: Promise<SetupStatus> | null = null;
/** Entschieden: Diese Seite führt nicht noch einmal in den Assistenten, auch nicht nach der Rückkehr von dort. */
let handled = false;

/** Für Tests: alles wieder auf Anfang. */
export function resetSetupAutoOpen(): void {
  check = null;
  handled = false;
}

/**
 * Öffnet den Assistenten von selbst, wenn die Einrichtung des Haushalts offen ist: einmal je
 * Seitenaufruf, nur mit erreichbarem Server, und nur, solange dieses Gerät weder „abgeschlossen"
 * (`setup.done`) noch „Später fortsetzen" (`setup.later`) kennt. Ist sie abgeschlossen, merkt sich
 * das Gerät das und fragt nie wieder; ebenso bei einem Server ohne Einrichtung (ältere Version).
 */
export function useSetupAutoOpen(): void {
  const core = useCore();
  const navigate = useNavigate();
  const online = useLive(core.sync.status)?.online === true;
  const [done, setDone] = useUiFlag(SETUP_DONE_FLAG, false);
  const [later] = useUiFlag(SETUP_LATER_FLAG, false);

  useEffect(() => {
    if (handled || done || later || !online) {
      return;
    }
    let active = true;
    check ??= core.setup.load();
    check.then(
      (status) => {
        if (!active || handled) {
          return;
        }
        handled = true;
        if (status.finished_at !== null) {
          setDone(true);
        } else {
          void navigate(ROUTES.setup);
        }
      },
      (error: unknown) => {
        if (!active || handled) {
          return;
        }
        if (isCoreError(error, "not_supported") || isCoreError(error, "not_found")) {
          // Ein Server ohne Einrichtung: Hier gibt es nichts einzurichten.
          handled = true;
          setDone(true);
        } else {
          // Etwa ohne Server: beim nächsten Kontakt noch einmal.
          check = null;
        }
      },
    );
    return () => {
      active = false;
    };
  }, [core, navigate, done, later, online, setDone]);
}
