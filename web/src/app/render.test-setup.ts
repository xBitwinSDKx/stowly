/**
 * Die ganze App auf der Attrappe, für die Tests der Ansichten:
 *
 *   const core = renderApp({ scenarios: ["single-zone"] }, ROUTES.zones);
 *
 * Kein eigener Test. Die Datei heißt "…test-setup.ts", weil nur Tests und Test-Hilfen
 * die Attrappe importieren dürfen (src/contract/boundaries.test.ts).
 */
import { render } from "@testing-library/react";
import { createElement } from "react";

import { ROUTES } from "@/contract";
import { createMockCore, MockScanPage, type MockCore, type MockOptions } from "@/mock";

import { App } from "./App";
import { preloadPages } from "./pages";

// Die Ansichten werden nachgeladen (pages.tsx). In den Tests stehen sie vorab bereit: So
// zeichnet die App wie bisher sofort, ohne dass jeder Test auf das Nachladen warten muss.
await preloadPages();

export function renderApp(options: MockOptions = {}, path: string = ROUTES.stock): MockCore {
  window.history.replaceState(null, "", path);
  const core = createMockCore({ latency: 0, ...options });
  render(createElement(App, { core, scanPage: MockScanPage }));
  return core;
}
