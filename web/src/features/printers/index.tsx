import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { useCore, type PiPairing, type Printer } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { ConfirmDialog, EmptyState, errorText, List, ListRow, Notice, Section, Select, useNow, ZoneLabel } from "@/ui";
import { Button, Dialog, useToast } from "@/ui/base";
import { CpuIcon, PlusIcon, PrinterIcon, WarningIcon } from "@/ui/icons";

import { useLabelActions } from "./labelActions";
import { Labels, pendingFor } from "./Labels";
import { certificateWarningTitle, describeHealth, describeRemoval, piCertificateWarning, printerDuties, printerForZone } from "./model";
import { PairPi } from "./PairPi";
import { usePairedPrinters } from "./usePairedPrinters";
import { PrinterCard, type ProbeState } from "./PrinterCard";
import { PrinterDialog } from "./PrinterDialog";
import styles from "./PrintersPage.module.css";
import { usePrinting } from "./usePrinting";

/** Ergebnis einer Abfrage, zusammen mit dem Stand des Druckers, für den es galt. */
interface ProbeEntry {
  state: ProbeState;
  /** `Printer.updated_at` beim Abfragen: Ändern sich die Angaben, gilt das Ergebnis nicht mehr. */
  version: string;
}

/** Wert der Auswahl für „kein eigener Drucker" bzw. „kein Standarddrucker". */
const NONE = "";

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; printer_id: string }
  | { kind: "delete"; printer_id: string }
  /** Einen Raspberry Pi koppeln; mit `printer_id` einen vorhandenen direkten Drucker übernehmen. */
  | { kind: "pair"; printer_id: string | null }
  | null;

/**
 * „Raspberry Pi koppeln" auf der Druckerseite: neu anlegen oder einen vorhandenen direkten Drucker
 * übernehmen (neu koppeln, etwa vor Ablauf seines Zertifikats). Schließen bricht eine wartende Kopplung ab.
 * `onPaired`: Der Pi ist gekoppelt (sein Zertifikat ist neu).
 */
function PairPiDialog({
  printers,
  initialPrinterId,
  onClose,
  onPaired,
}: {
  printers: readonly Printer[];
  initialPrinterId: string | null;
  onClose: () => void;
  onPaired: () => void;
}) {
  const core = useCore();
  const direct = printers.filter((printer) => printer.connection === "direct");
  const [printerId, setPrinterId] = useState(initialPrinterId ?? NONE);
  const [pairing, setPairing] = useState<PiPairing | null>(null);
  const started = pairing !== null && pairing.state !== "expired" && pairing.state !== "cancelled";

  function close() {
    if (pairing && (pairing.state === "waiting" || pairing.state === "installing")) {
      void core.printers.cancelPairing(pairing.id).catch(() => undefined);
    }
    onClose();
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Raspberry Pi koppeln"
      size="md"
      footer={<Button onClick={close}>{pairing?.state === "paired" ? "Fertig" : "Schließen"}</Button>}
    >
      <div className={styles.pairDialog}>
        {direct.length > 0 ? (
          <Select
            label="Drucker"
            value={printerId}
            onChange={setPrinterId}
            disabled={started}
            hint="Ein übernommener Drucker behält Namen und Zuordnung; nur die Verbindung zum Pi ist neu."
            options={[{ value: NONE, label: "Neuen Drucker anlegen" }, ...direct.map((printer) => ({ value: printer.id, label: `Vorhandenen Drucker übernehmen: ${printer.name}` }))]}
          />
        ) : null}
        <PairPi pairing={pairing} onPairing={setPairing} printerId={printerId === NONE ? null : printerId} sdCard={printerId === NONE} onPaired={onPaired} />
      </div>
    </Dialog>
  );
}

function scrollTo(id: string) {
  const element = document.getElementById(id);
  // Nicht jede Umgebung kann scrollen (Tests): Dann bleibt die Ansicht, wo sie ist.
  if (element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "start" });
  }
}

/**
 * Drucker und Etiketten: die Drucker des Haushalts mit ihrem Zustand, die Zuordnung
 * (Standarddrucker und Drucker je Zone) und die Etiketten.
 */
export function PrintersPage() {
  const core = useCore();
  const toast = useToast();
  const printing = usePrinting();
  const actions = useLabelActions();
  const now = useNow();
  const paired = usePairedPrinters();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [serial, setSerial] = useState(0);
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeEntry>>(new Map());
  const [fresh, setFresh] = useState<string | null>(null);
  const { hash } = useLocation();

  // Verweise wie /drucker#etiketten (Nachfrage im Rahmen): dorthin springen, sobald die Ansicht steht.
  const ready = printing.ready;
  useEffect(() => {
    if (ready && hash.length > 1) {
      scrollTo(decodeURIComponent(hash.slice(1)));
    }
  }, [ready, hash]);

  // Nach dem Löschen ist die Schaltfläche, die den Dialog geöffnet hat, mit dem Drucker verschwunden:
  // Der Fokus geht an „Drucker hinzufügen", statt verloren zu gehen. Die Schaltfläche steht im Kopf
  // oder, ohne Drucker, im leeren Zustand; wechselt sie den Platz, zieht der Fokus mit.
  const addRef = useRef<HTMLButtonElement>(null);
  const [removed, setRemoved] = useState(0);
  const none = ready && printing.printers.length === 0;
  useEffect(() => {
    const active = document.activeElement;
    if (removed > 0 && (active === null || active === document.body)) {
      addRef.current?.focus();
    }
  }, [removed, none]);

  // Eben angelegt: Der nächste Schritt ist „Verbindung prüfen" an der neuen Karte. Dorthin gehen
  // Blick und Fokus, statt zurück zu „Drucker hinzufügen" (die Karte steht oft weiter unten).
  const focusedFresh = useRef<string | null>(null);
  const printerCount = printing.printers.length;
  useEffect(() => {
    if (fresh === null || focusedFresh.current === fresh) {
      return;
    }
    const button = document.querySelector<HTMLElement>(`[data-printer="${fresh}"] [data-probe]`);
    if (!button) {
      return; // Die Karte ist noch nicht da: beim nächsten Zeichnen.
    }
    focusedFresh.current = fresh;
    const card = button.closest("li");
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "center" });
    }
    button.focus({ preventScroll: true });
  }, [fresh, printerCount]);

  if (!printing.ready) {
    return (
      <Page title="Drucker">
        <PageLoading label="Drucker werden geladen …" />
      </Page>
    );
  }

  const { printers, zones, settings, data } = printing;
  // Zertifikate gekoppelter Pi, die bald ablaufen: wie der Server sie kennt (`SetupStatus.paired_printers`).
  const expiring = paired.paired.flatMap((entry) => {
    const printer = printers.find((candidate) => candidate.id === entry.printer_id);
    const days = piCertificateWarning(entry.not_after, now);
    return printer && days !== null ? [{ printer, days, entry }] : [];
  });
  const multiZone = zones.length > 1;
  const byId = (id: string) => printers.find((printer) => printer.id === id);
  const editing = dialog?.kind === "edit" ? byId(dialog.printer_id) : undefined;
  const deleting = dialog?.kind === "delete" ? byId(dialog.printer_id) : undefined;
  const defaultPrinter = settings?.default_printer_id ? byId(settings.default_printer_id) : undefined;

  function open(next: DialogState) {
    setDialog(next);
    setSerial((current) => current + 1);
  }
  const close = () => setDialog(null);

  function report(error: unknown) {
    toast.show({ message: errorText(error), tone: "danger" });
  }

  function setProbe(printer: Printer, state: ProbeState) {
    setProbes((current) => new Map(current).set(printer.id, { state, version: printer.updated_at }));
  }

  /** Das Ergebnis der letzten Abfrage, solange die Angaben zum Drucker seither dieselben sind. */
  function probeOf(printer: Printer): ProbeState | undefined {
    const entry = probes.get(printer.id);
    return entry && (entry.version === printer.updated_at || entry.state.status === "busy") ? entry.state : undefined;
  }

  /**
   * Fragt den Druckdienst jetzt ab. Nur auf eine Handlung des Anwenders hin: Der Browser darf dabei nach dem lokalen Netzwerk fragen.
   * „Verbindung prüfen" behält dabei den Fokus (`busy` sperrt nur über aria-disabled).
   */
  async function probe(printer: Printer) {
    setProbe(printer, { status: "busy" });
    try {
      setProbe(printer, { status: "done", probe: await core.printers.probe(printer.id) });
    } catch (error) {
      setProbe(printer, { status: "failed", message: errorText(error, { not_found: "Diesen Drucker gibt es nicht mehr." }) });
    }
  }

  async function remove(printer: Printer) {
    await core.printers.remove(printer.id);
    toast.show({ message: `Drucker „${printer.name}“ gelöscht` });
    close();
    setRemoved((current) => current + 1);
  }

  const printerOptions = printers.map((printer) => ({ value: printer.id, label: printer.name }));
  const removal = deleting ? describeRemoval(deleting, zones, data, printing.waiting, multiZone) : { duties: [], labels: [] };

  return (
    <Page
      title="Drucker"
      description="Etikettendrucker des Haushalts: im Heimnetz am Server oder am Raspberry Pi im Keller."
      actions={
        printers.length > 0 ? (
          <>
            <Button icon={<CpuIcon />} onClick={() => open({ kind: "pair", printer_id: null })}>
              Raspberry Pi koppeln
            </Button>
            <Button ref={addRef} variant="primary" icon={<PlusIcon />} onClick={() => open({ kind: "create" })}>
              Drucker hinzufügen
            </Button>
          </>
        ) : undefined
      }
    >
      {expiring.map(({ printer, days, entry }) => (
        <Notice
          key={printer.id}
          tone="warn"
          icon={<WarningIcon />}
          title={certificateWarningTitle(printer.name, days, entry.not_after)}
          action={
            <Button size="sm" onClick={() => open({ kind: "pair", printer_id: printer.id })}>
              Neu koppeln
            </Button>
          }
        >
          Danach erreicht die App den Pi {entry.hostname} nicht mehr über HTTPS. Neu koppeln stellt ein neues Zertifikat aus; der Drucker bleibt, wie er ist.
        </Notice>
      ))}
      {printers.length === 0 ? (
        <EmptyState
          icon={<PrinterIcon size={26} />}
          title="Noch kein Drucker eingerichtet"
          actions={
            <>
              <Button variant="primary" icon={<CpuIcon />} onClick={() => open({ kind: "pair", printer_id: null })}>
                Raspberry Pi koppeln
              </Button>
              <Button ref={addRef} icon={<PlusIcon />} onClick={() => open({ kind: "create" })}>
                Drucker hinzufügen
              </Button>
            </>
          }
        >
          Mit einem Etikettendrucker bekommt jede Packung beim Einlagern ein Etikett mit ihrer ID als Klartext und QR-Code; ein Scan bucht sie später wieder aus. Ohne Drucker fordert Stowly
          keine Etiketten an: Die ID lässt sich dann von Hand auf die Packung schreiben.
        </EmptyState>
      ) : (
        <>
          <ul className={styles.printers} aria-label="Drucker">
            {printers.map((printer) => {
              const duties = printerDuties(printer, zones, settings);
              return (
                <PrinterCard
                  key={printer.id}
                  printer={printer}
                  health={describeHealth(printing.status.get(printer.id), printer, now)}
                  now={now}
                  isDefault={duties.isDefault}
                  zones={duties.zones}
                  multiZone={multiZone}
                  probe={probeOf(printer)}
                  fresh={fresh === printer.id}
                  pendingOwn={pendingFor(printing, printer)}
                  handoffBusy={actions.busy === `handoff:${printer.id}`}
                  onProbe={() => void probe(printer)}
                  onEdit={() => open({ kind: "edit", printer_id: printer.id })}
                  onDelete={() => open({ kind: "delete", printer_id: printer.id })}
                  onHandoff={(target) => void actions.handoff(target)}
                />
              );
            })}
          </ul>

          <Section
            id="zuordnung"
            title="Zuordnung"
            description={
              multiZone
                ? "Welcher Drucker die Etiketten druckt: der Drucker der Zone, in der die Packung liegt, sonst der Standarddrucker. Gilt für alle Geräte des Haushalts."
                : "Welcher Drucker die Etiketten druckt. Gilt für alle Geräte des Haushalts."
            }
          >
            <List>
              <ListRow label="Standarddrucker" hint={multiZone ? "Für Zonen ohne eigenen Drucker." : "Druckt alle Etiketten."}>
                <Select
                  className={styles.assign}
                  label="Standarddrucker"
                  hideLabel
                  value={defaultPrinter?.id ?? NONE}
                  onChange={(value) => void core.settings.update({ default_printer_id: value === NONE ? null : value }).catch(report)}
                  options={[{ value: NONE, label: "Kein Standarddrucker" }, ...printerOptions]}
                />
              </ListRow>
              {multiZone
                ? zones.map((zone) => {
                    const own = zone.printer_id ? byId(zone.printer_id) : undefined;
                    const effective = printerForZone(zone.id, data);
                    return (
                      <ListRow
                        key={zone.id}
                        label={<ZoneLabel zone={zone} truncate={false} />}
                        hint={
                          effective ? (
                            <>
                              Druckt auf: <strong className={styles.strong}>{effective.name}</strong>
                              {own ? "" : " (Standarddrucker)"}
                            </>
                          ) : (
                            <span className={styles.warn}>Kein Drucker: Etiketten für diese Zone bleiben ausstehend.</span>
                          )
                        }
                      >
                        <Select
                          className={styles.assign}
                          label={`Drucker für ${zone.name}`}
                          hideLabel
                          value={own?.id ?? NONE}
                          onChange={(value) => void core.zones.update(zone.id, { printer_id: value === NONE ? null : value }).catch(report)}
                          options={[{ value: NONE, label: defaultPrinter ? `Standarddrucker (${defaultPrinter.name})` : "Kein eigener Drucker" }, ...printerOptions]}
                        />
                      </ListRow>
                    );
                  })
                : null}
            </List>
            {!defaultPrinter && (!multiZone || zones.some((zone) => !printerForZone(zone.id, data))) ? (
              <p className={styles.small}>Ohne Standarddrucker bleiben Etiketten ausstehend, sobald ihre Zone keinen eigenen Drucker hat.</p>
            ) : null}
          </Section>
        </>
      )}

      {printers.length > 0 || printing.jobs.length > 0 ? <Labels printing={printing} actions={actions} now={now} onAssign={() => scrollTo("zuordnung")} /> : null}

      {dialog?.kind === "create" ? <PrinterDialog key={serial} onClose={close} onCreated={(created) => setFresh(created.id)} /> : null}
      {editing ? <PrinterDialog key={serial} printer={editing} onClose={close} /> : null}
      {dialog?.kind === "pair" ? <PairPiDialog key={serial} printers={printers} initialPrinterId={dialog.printer_id} onClose={close} onPaired={paired.reload} /> : null}
      <ConfirmDialog
        open={deleting !== undefined}
        onClose={close}
        title={`Drucker „${deleting?.name ?? ""}“ löschen?`}
        confirmLabel="Drucker löschen"
        tone="danger"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        errorText={(error) => errorText(error, { not_found: "Diesen Drucker gibt es nicht mehr." })}
      >
        {/* Wofür er zuständig ist und wer danach druckt; wohin die ausstehenden Etiketten gehen. */}
        <p>{removal.duties.join(" ")}</p>
        <p>{removal.labels.join(" ")}</p>
      </ConfirmDialog>
    </Page>
  );
}
