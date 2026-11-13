import { useCore, useLive } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Card, zoneColor, ZoneIcon } from "@/ui/base";

/** Lagerzonen. Grundgerüst; Verwaltung, Modus und QR-Codes folgen in Runde 1. */
export function ZonesPage() {
  const core = useCore();
  const zones = useLive(core.data.zones, []);
  const packages = useLive(core.data.packages, []);
  const settings = useLive(core.data.settings);

  return (
    <Page title="Zonen">
      <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))" }}>
        {zones.map((zone) => (
          <Card key={zone.id} selected={settings?.zone_mode === "primary" && settings.primary_zone_id === zone.id}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
              <strong>{zone.name}</strong>
              <span style={{ color: zoneColor(zone.color) }}>
                <ZoneIcon icon={zone.icon} />
              </span>
            </div>
            <div style={{ marginTop: "var(--space-3)", color: "var(--color-text-muted)" }}>
              Packungen <Badge>{packages.filter((pkg) => pkg.zone_id === zone.id).length}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
