/**
 * Wer darf was importieren?
 *
 * Die Grenzen halten Oberfläche (Worker 2) und Kern/Scannen (Worker 3) auseinander:
 * Nur so lässt sich jeder Bereich für sich prüfen (typecheck:ui, typecheck:core), und
 * nur so bleibt die Oberfläche unabhängig davon, ob der echte Kern oder die Attrappe läuft.
 *
 *   contract        nur sich selbst
 *   ui/base         contract, ui/base
 *   ui              contract, ui
 *   mock            contract, ui
 *   features/*      contract, ui, app, andere features (außer scan)
 *   app             contract, ui, features (außer scan)
 *   core            contract
 *   features/scan   contract, ui/base, core
 *   sw.ts           contract, core
 *
 * Verdrahtet wird ausschließlich in main.tsx und entry.*.ts. Tests dürfen zusätzlich die
 * Attrappe (mock) verwenden.
 */
import { describe, expect, it } from "vitest";

type Area = "contract" | "ui" | "ui/base" | "mock" | "features" | "features/scan" | "app" | "core" | "sw" | "wiring" | "test";

const ALLOWED: Record<Area, Area[]> = {
  contract: ["contract"],
  // Die Grundbausteine stehen für sich: Was sie importieren, zieht die Typprüfung des Kerns mit.
  "ui/base": ["contract", "ui/base"],
  ui: ["contract", "ui", "ui/base"],
  mock: ["contract", "ui", "ui/base", "mock"],
  features: ["contract", "ui", "ui/base", "app", "features"],
  app: ["contract", "ui", "ui/base", "features", "app"],
  core: ["contract", "core"],
  "features/scan": ["contract", "ui/base", "core", "features/scan"],
  sw: ["contract", "core"],
  wiring: ["contract", "ui", "ui/base", "mock", "features", "features/scan", "app", "core", "wiring"],
  test: ["test"],
};

/** Bereich eines Pfads relativ zu src, z. B. "ui/base/Button.tsx" oder "features/scan". */
function areaOf(path: string): Area | null {
  // Mit Schrägstrich am Ende, damit auch ein Verzeichnis-Import ("@/features/scan") passt.
  const dir = `${path}/`;
  if (dir.startsWith("contract/")) return "contract";
  if (dir.startsWith("ui/base/")) return "ui/base";
  if (dir.startsWith("ui/")) return "ui";
  if (dir.startsWith("mock/")) return "mock";
  if (dir.startsWith("features/scan/")) return "features/scan";
  if (dir.startsWith("features/")) return "features";
  if (dir.startsWith("app/")) return "app";
  if (dir.startsWith("core/")) return "core";
  if (dir.startsWith("test/")) return "test";
  if (path === "sw.ts" || path === "sw") return "sw";
  if (!path.includes("/")) return "wiring";
  return null;
}

/** Alle Quelltexte unter src als Text, Schlüssel relativ zu src. */
function sources(): Map<string, string> {
  const modules = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.d.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const result = new Map<string, string>();
  for (const [key, text] of Object.entries(modules)) {
    const path = key.startsWith("./") ? `contract/${key.slice(2)}` : key.replace(/^\.\.\//, "");
    result.set(path, text);
  }
  return result;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function importsOf(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return Array.from(code.matchAll(IMPORT_RE), (match) => match[1] as string);
}

/** Löst einen Import zu einem Pfad relativ zu src auf; null für Pakete aus node_modules. */
function targetOf(file: string, specifier: string): string | null {
  const clean = specifier.replace(/\?.*$/, "");
  if (clean === "@entry") return "entry.real.ts";
  if (clean.startsWith("@/")) return clean.slice(2);
  if (!clean.startsWith(".")) return null;
  const parts = file.split("/").slice(0, -1);
  for (const segment of clean.split("/")) {
    if (segment === "..") {
      if (parts.length === 0) return null; // führt aus src heraus
      parts.pop();
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function isTest(file: string): boolean {
  return /\.test\.(ts|tsx)$/.test(file) || /test-setup\.ts$/.test(file);
}

describe("Import-Grenzen", () => {
  it("jeder Bereich importiert nur, was er darf", () => {
    const files = sources();
    expect(files.size).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const [file, text] of files) {
      // Diese Datei enthält Import-Beispiele als Text.
      if (file === "contract/boundaries.test.ts") continue;
      const from = areaOf(file);
      if (from === null) continue;
      for (const specifier of importsOf(text)) {
        const target = targetOf(file, specifier);
        if (target === null) continue;
        const to = areaOf(target);
        if (to === null) continue;
        const allowed = [...ALLOWED[from], ...(isTest(file) ? (["mock", "test"] as Area[]) : [])];
        if (!allowed.includes(to)) {
          violations.push(`${file}  importiert  ${specifier}  (${from} -> ${to})`);
        }
      }
    }
    expect(violations, `Unerlaubte Importe:\n${violations.join("\n")}`).toEqual([]);
  });

  it("ordnet Dateien und Verzeichnisse den Bereichen richtig zu", () => {
    expect(areaOf("ui/base/Button.tsx")).toBe("ui/base");
    expect(areaOf("ui/theme.ts")).toBe("ui");
    expect(areaOf("features/scan/index.tsx")).toBe("features/scan");
    expect(areaOf("features/stock/index.tsx")).toBe("features");
    expect(areaOf("main.tsx")).toBe("wiring");
    expect(areaOf("sw.ts")).toBe("sw");
    // Verzeichnis-Importe wie "@/features/scan" und "@/ui/base"
    expect(areaOf("features/scan")).toBe("features/scan");
    expect(areaOf("ui/base")).toBe("ui/base");
    expect(areaOf("mock")).toBe("mock");
  });

  it("löst Importe relativ zu src auf", () => {
    expect(targetOf("features/stock/List.tsx", "@/core/db")).toBe("core/db");
    expect(targetOf("features/stock/List.tsx", "../scan/ScanPage")).toBe("features/scan/ScanPage");
    expect(targetOf("ui/base/Button.tsx", "./Button.module.css")).toBe("ui/base/Button.module.css");
    expect(targetOf("app/App.tsx", "../features/scan")).toBe("features/scan");
    expect(targetOf("main.tsx", "@entry")).toBe("entry.real.ts");
    expect(targetOf("core/sync.ts", "dexie")).toBeNull();
    expect(targetOf("core/scanner.ts", "zxing-wasm/reader/zxing_reader.wasm?url")).toBeNull();
  });

  it("erkennt die verschiedenen Schreibweisen eines Imports", () => {
    const text = [
      'import { a } from "@/core/a";',
      "import type { B } from '../b';",
      'export * from "./c";',
      'const d = await import("@/features/scan");',
      'import "./e.css";',
      '// import { f } from "@/core/f";',
      '/* import { g } from "@/core/g"; */',
    ].join("\n");
    expect(importsOf(text)).toEqual(["@/core/a", "../b", "./c", "@/features/scan", "./e.css"]);
  });
});
