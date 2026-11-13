/**
 * Einstieg der Web-App. Verdrahtet Kern, Scan-Ansicht und Oberfläche; sonst nichts.
 *
 * Welcher Kern läuft, entscheidet der Alias "@entry" (vite.config.ts):
 * der echte (src/core) oder die Attrappe (src/mock).
 */
import "./ui/tokens.css";
import "./ui/global.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createCore, ScanPage } from "@entry";

import { App } from "./app/App";
import { BootError } from "./BootError";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html enthält kein Element #root.");
}
const root = createRoot(container);

try {
  const core = createCore();
  root.render(
    <StrictMode>
      <App core={core} scanPage={ScanPage} />
    </StrictMode>,
  );
} catch (error) {
  root.render(<BootError error={error} />);
}
