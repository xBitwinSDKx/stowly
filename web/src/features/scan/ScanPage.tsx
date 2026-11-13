import { ArrowLeft, CameraOff, Flashlight, FlashlightOff, Keyboard, SwitchCamera, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useNavigate } from "react-router";

import {
  CoreError,
  DEFAULT_DEVICE_PREFS,
  formatDate,
  isPlaceholder,
  productTitle,
  ROUTES,
  useCore,
  useLive,
  type HouseholdSettings,
  type Package,
  type Product,
  type ScanResult,
  type Zone,
} from "@/contract";
import { CROP_FRACTION, playFeedback, setFeedbackActive, type FeedbackTone } from "@/core/scanner";
import { Button, cx, Dialog, IconButton, Spinner, useToast } from "@/ui/base";

import { ManualEntry } from "./ManualEntry";
import { QuantityStepper } from "./QuantityStepper";
import { evaluateScan } from "./scan-flow";
import styles from "./ScanPage.module.css";
import { StoreSheet, type StoreDecision, type StoreRequest } from "./StoreSheet";
import { CAMERA_PROBLEMS, MANUAL_HINT } from "./texts";
import { useScanner } from "./useScanner";
import { ZoneBar } from "./ZoneBar";
import { afterStore, chooseZone, currentZoneId, isTemporary, neighbourZoneId, primaryZoneId, showsZones, type ZoneContext, type ZoneOverride } from "./zone-logic";

const NO_ZONES: Zone[] = [];
/** Bis die Einstellungen geladen sind: die Vorgaben des Protokolls. */
const DEFAULT_ZONE_SETTINGS: Pick<HouseholdSettings, "zone_mode" | "primary_zone_id"> = { zone_mode: "primary", primary_zone_id: null };

/** Kennungen der Meldungen: Eine neue ersetzt die vorige ihrer Art, statt sich zu stapeln. */
const TOAST_ACTION = "scan-action";
const TOAST_NOTE = "scan-note";

/** Was zuletzt geschah; steht über den Bedienelementen, bis die nächste Aktion es ersetzt. */
type LastAction =
  | { kind: "stored"; text: string; ids: string[] }
  | { kind: "removed"; text: string; id: string; reason: "consumed" | "discarded" };

function describePackage(pkg: Package, product: Product | undefined): string {
  return `${productTitle(product)} (${pkg.id}${pkg.best_before ? `, MHD ${formatDate(pkg.best_before)}` : ""})`;
}

function errorText(error: unknown): string {
  return error instanceof CoreError ? error.message : "Das hat nicht geklappt.";
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

  const [quantity, setQuantity] = useState(1);
  const [override, setOverride] = useState<ZoneOverride>(null);
  const [storeRequest, setStoreRequest] = useState<StoreRequest | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastAction | null>(null);
  /** Schützt davor, dass zwei Scans gleichzeitig ausgewertet werden. */
  const working = useRef(false);

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
      await core.stock.remove([pkg.id], reason);
      signal("success");
      const text = `${describePackage(pkg, product)} ${reason === "discarded" ? "als entsorgt gemeldet" : "entnommen"}`;
      setLast({ kind: "removed", text, id: pkg.id, reason });
      toast.show({
        id: TOAST_ACTION,
        message: text,
        tone: "success",
        action: { label: "Rückgängig", onAction: () => void undoRemoval(pkg, product) },
      });
    },
    [core, signal, toast, undoRemoval],
  );

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
        return;
      }
      working.current = true;
      try {
        const action = await evaluateScan(result, { ...core.data, zones });
        switch (action.type) {
          case "store":
            signal("notice");
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
    },
    [core, fail, removePackage, selectZone, signal, toast, undoRemoval, zones],
  );

  // ---------------------------------------------------------------- Einlagern

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
        const stored = await core.stock.store({
          product: name === "" ? { kind: "barcode", barcode: request.barcode } : { kind: "barcode", barcode: request.barcode, name },
          zone_id: zoneId,
          best_before: decision.best_before,
          count: quantity,
        });
        // Ein Platzhalter, den es schon gab, bekommt den eingetippten Namen nachträglich.
        if (name !== "" && isPlaceholder(stored.product)) {
          await core.products.update(stored.product.id, { name });
        }
        const ids = stored.packages.map((pkg) => pkg.id);
        const title = name !== "" && isPlaceholder(stored.product) ? name : productTitle(stored.product);
        const where = zonesVisible && zone ? ` nach ${zone.name}` : "";
        const text = `${ids.length} × ${title}${where} eingelagert`;
        signal("success");
        setLast({ kind: "stored", text, ids });
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

  const problem = state.status === "error" && state.error ? CAMERA_PROBLEMS[state.error] : null;
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
        {state.status === "running" ? (
          <>
            <div className={styles.frame} style={frameSize ? { ["--frame-size" as string]: `${frameSize}px` } : undefined} aria-hidden="true" />
            <p className={styles.hint}>Barcode zum Einlagern, Etikett zum Entnehmen{zonesVisible ? ", Zonen-Etikett zum Wechseln" : ""}</p>
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
            <p className={styles.lastText}>
              {last.text}
              {last.kind === "stored" ? (
                <>
                  : <span className={styles.lastIds}>{last.ids.join(", ")}</span>
                </>
              ) : null}
            </p>
            {last.kind === "removed" && last.reason === "consumed" ? (
              <Button size="sm" onClick={() => void markDiscarded()}>
                Entsorgt
              </Button>
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
