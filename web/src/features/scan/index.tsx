/**
 * Die Scan-Ansicht. GRUNDGERÜST: Worker 3 ersetzt diese Datei in Runde 1.
 *
 * Fest steht nur die Nahtstelle zu src/entry.real.ts:
 *
 *   export function ScanPage(): JSX.Element     (ohne Props, füllt den ganzen Bildschirm)
 *
 * Die Ansicht liegt unter ROUTES.scan außerhalb des Rahmens der App, aber innerhalb von
 * Router, <CoreProvider> und <ToastProvider>: `useCore()`, `useToast()` und die
 * Navigation von react-router stehen zur Verfügung.
 */
import { Link } from "react-router";

import { ROUTES } from "@/contract";
import { Card } from "@/ui/base";

export function ScanPage() {
  return (
    <main style={{ display: "grid", gap: "var(--space-4)", maxWidth: "32rem", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
      <h1>Scannen</h1>
      <Card tone="info">
        <p>Die Scan-Ansicht ist noch nicht gebaut (Runde 1).</p>
      </Card>
      <Link to={ROUTES.stock}>Zurück zum Bestand</Link>
    </main>
  );
}
