/**
 * age-Schlüssel im Browser gegen die Schlüsselpaare von pyrage (docs/vectors.json, `age_keys`):
 * Was die App erzeugt und prüft, muss der Server (pyrage) genauso sehen.
 */
import { describe, expect, it } from "vitest";

import rawVectors from "../../../../docs/vectors.json";

import { checkSecret, generateKeyPair, identitiesOf, keyFile, keyFileName, looksSecret, normalizePublic, publicOf, rfc3339, shortKey } from "./keys";
import { loadKeys } from "./load";

interface AgeKeyVectors {
  pairs: { secret: string; public: string }[];
  key_file: { text: string; public: string };
  invalid_secrets: string[];
  invalid_publics: string[];
  case_variants: { secret_lower: string; public_upper: string; public: string };
}

const vectors = (rawVectors as unknown as { age_keys: AgeKeyVectors }).age_keys;

describe("Schlüsselpaare wie pyrage", () => {
  it("errechnet aus jedem geheimen Schlüssel den öffentlichen", () => {
    expect(vectors.pairs.length).toBeGreaterThanOrEqual(3);
    for (const pair of vectors.pairs) {
      expect(publicOf(pair.secret), pair.secret).toBe(pair.public);
      expect(normalizePublic(pair.public)).toBe(pair.public);
    }
  });

  it("liest die Schlüsseldatei von age-keygen: Zeilen mit # zählen nicht", () => {
    expect(identitiesOf(vectors.key_file.text)).toEqual([vectors.key_file.public]);
    // Auch mit Windows-Zeilenenden und Leerraum am Rand.
    expect(identitiesOf(`\r\n  ${vectors.key_file.text.replaceAll("\n", "\r\n")}  `)).toEqual([vectors.key_file.public]);
    // Nur Kommentare: kein Schlüssel.
    expect(identitiesOf("# created: 2026-11-16T20:00:00+01:00\n# public key: age1…\n")).toBeNull();
  });

  it("lehnt ungültige geheime und öffentliche Schlüssel ab", () => {
    for (const secret of vectors.invalid_secrets) {
      expect(publicOf(secret), JSON.stringify(secret)).toBeNull();
      expect(identitiesOf(secret), JSON.stringify(secret)).toBeNull();
    }
    for (const candidate of vectors.invalid_publics) {
      expect(normalizePublic(candidate), candidate).toBeNull();
    }
  });

  it("nimmt Groß- und Kleinschreibung, solange sie nicht gemischt ist", () => {
    const variants = vectors.case_variants;
    expect(publicOf(variants.secret_lower)).toBe(variants.public);
    expect(normalizePublic(variants.public_upper)).toBe(variants.public);
    expect(normalizePublic(`  ${variants.public}\n`)).toBe(variants.public);
  });
});

describe("Erzeugen", () => {
  it("baut ein Paar wie age-keygen: groß geschriebenes Geheimnis, passender öffentlicher Schlüssel", () => {
    const pair = generateKeyPair();
    expect(pair.secret).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(pair.public).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    expect(publicOf(pair.secret)).toBe(pair.public);
    // Jedes Mal ein anderes.
    expect(generateKeyPair().secret).not.toBe(pair.secret);
  });

  it("nimmt die Bytes des Zufalls so, wie age sie nimmt (Probe mit den Bytes eines Vektors)", () => {
    const first = vectors.pairs[0];
    if (!first) {
      throw new Error("Kein Vektor");
    }
    // Die 32 Byte des geheimen Schlüssels aus dem Vektor als „Zufall": dasselbe Paar kommt heraus.
    const words = decodeWords(first.secret);
    const pair = generateKeyPair((bytes) => {
      bytes.set(words);
      return bytes;
    });
    expect(pair).toEqual({ secret: first.secret, public: first.public });
  });

  it("schreibt die Schlüsseldatei wie age-keygen", () => {
    const first = vectors.pairs[0];
    if (!first) {
      throw new Error("Kein Vektor");
    }
    expect(keyFile(first, "2026-11-16T20:00:00+01:00")).toBe(vectors.key_file.text);
    expect(rfc3339(new Date("2026-11-16T19:00:00Z"), 60)).toBe("2026-11-16T20:00:00+01:00");
    expect(rfc3339(new Date("2026-11-16T19:00:00Z"), 0)).toBe("2026-11-16T19:00:00Z");
    expect(rfc3339(new Date("2026-11-16T19:00:00Z"), -330)).toBe("2026-11-16T13:30:00-05:30");
    expect(keyFileName(new Date())).toMatch(/^stowly-schluessel-\d{4}-\d{2}-\d{2}\.txt$/);
  });
});

describe("Prüfen", () => {
  const [one, two, three] = vectors.pairs;
  if (!one || !two || !three) {
    throw new Error("Zu wenige Vektoren");
  }

  it("sagt, zu welchem gespeicherten Schlüssel ein geheimer passt", () => {
    expect(checkSecret(one.secret, [two.public, one.public])).toEqual({ kind: "match", public: one.public });
    expect(checkSecret(vectors.key_file.text, [one.public])).toEqual({ kind: "match", public: one.public });
    // Gespeichert groß geschrieben: zählt trotzdem.
    expect(checkSecret(one.secret.toLowerCase(), [one.public.toUpperCase()])).toEqual({ kind: "match", public: one.public });
    expect(checkSecret(three.secret, [one.public, two.public])).toEqual({ kind: "no_match", publics: [three.public] });
    expect(checkSecret("kein Schlüssel", [one.public])).toEqual({ kind: "invalid" });
    expect(checkSecret(one.public, [one.public])).toEqual({ kind: "invalid" });
  });

  it("erkennt einen geheimen Schlüssel, der nicht an den Server darf, und kürzt öffentliche wie der Server", () => {
    expect(looksSecret(one.secret)).toBe(true);
    expect(looksSecret(` x ${one.secret.toLowerCase()}`)).toBe(true);
    expect(looksSecret(one.public)).toBe(false);
    expect(shortKey(one.public)).toBe(`${one.public.slice(0, 8)}…${one.public.slice(-4)}`);
  });
});

describe("Nachladen", () => {
  it("lädt den Teil mit den Schlüsseln einmal", async () => {
    const first = loadKeys();
    expect(loadKeys()).toBe(first);
    expect(typeof (await first).generateKeyPair).toBe("function");
  });
});

/** Die 32 Byte hinter einem geheimen Schlüssel, ohne die Bibliothek der App (bech32 von Hand). */
function decodeWords(secret: string): Uint8Array {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = secret.toLowerCase().slice(secret.lastIndexOf("1") + 1, -6);
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of data) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes.slice(0, 32));
}
