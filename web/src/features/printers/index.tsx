import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { useCore, type Printer } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { ConfirmDialog, EmptyState, errorText, List, ListRow, plural, Section, Select, useNow, ZoneLabel } from "@/ui";
import { Button, useToast } from "@/ui/base";
import { PlusIcon, PrinterIcon } from "@/ui/icons";

import { useLabelActions } from "./labelActions";
import { Labels, pendingFor } from "./Labels";
import { describeHealth, printerDuties, printerForZone } from "./model";
import { PrinterCard, type ProbeState } from "./PrinterCard";
import { PrinterDialog } from "./PrinterDialog";
import styles from "./PrintersPage.module.css";
import { usePrinting } from "./usePrinting";

/** Wert der Auswahl für „kein eigener Drucker" bzw. „kein Standarddrucker". */
const NONE = "";

type DialogState = { kind: "create" } | { kind: "edit"; printer_id: string } | { kind: "delete"; printer_id: string } | null;

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
  const [dialog, setDialog] = useState<DialogState>(null);
  const [serial, setSerial] = useState(0);
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeState>>(new Map());
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

  if (!printing.ready) {
    return (
      <Page title="Drucker">
        <PageLoading label="Drucker werden geladen …" />
      </Page>
    );
  }

  const { printers, zones, settings, data } = printing;
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

  function setProbe(id: string, state: ProbeState) {
    setProbes((current) => new Map(current).set(id, state));
  }

  /** Fragt den Druckdienst jetzt ab. Nur auf eine Handlung des Anwenders hin: Der Browser darf dabei nach dem lokalen Netzwerk fragen. */
  async function probe(printer: Printer) {
    setProbe(printer.id, { status: "busy" });
    try {
      setProbe(printer.id, { status: "done", probe: await core.printers.probe(printer.id) });
    } catch (error) {
      setProbe(printer.id, { status: "failed", message: errorText(error, { not_found: "Diesen Drucker gibt es nicht mehr." }) });
    }
  }

  async function remove(printer: Printer) {
    await core.printers.remove(printer.id);
    toast.show({ message: `Drucker „${printer.name}“ gelöscht` });
    close();
    setRemoved((current) => current + 1);
  }

  const printerOptions = printers.map((printer) => ({ value: printer.id, label: printer.name }));
  const deletingDuties = deleting ? printerDuties(deleting, zones, settings) : undefined;
  const deletingPending = deleting ? printing.waiting.filter((view) => view.printer?.id === deleting.id).length : 0;

  return (
    <Page
      title="Drucker"
      description="Etikettendrucker des Haushalts: im Heimnetz am Server oder am Raspberry Pi im Keller."
      actions={
        printers.length > 0 ? (
          <Button ref={addRef} variant="primary" icon={<PlusIcon />} onClick={() => open({ kind: "create" })}>
            Drucker hinzufügen
          </Button>
        ) : undefined
      }
    >
      {printers.length === 0 ? (
        <EmptyState
          icon={<PrinterIcon size={26} />}
          title="Noch kein Drucker eingerichtet"
          actions={
            <Button ref={addRef} variant="primary" icon={<PlusIcon />} onClick={() => open({ kind: "create" })}>
              Drucker hinzufügen
            </Button>
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
                  probe={probes.get(printer.id)}
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
      <ConfirmDialog
        open={deleting !== undefined}
        onClose={close}
        title={`Drucker „${deleting?.name ?? ""}“ löschen?`}
        confirmLabel="Drucker löschen"
        tone="danger"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        errorText={(error) => errorText(error, { not_found: "Diesen Drucker gibt es nicht mehr." })}
      >
        <p>
          {deletingDuties && (deletingDuties.isDefault || deletingDuties.zones.length > 0)
            ? `${[deletingDuties.isDefault ? "Er ist der Standarddrucker" : null, deletingDuties.zones.length > 0 ? `${deletingDuties.isDefault ? "und " : "Er "}druckt für ${deletingDuties.zones.map((zone) => `„${zone.name}“`).join(", ")}` : null].filter(Boolean).join(" ")}. `
            : ""}
          Zonen mit diesem Drucker nutzen danach wieder den Standarddrucker{deletingDuties?.isDefault ? "; einen Standarddrucker gibt es dann nicht mehr, bis ein anderer gewählt ist" : ""}.
        </p>
        <p>
          {deletingPending > 0
            ? `${plural(deletingPending, "ausstehendes Etikett bleibt", "ausstehende Etiketten bleiben")} stehen und ${deletingPending === 1 ? "wird" : "werden"} gedruckt, sobald ein anderer Drucker zuständig ist.`
            : "Ausstehende Etiketten bleiben stehen, bis ein anderer Drucker zuständig ist."}
        </p>
      </ConfirmDialog>
    </Page>
  );
}
