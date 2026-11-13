/**
 * Zonenlogik der Scan-Ansicht: Modus „Primärzone" (ein Wechsel gilt für genau einen
 * Einlager-Vorgang) und Modus „gleichwertig" (ein Wechsel bleibt und wird gemerkt).
 */
import { describe, expect, it } from "vitest";

import { afterStore, chooseZone, currentZoneId, isTemporary, neighbourZoneId, primaryZoneId, showsZones, type ZoneContext, type ZoneOverride } from "./zone-logic";

const SHELF = "10000000-0000-4000-8000-000000000001";
const CELLAR = "10000000-0000-4000-8000-000000000002";
const FREEZER = "10000000-0000-4000-8000-000000000003";
const GONE = "10000000-0000-4000-8000-000000000099";

function context(changes: Partial<{ mode: "primary" | "equal"; primary: string | null; remembered: string | null; zones: string[] }> = {}): ZoneContext {
  return {
    zones: (changes.zones ?? [SHELF, CELLAR, FREEZER]).map((id) => ({ id })),
    settings: { zone_mode: changes.mode ?? "primary", primary_zone_id: changes.primary === undefined ? CELLAR : changes.primary },
    remembered: changes.remembered ?? null,
  };
}

describe("Primärzone", () => {
  it("ist die eingestellte Zone, sonst die erste der Reihenfolge", () => {
    expect(primaryZoneId(context())).toBe(CELLAR);
    expect(primaryZoneId(context({ primary: null }))).toBe(SHELF);
    // Ein Verweis ins Leere oder auf eine gelöschte Zone gilt als nicht gesetzt.
    expect(primaryZoneId(context({ primary: GONE }))).toBe(SHELF);
    expect(primaryZoneId(context({ zones: [] }))).toBeNull();
  });
});

describe("Modus Primärzone", () => {
  it("lagert in die Primärzone ein, solange nichts anderes gewählt ist", () => {
    expect(currentZoneId(context(), null)).toBe(CELLAR);
    // Die gemerkte Zone des anderen Modus spielt hier keine Rolle.
    expect(currentZoneId(context({ remembered: FREEZER }), null)).toBe(CELLAR);
  });

  it("lässt einen Wechsel für genau einen Einlager-Vorgang gelten", () => {
    const ctx = context();
    let override: ZoneOverride = null;

    const choice = chooseZone(ctx, override, FREEZER);
    override = choice.override;
    expect(choice.remember).toBeUndefined();
    expect(currentZoneId(ctx, override)).toBe(FREEZER);
    expect(isTemporary(ctx, override)).toBe(true);

    // Ein Einlager-Vorgang, danach gilt wieder die Primärzone.
    override = afterStore(ctx, override);
    expect(override).toBeNull();
    expect(currentZoneId(ctx, override)).toBe(CELLAR);
    expect(isTemporary(ctx, override)).toBe(false);
  });

  it("hebt die Abweichung auf, wenn die Primärzone selbst gewählt wird", () => {
    const ctx = context();
    const away = chooseZone(ctx, null, SHELF).override;
    expect(currentZoneId(ctx, away)).toBe(SHELF);
    const back = chooseZone(ctx, away, CELLAR).override;
    expect(back).toBeNull();
    expect(isTemporary(ctx, back)).toBe(false);
  });

  it("ändert bei einer unbekannten Zone nichts", () => {
    const ctx = context();
    expect(chooseZone(ctx, FREEZER, GONE)).toEqual({ override: FREEZER });
    // Wird die gewählte Zone inzwischen gelöscht, gilt die Primärzone.
    expect(currentZoneId(context({ zones: [SHELF, CELLAR] }), FREEZER)).toBe(CELLAR);
  });
});

describe("Modus gleichwertig", () => {
  it("merkt sich den Wechsel und behält ihn über das Einlagern hinaus", () => {
    const ctx = context({ mode: "equal" });
    const choice = chooseZone(ctx, null, FREEZER);
    expect(choice).toEqual({ override: null, remember: FREEZER });

    // Das Gerät hat sich die Zone gemerkt (prefs.scan_zone_id).
    const remembered = context({ mode: "equal", remembered: FREEZER });
    expect(currentZoneId(remembered, choice.override)).toBe(FREEZER);
    expect(afterStore(remembered, choice.override)).toBeNull();
    expect(currentZoneId(remembered, afterStore(remembered, choice.override))).toBe(FREEZER);
    expect(isTemporary(remembered, choice.override)).toBe(false);
  });

  it("beginnt ohne gemerkte Zone bei der Primärzone und fällt auf sie zurück, wenn die gemerkte fehlt", () => {
    expect(currentZoneId(context({ mode: "equal" }), null)).toBe(CELLAR);
    expect(currentZoneId(context({ mode: "equal", remembered: GONE }), null)).toBe(CELLAR);
    // Eine Abweichung aus dem anderen Modus zählt hier nicht.
    expect(currentZoneId(context({ mode: "equal", remembered: SHELF }), FREEZER)).toBe(SHELF);
  });
});

describe("Eine einzige Zone", () => {
  it("zeigt nichts zu Zonen und lagert immer dorthin ein", () => {
    const single = context({ zones: [SHELF], primary: GONE, remembered: CELLAR });
    expect(showsZones(single)).toBe(false);
    expect(currentZoneId(single, FREEZER)).toBe(SHELF);
    expect(currentZoneId({ ...single, settings: { zone_mode: "equal", primary_zone_id: null } }, null)).toBe(SHELF);
    expect(showsZones(context())).toBe(true);
  });
});

describe("Wischen", () => {
  it("geht zur Nachbarzone und bleibt an den Enden stehen", () => {
    const ctx = context();
    expect(neighbourZoneId(ctx, null, 1)).toBe(FREEZER);
    expect(neighbourZoneId(ctx, null, -1)).toBe(SHELF);
    expect(neighbourZoneId(ctx, FREEZER, 1)).toBeNull();
    expect(neighbourZoneId(ctx, SHELF, -1)).toBeNull();
  });
});
