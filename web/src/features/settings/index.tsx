import { useEffect, useState } from "react";

import { ROUTES, useCore, useLive, type DevicePrefs, type SettingsChanges } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { useLogout } from "@/features/auth/logout";
import { errorText, List, ListLink, ListRow, Notice, plural, Section } from "@/ui";
import { Button, cx, SegmentedControl, Switch, TextField, useToast } from "@/ui/base";
import { DownloadIcon, LogOutIcon, PrinterIcon, ZonesIcon } from "@/ui/icons";
import { ACCENTS, setAccent, setTheme, useTheme, type AccentKey, type ThemeChoice } from "@/ui/theme";

import { DevicesSection } from "./DevicesSection";
import styles from "./SettingsPage.module.css";

interface NumberSettingProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}

/** Zahl in einer Zeile der Einstellungen. Übernommen wird beim Verlassen des Felds oder mit Enter. */
function NumberSetting({ label, hint, value, min, max, onCommit }: NumberSettingProps) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  // Wert von außen geändert (Abgleich mit einem anderen Gerät): Feld nachziehen.
  useEffect(() => {
    setText(String(value));
    setError(null);
  }, [value]);

  function commit() {
    const trimmed = text.trim();
    const next = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || next < min || next > max) {
      setError(`Bitte eine ganze Zahl von ${String(min)} bis ${String(max)} eingeben.`);
      return;
    }
    setError(null);
    setText(String(next));
    if (next !== value) {
      onCommit(next);
    }
  }

  return (
    <ListRow
      label={label}
      hint={
        error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : (
          hint
        )
      }
    >
      <TextField
        className={styles.number}
        label={label}
        hideLabel
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        trailing={<span className={styles.unit}>Tage</span>}
      />
    </ListRow>
  );
}

/** Auswahl der Akzentfarbe: jede Farbe in ihrem eigenen Feld. */
function AccentPicker({ value }: { value: AccentKey }) {
  return (
    <div role="radiogroup" aria-label="Akzentfarbe" className={styles.accents}>
      {ACCENTS.map((accent) => (
        <button
          key={accent.key}
          type="button"
          role="radio"
          aria-checked={accent.key === value}
          aria-label={accent.label}
          title={accent.label}
          data-accent={accent.key}
          className={cx(styles.accent, accent.key === value && styles.accentOn)}
          onClick={() => setAccent(accent.key)}
        />
      ))}
    </div>
  );
}

/** Speichert eine Datei, die der Kern als Blob liefert. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Der Download hat die Adresse zu diesem Zeitpunkt sicher übernommen.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Einstellungen nach dem Entwurf: eine Liste aus Zeilen mit dem Bedienelement rechts,
 * gegliedert in Darstellung, dieses Gerät, Haushalt, Geräte, Sicherung und Über.
 */
export function SettingsPage() {
  const core = useCore();
  const toast = useToast();
  const logout = useLogout();
  const prefs = useLive(core.prefs.value);
  const settings = useLive(core.data.settings);
  const zones = useLive(core.data.zones);
  const printers = useLive(core.data.printers);
  const app = useLive(core.app.state);
  const sync = useLive(core.sync.status);
  const session = useLive(core.session.state);
  const { theme, accent } = useTheme();
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  if (!prefs || !settings || !zones) {
    return (
      <Page title="Einstellungen" narrow>
        <PageLoading />
      </Page>
    );
  }

  function report(error: unknown) {
    toast.show({ message: errorText(error), tone: "danger" });
  }

  function updatePrefs(changes: Partial<DevicePrefs>) {
    core.prefs.update(changes).catch(report);
  }

  function updateSettings(changes: SettingsChanges) {
    core.settings
      .update(changes)
      .then(() => toast.show({ id: "settings-saved", message: "Einstellung gespeichert", tone: "success", duration: 2500 }))
      .catch(report);
  }

  async function downloadBackup() {
    setBackupBusy(true);
    setBackupError(null);
    try {
      const { blob, filename } = await core.backup.download();
      saveBlob(blob, filename);
      toast.show({ message: `Sicherung heruntergeladen: ${filename}`, tone: "success" });
    } catch (caught) {
      setBackupError(errorText(caught, { offline: "Die Sicherung kommt vom Server, und der ist gerade nicht erreichbar." }));
    } finally {
      setBackupBusy(false);
    }
  }

  async function install() {
    setInstalling(true);
    try {
      await core.app.promptInstall();
    } finally {
      setInstalling(false);
    }
  }

  const multiZone = zones.length > 1;
  const primaryZone = zones.find((zone) => zone.id === settings.primary_zone_id) ?? zones[0];
  const deviceName = session?.status === "signed_in" ? session.device.name : "";

  return (
    <Page title="Einstellungen" narrow>
      <Section title="Darstellung" description="Gilt nur für dieses Gerät.">
        <List>
          <ListRow label="Thema" stacked>
            <SegmentedControl<ThemeChoice>
              className={styles.theme}
              label="Thema"
              block
              value={theme}
              onChange={setTheme}
              options={[
                { value: "dark", label: "Dunkel" },
                { value: "light", label: "Hell" },
                { value: "system", label: "Wie das Gerät" },
              ]}
            />
          </ListRow>
          <ListRow label="Akzentfarbe" hint={ACCENTS.find((entry) => entry.key === accent)?.label}>
            <AccentPicker value={accent} />
          </ListRow>
        </List>
      </Section>

      <Section title="Dieses Gerät" description="Gilt nur für dieses Gerät und wird nicht abgeglichen.">
        <List>
          <div className={styles.switchRow}>
            <Switch
              label="Etiketten"
              hint="Beim Einlagern für jede Packung ein Etikett anfordern"
              checked={prefs.print_labels}
              onChange={(print_labels) => updatePrefs({ print_labels })}
            />
          </div>
          <div className={styles.switchRow}>
            <Switch label="Ton beim Scannen" hint="Kurzer Ton, sobald ein Code erkannt ist" checked={prefs.scan_sound} onChange={(scan_sound) => updatePrefs({ scan_sound })} />
          </div>
          <div className={styles.switchRow}>
            <Switch
              label="Vibration beim Scannen"
              hint="Nur wo der Browser es kann; das iPhone vibriert nicht"
              checked={prefs.scan_vibration}
              onChange={(scan_vibration) => updatePrefs({ scan_vibration })}
            />
          </div>
        </List>
      </Section>

      <Section title="Haushalt" description="Gilt für alle Geräte des Haushalts.">
        <List>
          <NumberSetting
            label="Vorlaufzeit der MHD-Warnung"
            hint="So viele Tage vor dem MHD gilt eine Packung als „läuft bald ab“. Einzelne Produkte können abweichen."
            value={settings.warn_days}
            min={0}
            max={3650}
            onCommit={(warn_days) => updateSettings({ warn_days })}
          />
          <NumberSetting
            label="Aufbewahrung der Lösch-Historie"
            hint="So lange lassen sich entnommene Packungen wiederherstellen."
            value={settings.trash_retention_days}
            min={1}
            max={3650}
            onCommit={(trash_retention_days) => updateSettings({ trash_retention_days })}
          />
          <ListLink
            to={ROUTES.zones}
            icon={<ZonesIcon size={20} />}
            label="Zonen"
            hint={
              multiZone
                ? settings.zone_mode === "primary"
                  ? `Primärzone: ${primaryZone?.name ?? "–"}`
                  : "Alle Zonen gleichwertig"
                : "Eine weitere Zone anlegen, um Lagerorte zu unterscheiden"
            }
            value={plural(zones.length, "Zone", "Zonen")}
          />
          <ListLink
            to={ROUTES.printers}
            icon={<PrinterIcon size={20} />}
            label="Drucker"
            hint="Etikettendrucker des Haushalts"
            value={printers && printers.length > 0 ? String(printers.length) : "keiner"}
          />
        </List>
      </Section>

      <DevicesSection />

      <Section title="Sicherung" description="Eine vollständige Kopie der Datenbank des Servers als Datei. Braucht den Server.">
        <List>
          <ListRow label="Kopie der Datenbank" hint="Enthält den gesamten Bestand, alle Einstellungen und das Ereignisprotokoll.">
            <Button icon={<DownloadIcon />} busy={backupBusy} onClick={() => void downloadBackup()}>
              Herunterladen
            </Button>
          </ListRow>
        </List>
        {backupError ? (
          <Notice tone="warn" role="alert">
            {backupError}
          </Notice>
        ) : null}
      </Section>

      <Section title="Über" id="ueber">
        <List>
          <ListRow label="Version" inline>
            <span className={styles.value}>
              Stowly {app?.version ?? "–"}
              {sync?.server_version ? ` · Server ${sync.server_version}` : ""}
            </span>
          </ListRow>
          <ListRow
            label="Lokaler Speicher"
            hint={
              app?.storage_persistent === true
                ? "Der Browser hat zugesagt, die Kopie auf diesem Gerät nicht von sich aus zu löschen."
                : app?.storage_persistent === false
                  ? "Der Browser darf die Kopie auf diesem Gerät löschen, etwa bei Platzmangel. Als App installiert, bleibt sie erhalten; der Bestand selbst liegt ohnehin auf dem Server."
                  : "Ob der Browser die Kopie auf diesem Gerät dauerhaft behält, ist nicht bekannt."
            }
          >
            <span className={styles.value}>{app?.storage_persistent === true ? "dauerhaft" : app?.storage_persistent === false ? "nicht zugesagt" : "unbekannt"}</span>
          </ListRow>
          <ListRow
            label="Als App"
            hint={
              app?.installed
                ? "Stowly läuft als installierte App."
                : app?.can_install
                  ? "Installiert startet Stowly vom Home-Bildschirm und behält seine Daten."
                  : "Über das Menü des Browsers lässt sich Stowly zum Home-Bildschirm hinzufügen."
            }
          >
            {app?.installed ? (
              <span className={styles.value}>installiert</span>
            ) : app?.can_install ? (
              <Button busy={installing} onClick={() => void install()}>
                Installieren
              </Button>
            ) : (
              <span className={styles.value}>nicht installiert</span>
            )}
          </ListRow>
          <ListRow
            label="Verbindung"
            hint={
              app?.secure_context === false
                ? "Über eine http-Adresse verweigert der Browser Kamera, Offline-Betrieb und Installation."
                : "Über die HTTPS-Adresse sind Scannen und Offline-Betrieb möglich."
            }
          >
            <span className={styles.value}>{app?.secure_context === false ? "http (eingeschränkt)" : "HTTPS"}</span>
          </ListRow>
          <ListRow label="Produktdaten" hint="Namen und Bilder zu unbekannten Barcodes schlägt der Server dort nach.">
            <span className={styles.value}>Open Food Facts (ODbL)</span>
          </ListRow>
        </List>
      </Section>

      <Section title="Abmelden">
        <List>
          <ListRow
            label={deviceName === "" ? "Dieses Gerät" : `Angemeldet als „${deviceName}“`}
            hint="Abmelden löscht die Kopie der Daten auf diesem Gerät. Der Bestand bleibt auf dem Server."
          >
            <Button icon={<LogOutIcon />} onClick={logout}>
              Abmelden
            </Button>
          </ListRow>
        </List>
      </Section>
    </Page>
  );
}
