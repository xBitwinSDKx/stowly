/**
 * Das YAML für Home Assistant gegen docs/betrieb.md: Mit der Beispiel-Adresse der Doku und dem
 * Platzhalter „…" für den Token muss die App genau die Blöcke aus 18.2 (Sensor, Vorlagen) und 18.4
 * (Bestand, `recorder`) liefern, beide `rest`-Einträge unter einem `rest:`.
 */
import { describe, expect, it } from "vitest";

import betrieb from "../../../../docs/betrieb.md?raw";

import { ENV_TOKEN_PLACEHOLDER, haSnippet, usesOwnCa } from "./haSnippet";

/** Alle YAML-Blöcke der Datei, als Zeilen. */
function yamlBlocks(markdown: string): string[][] {
  return Array.from(markdown.replaceAll("\r\n", "\n").matchAll(/```yaml\n([\s\S]*?)```/g), (match) => (match[1] ?? "").replace(/\n$/, "").split("\n"));
}

/** Ein Abschnitt oberster Ebene (`template:`, `recorder:`) bis zur nächsten Leerzeile oder dem Ende. */
function section(lines: readonly string[], key: string): string[] {
  const start = lines.indexOf(`${key}:`);
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && (line === "" || /^\S/.test(line)));
  return lines.slice(start, end === -1 ? undefined : end);
}

/** Die Einträge unter `rest:`, je Eintrag seine Zeilen. */
function restItems(lines: readonly string[]): string[][] {
  const items: string[][] = [];
  for (const line of section(lines, "rest").slice(1)) {
    if (line.startsWith("  - ")) {
      items.push([line]);
    } else {
      items.at(-1)?.push(line);
    }
  }
  return items;
}

describe("YAML für Home Assistant", () => {
  const blocks = yamlBlocks(betrieb);
  const doc = haSnippet({ origin: "https://stowly.example", token: "…", ownCa: false });

  it("findet die Blöcke in docs/betrieb.md", () => {
    expect(blocks.some((block) => block.includes("# secrets.yaml"))).toBe(true);
    expect(blocks.flatMap(restItems).map((item) => item[0])).toEqual(
      expect.arrayContaining(["  - resource: https://stowly.example/api/ha/summary", "  - resource: https://stowly.example/api/ha/stock"]),
    );
  });

  it("liefert für die Adresse der Doku genau deren secrets.yaml", () => {
    const secrets = blocks.find((block) => block[0] === "# secrets.yaml");
    expect(doc.secrets).toBe(`${(secrets ?? []).join("\n")}\n`);
  });

  it("liefert für die Adresse der Doku genau deren Sensor, Vorlagen, Bestand und Ausschluss", () => {
    const items = blocks.flatMap(restItems);
    const summary = items.find((item) => item[0]?.endsWith("/api/ha/summary"));
    const stock = items.find((item) => item[0]?.endsWith("/api/ha/stock"));
    const template = blocks.map((block) => section(block, "template")).find((lines) => lines.length > 0);
    const recorder = blocks.map((block) => section(block, "recorder")).find((lines) => lines.length > 0);
    expect(summary && stock && template && recorder).toBeTruthy();
    const expected = ["# configuration.yaml", "rest:", ...(summary ?? []), ...(stock ?? []), "", ...(template ?? []), "", ...(recorder ?? []), ""].join("\n");
    expect(doc.configuration).toBe(expected);
  });

  it("nimmt die Adresse der App, den Token oder einen Platzhalter und verify_ssl bei eigener CA", () => {
    const own = haSnippet({ origin: "https://192.168.1.10:8443/", token: "a".repeat(64), ownCa: true });
    expect(own.secrets).toBe(`# secrets.yaml\nstowly_summary_auth: "Bearer ${"a".repeat(64)}"\n`);
    expect(own.configuration).toContain("  - resource: https://192.168.1.10:8443/api/ha/summary\n    # Stowly hat ein Zertifikat");
    expect(own.configuration.match(/^ {4}verify_ssl: false$/gm)).toHaveLength(2);
    expect(doc.configuration).not.toContain("verify_ssl");

    const env = haSnippet({ origin: "http://stowly.local:8010", token: null, ownCa: false });
    expect(env.secrets).toContain(`"Bearer ${ENV_TOKEN_PLACEHOLDER}"`);
    expect(env.configuration).toContain("resource: http://stowly.local:8010/api/ha/stock");
  });

  it("erkennt die eigene CA von Stowly an seinem HTTPS-Listener, nicht hinter einem Proxy", () => {
    const https = { ca: { name: "Stowly CA" }, via_https: false, origins: ["https://192.168.1.10:8443"] };
    expect(usesOwnCa({ protocol: "https:", origin: "https://192.168.1.10:8443" }, https)).toBe(true);
    expect(usesOwnCa({ protocol: "https:", origin: "https://stowly.example" }, https)).toBe(false);
    expect(usesOwnCa({ protocol: "https:", origin: "https://nas:8443" }, { ...https, via_https: true })).toBe(true);
    expect(usesOwnCa({ protocol: "http:", origin: "http://192.168.1.10:8010" }, https)).toBe(false);
    expect(usesOwnCa({ protocol: "https:", origin: "https://192.168.1.10:8443" }, { ...https, ca: null })).toBe(false);
    expect(usesOwnCa({ protocol: "https:", origin: "https://192.168.1.10:8443" }, null)).toBe(false);
  });
});
