import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  detectPlatform,
  ENDPOINTS,
  isCoreError,
  LIMITS,
  ROUTES,
  useCore,
  useLive,
  type HttpsStatus,
  type SetupAddress,
  type SetupChanges,
  type SetupStatus,
} from "@/contract";
import { DESKTOP_QUERY, errorText, Notice, plural, useMediaQuery } from "@/ui";
import { Button, ButtonLink, Spinner, TextField, useToast } from "@/ui/base";
import { DownloadIcon, InfoIcon, RefreshIcon, ShieldCheckIcon, WarningIcon } from "@/ui/icons";
import { QrCode } from "@/ui/QrCode";

import { navigateAway, rememberMove } from "./navigateAway";
import styles from "./SetupPage.module.css";
import { TrustGuide } from "./TrustGuide";
import { SETUP_OFFLINE } from "./useSetup";

/** Loopback und lokale Entwicklung: Diese Adressen erreicht ein Handy nicht. */
function isLoopback(host: string): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(host) || host.endsWith(".localhost");
}

/** Eine Adresse für eine URL: IPv6 in eckigen Klammern. */
function urlHost(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

/**
 * Unter welchem Namen ein Handy Stowly erreicht: der Name dieser Seite, außer sie läuft unter
 * localhost; dann die erste Adresse im Heimnetz, die der Server kennt.
 */
export function phoneHost(hostname: string, addresses: readonly Pick<SetupAddress, "address">[]): string {
  if (!isLoopback(hostname)) {
    return hostname;
  }
  const lan = addresses.find((entry) => !isLoopback(entry.address));
  return lan ? urlHost(lan.address) : hostname;
}

/**
 * Wo ein anderes Gerät das Zertifikat der CA lädt: über http, denn HTTPS vertraut es ja noch nicht.
 * Der HTTP-Port ist der gelernte (`http_port`), sonst der dieser Seite. Kennt ihn eine HTTPS-Seite
 * nicht, bleibt nur ihre eigene Adresse (der Browser warnt dann einmal).
 */
export function certificateUrl(https: Pick<HttpsStatus, "http_port" | "addresses">, location: Pick<Location, "protocol" | "hostname" | "port" | "origin">): string {
  const port = https.http_port ?? (location.protocol === "http:" && location.port !== "" ? Number(location.port) : null);
  if (port === null && location.protocol === "https:") {
    return `${location.origin}${ENDPOINTS.download_ca.path}`;
  }
  return `http://${phoneHost(location.hostname, https.addresses)}${port === null ? "" : `:${String(port)}`}${ENDPOINTS.download_ca.path}`;
}

function QrFigure({ value, caption }: { value: string; caption: string }) {
  return (
    <figure className={styles.qr}>
      <QrCode value={value} title={`QR-Code: ${caption}`} size={168} />
      <figcaption>
        <strong>{caption}</strong>
        <br />
        <span className={styles.fingerprint}>{value}</span>
      </figcaption>
    </figure>
  );
}

export interface SecureStepProps {
  status: SetupStatus;
  update: (changes: SetupChanges) => Promise<SetupStatus>;
  /** Die Seite läuft über HTTPS (auch hinter einem Reverse Proxy). */
  secure: boolean;
}

/**
 * „Sichere Verbindung": Über HTTPS ist nichts mehr zu tun (am Desktop gibt es die QR-Codes für
 * weitere Geräte). Über http: Zertifikat laden, ihm nach der Anleitung des Geräts vertrauen, prüfen,
 * dann zur HTTPS-Adresse wechseln. Ohne eigenes HTTPS ein Verweis auf die Anleitung zum Betrieb.
 */
export function SecureStep({ status, update, secure }: SecureStepProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const https = status.https;
  if (secure) {
    return (
      <>
        <Notice tone="success" icon={<ShieldCheckIcon />} title="Diese Seite läuft über HTTPS.">
          Scannen, Offline-Betrieb und Direktdruck gehen damit auf diesem Gerät.
        </Notice>
        {desktop ? (
          <section className={styles.block}>
            <h3 className={styles.subtitle}>Weitere Geräte</h3>
            <p className={styles.muted}>Mit der Kamera des Handys scannen: erst das Zertifikat laden und ihm vertrauen, dann Stowly über HTTPS öffnen.</p>
            <div className={styles.qrs}>
              <QrFigure value={certificateUrl(https, window.location)} caption="Zertifikat laden" />
              <QrFigure value={window.location.origin} caption="Stowly über HTTPS" />
            </div>
          </section>
        ) : null}
      </>
    );
  }
  if (!https.enabled) {
    return (
      <Notice tone="info" icon={<InfoIcon />} title="Stowly hat hier kein eigenes HTTPS.">
        Dafür braucht der Container den Port 8443 (STOWLY_HTTPS_PORT) oder einen Reverse Proxy davor; wie das geht, steht in docs/betrieb.md. Bis dahin lässt sich dieser Schritt
        überspringen.
      </Notice>
    );
  }
  return <SecureViaHttp https={https} update={update} desktop={desktop} />;
}

type Check = "checking" | "trusted" | "untrusted";

function SecureViaHttp({ https, update, desktop }: { https: HttpsStatus; update: SecureStepProps["update"]; desktop: boolean }) {
  const core = useCore();
  const session = useLive(core.session.state);
  const [{ platform, isFirefox }] = useState(() => detectPlatform(typeof navigator === "undefined" ? undefined : navigator));
  const origin = https.port === null ? null : `https://${window.location.hostname}:${String(https.port)}`;
  const [check, setCheck] = useState<Check>("checking");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(async () => {
    latest.current += 1;
    const call = latest.current;
    if (origin === null) {
      setCheck("untrusted");
      return;
    }
    setCheck("checking");
    const trusted = await core.setup.reachesSecurely(origin);
    if (call === latest.current) {
      setCheck(trusted ? "trusted" : "untrusted");
    }
  }, [core, origin]);

  // Geprüft wird beim Öffnen und bei jeder Rückkehr auf die Seite (etwa aus den Einstellungen des Geräts).
  useEffect(() => {
    void run();
    const onVisible = () => {
      if (document.visibilityState !== "hidden") {
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [run]);

  /**
   * Der Wechsel (docs/plan-einrichtung.md, 7): abgleichen, hier abmelden (nicht, solange Änderungen
   * noch nicht beim Server sind), dann die HTTPS-Adresse öffnen, mit dem Namen dieses Geräts.
   */
  async function move() {
    if (origin === null) {
      return;
    }
    const name = session?.status === "signed_in" ? session.device.name : "";
    const target = `${origin}${ROUTES.setup}${name === "" ? "" : `#geraet=${encodeURIComponent(name)}`}`;
    setMoving(true);
    setMoveError(null);
    await core.sync.now();
    // Schon jetzt merken: Die Anmeldung, die nach dem Abmelden kurz erscheint, nennt so das Ziel.
    rememberMove(target);
    try {
      await core.session.logout();
    } catch (caught) {
      rememberMove(null);
      setMoving(false);
      const pending = isCoreError(caught, "pending_changes") ? Number(caught.details.pending) : null;
      setMoveError(
        pending !== null
          ? `Erst abgleichen: ${plural(Number.isFinite(pending) && pending > 0 ? pending : 1, "Änderung ist", "Änderungen sind")} noch nicht beim Server.`
          : errorText(caught),
      );
      return;
    }
    navigateAway(target);
  }

  const problem = https.problem ?? (https.listening ? null : "Der HTTPS-Listener läuft nicht.");
  const download = `${ENDPOINTS.download_ca.path}${platform === "ios" ? "" : "?download=true"}`;

  return (
    <>
      {problem !== null ? (
        <Notice tone="warn" icon={<WarningIcon />} title="HTTPS läuft gerade nicht">
          {problem}
        </Notice>
      ) : null}
      {https.ca ? (
        <section className={styles.block}>
          <h3 className={styles.subtitle}>1. Zertifikat laden</h3>
          <div className={styles.actions}>
            <ButtonLink reloadDocument to={download} variant="primary" icon={<DownloadIcon />}>
              Zertifikat laden
            </ButtonLink>
          </div>
          <details className={styles.details}>
            <summary>Fingerabdruck prüfen</summary>
            <p className={styles.muted}>Wer sichergehen will, vergleicht ihn mit dem, was das Gerät beim Installieren zeigt (SHA-256):</p>
            <p className={styles.fingerprint}>{https.ca.fingerprint_sha256}</p>
          </details>
        </section>
      ) : null}
      <section className={styles.block}>
        <h3 className={styles.subtitle}>2. Dem Zertifikat vertrauen</h3>
        <TrustGuide platform={platform} firefox={isFirefox} caName={https.ca?.name ?? "Stowly CA"} />
      </section>
      <section className={styles.block}>
        <h3 className={styles.subtitle}>3. Prüfen</h3>
        {check === "checking" ? (
          <p className={styles.actions}>
            <Spinner size={18} label="Die sichere Verbindung wird geprüft" />
            <span aria-hidden="true">Die sichere Verbindung wird geprüft …</span>
          </p>
        ) : check === "trusted" ? (
          <Notice tone="success" role="status" icon={<ShieldCheckIcon />} title="Dieses Gerät vertraut Stowly.">
            <div className={styles.block}>
              <div className={styles.actions}>
                <Button variant="primary" busy={moving} onClick={() => void move()}>
                  Zur sicheren Adresse wechseln
                </Button>
              </div>
              <p className={styles.muted}>Dabei wird dieses Gerät hier abgemeldet; unter {origin} einmal neu anmelden.</p>
              {moveError ? (
                <p role="alert" className={styles.error}>
                  {moveError}
                </p>
              ) : null}
            </div>
          </Notice>
        ) : (
          <>
            <Notice
              tone="warn"
              role="status"
              icon={<WarningIcon />}
              title="Noch keine sichere Verbindung."
              action={
                <Button size="sm" icon={<RefreshIcon />} onClick={() => void run()}>
                  Erneut prüfen
                </Button>
              }
            >
              <ul className={styles.tips}>
                <li>Ist das Vertrauen eingeschaltet (der letzte Schritt der Anleitung)?</li>
                <li>Den Browser einmal neu starten.</li>
                <li>Ist Port {https.port ?? 8443} in den Einstellungen des Containers freigegeben, in der Spalte „Lokaler Port“?</li>
                <li>Hat das NAS im Router eine feste IP-Adresse?</li>
              </ul>
            </Notice>
            <Advanced https={https} update={update} />
          </>
        )}
      </section>
      {desktop ? (
        <section className={styles.block}>
          <h3 className={styles.subtitle}>Fürs Handy</h3>
          <p className={styles.muted}>Mit der Kamera des Handys scannen: Es lädt das Zertifikat; weiter geht es mit der Anleitung „iPhone“ oder „Android“.</p>
          <div className={styles.qrs}>
            <QrFigure value={certificateUrl(https, window.location)} caption="Zertifikat laden" />
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Ein Port aus dem Feld: null für leer (wieder selbst erkennen); undefined, wenn es keiner ist. */
function readPort(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const port = Number(trimmed);
  return /^\d+$/.test(trimmed) && port >= 1 && port <= 65535 ? port : undefined;
}

/** „Erweitert": ein anderer HTTPS-Port und weitere Adressen fürs Zertifikat. */
function Advanced({ https, update }: { https: HttpsStatus; update: SecureStepProps["update"] }) {
  const toast = useToast();
  const [port, setPort] = useState(https.port_source === "manual" && https.port !== null ? String(https.port) : "");
  const [addresses, setAddresses] = useState(() =>
    https.addresses
      .filter((entry) => entry.source === "manual")
      .map((entry) => entry.address)
      .join(", "),
  );
  const [portError, setPortError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"port" | "addresses" | null>(null);
  const certified = https.addresses.filter((entry) => entry.in_certificate).map((entry) => entry.address);

  async function savePort(event: FormEvent) {
    event.preventDefault();
    const value = readPort(port);
    if (value === undefined) {
      setPortError("Ein Port ist eine Zahl von 1 bis 65535.");
      return;
    }
    setBusy("port");
    setPortError(null);
    try {
      await update({ https_port: value });
      toast.show({ message: value === null ? "Stowly erkennt den HTTPS-Port wieder selbst." : `HTTPS-Port ${String(value)} gespeichert.`, tone: "success" });
    } catch (caught) {
      setPortError(errorText(caught, { offline: SETUP_OFFLINE }));
    } finally {
      setBusy(null);
    }
  }

  async function saveAddresses(event: FormEvent) {
    event.preventDefault();
    const list = addresses
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (list.length > LIMITS.setup_addresses) {
      setAddressError(`Höchstens ${String(LIMITS.setup_addresses)} Adressen.`);
      return;
    }
    setBusy("addresses");
    setAddressError(null);
    try {
      await update({ addresses: list });
      toast.show({ message: "Adressen gespeichert. Das Zertifikat gilt jetzt auch für sie.", tone: "success" });
    } catch (caught) {
      // Der Server nennt die Stelle (details.errors[].loc = ["body", "addresses", i]).
      const errors = isCoreError(caught) && Array.isArray(caught.details.errors) ? (caught.details.errors as { loc?: unknown[] }[]) : [];
      const index = errors[0]?.loc?.[2];
      const which = typeof index === "number" && list[index] !== undefined ? `${list[index]}: ` : "";
      setAddressError(`${which}${errorText(caught, { offline: SETUP_OFFLINE })}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className={styles.details}>
      <summary>Erweitert</summary>
      <div className={styles.block}>
        <form className={styles.inline} onSubmit={(event) => void savePort(event)} noValidate>
          <TextField
            label="HTTPS-Port"
            inputMode="numeric"
            autoComplete="off"
            placeholder={String(https.port ?? 8443)}
            hint="Der Port, unter dem HTTPS von außen erreichbar ist. Leer: Stowly erkennt ihn selbst."
            value={port}
            onChange={(event) => setPort(event.target.value)}
            error={portError}
          />
          <Button type="submit" busy={busy === "port"}>
            Speichern
          </Button>
        </form>
        <p className={styles.muted}>Das Zertifikat gilt für: {certified.length > 0 ? certified.join(", ") : "noch keine Adresse im Heimnetz"}.</p>
        <form className={styles.inline} onSubmit={(event) => void saveAddresses(event)} noValidate>
          <TextField
            label="Weitere Adressen"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="nas.fritz.box"
            hint="IP-Adressen oder Namen im Heimnetz, durch Komma getrennt."
            value={addresses}
            onChange={(event) => setAddresses(event.target.value)}
            error={addressError}
          />
          <Button type="submit" busy={busy === "addresses"}>
            Speichern
          </Button>
        </form>
      </div>
    </details>
  );
}
