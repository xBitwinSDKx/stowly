import { useCallback } from "react";

import { useCore, type SetupChanges, type SetupStatus } from "@/contract";
import { useLoaded, type LoadedResource } from "@/features/settings/loaded";

/** Was ohne Server fehlt. */
export const SETUP_OFFLINE = "Die Einrichtung braucht den Server, und der ist gerade nicht erreichbar.";

export interface SetupResource extends LoadedResource<SetupStatus> {
  /** `setup.update`; der neue Stand gilt danach auch hier. */
  update: (changes: SetupChanges) => Promise<SetupStatus>;
}

/**
 * Der Stand der Einrichtung vom Server (Muster `useIntegrations`): beim Öffnen und noch einmal,
 * sobald der Server wieder erreichbar ist. Was `update` zurückbringt, gilt sofort.
 */
export function useSetup(): SetupResource {
  const core = useCore();
  const loaded = useLoaded(() => core.setup.load(), SETUP_OFFLINE);
  const { set } = loaded;
  const update = useCallback(
    async (changes: SetupChanges) => {
      const next = await core.setup.update(changes);
      set(next);
      return next;
    },
    [core, set],
  );
  return { ...loaded, update };
}
