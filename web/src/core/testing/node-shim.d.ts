/**
 * Das Wenige, das die Tests des Kerns von Node brauchen: eine Datei aus node_modules lesen
 * (die .wasm-Dateien der Barcode-Erkennung). Von Hand notiert, damit die Typprüfung des
 * Kerns ohne die Typen von Node auskommt (siehe tsconfig.core.json).
 */
declare module "node:fs" {
  /** Liest eine Datei vollständig; relative Pfade gelten ab dem Arbeitsverzeichnis (web/). */
  export function readFileSync(path: string): Uint8Array;
}
