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
 *   scan-flow.ts      was ein Scan bedeutet; Eingabe von Hand; FIFO-Hinweis und Einkaufsliste
 *   zone-logic.ts     in welche Zone eingelagert wird (Modus „Primärzone" und „gleichwertig")
 *   StoreSheet.tsx    MHD und Menge beim Einlagern
 *   useScanner.ts     Kamera an und aus mit der Ansicht
 *
 * Nachgeladen (Plan von Stufe 2, Entscheidung 8): Die Ansicht samt Kamera und Erkennung kommt
 * erst, wenn sie aufgerufen wird, als eigener Teil der App; das Hauptpaket bleibt so klein. Der
 * Service Worker hält den Teil vor, offline fehlt also nichts. Was sofort da sein muss, steht
 * hier: das Entsperren des Tons. Es hängt am Tippen, das zur Ansicht führt, und das liegt vor
 * dem Nachladen.
 *
 * Bewusst ohne `React.lazy` und Suspense, wie `lazyPage` im Rahmen (src/app/pages.tsx): React
 * hielte die Ansicht nach der Ladeanzeige sonst bis zu 300 Millisekunden zurück. Scheitert das
 * Laden, fängt der Router den Fehler ab („Neu laden"); ein späterer Aufruf versucht es neu.
 */
import { useEffect, useReducer, useState, type ComponentType } from "react";

import { installAudioUnlock } from "@/core/scanner/feedback";
import { Spinner } from "@/ui/base";

// Der Ton braucht eine Berührung, bevor er spielen darf. Die erste Berührung irgendwo in der
// App (meist das Tippen auf „Jetzt scannen") entsperrt ihn, noch bevor die Ansicht offen ist.
if (typeof document !== "undefined") {
  installAudioUnlock(document);
}

let Loaded: ComponentType | null = null;
let failure: { error: unknown } | null = null;
let pending: Promise<void> | null = null;

/** Holt die Ansicht. Mehrere Aufrufe teilen sich ein Laden; nach einem Fehlschlag darf der nächste es noch einmal versuchen. */
function load(): Promise<void> {
  if (Loaded) {
    return Promise.resolve();
  }
  pending ??= import("./ScanPage").then(
    (module) => {
      Loaded = module.ScanPage;
      failure = null;
    },
    (error: unknown) => {
      failure = { error };
      pending = null;
      throw error;
    },
  );
  return pending;
}

/** Solange die Ansicht lädt: dieselbe Fläche, eine Ladeanzeige. */
function ScanLoading() {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-nav)",
        display: "grid",
        placeItems: "center",
        background: "var(--color-bg)",
        color: "var(--color-text-muted)",
      }}
    >
      <Spinner size={28} label="Die Scan-Ansicht wird geladen" />
    </main>
  );
}

export function ScanPage() {
  const [, update] = useReducer((count: number) => count + 1, 0);
  // Ein Fehlschlag, der schon vor diesem Aufruf da war, gilt ihm nicht: Er versucht es neu.
  const [earlier] = useState(() => failure);
  useEffect(() => {
    if (Loaded) {
      return undefined;
    }
    let current = true;
    const settle = () => {
      if (current) {
        update();
      }
    };
    load().then(settle, settle);
    return () => {
      current = false;
    };
  }, []);
  if (Loaded) {
    return <Loaded />;
  }
  if (failure !== null && failure !== earlier) {
    throw failure.error;
  }
  return <ScanLoading />;
}

/** Holt die Ansicht vorab, etwa wenn der Rahmen alle Ansichten vorlädt. Wirft nicht. */
ScanPage.preload = (): Promise<void> => load().catch(() => undefined);
