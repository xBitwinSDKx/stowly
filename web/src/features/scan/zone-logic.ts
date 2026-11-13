/**
 * In welche Zone eingelagert wird (docs/plan-stufe-1.md, Entscheidung 4; docs/sync-protokoll.md, 3.4).
 *
 * - Modus „Primärzone": Eingelagert wird in die Primärzone. Ein Wechsel (Zonen-Etikett
 *   gescannt oder in der Zonenleiste angetippt) gilt für genau einen Einlager-Vorgang;
 *   danach gilt wieder die Primärzone.
 * - Modus „gleichwertig": Ein Wechsel bleibt bestehen und wird auf dem Gerät gemerkt
 *   (`prefs.scan_zone_id`).
 * - Gibt es nur eine Zone, ist sie es immer; die Oberfläche zeigt dann nichts zu Zonen.
 *
 * Reine Funktionen ohne React, damit sich die Regeln für sich prüfen lassen.
 */
import type { HouseholdSettings, Zone } from "@/contract";

export interface ZoneContext {
  /** Alle nicht gelöschten Zonen in ihrer Reihenfolge (`core.data.zones`). */
  zones: readonly Pick<Zone, "id">[];
  settings: Pick<HouseholdSettings, "zone_mode" | "primary_zone_id">;
  /** Die auf diesem Gerät gemerkte Zone (`prefs.scan_zone_id`). */
  remembered: string | null;
}

/**
 * Die im Modus „Primärzone" für den nächsten Einlager-Vorgang gewählte Zone; null = keine Abweichung.
 * Lebt nur in der Ansicht und wird nie gespeichert.
 */
export type ZoneOverride = string | null;

function exists(context: ZoneContext, id: string | null): id is string {
  return id !== null && context.zones.some((zone) => zone.id === id);
}

/** Wahr, wenn die Oberfläche überhaupt etwas zu Zonen zeigt. */
export function showsZones(context: ZoneContext): boolean {
  return context.zones.length > 1;
}

/**
 * Die Primärzone. Zeigt die Einstellung ins Leere oder auf eine gelöschte Zone, gilt die
 * erste Zone der Reihenfolge.
 */
export function primaryZoneId(context: ZoneContext): string | null {
  if (exists(context, context.settings.primary_zone_id)) {
    return context.settings.primary_zone_id;
  }
  return context.zones[0]?.id ?? null;
}

/** Die Zone, in die der nächste Einlager-Vorgang geht; null nur, solange es noch keine Zone gibt. */
export function currentZoneId(context: ZoneContext, override: ZoneOverride): string | null {
  if (context.settings.zone_mode === "equal") {
    return exists(context, context.remembered) ? context.remembered : primaryZoneId(context);
  }
  return exists(context, override) ? override : primaryZoneId(context);
}

export interface ZoneChoice {
  /** Neuer Wert für die Abweichung der Ansicht. */
  override: ZoneOverride;
  /** Zone, die das Gerät sich merken soll (`prefs.scan_zone_id`); undefined = nichts merken. */
  remember?: string;
}

/**
 * Der Anwender wählt eine Zone (Etikett gescannt oder Zonenleiste angetippt).
 * Eine unbekannte Zone ändert nichts.
 */
export function chooseZone(context: ZoneContext, override: ZoneOverride, zoneId: string): ZoneChoice {
  if (!exists(context, zoneId)) {
    return { override };
  }
  if (context.settings.zone_mode === "equal") {
    // Bleibt bestehen und wird gemerkt.
    return { override: null, remember: zoneId };
  }
  // Gilt für genau einen Einlager-Vorgang. Die Primärzone selbst zu wählen hebt die Abweichung auf.
  return { override: zoneId === primaryZoneId(context) ? null : zoneId };
}

/** Nach einem Einlager-Vorgang: Im Modus „Primärzone" gilt wieder die Primärzone. */
export function afterStore(context: ZoneContext, override: ZoneOverride): ZoneOverride {
  return context.settings.zone_mode === "primary" ? null : override;
}

/** Wahr, solange im Modus „Primärzone" eine andere Zone für den nächsten Vorgang gewählt ist. */
export function isTemporary(context: ZoneContext, override: ZoneOverride): boolean {
  return context.settings.zone_mode === "primary" && exists(context, override) && override !== primaryZoneId(context);
}

/** Die Zone neben der aktuellen, für das Wischen über das Kamerabild. `step` ist +1 oder −1; an den Enden bleibt es stehen. */
export function neighbourZoneId(context: ZoneContext, override: ZoneOverride, step: 1 | -1): string | null {
  const current = currentZoneId(context, override);
  const index = context.zones.findIndex((zone) => zone.id === current);
  if (index === -1) {
    return null;
  }
  return context.zones[index + step]?.id ?? null;
}
