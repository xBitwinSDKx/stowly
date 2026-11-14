import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

import { formatTimestamp, isCoreError, useCore, useLive, type Device } from "@/contract";
import { useLogout } from "@/features/auth/logout";
import { ConfirmDialog, errorText, List, ListRow, Notice, Section, timeAgo, useNow } from "@/ui";
import { Badge, Button, Dialog, dialogFocus, Spinner, TextField, useToast } from "@/ui/base";
import { CloudOffIcon, RefreshIcon } from "@/ui/icons";

import styles from "./SettingsPage.module.css";

type State = { status: "loading" } | { status: "ready"; devices: Device[] } | { status: "error"; offline: boolean; message: string };

/** Eigenes Gerät zuerst, dann die angemeldeten nach „zuletzt gesehen", zuletzt die gesperrten. */
export function sortDevices(devices: readonly Device[]): Device[] {
  const rank = (device: Device) => (device.current ? 0 : device.revoked_at === null ? 1 : 2);
  return [...devices].sort((a, b) => rank(a) - rank(b) || (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") || a.name.localeCompare(b.name, "de"));
}

function RenameDialog({ device, onClose, onRenamed }: { device: Device; onClose: () => void; onRenamed: (device: Device) => void }) {
  const core = useCore();
  const formId = useId();
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Bitte einen Namen eingeben.");
      return;
    }
    if (trimmed === device.name) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onRenamed(await core.devices.rename(device.id, trimmed));
      onClose();
    } catch (caught) {
      setError(errorText(caught, { offline: "Zum Umbenennen braucht es den Server, und der ist gerade nicht erreichbar.", not_found: "Dieses Gerät gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Gerät umbenennen"
      size="sm"
      variant="sheet"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            Speichern
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <TextField ref={dialogFocus} label="Name des Geräts" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" error={error} />
      </form>
    </Dialog>
  );
}

/**
 * Die Geräte des Haushalts: Liste mit „zuletzt gesehen", umbenennen, einzeln abmelden.
 * Braucht den Server; ohne ihn sagt der Abschnitt das und bietet einen neuen Versuch an.
 */
export function DevicesSection() {
  const core = useCore();
  const toast = useToast();
  const logout = useLogout();
  const online = useLive(core.sync.status)?.online;
  const now = useNow();
  const [state, setState] = useState<State>({ status: "loading" });
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);

  const load = useCallback(async () => {
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      setState({ status: "ready", devices: await core.devices.list() });
    } catch (caught) {
      setState({
        status: "error",
        offline: isCoreError(caught, "offline"),
        message: errorText(caught, { offline: "Die Geräteliste liegt auf dem Server, und der ist gerade nicht erreichbar." }),
      });
    }
  }, [core]);

  // Beim Öffnen laden, und noch einmal, sobald sich die Erreichbarkeit des Servers ändert.
  useEffect(() => {
    void load();
  }, [load, online]);

  async function revoke(device: Device) {
    await core.devices.revoke(device.id);
    toast.show({ message: `„${device.name}“ ist abgemeldet`, tone: "success" });
    setRevoking(null);
    await load();
  }

  return (
    <Section
      id="geraete"
      title="Geräte"
      description="Jedes angemeldete Gerät hat einen eigenen Zugang und lässt sich einzeln abmelden, etwa wenn ein Handy verloren geht."
      actions={
        state.status === "ready" ? (
          <Button size="sm" variant="ghost" icon={<RefreshIcon />} onClick={() => void load()}>
            Aktualisieren
          </Button>
        ) : undefined
      }
    >
      {state.status === "loading" ? (
        <List>
          <ListRow label={<span className={styles.muted}>Geräte werden geladen …</span>}>
            <Spinner label="Geräte werden geladen" />
          </ListRow>
        </List>
      ) : state.status === "error" ? (
        <Notice
          tone={state.offline ? "warn" : "danger"}
          icon={state.offline ? <CloudOffIcon /> : undefined}
          role="status"
          action={
            <Button size="sm" onClick={() => void load()}>
              Erneut versuchen
            </Button>
          }
        >
          {state.message}
        </Notice>
      ) : (
        <List>
          {sortDevices(state.devices).map((device) => {
            const revoked = device.revoked_at !== null;
            return (
              <ListRow
                key={device.id}
                label={
                  <span className={styles.deviceName}>
                    <span className={revoked ? styles.muted : undefined}>{device.name}</span>
                    {device.current ? <Badge tone="accent">Dieses Gerät</Badge> : null}
                    {revoked ? <Badge>abgemeldet</Badge> : null}
                  </span>
                }
                hint={
                  revoked && device.revoked_at
                    ? `Abgemeldet am ${formatTimestamp(device.revoked_at)}`
                    : device.last_seen_at
                      ? `Zuletzt gesehen ${timeAgo(device.last_seen_at, now)} (${formatTimestamp(device.last_seen_at)})`
                      : "Noch nie gesehen"
                }
              >
                {revoked ? null : (
                  <>
                    <Button size="sm" aria-label={`Umbenennen: ${device.name}`} onClick={() => setRenaming(device)}>
                      Umbenennen
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Abmelden: ${device.name}`}
                      // Das eigene Gerät geht den Weg mit der Rückfrage zu ungesendeten Änderungen.
                      onClick={() => (device.current ? logout() : setRevoking(device))}
                    >
                      Abmelden
                    </Button>
                  </>
                )}
              </ListRow>
            );
          })}
        </List>
      )}

      {renaming ? (
        <RenameDialog
          key={renaming.id}
          device={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(renamed) =>
            setState((current) =>
              current.status === "ready" ? { status: "ready", devices: current.devices.map((device) => (device.id === renamed.id ? renamed : device)) } : current,
            )
          }
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`„${revoking?.name ?? ""}“ abmelden?`}
        confirmLabel="Abmelden"
        tone="danger"
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
        errorText={(caught) => errorText(caught, { offline: "Zum Abmelden braucht es den Server, und der ist gerade nicht erreichbar.", not_found: "Dieses Gerät gibt es nicht mehr." })}
      >
        <p>Das Gerät verliert seinen Zugang und muss sich mit dem Haushalts-Passwort neu anmelden. Was es noch nicht gesendet hat, reicht es danach nach.</p>
      </ConfirmDialog>
    </Section>
  );
}
