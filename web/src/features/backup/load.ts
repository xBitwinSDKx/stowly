/**
 * Lädt den Teil der App mit den age-Schlüsseln (./keys.ts) erst, wenn er gebraucht wird: Er bringt
 * die Bibliotheken für X25519 und bech32 mit und gehört weder ins Hauptpaket noch fest in die
 * Einstellungen oder den Assistenten.
 */
export type KeysModule = typeof import("./keys");

let loading: Promise<KeysModule> | null = null;

/** Der Teil mit den Schlüsseln; ein gescheitertes Laden darf ein späterer Aufruf noch einmal versuchen. */
export function loadKeys(): Promise<KeysModule> {
  loading ??= import("./keys").catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
