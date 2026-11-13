/**
 * Texte der Scan-Ansicht, die mehr als eine Zeile brauchen: Warum läuft die Kamera nicht,
 * und was hilft?
 */
import type { ScannerErrorKind } from "@/core/scanner";

export interface CameraProblem {
  title: string;
  text: string;
  /** Lohnt ein neuer Versuch, ohne dass der Anwender vorher etwas ändert? */
  retry: boolean;
}

export const CAMERA_PROBLEMS: Record<ScannerErrorKind, CameraProblem> = {
  insecure: {
    title: "Die Kamera braucht die sichere Adresse",
    text: "Über diese Adresse (http) gibt der Browser die Kamera nicht frei. Öffne Stowly über seine HTTPS-Adresse, dann funktioniert auch das Scannen.",
    retry: false,
  },
  unsupported: {
    title: "Dieser Browser gibt die Kamera nicht her",
    text: "Der Browser bietet Webseiten hier keinen Zugriff auf die Kamera.",
    retry: false,
  },
  denied: {
    title: "Stowly darf die Kamera nicht benutzen",
    text: "Erlaube den Kamerazugriff für diese Seite in den Einstellungen des Browsers und versuche es dann erneut.",
    retry: true,
  },
  not_found: {
    title: "Keine Kamera gefunden",
    text: "An diesem Gerät ist keine Kamera angeschlossen oder freigegeben.",
    retry: true,
  },
  in_use: {
    title: "Die Kamera ist belegt",
    text: "Eine andere App oder ein anderer Tab benutzt sie gerade. Schließe sie dort und versuche es erneut.",
    retry: true,
  },
  detector: {
    title: "Die Erkennung ließ sich nicht laden",
    text: "Der Teil der App, der Barcodes liest, fehlt noch auf diesem Gerät. Lade die Seite einmal mit Netz neu.",
    retry: true,
  },
  failed: {
    title: "Die Kamera lässt sich nicht starten",
    text: "Der Browser meldet einen Fehler beim Öffnen der Kamera.",
    retry: true,
  },
};

export const MANUAL_HINT = "Packungs-ID oder Barcode lassen sich auch von Hand eingeben.";

export const MANUAL_ERRORS = {
  empty: "Bitte eine Packungs-ID oder einen Barcode eingeben.",
  barcode: "Die Prüfziffer dieses Barcodes stimmt nicht. Bitte noch einmal vergleichen.",
  unknown: "Das ist weder eine Packungs-ID (5 Zeichen) noch ein Barcode (8, 12 oder 13 Ziffern).",
} as const;
