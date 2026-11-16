import { useState } from "react";

import type { Platform } from "@/contract";
import { Notice } from "@/ui";
import { SegmentedControl } from "@/ui/base";
import { InfoIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";

/** Die Anleitungen, umschaltbar: iPhone, Android, Windows, Mac. */
export type GuidePlatform = Exclude<Platform, "other">;

const OPTIONS: readonly { value: GuidePlatform; label: string }[] = [
  { value: "ios", label: "iPhone" },
  { value: "android", label: "Android" },
  { value: "windows", label: "Windows" },
  { value: "macos", label: "Mac" },
];

/** Die Anleitung, die zuerst offen ist: die des Geräts; ein unbekanntes (Linux) beginnt bei Windows. */
export function guideFor(platform: Platform): GuidePlatform {
  return platform === "other" ? "windows" : platform;
}

export interface TrustGuideProps {
  /** Das erkannte Gerät (`detectPlatform`). */
  platform: Platform;
  /** Firefox hat unter Windows und macOS vor Version 120 einen eigenen Speicher für Zertifikate. */
  firefox: boolean;
  /** Name der CA, wie ihn die Einstellungen des iPhones zeigen („Stowly CA 3F2A1C"). */
  caName: string;
}

/**
 * Wie dieses Gerät der CA von Stowly vertraut, Schritt für Schritt (docs/integrationen.md, 11.5).
 * Vorgewählt ist das erkannte Gerät; umschalten geht, etwa um die Anleitung fürs Handy am PC zu lesen.
 */
export function TrustGuide({ platform, firefox, caName }: TrustGuideProps) {
  const [chosen, setChosen] = useState<GuidePlatform>(() => guideFor(platform));
  return (
    <div className={styles.block}>
      <SegmentedControl<GuidePlatform> label="Anleitung für" value={chosen} onChange={setChosen} options={OPTIONS} />
      {chosen === "ios" ? (
        <>
          <ol className={styles.steps}>
            <li>„Zertifikat laden“ in Safari antippen → „Erlauben“ → „Schließen“.</li>
            <li>
              Einstellungen öffnen → oben „Profil geladen“ (sonst Allgemein → VPN und Geräteverwaltung) → „Installieren“, Gerätecode eingeben, „Installieren“,
              „Fertig“.
            </li>
            <li>Allgemein → Info → ganz unten „Zertifikatsvertrauenseinstellungen“ → den Schalter bei „{caName}“ einschalten → „Fortfahren“.</li>
          </ol>
          <p className={styles.muted}>Das geht nur in Safari; das Profil gilt danach für alle Apps des iPhones.</p>
        </>
      ) : null}
      {chosen === "android" ? (
        <>
          <ol className={styles.steps}>
            <li>„Zertifikat laden“ antippen; die Datei landet in den Downloads.</li>
            <li>In den Einstellungen nach „Zertifikat installieren“ suchen → „CA-Zertifikat“ → „Trotzdem installieren“ → die Datei wählen.</li>
          </ol>
          <p className={styles.muted}>Der Weg in den Einstellungen ist je Hersteller verschieden, darum die Suche. Android verlangt dafür eine Displaysperre.</p>
        </>
      ) : null}
      {chosen === "windows" ? (
        <ol className={styles.steps}>
          <li>„Zertifikat laden“, dann die Datei öffnen → „Zertifikat installieren…“ → „Aktueller Benutzer“.</li>
          <li>„Alle Zertifikate in folgendem Speicher speichern“ → „Durchsuchen…“ → „Vertrauenswürdige Stammzertifizierungsstellen“ → „Fertig stellen“ → die Sicherheitswarnung mit „Ja“ bestätigen.</li>
          <li>Den Browser neu starten.</li>
        </ol>
      ) : null}
      {chosen === "macos" ? (
        <ol className={styles.steps}>
          <li>„Zertifikat laden“, dann die Datei doppelklicken, Schlüsselbund „Anmeldung“ → „Hinzufügen“.</li>
          <li>In der Schlüsselbundverwaltung den Eintrag „{caName}“ doppelklicken → „Vertrauen“ → „Immer vertrauen“ → mit dem Passwort bestätigen.</li>
        </ol>
      ) : null}
      {firefox && (chosen === "windows" || chosen === "macos") ? (
        <Notice tone="info" icon={<InfoIcon />} title="Firefox">
          Ab Version 120 übernimmt Firefox unter Windows und macOS die CA des Systems. Sonst: Einstellungen → Datenschutz & Sicherheit → Zertifikate anzeigen →
          Zertifizierungsstellen → Importieren → „Dieser CA vertrauen, um Websites zu identifizieren“.
        </Notice>
      ) : null}
    </div>
  );
}
