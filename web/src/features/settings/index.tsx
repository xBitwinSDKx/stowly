import { useEffect, useState } from "react";

import { formatBuild, isTimeOfDay, ROUTES, setupPath, useCore, useLive, type AiConfig, type DevicePrefs, type SettingsChanges } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { useLogout } from "@/features/auth/logout";
import { modelName } from "@/features/cook/texts";
import { errorText, List, ListLink, ListRow, Notice, plural, Section } from "@/ui";
import { Button, ButtonLink, cx, SegmentedControl, Spinner, Switch, TextField, useToast } from "@/ui/base";
import { InstallIcon, LockOpenIcon, LogOutIcon, PrinterIcon, ZonesIcon } from "@/ui/icons";
import { ACCENTS, setAccent, setTheme, useTheme, type AccentKey, type ThemeChoice } from "@/ui/theme";

import { BackupSection } from "./BackupSection";
import { DevicesSection } from "./DevicesSection";
import { HomeAssistantSection } from "./HomeAssistantSection";
import { useIntegrations } from "./integrations";
import { IosInstallSteps } from "./IosInstallSteps";
import { loadedValue, useLoaded, type LoadedResource } from "./loaded";
import { DEFAULT_NOTIFY_TIME, NotifyTimeSetting } from "./NotifyTimeSetting";
import { PushSetting } from "./PushSetting";
import { SetupSection } from "./SetupSection";
import styles from "./SettingsPage.module.css";
import { UpdateSection } from "./UpdateSection";

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

/** Der Wert der Zeile „Verbindung" über eine unverschlüsselte Adresse: Dort führt „Einrichten" zur sicheren Verbindung. */
const HTTP_VALUE = "http (eingeschränkt)";

/** Was eine Zeile der Einstellungen rechts zeigt und darunter erklärt. */
export interface RowText {
  value: string;
  hint: string;
}

/**
 * Die Zeile „Verbindung": Sie sagt, was wirklich gilt. Die Adresse bestimmt das Wort
 * (HTTPS, lokal, http); ob Scannen und Offline-Betrieb gehen, entscheidet allein der Kern
 * (`app.state.secure_context`).
 */
export function describeConnection(location: Pick<Location, "protocol" | "hostname">, secureContext: boolean | undefined): RowText {
  const host = location.hostname;
  const restricted = "Scannen, Offline-Betrieb und Installation verweigert der Browser hier; gedruckt wird nur über den Server.";
  if (location.protocol === "https:") {
    return {
      value: "HTTPS",
      hint: secureContext === false ? `Die Adresse ist verschlüsselt, der Browser meldet trotzdem keinen sicheren Kontext. ${restricted}` : "Über die HTTPS-Adresse sind Scannen und Offline-Betrieb möglich.",
    };
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) {
    return {
      value: "lokal (Entwicklung)",
      hint:
        secureContext === false
          ? `Aufruf vom selben Rechner, aber ohne sicheren Kontext. ${restricted}`
          : "Aufruf vom selben Rechner: Der Browser behandelt das wie eine sichere Adresse. Für Handys im Haushalt braucht es die HTTPS-Adresse.",
    };
  }
  return {
    value: HTTP_VALUE,
    hint: secureContext === true ? "Unverschlüsselte Adresse. Für Handys im Haushalt braucht es die HTTPS-Adresse von Stowly." : `Unverschlüsselte Adresse. ${restricted} Die HTTPS-Adresse von Stowly hebt das auf.`,
  };
}

const AI_OFFLINE = "Die Einrichtung der KI-Vorschläge kennt nur der Server, und der ist gerade nicht erreichbar.";

type AiSectionModule = typeof import("./AiSection");

let aiSection: AiSectionModule | null = null;
let aiSectionLoading: Promise<AiSectionModule> | null = null;

/** Der Abschnitt „KI-Vorschläge" (seit 0.6.0), nachgeladen; ein gescheitertes Laden darf ein späterer Aufruf noch einmal versuchen. */
function loadAiSection(): Promise<AiSectionModule> {
  aiSectionLoading ??= import("./AiSection").then(
    (module) => {
      aiSection = module;
      return module;
    },
    (error: unknown) => {
      aiSectionLoading = null;
      throw error;
    },
  );
  return aiSectionLoading;
}

// Wie die Ansichten selbst (app/pages.tsx, `preloadPages`): mit diesem Teil gleich mitholen, damit der
// Abschnitt auch dann da ist, wenn der Server später nicht mehr erreichbar ist (ohne Service Worker).
loadAiSection().catch(() => undefined);

/**
 * Platz für „KI-Vorschläge": Das Formular gehört nicht in den Teil der Einstellungen, den jeder Aufruf
 * braucht, und kommt mit dem ersten Zeichnen nach. Lässt es sich nicht laden (ohne Server und ohne
 * Service Worker), steht hier ein Hinweis; der Rest der Einstellungen bleibt.
 */
function AiSectionSlot({ config }: { config: LoadedResource<AiConfig> }) {
  const [loaded, setLoaded] = useState<AiSectionModule | null>(aiSection);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (loaded) {
      return;
    }
    let active = true;
    setFailed(false);
    loadAiSection().then(
      (module) => {
        if (active) {
          setLoaded(module);
        }
      },
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [loaded, attempt]);

  if (loaded) {
    return <loaded.AiSection config={config} />;
  }
  return (
    <Section title="KI-Vorschläge" id="ki">
      {failed ? (
        <Notice
          tone="warn"
          role="status"
          action={
            <Button size="sm" onClick={() => setAttempt((count) => count + 1)}>
              Erneut versuchen
            </Button>
          }
        >
          Dieser Abschnitt ließ sich nicht laden. Mit Verbindung zum Server geht es wieder.
        </Notice>
      ) : (
        <p className={styles.muted}>
          <Spinner label="KI-Vorschläge werden geladen" />
        </p>
      )}
    </Section>
  );
}

/** Die Zeile „KI-Vorschläge" unter „Über": wie die Produktdaten, nach der Einrichtung beim Server (`ai.load`). */
export function describeAi(config: Pick<AiConfig, "configured" | "model"> | null): RowText {
  if (config === null) {
    return { value: "unbekannt", hint: "Ob Vorschläge von Claude eingerichtet sind, weiß nur der Server." };
  }
  if (config.configured) {
    return {
      value: `Anthropic (${modelName(config.model)})`,
      hint: "„Was koche ich?“ fragt Claude auf Knopfdruck nach Gerichten; dabei geht die Vorratsliste an Anthropic. Mehr unter „KI-Vorschläge“.",
    };
  }
  return { value: "aus", hint: "Ohne API-Schlüssel gibt es auf „Was koche ich?“ nur die Such-Links zu Cookidoo und Chefkoch." };
}

/** Die Zeile „Produktdaten": richtet sich danach, ob der Server Barcodes nachschlägt (`sync.status.lookup_enabled`). */
export function describeLookup(enabled: boolean | null | undefined): RowText {
  if (enabled === false) {
    return {
      value: "abgeschaltet",
      hint: "Der Server schlägt keine Produktdaten nach (abgeschaltet). Unbekannte Barcodes bleiben ohne Namen, bis ihn jemand einträgt.",
    };
  }
  if (enabled === true) {
    return { value: "Open Food Facts (ODbL)", hint: "Namen und Bilder zu unbekannten Barcodes schlägt der Server dort nach." };
  }
  return { value: "noch unbekannt", hint: "Ob der Server Produktdaten nachschlägt, steht nach dem nächsten Abgleich fest." };
}

/**
 * Einstellungen nach dem Entwurf: eine Liste aus Zeilen mit dem Bedienelement rechts,
 * gegliedert in Darstellung, dieses Gerät (samt Benachrichtigungen), Haushalt (samt der Uhrzeit
 * der Tagesnachricht), Geräte, Einrichtung und Zugang, Sicherung, Home Assistant und Bring!,
 * KI-Vorschläge (nachgeladen), Aktualisierung, diese App und Über. Solange die Ansicht offen ist, lädt sie den Zustand der
 * Integrationen (Sicherung, Home Assistant, Push, Updates) und die Einstellungen des Servers
 * (Kontakt für Push, Schalter für Updates).
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
  const integrations = useIntegrations();
  const serverConfig = useLoaded(() => core.serverConfig.load(), "Die Einstellungen des Servers kennt nur er, und er ist gerade nicht erreichbar.");
  const ai = useLoaded(() => core.ai.load(), AI_OFFLINE);
  const [installing, setInstalling] = useState(false);
  const [persisting, setPersisting] = useState(false);

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

  async function install() {
    setInstalling(true);
    try {
      await core.app.promptInstall();
    } finally {
      setInstalling(false);
    }
  }

  async function requestPersistence() {
    setPersisting(true);
    try {
      const granted = await core.app.requestPersistence();
      toast.show(
        granted
          ? { message: "Der Browser behält die Daten auf diesem Gerät jetzt dauerhaft.", tone: "success" }
          : { message: "Der Browser hat nicht zugesagt. Als installierte App stehen die Chancen besser.", tone: "warn" },
      );
    } catch (caught) {
      report(caught);
    } finally {
      setPersisting(false);
    }
  }

  const connection = describeConnection(window.location, app?.secure_context);
  const lookup = describeLookup(sync?.lookup_enabled);
  const aiRow = describeAi(loadedValue(ai.state));
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
          <PushSetting integrations={integrations.state} />
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
          <NotifyTimeSetting
            value={isTimeOfDay(settings.notify_time) ? settings.notify_time : DEFAULT_NOTIFY_TIME}
            integrations={integrations.state}
            onCommit={(notify_time) => updateSettings({ notify_time })}
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

      <SetupSection serverConfig={serverConfig} />

      <BackupSection integrations={integrations.state} onReload={integrations.reload} serverConfig={serverConfig} />

      <HomeAssistantSection integrations={integrations.state} onReload={integrations.reload} />

      <AiSectionSlot config={ai} />

      <UpdateSection integrations={integrations.state} onReload={integrations.reload} serverConfig={serverConfig} />

      <Section title="Diese App" id="app" description="Installation und Speicher auf diesem Gerät.">
        <List>
          {app?.installed ? (
            <ListRow label="Installation" hint="Stowly läuft als installierte App." inline>
              <span className={styles.value}>installiert</span>
            </ListRow>
          ) : app?.can_install ? (
            <ListRow label="Installation" hint="Installiert startet Stowly vom Home-Bildschirm wie eine App, und der Browser behält die Daten für den Betrieb ohne Netz.">
              <Button icon={<InstallIcon />} busy={installing} onClick={() => void install()}>
                Stowly installieren
              </Button>
            </ListRow>
          ) : app?.manual_install === "ios" ? (
            <ListRow
              label="Installation auf dem iPhone"
              hint="Ohne Installation löscht Safari die lokalen Daten nach sieben Tagen ohne Nutzung. Installiert bleiben sie erhalten."
              stacked
            >
              <IosInstallSteps />
            </ListRow>
          ) : (
            <ListRow
              label="Installation"
              hint={
                app?.secure_context === false
                  ? "Über eine http-Adresse lässt der Browser keine Installation zu. Über die HTTPS-Adresse von Stowly geht es."
                  : "Dieser Browser bietet gerade keine Installation an. In Chrome und Edge steht sie im Menü unter „App installieren“."
              }
              inline
            >
              <span className={styles.value}>nicht installiert</span>
            </ListRow>
          )}
          <ListRow
            label="Lokaler Speicher"
            hint={
              app?.storage_persistent === true
                ? "Der Browser hat zugesagt, die Kopie auf diesem Gerät nicht von sich aus zu löschen."
                : app?.storage_persistent === false
                  ? "Der Browser darf die Kopie auf diesem Gerät löschen, etwa bei Platzmangel; ungesendete Änderungen gingen dabei verloren. Als installierte App und bei häufiger Nutzung sagt er eher zu."
                  : "Ob der Browser die Kopie auf diesem Gerät dauerhaft behält, ist noch nicht bekannt."
            }
          >
            {app?.storage_persistent === false ? (
              <Button busy={persisting} onClick={() => void requestPersistence()}>
                Erneut anfragen
              </Button>
            ) : (
              <span className={styles.value}>{app?.storage_persistent === true ? "dauerhaft" : "unbekannt"}</span>
            )}
          </ListRow>
        </List>
      </Section>

      <Section title="Über" id="ueber">
        <List>
          <ListRow label="Version" hint={formatBuild() !== "" ? `Stand vom ${formatBuild()}` : undefined} inline>
            <span className={styles.value}>
              Stowly {app?.version ?? "–"}
              {sync?.server_version ? ` · Server ${sync.server_version}` : ""}
            </span>
          </ListRow>
          <ListRow label="Verbindung" hint={connection.hint}>
            <span className={styles.value}>{connection.value}</span>
            {connection.value === HTTP_VALUE ? (
              <ButtonLink to={setupPath("https")} icon={<LockOpenIcon />}>
                Einrichten
              </ButtonLink>
            ) : null}
          </ListRow>
          <ListRow label="Produktdaten" hint={lookup.hint}>
            <span className={styles.value}>{lookup.value}</span>
          </ListRow>
          <ListRow label="KI-Vorschläge" hint={aiRow.hint}>
            <span className={styles.value}>{aiRow.value}</span>
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
