/**
 * Die Scan-Ansicht.
 *
 * Die Nahtstelle zu src/entry.real.ts:
 *
 *   export function ScanPage(): JSX.Element     (ohne Props, füllt den ganzen Bildschirm)
 *
 * Sie liegt unter ROUTES.scan außerhalb des Rahmens der App, aber innerhalb von Router,
 * <CoreProvider> und <ToastProvider>. Sie benutzt nur die Schnittstelle `Core` und den
 * Scanner (src/core/scanner) und läuft deshalb auch auf der Attrappe.
 *
 *   ScanPage.tsx      die Ansicht: Kamerabild, Zonenleiste, Menge, Meldungen
 *   scan-flow.ts      was ein Scan bedeutet; Eingabe von Hand
 *   zone-logic.ts     in welche Zone eingelagert wird (Modus „Primärzone" und „gleichwertig")
 *   StoreSheet.tsx    MHD und Menge beim Einlagern
 *   useScanner.ts     Kamera an und aus mit der Ansicht
 */
import { installAudioUnlock } from "@/core/scanner";

// Der Ton braucht eine Berührung, bevor er spielen darf. Die erste Berührung irgendwo in der
// App (meist das Tippen auf „Jetzt scannen") entsperrt ihn, noch bevor die Ansicht offen ist.
if (typeof document !== "undefined") {
  installAudioUnlock(document);
}

export { ScanPage } from "./ScanPage";
