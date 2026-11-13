import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { LIMITS, useCore, type DirectPrinterConfig, type Printer, type PrinterChanges, type PrinterConnection, type PrinterDriver, type ServerPrinterConfig } from "@/contract";
import { errorText, FieldGroup, Notice, Select } from "@/ui";
import { Button, Dialog, dialogFocus, IconButton, SegmentedControl, TextField, useToast } from "@/ui/base";
import { CloseIcon, EyeIcon, EyeOffIcon, PlusIcon } from "@/ui/icons";

import styles from "./PrintersPage.module.css";

export interface PrinterDialogProps {
  /** Der Drucker, der bearbeitet wird; ohne Angabe wird ein neuer angelegt. */
  printer?: Printer;
  onClose: () => void;
  /** Nach dem Anlegen: Die Ansicht bietet dann an, die Verbindung zu prüfen. */
  onCreated?: (printer: Printer) => void;
}

/** Die Rolle steht in dieser Stufe fest: 62 mm endlos. */
const MEDIA = "62";
/** Die Modelle, die der Treiber sicher kennt; freie Eingabe bleibt erlaubt. */
const MODELS = ["QL-800", "QL-810W", "QL-820NWB"];
/** So richtet die Anleitung den Pi ein: erst HTTPS, dann HTTP. */
const USUAL_URLS = ["https://10.71.83.1:8443", "http://10.71.83.1:8080"];

const DRIVER_OPTIONS: { value: PrinterDriver; label: string }[] = [
  { value: "brother_ql", label: "Brother QL" },
  { value: "image", label: "Bild (PNG), zum Ausprobieren" },
];

/** Eine Adresse eines Druckdienstes: http oder https, mit Rechner. */
export function isServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Die Adresse eines Druckers am Server, wie der Treiber sie versteht. */
export function isDriverAddress(value: string): boolean {
  return /^(tcp|usb):\/\/\S+$/.test(value);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Drucker anlegen oder ändern.
 *
 * Am Server: Der Server steuert den Drucker (Treiber, Modell, Adresse). Direkt: Dieses Gerät
 * spricht selbst mit dem Druckdienst auf dem Raspberry Pi (Adressen, Token). Die Art lässt
 * sich nach dem Anlegen nicht ändern.
 */
export function PrinterDialog({ printer, onClose, onCreated }: PrinterDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const modelsId = useId();

  const [name, setName] = useState(printer?.name ?? "");
  const [connection, setConnection] = useState<PrinterConnection>(printer?.connection ?? "server");
  const [driver, setDriver] = useState<PrinterDriver>(printer?.server?.driver ?? "brother_ql");
  const [model, setModel] = useState(printer?.server?.model ?? "");
  const [address, setAddress] = useState(printer?.server?.address ?? "");
  const [urls, setUrls] = useState<string[]>(printer?.direct?.urls ?? USUAL_URLS);
  const [token, setToken] = useState(printer?.direct?.token ?? "");
  const [showToken, setShowToken] = useState(false);
  const [queue, setQueue] = useState(printer?.direct?.printer ?? "");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adressen kommen und gehen: Der Fokus folgt, statt mit der entfernten Schaltfläche zu verschwinden.
  const urlsRef = useRef<HTMLDivElement>(null);
  const addUrlRef = useRef<HTMLButtonElement>(null);
  const [urlFocus, setUrlFocus] = useState<{ field: number | null } | null>(null);
  useEffect(() => {
    if (!urlFocus) {
      return;
    }
    if (urlFocus.field === null) {
      addUrlRef.current?.focus();
    } else {
      urlsRef.current?.querySelectorAll("input")[urlFocus.field]?.focus();
    }
  }, [urlFocus]);

  function addUrl() {
    setUrls([...urls, ""]);
    // Das neue Feld: Dort geht es gleich weiter.
    setUrlFocus({ field: urls.length });
  }

  function removeUrl(index: number) {
    setUrls(urls.filter((_, position) => position !== index));
    // Kein Eingabefeld: Am Handy spränge sonst die Tastatur auf.
    setUrlFocus({ field: null });
  }

  const trimmedName = name.trim();
  const trimmedModel = model.trim();
  const trimmedAddress = address.trim();
  const cleanUrls = urls.map((url) => url.trim()).filter((url) => url !== "");
  const brother = connection === "server" && driver === "brother_ql";

  const nameError = trimmedName === "" ? "Bitte einen Namen eingeben." : null;
  const modelError = brother && trimmedModel === "" ? "Bitte das Modell angeben, z. B. QL-820NWB." : null;
  const addressError = !brother
    ? null
    : trimmedAddress === ""
      ? "Bitte die Adresse des Druckers angeben."
      : isDriverAddress(trimmedAddress)
        ? null
        : "Erwartet wird tcp://… für einen Drucker im Netzwerk oder usb://… für einen Drucker am Server.";
  const urlErrors = urls.map((url) => (connection !== "direct" || url.trim() === "" || isServiceUrl(url.trim()) ? null : "Keine gültige Adresse. Beispiel: https://10.71.83.1:8443"));
  const urlsError = connection === "direct" && cleanUrls.length === 0 ? "Bitte mindestens eine Adresse angeben." : null;
  const tokenError = connection === "direct" && token.trim() === "" ? "Bitte das Token eingeben." : null;
  const invalid = nameError || modelError || addressError || urlsError || tokenError || urlErrors.some((entry) => entry !== null);

  function serverConfig(): ServerPrinterConfig {
    return brother ? { driver, model: trimmedModel, address: trimmedAddress, media: MEDIA } : { driver, model: null, address: null, media: MEDIA };
  }

  function directConfig(): DirectPrinterConfig {
    return { urls: cleanUrls, token: token.trim(), printer: queue.trim() === "" ? null : queue.trim() };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (invalid) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (printer) {
        const changes: PrinterChanges = {};
        if (trimmedName !== printer.name) {
          changes.name = trimmedName;
        }
        if (printer.connection === "server") {
          const next = serverConfig();
          const old = printer.server;
          if (!old || old.driver !== next.driver || old.model !== next.model || old.address !== next.address || old.media !== next.media) {
            changes.server = next;
          }
        } else {
          const next = directConfig();
          const old = printer.direct;
          if (!old || !sameList(old.urls, next.urls) || old.token !== next.token || old.printer !== next.printer) {
            changes.direct = next;
          }
        }
        if (Object.keys(changes).length > 0) {
          await core.printers.update(printer.id, changes);
          toast.show({ message: `Drucker „${trimmedName}“ geändert`, tone: "success" });
        }
        onClose();
      } else {
        const created =
          connection === "server"
            ? await core.printers.create({ name: trimmedName, connection: "server", server: serverConfig() })
            : await core.printers.create({ name: trimmedName, connection: "direct", direct: directConfig() });
        toast.show({ message: `Drucker „${created.name}“ angelegt`, tone: "success" });
        onCreated?.(created);
        onClose();
      }
    } catch (caught) {
      // Der Satz nennt nie das Token: Er kommt aus dem Code des Fehlers oder aus der Eingabeprüfung des Kerns.
      setError(errorText(caught, { not_found: "Diesen Drucker gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={printer ? "Drucker bearbeiten" : "Drucker hinzufügen"}
      variant="sheet"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            {printer ? "Speichern" : "Anlegen"}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          ref={dialogFocus}
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          placeholder="z. B. Keller, Küche"
          error={tried ? nameError : null}
        />

        {printer ? (
          <FieldGroup label="Art" hint="Die Art lässt sich nach dem Anlegen nicht ändern.">
            <span>{printer.connection === "server" ? "Am Server" : "Direkt (Raspberry Pi)"}</span>
          </FieldGroup>
        ) : (
          <FieldGroup
            label="Art"
            hint={
              connection === "server"
                ? "Der Drucker steht im Heimnetz oder hängt am Server; der Server druckt. Etiketten kommen an, sobald der Server erreichbar ist."
                : "Der Drucker hängt an einem Raspberry Pi mit eigenem WLAN, etwa im Keller. Dieses Gerät schickt die Etiketten selbst dorthin, auch ohne Server."
            }
          >
            <SegmentedControl<PrinterConnection>
              label="Art"
              block
              value={connection}
              onChange={setConnection}
              options={[
                { value: "server", label: "Am Server" },
                { value: "direct", label: "Direkt (Raspberry Pi)" },
              ]}
            />
          </FieldGroup>
        )}

        {connection === "server" ? (
          <>
            <Select
              label="Treiber"
              value={driver}
              onChange={setDriver}
              options={DRIVER_OPTIONS}
              hint={
                driver === "image"
                  ? "Schreibt jedes Etikett als Bild, statt zu drucken. So lässt sich der ganze Weg ohne Drucker ausprobieren."
                  : "Für die Etikettendrucker der Reihe Brother QL. Gedruckt wird auf die 62-mm-Endlosrolle."
              }
            />
            {brother ? (
              <>
                <TextField
                  label="Modell"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  maxLength={LIMITS.printer_model}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  list={modelsId}
                  placeholder="z. B. QL-820NWB"
                  hint="Die Bezeichnung, wie der Treiber sie kennt. Vorschläge: QL-800, QL-810W, QL-820NWB."
                  error={tried ? modelError : null}
                />
                <datalist id={modelsId}>
                  {MODELS.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
                <TextField
                  label="Adresse"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  maxLength={LIMITS.printer_address}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="url"
                  placeholder="tcp://192.168.1.60:9100"
                  hint="Im Netzwerk: tcp://, die IP-Adresse des Druckers und der Port 9100. Per USB am Server: usb:// und die Kennung des Geräts, z. B. usb://04f9:209b."
                  error={tried ? addressError : null}
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            <Notice tone="info">
              Adressen und Token stehen in der Anleitung des Raspberry Pi; das Installationsskript zeigt sie am Ende an. Sie gelten für alle Geräte des Haushalts.
            </Notice>
            <FieldGroup
              label="Adressen des Druckdienstes"
              hint="Versucht wird in dieser Reihenfolge: üblich erst die HTTPS-Adresse, dann die HTTP-Adresse. Das iPhone erreicht den Pi nur über HTTPS."
              error={tried ? urlsError : null}
            >
              <div ref={urlsRef} className={styles.urls}>
                {urls.map((url, index) => (
                  <div key={index} className={styles.urlRow}>
                    <TextField
                      className={styles.grow}
                      label={`Adresse ${String(index + 1)}`}
                      hideLabel
                      value={url}
                      onChange={(event) => setUrls(urls.map((entry, position) => (position === index ? event.target.value : entry)))}
                      maxLength={LIMITS.printer_url}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="url"
                      placeholder={USUAL_URLS[index] ?? "https://…"}
                      error={tried ? (urlErrors[index] ?? null) : null}
                    />
                    {urls.length > 1 ? (
                      <IconButton label={`Adresse ${String(index + 1)} entfernen`} onClick={() => removeUrl(index)}>
                        <CloseIcon />
                      </IconButton>
                    ) : null}
                  </div>
                ))}
                {urls.length < LIMITS.printer_urls ? (
                  <Button ref={addUrlRef} size="sm" variant="ghost" icon={<PlusIcon />} className={styles.addUrl} onClick={addUrl}>
                    Adresse hinzufügen
                  </Button>
                ) : null}
              </div>
            </FieldGroup>
            <TextField
              label="Token"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              maxLength={LIMITS.printer_token}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              hint="Das Geheimnis des Druckdienstes. Wer es kennt, kann dort drucken."
              error={tried ? tokenError : null}
              trailing={
                <IconButton label={showToken ? "Token verbergen" : "Token anzeigen"} size="sm" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>
                  {showToken ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              }
            />
            <TextField
              label="Name des Druckers im Dienst (freiwillig)"
              value={queue}
              onChange={(event) => setQueue(event.target.value)}
              maxLength={LIMITS.printer_queue}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              hint="Leer = der Standarddrucker des Pi. Nur nötig, wenn am Pi mehrere Drucker hängen."
            />
          </>
        )}

        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
