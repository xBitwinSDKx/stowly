import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Ausprägungen derselben App:
 *
 *   npm run dev / build            echter Offline-Kern (src/core), Service Worker, /api geht an den Server
 *   npm run dev:mock / build:mock  Attrappe mit Beispieldaten (src/mock), kein Server, kein Service Worker
 *   npm run dev:fake               echter Offline-Kern gegen eine nachgebaute Schnittstelle im selben
 *                                  Prozess (src/core/testing/fake-api.ts), ohne Server
 *
 * Die Weiche ist der Alias "@entry": src/entry.real.ts oder src/entry.mock.ts.
 */

const FAKE_API_MODULE = "/src/core/testing/fake-api.ts";

/** Hängt die nachgebaute Schnittstelle als Middleware in den Entwicklungsserver (nur dev:fake). */
function fakeApi(): Plugin {
  return {
    name: "stowly-fake-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/") && !request.url?.startsWith("/print/")) {
          next();
          return;
        }
        // ssrLoadModule liefert das Modul aus dem Zwischenspeicher und lädt es neu, sobald sich
        // die Datei ändert. Sein Zustand geht dabei verloren, sofern er nicht an globalThis hängt.
        server
          .ssrLoadModule(FAKE_API_MODULE)
          .then((module) => (module.default as (req: unknown, res: unknown, next: () => void) => void)(request, response, next))
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ error: { code: "internal", message: String(error), details: null } }));
          });
      });
    },
  };
}

/** Port aus der Befehlszeile (--port 8012), falls angegeben. */
function portArgument(): string | null {
  const index = process.argv.indexOf("--port");
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

export default defineConfig(({ mode }) => {
  const mock = mode === "mock";
  const fake = mode === "fake";
  const src = fileURLToPath(new URL("./src", import.meta.url));
  // Wohin der Entwicklungsserver /api und /print weiterreicht.
  const api = process.env.STOWLY_API ?? "http://127.0.0.1:8010";
  const port = portArgument();

  const plugins: PluginOption[] = [react()];
  if (fake) {
    plugins.push(fakeApi());
  }
  if (!mock) {
    plugins.push(
      VitePWA({
        // Eigener Service Worker (src/sw.ts); das Plugin setzt nur die Liste der Dateien ein.
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        // Registriert wird im Offline-Kern, das Manifest liegt als Datei in public/.
        injectRegister: false,
        manifest: false,
        injectManifest: {
          // .wasm gehört dazu: Die Barcode-Erkennung für Safari muss offline vorliegen.
          globPatterns: ["**/*.{js,css,html,svg,png,ico,wasm,webmanifest,woff2}"],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    );
  }

  return {
    plugins,
    resolve: {
      alias: [
        { find: "@entry", replacement: `${src}/entry.${mock ? "mock" : "real"}.ts` },
        { find: /^@\//, replacement: `${src}/` },
      ],
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
      __APP_BUILD__: JSON.stringify(new Date().toISOString()),
    },
    // Je Ausprägung und Port ein eigener Zwischenspeicher: Mehrere Entwicklungsserver im
    // selben Ordner kommen sich so nicht in die Quere.
    cacheDir: `node_modules/.vite-${mode}${port ? `-${port}` : ""}`,
    server: {
      port: 5173,
      strictPort: true,
      proxy: mock || fake ? undefined : { "/api": api, "/print": api },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: mock ? undefined : { "/api": api, "/print": api },
    },
    build: {
      outDir: mock ? "dist-mock" : "dist",
      target: "es2022",
      sourcemap: true,
    },
  };
});
