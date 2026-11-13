import { APP_VERSION, DEFAULT_DEVICE_PREFS, useCore, useLive } from "@/contract";
import { Page } from "@/app/Page";
import { Card, SegmentedControl, Switch } from "@/ui/base";
import { ACCENTS, setAccent, setTheme, useTheme, type AccentKey } from "@/ui/theme";

/** Einstellungen. Grundgerüst; die Ausgestaltung nach dem Entwurf folgt in Runde 1. */
export function SettingsPage() {
  const core = useCore();
  const prefs = useLive(core.prefs.value, DEFAULT_DEVICE_PREFS);
  const { theme, accent } = useTheme();

  return (
    <Page title="Einstellungen">
      <Card style={{ display: "grid", gap: "var(--space-4)" }}>
        <h2 style={{ fontSize: "var(--text-lg)" }}>Darstellung</h2>
        <SegmentedControl
          label="Thema"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "dark", label: "Dunkel" },
            { value: "light", label: "Hell" },
            { value: "system", label: "Wie das Gerät" },
          ]}
        />
        <SegmentedControl<AccentKey>
          label="Akzentfarbe"
          value={accent}
          onChange={setAccent}
          options={ACCENTS.map((entry) => ({ value: entry.key, label: entry.label }))}
        />
      </Card>

      <Card style={{ display: "grid", gap: "var(--space-2)" }}>
        <h2 style={{ fontSize: "var(--text-lg)" }}>Dieses Gerät</h2>
        <Switch
          label="Etiketten"
          hint="Beim Einlagern für jede Packung ein Etikett anfordern"
          checked={prefs.print_labels}
          onChange={(print_labels) => void core.prefs.update({ print_labels })}
        />
        <Switch label="Ton beim Scannen" checked={prefs.scan_sound} onChange={(scan_sound) => void core.prefs.update({ scan_sound })} />
        <Switch
          label="Vibration beim Scannen"
          hint="Nur auf Android; Safari kann nicht vibrieren"
          checked={prefs.scan_vibration}
          onChange={(scan_vibration) => void core.prefs.update({ scan_vibration })}
        />
      </Card>

      <p style={{ color: "var(--color-text-faint)", fontSize: "var(--text-sm)" }}>Stowly {APP_VERSION} · Produktdaten: Open Food Facts (ODbL)</p>
    </Page>
  );
}
