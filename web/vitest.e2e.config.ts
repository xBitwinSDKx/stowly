import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Der echte Offline-Kern gegen den echten Server:
 *
 *   npm run test:e2e
 *
 * Eine eigene Konfiguration und nicht Teil von `npm test`, weil diese Tests die
 * Python-Umgebung des Servers brauchen (e2e/support/server.ts). Jede Testdatei startet
 * ihren eigenen Server als Prozess: freier Port, eigenes temporäres Datenverzeichnis,
 * Open Food Facts ausgeschaltet.
 *
 * Die Umgebung ist "node", nicht "jsdom": Der Kern braucht kein DOM (er läuft so auch im
 * Service Worker), und das `fetch` von Node verträgt sich nicht mit dem AbortController,
 * den jsdom mitbringt. IndexedDB kommt aus fake-indexeddb.
 */
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("0.0.0-e2e"), __APP_BUILD__: JSON.stringify("2026-11-14T00:00:00.000Z") },
  resolve: {
    alias: [
      { find: "@entry", replacement: `${src}/entry.real.ts` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    name: "e2e",
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    setupFiles: ["e2e/support/setup.ts"],
    globalSetup: ["e2e/support/global-setup.ts"],
    // Eigene Prozesse: Nur dort ist sicher, dass beim Ende eines Tests auch sein Server endet.
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
