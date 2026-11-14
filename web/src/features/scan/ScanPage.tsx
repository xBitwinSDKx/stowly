import { ArrowLeft, CameraOff, Flashlight, FlashlightOff, Keyboard, SwitchCamera, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useNavigate } from "react-router";

import {
  APP_VERSION,
  CoreError,
  DEFAULT_DEVICE_PREFS,
  formatBuild,
  formatDate,
  isPlaceholder,
  productTitle,
  ROUTES,
  useCore,
  useLive,
  willLookUp,
  type HouseholdSettings,
  type Package,
  type PrintJob,
  type Product,
  type ScanResult,
  type ShoppingItem,
  type Zone,
} from "@/contract";
import { CROP_FRACTION, playFeedback, setFeedbackActive, type FeedbackTone, type Scanner, type ScannerDiagnostics } from "@/core/scanner";
import { Button, cx, Dialog, IconButton, Spinner, useToast } from "@/ui/base";

import { ManualEntry } from "./ManualEntry";
import { QuantityStepper } from "./QuantityStepper";
import { labelStatus, labelStatusText } from "./label-status";
import { evaluateScan, fifoHint, isOnShoppingList, offersShoppingList } from "./scan-flow";
import styles from "./ScanPage.module.css";
import { StoreSheet, type StoreDecision, type StoreLookup, type StoreRequest } from "./StoreSheet";
import { CAMERA_PROBLEMS, CLOSER_HINT, MANUAL_HINT, RESCAN_HINT, SHOPPING_TEXTS } from "./texts";
import { useScanner } from "./useScanner";
import { ZoneBar } from "./ZoneBar";
import { afterStore, chooseZone, currentZoneId, isTemporary, neighbourZoneId, primaryZoneId, showsZones, type ZoneContext, type ZoneOverride } from "./zone-logic";

const NO_ZONES: Zone[] = [];
const NO_JOBS: PrintJob[] = [];
const NO_PACKAGES: Package[] = [];
const NO_ITEMS: ShoppingItem[] = [];
/** Bis die Einstellungen geladen sind: die Vorgaben des Protokolls. */
const DEFAULT_ZONE_SETTINGS: Pick<HouseholdSettings, "zone_mode" | "primary_zone_id"> = { zone_mode: "primary", primary_zone_id: null };

/** Kennungen der Meldungen: Eine neue ersetzt die vorige ihrer Art, statt sich zu stapeln. */
const TOAST_ACTION = "scan-action";
const TOAST_NOTE = "scan-note";

/** Was zuletzt geschah; steht über den Bedienelementen, bis die nächste Aktion es ersetzt. */
type LastAction =
  | { kind: "stored"; text: string; ids: string[]; jobIds: string[] }
  | {
      kind: "removed";
      text: string;
      id: string;
      reason: "consumed" | "discarded";
      product_id: string;
      /** FIFO-Hinweis auf eine ältere Packung desselben Produkts; nur nach „verbraucht". */
      fifo: string | null;
      /**
       * Es war die letzte Packung eines Produkts ohne Mindestbestand: Die Ansicht bietet die
       * Einkaufsliste an (`offersShoppingList`). Mit Mindestbestand legt der Server den Eintrag an.
       */
      empty: boolean;
      /** Eben über „Auf die Einkaufsliste" dazugekommen. */
      listed: boolean;
    };

function describePackage(pkg: Package, product: Product | undefined): string {
  return `${productTitle(product)} (${pkg.id}${pkg.best_before ? `, MHD ${formatDate(pkg.best_before)}` : ""})`;
}

function errorText(error: unknown): string {
  return error instanceof CoreError ? error.message : "Das hat nicht geklappt.";
}

/** Merkt sich für diesen Tab, dass die Kamera-Infos gewünscht sind (`?diagnose`, aus mit `?diagnose=0`). */
const DIAGNOSE_KEY = "stowly-diagnose";

/**
 * Sollen die Kamera-Infos erscheinen? Einmal mit `?diagnose` geöffnet, bleiben sie in diesem Tab an,
 * auch wenn man danach über „Jetzt scannen" kommt; `?diagnose=0` schaltet sie wieder aus.
 */
function wantsDiagnostics(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get("diagnose");
  try {
    if (value === "0") {
      window.sessionStorage.removeItem(DIAGNOSE_KEY);
      return false;
    }
    if (value !== null) {
      window.sessionStorage.setItem(DIAGNOSE_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(DIAGNOSE_KEY) === "1";
  } catch {
    // Ohne Speicher gilt nur die Adresse.
    return value !== null && value !== "0";
  }
}

/** Ein Wert aus `getCapabilities()` oder `getSettings()` als kurzer Text. */
function describeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "–";
  }
  if (Array.isArray(value)) {
    return value.map(describeValue).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, part]) => `${key} ${describeValue(part)}`)
      .join(" · ");
  }
  return String(value);
}

/** Die Meldungen des Scanners als Text zum Ablesen (und Abschreiben) am Gerät. */
export function describeDiagnostics(info: ScannerDiagnostics, build: string = formatBuild()): string {
  const caps = info.capabilities ?? {};
  const settings = info.settings ?? {};
  return [
    `Stowly ${APP_VERSION}${build !== "" ? `, Stand ${build}` : ""}`,
    `iPhone/iPad erkannt: ${info.apple_mobile ? "ja" : "nein"}`,
    `Erkennung: ${info.engine ?? "–"} · zuletzt ${describeValue(info.detect_ms.last)} ms · Mittel ${describeValue(info.detect_ms.average)} ms`,
    `Kamera: ${info.camera ?? "–"}`,
    `Kameras: ${info.cameras.length > 0 ? info.cameras.join(" | ") : "–"}`,
    `Bild: ${info.video ?? "–"} · Ausschnitt ${describeValue(info.frame)} · angezeigt ${info.display ?? "–"}`,
    `Bilder je Sekunde: ${describeValue(info.fps)} · Kamera geöffnet: ${String(info.starts)}× · ${info.paused ? "angehalten" : "wertet aus"}`,
    `Zoom möglich: ${describeValue(caps.zoom)}`,
    `Zoom eingestellt: ${describeValue(settings.zoom)}`,
    `Fokus möglich: ${describeValue(caps.focusMode)} · Abstand ${describeValue(caps.focusDistance)}`,
    `Fokus eingestellt: ${describeValue(settings.focusMode)} · Abstand ${describeValue(settings.focusDistance)}`,
  ].join("\n");
}

/** Anzeige für `?diagnose`: einmal je Sekunde neu, solange die Ansicht offen ist. */
function Diagnostics({ scanner }: { scanner: Scanner | null }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const update = () => setText(scanner ? describeDiagnostics(scanner.diagnostics()) : "Der Scanner startet …");
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [scanner]);
  return (
    <pre className={styles.diagnostics} aria-label="Kamera-Infos">
      {text}
    </pre>
  );
}

/**
 * Die Scan-Ansicht: Der Scanner erkennt selbst, was er sieht. Ein Produkt-Barcode lagert
 * ein, das Etikett einer Packung bucht sie aus, das Etikett einer Zone wechselt die Zone.
 * Alles geht auch über die Eingabe von Hand.
 */
export function ScanPage() {
  const core = useCore();
  const toast = useToast();
  const navigate = useNavigate();
  const zones = useLive(core.data.zones, NO_ZONES);
  const settings = useLive(core.data.settings);
  const prefs = useLive(core.prefs.value, DEFAULT_DEVICE_PREFS);
  const syncStatus = useLive(core.sync.status);
  const printJobs = useLive(core.data.printJobs, NO_JOBS);
  const shoppingItems = useLive(core.data.shoppingItems, NO_ITEMS);
  // Die Scan-Ansicht liegt außerhalb des Rahmens der App und sieht dessen Hinweis „Neue Version"
  // nicht: Wer nur scannt, bekäme eine neue Version sonst nie.
  const app = useLive(core.app.state);
  const [updating, setUpdating] = useState(false);

  const [quantity, setQuantity] = useState(1);
  const [override, setOverride] = useState<ZoneOverride>(null);
  const [storeRequest, setStoreRequest] = useState<StoreRequest | null>(null);
  const [lookup, setLookup] = useState<StoreLookup | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastAction | null>(null);
  const [listing, setListing] = useState(false);
  /** Schützt davor, dass zwei Scans gleichzeitig ausgewertet werden. */
  const working = useRef(false);
  /** Ein Scan, der während der Auswertung des vorigen eintraf: Er kommt danach dran. */
  const waitingScan = useRef<ScanResult | null>(null);
  const handleScanRef = useRef<(result: ScanResult) => void>(() => undefined);

  const zoneContext = useMemo<ZoneContext>(
    () => ({ zones, settings: settings ?? DEFAULT_ZONE_SETTINGS, remembered: prefs.scan_zone_id }),
    [zones, settings, prefs.scan_zone_id],
  );
  const zonesVisible = showsZones(zoneContext);
  const zoneId = currentZoneId(zoneContext, override);
  const zone = zones.find((candidate) => candidate.id === zoneId);

  const signal = useCallback(
    (tone: FeedbackTone) => playFeedback(tone, { sound: prefs.scan_sound, vibration: prefs.scan_vibration }),
    [prefs.scan_sound, prefs.scan_vibration],
  );

  const fail = useCallback(
    (error: unknown) => {
      signal("error");
      toast.show({ id: TOAST_NOTE, message: errorText(error), tone: "danger" });
    },
    [signal, toast],
  );

  // ---------------------------------------------------------------- Zonen

  const selectZone = useCallback(
    (id: string, announce: boolean) => {
      const choice = chooseZone(zoneContext, override, id);
      setOverride(choice.override);
      if (choice.remember !== undefined && choice.remember !== prefs.scan_zone_id) {
        void core.prefs.update({ scan_zone_id: choice.remember }).catch(() => undefined);
      }
      if (announce) {
        const name = zones.find((candidate) => candidate.id === id)?.name ?? "";
        const temporary = zoneContext.settings.zone_mode === "primary" && choice.override !== null;
        signal("notice");
        toast.show({ id: TOAST_NOTE, message: temporary ? `Das nächste Einlagern geht nach ${name}.` : `Zone: ${name}`, duration: 3000 });
      }
    },
    [core, override, prefs.scan_zone_id, signal, toast, zoneContext, zones],
  );

  // ---------------------------------------------------------------- Entnehmen

  const undoRemoval = useCallback(
    async (pkg: Package, product: Product | undefined) => {
      try {
        await core.stock.restore([pkg.id]);
        setLast(null);
        toast.show({ id: TOAST_ACTION, message: `${describePackage(pkg, product)} ist wieder im Bestand.` });
      } catch (error) {
        fail(error);
      }
    },
    [core, fail, toast],
  );

  const removePackage = useCallback(
    async (pkg: Package, product: Product | undefined, reason: "consumed" | "discarded") => {
      // Der Bestand von eben, frisch gelesen: Er entscheidet über den FIFO-Hinweis und darüber,
      // ob das die letzte Packung war. Beides rein lokal, auch ohne Verbindung.
      const before = core.data.packages.get() ?? NO_PACKAGES;
      await core.stock.remove([pkg.id], reason);
      signal("success");
      const text = `${describePackage(pkg, product)} ${reason === "discarded" ? "als entsorgt gemeldet" : "entnommen"}`;
      const fifo = reason === "consumed" ? fifoHint(pkg, before, zones) : null;
      const empty = offersShoppingList(pkg, product, before);
      setLast({ kind: "removed", text, id: pkg.id, reason, product_id: pkg.product_id, fifo, empty, listed: false });
      // Der Hinweis steht neben „Rückgängig": Wer tauschen will, nimmt zurück und scannt die ältere.
      toast.show({
        id: TOAST_ACTION,
        message: fifo ? `${text}. ${fifo}` : text,
        tone: "success",
        ...(fifo ? { duration: 10_000 } : {}),
        action: { label: "Rückgängig", onAction: () => void undoRemoval(pkg, product) },
      });
    },
    [core, signal, toast, undoRemoval, zones],
  );

  /** „Auf die Einkaufsliste" nach der letzten Packung eines Produkts. */
  const addToShoppingList = useCallback(async () => {
    if (last?.kind !== "removed" || listing) {
      return;
    }
    setListing(true);
    try {
      await core.shopping.create({ product_id: last.product_id });
      setLast((current) => (current?.kind === "removed" && current.id === last.id ? { ...current, listed: true } : current));
    } catch (error) {
      fail(error);
    } finally {
      setListing(false);
    }
  }, [core, fail, last, listing]);

  /** Stattdessen „entsorgt" melden: für die zuletzt entnommene Packung. */
  const markDiscarded = useCallback(async () => {
    if (last?.kind !== "removed") {
      return;
    }
    try {
      const pkg = await core.data.findPackage(last.id);
      if (!pkg) {
        return;
      }
      await removePackage(pkg, await core.data.findProduct(pkg.product_id), "discarded");
    } catch (error) {
      fail(error);
    }
  }, [core, fail, last, removePackage]);

  // ---------------------------------------------------------------- Auswertung eines Scans

  const handleScan = useCallback(
    async (result: ScanResult) => {
      if (working.current) {
        // Der Scanner meldet jeden Code nur einmal: nicht verwerfen, sondern gleich danach auswerten.
        waitingScan.current = result;
        return;
      }
      working.current = true;
      let opened = false;
      try {
        const action = await evaluateScan(result, { ...core.data, zones });
        switch (action.type) {
          case "store":
            signal("notice");
            opened = true;
            setStoreRequest({ barcode: action.barcode, product: action.product });
            break;
          case "remove":
            await removePackage(action.pkg, action.product, "consumed");
            break;
          case "already_removed": {
            const { pkg, product } = action;
            signal("error");
            toast.show({
              id: TOAST_NOTE,
              message: `${describePackage(pkg, product)} ist schon entnommen.`,
              tone: "warn",
              action: { label: "Wieder einlagern", onAction: () => void undoRemoval(pkg, product) },
            });
            break;
          }
          case "unknown_package":
            signal("error");
            toast.show({ id: TOAST_NOTE, message: `Die Packung ${action.package_id} kennt dieses Gerät nicht. Vielleicht fehlt noch ein Abgleich.`, tone: "warn" });
            break;
          case "zone":
            selectZone(action.zone.id, true);
            break;
          case "unknown_zone":
            signal("error");
            toast.show({ id: TOAST_NOTE, message: "Dieses Zonen-Etikett gehört zu keiner Zone mehr.", tone: "warn" });
            break;
          case "unknown_code":
            signal("error");
            toast.show({ id: TOAST_NOTE, message: "Diesen Code kennt Stowly nicht: weder Produkt-Barcode noch Etikett.", tone: "warn" });
            break;
          case "nothing":
            break;
        }
      } catch (error) {
        fail(error);
      } finally {
        working.current = false;
      }
      const next = waitingScan.current;
      waitingScan.current = null;
      // Hat sich eben der Dialog zum Einlagern geöffnet, gehört die Aufmerksamkeit ihm.
      if (next && !opened) {
        handleScanRef.current(next);
      }
    },
    [core, fail, removePackage, selectZone, signal, toast, undoRemoval, zones],
  );

  // Immer die jüngste Fassung, damit ein wartender Scan mit dem aktuellen Stand ausgewertet wird.
  useEffect(() => {
    handleScanRef.current = (result) => void handleScan(result);
  }, [handleScan]);

  // ---------------------------------------------------------------- Einlagern

  // Ein unbekanntes Produkt wird gleich beim Scannen nachgeschlagen, wenn der Server das tut und
  // erreichbar ist (docs/sync-protokoll.md, Abschnitt 10). Der Dialog ist da schon offen.
  const statusRef = useRef(syncStatus);
  useEffect(() => {
    statusRef.current = syncStatus;
  });
  useEffect(() => {
    const request = storeRequest;
    const status = statusRef.current;
    const unknown = request !== null && (request.product === undefined || isPlaceholder(request.product));
    if (!request || !unknown || !willLookUp(request.barcode, status?.lookup_enabled ?? null) || status?.online === false) {
      setLookup(null);
      return undefined;
    }
    let current = true;
    setLookup({ state: "loading" });
    void core.products.lookup(request.barcode).then((result) => {
      if (current) {
        setLookup(result);
      }
    });
    return () => {
      current = false;
    };
  }, [core, storeRequest]);

  const confirmStore = useCallback(
    async (decision: StoreDecision) => {
      const request = storeRequest;
      if (!request || busy) {
        return;
      }
      if (zoneId === null) {
        fail(new CoreError("not_found", "Es gibt noch keine Zone, in die sich einlagern ließe."));
        return;
      }
      setBusy(true);
      try {
        const name = decision.name.trim();
        const brand = decision.brand.trim();
        const size = decision.quantity.trim();
        // Name, Marke und Größe gelten als Eingabe des Anwenders, auch die nachgeschlagenen.
        const stored = await core.stock.store({
          product: { kind: "barcode", barcode: request.barcode, ...(name !== "" ? { name } : {}), ...(brand !== "" ? { brand } : {}), ...(size !== "" ? { quantity: size } : {}) },
          zone_id: zoneId,
          best_before: decision.best_before,
          count: quantity,
        });
        // Ein Platzhalter, den es schon gab, bekommt sie nachträglich, soweit seine Felder leer sind.
        if (isPlaceholder(stored.product)) {
          const changes = {
            ...(name !== "" ? { name } : {}),
            ...(brand !== "" && stored.product.brand === "" ? { brand } : {}),
            ...(size !== "" && stored.product.quantity === "" ? { quantity: size } : {}),
          };
          if (Object.keys(changes).length > 0) {
            await core.products.update(stored.product.id, changes);
          }
        }
        const ids = stored.packages.map((pkg) => pkg.id);
        const title = name !== "" && isPlaceholder(stored.product) ? name : productTitle(stored.product);
        const where = zonesVisible && zone ? ` nach ${zone.name}` : "";
        const text = `${ids.length} × ${title}${where} eingelagert`;
        signal("success");
        setLast({ kind: "stored", text, ids, jobIds: stored.print_jobs.map((job) => job.id) });
        toast.show({
          id: TOAST_ACTION,
          message: `${text}: ${ids.join(", ")}`,
          tone: "success",
          duration: 10_000,
          action: {
            label: "Rückgängig",
            onAction: () => {
              core.stock.remove(ids, "mistake").then(() => {
                setLast(null);
                toast.show({ id: TOAST_ACTION, message: "Das Einlagern ist rückgängig gemacht." });
              }, fail);
            },
          },
        });
        setStoreRequest(null);
        // Die Menge springt zurück; im Modus „Primärzone" gilt wieder die Primärzone.
        setQuantity(1);
        setOverride(afterStore(zoneContext, override));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    [busy, core, fail, override, quantity, signal, storeRequest, toast, zone, zoneContext, zoneId, zonesVisible],
  );

  // ---------------------------------------------------------------- Kamera

  const { videoRef, state, scanner } = useScanner({
    cameraId: prefs.scan_camera_id,
    onScan: (result) => void handleScan(result),
    onCameraChosen: (deviceId) => void core.prefs.update({ scan_camera_id: deviceId }).catch(() => undefined),
    paused: storeRequest !== null || manualOpen,
  });

  // Ton: läuft nur, solange die Ansicht offen ist.
  useEffect(() => {
    setFeedbackActive(true);
    return () => setFeedbackActive(false);
  }, []);

  // Meldungen erscheinen über den Bedienelementen am unteren Rand, nicht darauf.
  const bottomRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = bottomRef.current;
    const root = document.documentElement;
    if (!element) {
      return undefined;
    }
    const update = () => root.style.setProperty("--toast-offset", `${element.offsetHeight + 12}px`);
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--toast-offset");
    };
  }, []);

  // Der Rahmen zeigt den Ausschnitt, den die Erkennung auswertet.
  const viewfinderRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<number | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    const box = viewfinderRef.current;
    if (!video || !box) {
      return undefined;
    }
    const update = () => {
      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight || !box.clientWidth || !box.clientHeight) {
        setFrameSize(null);
        return;
      }
      // Das Bild füllt die Fläche (object-fit: cover). Ragt der ausgewertete Ausschnitt über den
      // sichtbaren Teil hinaus (Querformat-Kamera auf einem Hochformat-Bildschirm), bleibt der
      // Rahmen im Bild.
      const scale = Math.max(box.clientWidth / videoWidth, box.clientHeight / videoHeight);
      const evaluated = Math.min(videoWidth, videoHeight) * CROP_FRACTION * scale;
      setFrameSize(Math.round(Math.min(evaluated, box.clientWidth - 32, box.clientHeight - 32)));
    };
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(box);
    update();
    return () => {
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [videoRef]);

  // Wischen über das Kamerabild wechselt zur Nachbarzone: mit einer Hand erreichbar.
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  function onPointerDown(event: PointerEvent) {
    swipe.current = zonesVisible ? { x: event.clientX, y: event.clientY, at: event.timeStamp } : null;
  }
  function onPointerUp(event: PointerEvent) {
    const start = swipe.current;
    swipe.current = null;
    if (!start) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy) || event.timeStamp - start.at > 700) {
      return;
    }
    const next = neighbourZoneId(zoneContext, override, dx < 0 ? 1 : -1);
    if (next !== null) {
      selectZone(next, true);
    }
  }

  const diagnose = useMemo(wantsDiagnostics, []);
  const problem = state.status === "error" && state.error ? CAMERA_PROBLEMS[state.error] : null;
  // Was aus den Etiketten des letzten Einlagerns geworden ist: Der Halbsatz folgt dem Zustellen.
  const labels = last?.kind === "stored" ? labelStatus(printJobs, last.jobIds) : null;
  // Nach der letzten Packung eines Produkts ohne Mindestbestand: anbieten oder sagen, dass es schon
  // auf der Liste steht. Mit Mindestbestand weder das eine noch das andere: Den Eintrag legt der
  // Server an (Protokoll 7.6). Nach dem Rückgängig des Einlagerns ("mistake") steht hier nichts.
  const removed = last?.kind === "removed" ? last : null;
  const listed = removed !== null && removed.empty && isOnShoppingList(removed.product_id, shoppingItems);
  const zoom = state.zoom;
  const zoomTarget = zoom ? (zoom.value > 1.5 ? Math.max(1, zoom.min) : Math.min(2, zoom.max)) : 1;

  return (
    <main className={styles.page} data-scanner={state.status} data-engine={state.engine ?? undefined}>
      <header className={styles.top}>
        <Button variant="ghost" icon={<ArrowLeft />} aria-label="Zurück zum Bestand" onClick={() => void navigate(ROUTES.stock)}>
          Bestand
        </Button>
        <h1 className={styles.title}>Scannen</h1>
        <div className={styles.tools}>
          {app?.update_ready && !app.update_required ? (
            <Button
              variant="primary"
              size="sm"
              busy={updating}
              onClick={() => {
                setUpdating(true);
                void core.app.applyUpdate().finally(() => setUpdating(false));
              }}
            >
              Neue Version
            </Button>
          ) : null}
          {state.status === "running" && zoom && zoom.max >= 1.5 ? (
            <Button variant="ghost" size="sm" icon={<ZoomIn />} aria-label={`Zoom auf ${zoomTarget}-fach stellen`} onClick={() => void scanner?.setZoom(zoomTarget)}>
              {`${zoom.value > 1.5 ? "2" : "1"}×`}
            </Button>
          ) : null}
          {state.status === "running" && state.torch.available ? (
            <IconButton
              label={state.torch.on ? "Taschenlampe ausschalten" : "Taschenlampe einschalten"}
              aria-pressed={state.torch.on}
              className={cx(state.torch.on && styles.toolOn)}
              onClick={() => void scanner?.setTorch(!state.torch.on)}
            >
              {state.torch.on ? <Flashlight /> : <FlashlightOff />}
            </IconButton>
          ) : null}
          {state.cameras.length > 1 ? (
            <IconButton label="Kamera wechseln" onClick={() => void scanner?.switchCamera()}>
              <SwitchCamera />
            </IconButton>
          ) : null}
        </div>
      </header>

      {zonesVisible ? (
        <ZoneBar
          zones={zones}
          currentId={zoneId}
          primaryId={zoneContext.settings.zone_mode === "primary" ? primaryZoneId(zoneContext) : null}
          temporary={isTemporary(zoneContext, override)}
          onSelect={(id) => selectZone(id, false)}
        />
      ) : (
        <div />
      )}

      <div ref={viewfinderRef} className={styles.viewfinder} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)}>
        <video ref={videoRef} className={cx(styles.video, state.status !== "running" && styles.videoHidden)} muted playsInline aria-label="Kamerabild" />
        {diagnose ? <Diagnostics scanner={scanner} /> : null}
        {state.status === "running" ? (
          <>
            <div className={styles.frame} style={frameSize ? { ["--frame-size" as string]: `${frameSize}px` } : undefined} aria-hidden="true" />
            {state.rescan ? (
              // Der Barcode von eben ist seit dem Dialog im Bild: Er öffnet ihn nicht von selbst wieder.
              <p className={cx(styles.hint, styles.closer)}>{RESCAN_HINT}</p>
            ) : state.too_small ? (
              // Ein Etikett ist erkannt, aber zu weit weg: nichts buchen, nur sagen, was hilft.
              <p className={cx(styles.hint, styles.closer)}>{CLOSER_HINT}</p>
            ) : (
              <p className={styles.hint}>Barcode zum Einlagern, Etikett zum Entnehmen{zonesVisible ? ", Zonen-Etikett zum Wechseln" : ""}</p>
            )}
          </>
        ) : null}
        {state.status === "starting" || state.status === "idle" ? (
          <div className={styles.center}>
            <Spinner size={28} label="Die Kamera wird geöffnet" />
          </div>
        ) : null}
        {problem ? (
          <div className={styles.problem}>
            <div className={styles.problemBody}>
              <CameraOff size={32} className={styles.problemIcon} aria-hidden="true" />
              <h2 className={styles.problemTitle}>{problem.title}</h2>
              <p className={styles.problemText}>
                {problem.text} {MANUAL_HINT}
              </p>
              {problem.retry ? (
                <Button onClick={() => void scanner?.start()} block>
                  Kamera erneut versuchen
                </Button>
              ) : null}
              <ManualEntry onSubmit={(result) => void handleScan(result)} />
            </div>
          </div>
        ) : null}
      </div>

      <footer ref={bottomRef} className={styles.bottom}>
        {last ? (
          <div className={styles.last} aria-live="polite">
            <div className={styles.lastBody}>
              <p className={styles.lastText}>
                {last.text}
                {last.kind === "stored" ? (
                  <>
                    : <span className={styles.lastIds}>{last.ids.join(", ")}</span>
                    {labels ? <span className={styles.lastLabels}> · {labelStatusText(labels, last.jobIds.length)}</span> : null}
                  </>
                ) : null}
              </p>
              {removed?.fifo ? <p className={styles.fifo}>{removed.fifo}</p> : null}
              {listed ? <p className={styles.lastNote}>{removed.listed || listing ? SHOPPING_TEXTS.added : SHOPPING_TEXTS.already}</p> : null}
            </div>
            {removed && ((removed.empty && !listed) || removed.reason === "consumed") ? (
              <div className={styles.lastActions}>
                {removed.empty && !listed ? (
                  <Button size="sm" busy={listing} onClick={() => void addToShoppingList()}>
                    {SHOPPING_TEXTS.add}
                  </Button>
                ) : null}
                {removed.reason === "consumed" ? (
                  <Button size="sm" onClick={() => void markDiscarded()}>
                    Entsorgt
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={styles.controls}>
          <div className={styles.quantity}>
            <span className={styles.controlLabel}>Menge</span>
            <QuantityStepper value={quantity} onChange={setQuantity} label="Menge für das nächste Einlagern" />
          </div>
          {problem ? null : (
            <Button size="lg" icon={<Keyboard />} onClick={() => setManualOpen(true)}>
              Von Hand
            </Button>
          )}
        </div>
      </footer>

      <StoreSheet
        request={storeRequest}
        quantity={quantity}
        onQuantity={setQuantity}
        zoneName={zonesVisible && zone ? zone.name : null}
        lookupEnabled={syncStatus?.lookup_enabled ?? null}
        lookup={lookup}
        imageUrl={core.data.imageUrl}
        busy={busy}
        onConfirm={(decision) => void confirmStore(decision)}
        onCancel={() => setStoreRequest(null)}
      />

      <Dialog open={manualOpen} onClose={() => setManualOpen(false)} title="Von Hand eingeben" variant="sheet" size="sm">
        <ManualEntry
          inDialog
          onSubmit={(result) => {
            setManualOpen(false);
            void handleScan(result);
          }}
        />
      </Dialog>
    </main>
  );
}
