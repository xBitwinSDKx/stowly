/**
 * Das YAML für Home Assistant (docs/betrieb.md, 18.2 und 18.4), fertig für die Adresse dieser App:
 * `secrets.yaml` mit dem Sensor-Token und `configuration.yaml` mit dem Sensor, den
 * Vorlagen-Sensoren, dem Bestand und dessen Ausschluss aus der Historie. Reine Logik ohne React; ein
 * Test vergleicht das Ergebnis mit den Blöcken in docs/betrieb.md.
 */

/** Statt des Tokens, wenn er aus der Umgebung kommt (STOWLY_HA_SUMMARY_TOKEN): Die App kennt ihn nicht. */
export const ENV_TOKEN_PLACEHOLDER = "<Token aus STOWLY_HA_SUMMARY_TOKEN>";

export interface HaSnippetInput {
  /** Die Adresse von Stowly, unter der HA den Sensor liest (`location.origin`). */
  origin: string;
  /** Der Sensor-Token; null, wenn er aus der Umgebung kommt: dann ein Platzhalter. */
  token: string | null;
  /** Stowly läuft mit seiner eigenen Zertifizierungsstelle, die HA nicht kennt (`verify_ssl: false`). */
  ownCa: boolean;
}

export interface HaSnippet {
  secrets: string;
  configuration: string;
}

const SUMMARY_SENSOR = [
  "      - name: Stowly",
  "        unique_id: stowly_summary",
  '        value_template: "{{ value_json.state }}"',
  "        unit_of_measurement: Packungen",
  "        json_attributes:",
  "          - today",
  "          - expired",
  "          - total",
  "          - next",
  "          - shopping",
  "          - soon_list",
  "          - expired_list",
  "          - shopping_list",
  "          - message",
];

const STOCK_SENSOR = [
  "      - name: Stowly Bestand",
  "        unique_id: stowly_stock",
  '        value_template: "{{ value_json.state }}"',
  "        unit_of_measurement: Packungen",
  "        json_attributes:",
  "          - product_count",
  "          - zones",
  "          - truncated",
];

const TEMPLATES = [
  "template:",
  "  - sensor:",
  "      - name: Stowly abgelaufen",
  "        unique_id: stowly_expired",
  "        state: \"{{ state_attr('sensor.stowly', 'expired') | int(0) }}\"",
  "        unit_of_measurement: Packungen",
  "      - name: Stowly Einkaufsliste",
  "        unique_id: stowly_shopping",
  "        state: \"{{ state_attr('sensor.stowly', 'shopping') | int(0) }}\"",
  "        unit_of_measurement: Einträge",
  "      - name: Stowly Ansage",
  "        unique_id: stowly_message",
  "        state: \"{{ state_attr('sensor.stowly', 'message') }}\"",
];

/** Der Bestand ist groß: aus der Historie von HA nehmen (docs/betrieb.md, 18.4). */
const RECORDER = ["recorder:", "  exclude:", "    entities:", "      - sensor.stowly_bestand"];

/** Ohne Prüfung des Zertifikats, aber verschlüsselt (docs/betrieb.md, 18.3). */
const NO_VERIFY = [
  "    # Stowly hat ein Zertifikat seiner eigenen Zertifizierungsstelle, die HA nicht kennt:",
  "    # verschlüsselt, aber ohne Prüfung (docs/betrieb.md, 18.3).",
  "    verify_ssl: false",
];

function resource(origin: string, path: string, sensor: readonly string[], ownCa: boolean): string[] {
  return [
    `  - resource: ${origin}${path}`,
    ...(ownCa ? NO_VERIFY : []),
    "    headers:",
    "      Authorization: !secret stowly_summary_auth",
    "    scan_interval: 300",
    "    timeout: 10",
    "    sensor:",
    ...sensor,
  ];
}

/** `secrets.yaml` und `configuration.yaml` für Home Assistant. */
export function haSnippet({ origin, token, ownCa }: HaSnippetInput): HaSnippet {
  const base = origin.replace(/\/+$/, "");
  const secrets = ["# secrets.yaml", `stowly_summary_auth: "Bearer ${token ?? ENV_TOKEN_PLACEHOLDER}"`, ""].join("\n");
  const configuration = [
    "# configuration.yaml",
    "rest:",
    ...resource(base, "/api/ha/summary", SUMMARY_SENSOR, ownCa),
    ...resource(base, "/api/ha/stock", STOCK_SENSOR, ownCa),
    "",
    ...TEMPLATES,
    "",
    ...RECORDER,
    "",
  ].join("\n");
  return { secrets, configuration };
}

/**
 * Läuft diese Seite mit dem Zertifikat von Stowlys eigener Zertifizierungsstelle? Dann kennt HA es
 * nicht. Das gilt über HTTPS, wenn Stowly eine eigene CA hat und die Anfrage über seinen Listener
 * kam (oder die Adresse eine seiner HTTPS-Adressen ist); hinter einem Reverse Proxy mit eigenem
 * Zertifikat nicht.
 */
export function usesOwnCa(location: Pick<Location, "protocol" | "origin">, https: { ca: unknown; via_https: boolean; origins: readonly string[] } | null): boolean {
  return location.protocol === "https:" && https !== null && https.ca !== null && (https.via_https || https.origins.includes(location.origin));
}
