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

export function renderApp(options: MockOptions = {}, path: string = ROUTES.stock): MockCore {
  window.history.replaceState(null, "", path);
  const core = createMockCore({ latency: 0, ...options });
  render(createElement(App, { core, scanPage: MockScanPage }));
  return core;
}
