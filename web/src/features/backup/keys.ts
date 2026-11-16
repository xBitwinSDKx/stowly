/**
 * age-Schlüssel im Browser (docs/plan-einrichtung-b.md, Abschnitt 1, „Schlüssel im Browser").
 *
 * Ein Schlüsselpaar für X25519 wie von `age-keygen`: der geheime Teil `AGE-SECRET-KEY-1…` (bech32,
 * groß geschrieben) und der öffentliche `age1…`. Der Zufall kommt nur aus `crypto.getRandomValues`:
 * Das gibt es auch über http, `crypto.subtle` dort nicht. Nicht `age-encryption`: Es scheitert ohne
 * `crypto.subtle` und will womöglich bald Schlüssel, die pyrage auf dem Server nicht kennt.
 *
 * Der geheime Schlüssel verlässt das Gerät von hier aus nie: An den Server geht nur der öffentliche.
 * Zum Prüfen („passt mein gesicherter Schlüssel?") errechnet der Browser aus dem geheimen den
 * öffentlichen und vergleicht.
 *
 * Ein eigener, nachgeladener Teil der App (`loadKeys` in ./load.ts): Einstellungen und Assistent
 * holen ihn erst, wenn es um Schlüssel geht. Die Probe sind die Schlüsselpaare von pyrage in
 * docs/vectors.json (`age_keys`).
 */
import { montgomery } from "@noble/curves/abstract/montgomery.js";
import { pow } from "@noble/curves/abstract/modular.js";
import { bech32 } from "@scure/base";

/** Präfix (HRP) eines geheimen Schlüssels; age schreibt ihn groß. */
const SECRET_PREFIX = "age-secret-key-";
/** Präfix (HRP) eines öffentlichen Schlüssels. */
const PUBLIC_PREFIX = "age";
/** Ein X25519-Schlüssel hat 32 Byte. */
const KEY_BYTES = 32;

/** Die Primzahl von Curve25519, 2^255 − 19 (RFC 7748). */
const P = 2n ** 255n - 19n;

/**
 * X25519 nach RFC 7748, nur mit der Montgomery-Leiter. Bewusst nicht `x25519` aus
 * `@noble/curves/ed25519.js`: Das rechnet den öffentlichen Schlüssel schneller über die
 * Edwards-Kurve und zöge dafür ed25519 samt SHA-512 in diesen Teil der App. Für einen Schlüssel ab
 * und zu genügt die Leiter.
 */
const x25519 = montgomery({
  P,
  type: "x25519",
  powPminus2: (x: bigint) => pow(x, P - 2n, P),
  // Abschnitt 5: die drei untersten Bits löschen, das oberste löschen, das zweithöchste setzen.
  adjustScalarBytes: (bytes: Uint8Array): Uint8Array => {
    const scalar = Uint8Array.from(bytes);
    scalar[0] = (scalar[0] ?? 0) & 248;
    scalar[31] = ((scalar[31] ?? 0) & 127) | 64;
    return scalar;
  },
});

export interface AgeKeyPair {
  /** Der geheime Schlüssel, `AGE-SECRET-KEY-1…`. */
  secret: string;
  /** Der öffentliche Schlüssel, `age1…`. */
  public: string;
}

function encode(prefix: string, bytes: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(bytes));
}

/**
 * Die 32 Byte hinter einem bech32-Text mit diesem Präfix; null, wenn er das nicht ist. Groß- und
 * Kleinschreibung zählt nicht, solange sie nicht gemischt ist (wie bei pyrage).
 */
function decode(text: string, prefix: string): Uint8Array | null {
  try {
    const decoded = bech32.decode(text);
    if (decoded.prefix !== prefix) {
      return null;
    }
    const bytes = bech32.fromWords(decoded.words);
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function publicFor(secret: Uint8Array): string {
  return encode(PUBLIC_PREFIX, x25519.getPublicKey(secret));
}

/** Ein neues Schlüsselpaar. `random` füllt die 32 Byte des geheimen Schlüssels (Vorgabe: `crypto.getRandomValues`). */
export function generateKeyPair(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): AgeKeyPair {
  const secret = random(new Uint8Array(KEY_BYTES));
  const pair = { secret: encode(SECRET_PREFIX, secret).toUpperCase(), public: publicFor(secret) };
  secret.fill(0);
  return pair;
}

/** Der öffentliche Schlüssel zu einem geheimen (`AGE-SECRET-KEY-1…`); null, wenn der Text keiner ist. */
export function publicOf(secret: string): string | null {
  const bytes = decode(secret.trim(), SECRET_PREFIX);
  if (bytes === null) {
    return null;
  }
  const result = publicFor(bytes);
  bytes.fill(0);
  return result;
}

/** Ein öffentlicher Schlüssel in der Form, die der Server speichert (`age1…`, klein); null, wenn der Text keiner ist. */
export function normalizePublic(text: string): string | null {
  const trimmed = text.trim();
  return decode(trimmed, PUBLIC_PREFIX) === null ? null : trimmed.toLowerCase();
}

/** Steht da ein geheimer Schlüssel (oder etwas, das so anfängt)? Dann gehört der Text nicht an den Server. */
export function looksSecret(text: string): boolean {
  return /AGE-SECRET-KEY-/i.test(text);
}

/**
 * Die öffentlichen Schlüssel zu den geheimen in einem Text: eingefügt oder der Inhalt einer
 * Schlüsseldatei. Leere Zeilen und Zeilen mit # zählen nicht. null, wenn eine der übrigen Zeilen
 * kein geheimer Schlüssel ist oder es keine gibt.
 */
export function identitiesOf(text: string): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    return null;
  }
  const publics: string[] = [];
  for (const line of lines) {
    const found = publicOf(line);
    if (found === null) {
      return null;
    }
    publics.push(found);
  }
  return publics;
}

/** Was „Schlüssel prüfen" ergibt. */
export type KeyCheckResult =
  /** Der Text enthält keinen geheimen Schlüssel von age. */
  | { kind: "invalid" }
  /** Er passt zu diesem gespeicherten öffentlichen Schlüssel. */
  | { kind: "match"; public: string }
  /** Er ist gültig, passt aber zu keinem der gespeicherten; `publics` sind die öffentlichen dazu. */
  | { kind: "no_match"; publics: string[] };

/** Prüft einen geheimen Schlüssel (oder eine Schlüsseldatei) gegen die gespeicherten öffentlichen. */
export function checkSecret(text: string, recipients: readonly string[]): KeyCheckResult {
  const publics = identitiesOf(text);
  if (publics === null) {
    return { kind: "invalid" };
  }
  const known = new Set(recipients.map((recipient) => recipient.trim().toLowerCase()));
  const match = publics.find((candidate) => known.has(candidate));
  return match === undefined ? { kind: "no_match", publics } : { kind: "match", public: match };
}

/** Ein öffentlicher Schlüssel gekürzt wie beim Server (`short_key`): die ersten 8 Zeichen, „…", die letzten 4. */
export function shortKey(key: string): string {
  return key.length <= 13 ? key : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Ein Zeitpunkt wie `time.RFC3339` von Go, wie ihn `age-keygen` in die Datei schreibt:
 * „2026-11-16T20:00:00+01:00", ohne Abstand zu UTC „…Z". `offsetMinutes` ist der Abstand östlich
 * von UTC; Vorgabe die Zeitzone des Geräts.
 */
export function rfc3339(date: Date, offsetMinutes: number = -date.getTimezoneOffset()): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${String(local.getUTCFullYear()).padStart(4, "0")}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const abs = Math.abs(offsetMinutes);
  const zone = offsetMinutes === 0 ? "Z" : `${offsetMinutes > 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${day}T${time}${zone}`;
}

/** Die Schlüsseldatei wie von `age-keygen`: wann erzeugt, der öffentliche Schlüssel, dann der geheime. */
export function keyFile(pair: AgeKeyPair, created: string = rfc3339(new Date())): string {
  return `# created: ${created}\n# public key: ${pair.public}\n${pair.secret}\n`;
}

/** Name der Schlüsseldatei zum Herunterladen, mit dem Tag (Zeitzone des Geräts). */
export function keyFileName(date: Date = new Date()): string {
  return `stowly-schluessel-${rfc3339(date).slice(0, 10)}.txt`;
}
