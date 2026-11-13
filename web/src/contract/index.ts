/**
 * Der Vertrag der Web-App an einer Stelle: `import { … } from "@/contract"`.
 *
 * Dieser Ordner ist für beide Web-Worker eingefroren. Er enthält
 *   api.gen.ts   Datentypen und Konstanten, erzeugt aus den Python-Modellen des Servers
 *   core.ts      Schnittstelle des Offline-Kerns
 *   errors.ts    Fehler des Kerns
 *   ids.ts, qr.ts, barcode.ts, time.ts, mhd.ts, labels.ts   gemeinsame Regeln als Funktionen
 *   input.ts     Eingabegrenzen und ihre Prüfung, gemeinsam für Kern und Attrappe
 *   routes.ts    Adressen der Ansichten
 *   react.tsx    Anbindung an React
 */
export * from "./api.gen";
export * from "./barcode";
export * from "./core";
export * from "./errors";
export * from "./ids";
export * from "./input";
export * from "./labels";
export * from "./mhd";
export * from "./qr";
export * from "./react";
export * from "./routes";
export * from "./time";

/** Version der Web-App, beim Bauen eingesetzt. */
export const APP_VERSION: string = __APP_VERSION__;
