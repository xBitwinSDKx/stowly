import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Drei getrennte Test-Projekte, damit jeder Bereich für sich prüfbar ist:
 *
 *   npm run test:contract   src/contract            reine Logik, ohne Browser-Umgebung
 *   npm run test:ui         Oberfläche und Attrappe  jsdom; "@entry" zeigt auf die Attrappe
 *   npm run test:core       src/core, features/scan  jsdom und IndexedDB (fake-indexeddb)
 *   npm test                alle
 *
 * Tests importieren describe/it/expect ausdrücklich aus "vitest" (keine globalen Namen).
 */
function alias(entry: "mock" | "real") {
  return [
    { find: "@entry", replacement: `${src}/entry.${entry}.ts` },
    { find: /^@\//, replacement: `${src}/` },
  ];
}

const define = { __APP_VERSION__: JSON.stringify("0.0.0-test"), __APP_BUILD__: JSON.stringify("2026-11-14T00:00:00.000Z") };

export default defineConfig({
  test: {
    projects: [
      {
        define,
        resolve: { alias: alias("mock") },
        test: {
          name: "contract",
          environment: "node",
          include: ["src/contract/**/*.test.{ts,tsx}"],
        },
      },
      {
        plugins: [react()],
        define,
        resolve: { alias: alias("mock") },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/{app,ui,mock,features}/**/*.test.{ts,tsx}", "src/*.test.{ts,tsx}"],
          exclude: ["src/features/scan/**"],
          setupFiles: ["src/test/setup.dom.ts", "src/ui/test-setup.ts"],
          css: { modules: { classNameStrategy: "non-scoped" } },
        },
      },
      {
        plugins: [react()],
        define,
        resolve: { alias: alias("real") },
        test: {
          name: "core",
          environment: "jsdom",
          include: ["src/core/**/*.test.{ts,tsx}", "src/features/scan/**/*.test.{ts,tsx}"],
          setupFiles: ["src/test/setup.dom.ts", "src/test/setup.core.ts", "src/core/test-setup.ts"],
          css: { modules: { classNameStrategy: "non-scoped" } },
        },
      },
    ],
  },
});
