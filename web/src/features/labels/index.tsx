import { useEffect, useMemo, useRef, useState } from "react";

import {
  isCoreError,
  LIMITS,
  packageLabelData,
  productTitle,
  ROUTES,
  useCore,
  useLive,
  zoneLabelData,
  type LabelDesign,
  type LabelDesignState,
  type LabelKind,
  type LabelLayout,
  type LabelPaper,
  type LabelPreviewInput,
  type Printer,
  type PrinterProbe,
} from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { useHasPrinter } from "@/features/printers/usePrinting";
import { usePairedPrinters } from "@/features/printers/usePairedPrinters";
import { rememberPapers, useHouseholdPaper } from "@/features/printers/paper";
import { outdatedService, paperName, serviceOf } from "@/features/printers/verdict";
import { ConfirmDialog, errorText, FieldGroup, List, ListRow, Notice, Section, Select, Stepper } from "@/ui";
import { Button, ButtonLink, cx, IconButton, SegmentedControl, Spinner, Switch, TextField, useToast } from "@/ui/base";
import { ArrowDownIcon, ArrowUpIcon, CloudOffIcon, InfoIcon, PrinterIcon, RefreshIcon, UndoIcon, WarningIcon } from "@/ui/icons";

import styles from "./LabelsPage.module.css";
import {
  fieldLabel,
  fieldRows,
  layoutOfProblem,
  LENGTH_MAX_MM,
  LENGTH_MIN_MM,
  moveField,
  needsFormat2,
  rollFits,
  sameDesign,
  setFieldSize,
  setTitleLines,
  SIDE_OPTIONS,
  SIZE_OPTIONS,
  TITLE_LINES_MAX,
  toggleField,
  withPaper,
} from "./model";
import { usePreview } from "./usePreview";

/**
 * Die Gestaltung, die diese Seite zuletzt vom Server bekommen hat, je Kern. Ohne Server bleibt die
 * Seite so lesbar, solange die App offen ist; Vorschau und Speichern brauchen ihn.
 */
const remembered = new WeakMap<object, LabelDesignState>();

/** Wert der Auswahl „Beispiel mit langem Namen" (statt einer Packung oder Zone). */
const EXAMPLE = "";
/** So viele Packungen bietet die Auswahl für die Vorschau höchstens an. */
const SAMPLE_PACKAGES = 50;

const KIND_OPTIONS: readonly { value: LabelKind; label: string }[] = [
  { value: "package", label: "Packung" },
  { value: "zone", label: "Zone" },
];

type ProbeEntry = { status: "busy" } | { status: "done"; probe: PrinterProbe } | { status: "failed" };

/** Ein Hinweis zu einem Drucker, wenn das Papier nicht passt. */
interface PrinterHint {
  printer: Printer;
  text: string;
  /** Neu koppeln hilft (ein zu alter Druckdienst auf dem Pi). */
  repair: boolean;
}

/** Die Felder einer Etikettenart: an und aus, Reihenfolge mit Pfeilen, Größe, beim Namen die Zeilen. */
function FieldList({ kind, layout, onChange }: { kind: LabelKind; layout: LabelLayout; onChange: (layout: LabelLayout) => void }) {
  const rows = fieldRows(kind, layout);
  const count = layout.fields.length;
  return (
    <ul className={styles.fields} aria-label="Felder">
      {rows.map((row) => {
        const name = fieldLabel(kind, row.field);
        return (
          <li key={row.field} className={cx(styles.field, !row.on && styles.fieldOff)} data-field={row.field}>
            <Switch className={styles.fieldSwitch} label={name} checked={row.on} onChange={(on) => onChange(toggleField(layout, row.field, on))} />
            {row.on ? (
              <div className={styles.fieldControls}>
                <SegmentedControl label={`Größe: ${name}`} options={SIZE_OPTIONS} value={row.size} onChange={(size) => onChange(setFieldSize(layout, row.field, size))} />
                {row.field === "title" ? (
                  <Select
                    className={styles.lines}
                    label={`Zeilen: ${name}`}
                    hideLabel
                    value={String(row.lines ?? 1)}
                    onChange={(value) => onChange(setTitleLines(layout, Number(value)))}
                    options={Array.from({ length: TITLE_LINES_MAX }, (_, index) => ({ value: String(index + 1), label: index === 0 ? "1 Zeile" : `${String(index + 1)} Zeilen` }))}
                  />
                ) : null}
                <span className={styles.arrows}>
                  <IconButton label={`Nach oben: ${name}`} size="sm" disabled={row.position <= 0} onClick={() => onChange(moveField(layout, row.field, -1))}>
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton label={`Nach unten: ${name}`} size="sm" disabled={row.position >= count - 1} onClick={() => onChange(moveField(layout, row.field, 1))}>
                    <ArrowDownIcon />
                  </IconButton>
                </span>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Etiketten gestalten (docs/plan-0.5.md, 1): ein Papier für alle Drucker, je eine Gestaltung für
 * Packungs- und Zonen-Etiketten, daneben (am Handy darüber) die Vorschau, wie der Druckdienst sie
 * rendert. Gilt für den ganzen Haushalt; nach dem Speichern bekommen alle Geräte die neue Vorlage
 * mit dem Abgleich. Ohne Server bleibt die Seite lesbar; Vorschau und Speichern brauchen ihn.
 */
export function LabelsPage() {
  const core = useCore();
  const toast = useToast();
  const status = useLive(core.sync.status);
  const online = status?.online;
  const packages = useLive(core.data.packages);
  const products = useLive(core.data.products);
  const zones = useLive(core.data.zones);
  const printers = useLive(core.data.printers);
  const hasPrinter = useHasPrinter();
  const paired = usePairedPrinters();
  const household = useHouseholdPaper();

  const [state, setState] = useState<LabelDesignState | null>(() => remembered.get(core) ?? null);
  const [draft, setDraft] = useState<LabelDesign | null>(() => remembered.get(core)?.design ?? null);
  const [loadProblem, setLoadProblem] = useState<"offline" | string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [kind, setKind] = useState<LabelKind>("package");
  const [samples, setSamples] = useState<Record<LabelKind, string>>({ package: EXAMPLE, zone: EXAMPLE });
  const [busy, setBusy] = useState<"save" | "reset" | "print" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeEntry>>(new Map());
  /** Die Gestaltung, die zuletzt vom Server kam: Was davon abweicht, ist ungespeichert. */
  const baseline = useRef<LabelDesign | null>(remembered.get(core)?.design ?? null);

  // Laden, und noch einmal, sobald der Server wieder da ist. Ungespeichertes bleibt dabei stehen.
  useEffect(() => {
    let cancelled = false;
    core.labels.design().then(
      (loaded) => {
        if (cancelled) {
          return;
        }
        remembered.set(core, loaded);
        rememberPapers(loaded.papers);
        setState(loaded);
        setDraft((current) => (current === null || sameDesign(current, baseline.current) ? loaded.design : current));
        baseline.current = loaded.design;
        setLoadProblem(null);
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadProblem(isCoreError(error, "offline") ? "offline" : errorText(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [core, attempt]);
  useEffect(() => {
    if (online === true && loadProblem !== null) {
      setAttempt((current) => current + 1);
    }
  }, [online, loadProblem]);

  const papers = state?.papers ?? [];
  const paper: LabelPaper | undefined = draft ? papers.find((candidate) => candidate.id === draft.paper) : undefined;
  const layout = draft?.[kind];
  const dirty = draft !== null && state !== null && !sameDesign(draft, state.design);
  const serverReady = online !== false && state !== null;

  // Inhalt der Vorschau: eine Packung aus dem Bestand, eine Zone, oder das Beispiel des Servers.
  const sample = samples[kind];
  const sampleOptions = useMemo(() => {
    if (kind === "zone") {
      return (zones ?? []).map((zone) => ({ value: zone.id, label: zone.name }));
    }
    const byId = new Map((products ?? []).map((product) => [product.id, product]));
    return (packages ?? [])
      .map((pkg) => ({ value: pkg.id, label: `${productTitle(byId.get(pkg.product_id))} · ${pkg.id}` }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"))
      .slice(0, SAMPLE_PACKAGES);
  }, [kind, packages, products, zones]);
  const sampleData = useMemo((): Record<string, string> | null => {
    if (sample === EXAMPLE) {
      return null;
    }
    if (kind === "zone") {
      const zone = zones?.find((candidate) => candidate.id === sample);
      return zone ? { ...zoneLabelData(zone) } : null;
    }
    const pkg = packages?.find((candidate) => candidate.id === sample);
    if (!pkg) {
      return null;
    }
    const product = products?.find((candidate) => candidate.id === pkg.product_id);
    return { ...packageLabelData(pkg, product, zones?.find((zone) => zone.id === pkg.zone_id)) };
  }, [kind, sample, packages, products, zones]);

  const input: LabelPreviewInput | null = draft && layout && paper ? { kind, paper: draft.paper, layout, data: sampleData } : null;
  const preview = usePreview(input, serverReady);

  function change(next: LabelLayout) {
    setDraft((current) => (current ? { ...current, [kind]: next } : current));
    setSaveError(null);
  }

  async function save() {
    if (!draft) {
      return;
    }
    setBusy("save");
    setSaveError(null);
    try {
      const saved = await core.labels.save(draft);
      remembered.set(core, saved);
      baseline.current = saved.design;
      setState(saved);
      setDraft(saved.design);
      toast.show({ message: "Gestaltung gespeichert. Alle Geräte bekommen die neue Vorlage mit dem nächsten Abgleich.", tone: "success" });
    } catch (error) {
      // Der Server nennt die Stelle: Betrifft der Satz die andere Etikettenart, dorthin wechseln.
      const where = isCoreError(error, "invalid") ? layoutOfProblem(error.details) : null;
      if (where !== null && where !== kind) {
        setKind(where);
      }
      const text = errorText(error, { offline: "Speichern braucht den Server, und der ist gerade nicht erreichbar." });
      setSaveError(where === null ? text : `${where === "package" ? "Packungs-Etikett" : "Zonen-Etikett"}: ${text}`);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const fresh = await core.labels.reset();
      remembered.set(core, fresh);
      baseline.current = fresh.design;
      setState(fresh);
      setDraft(fresh.design);
      setSaveError(null);
      setConfirmReset(false);
      toast.show({ message: "Es gelten wieder die mitgelieferten Etiketten.", tone: "success" });
    } finally {
      setBusy(null);
    }
  }

  async function testPrint() {
    setBusy("print");
    try {
      if (kind === "package") {
        await core.print.requestPackageLabels([sample]);
      } else {
        await core.print.requestZoneLabel(sample);
      }
      toast.show({ message: "Probedruck angefordert. Den Stand zeigt die Seite „Drucker“.", tone: "success" });
    } catch (error) {
      toast.show({ message: errorText(error, { not_found: "Für den Probedruck fehlt der Drucker oder der Inhalt." }), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  /** Fragt jeden Drucker nach seiner Rolle (auf einen Tipp hin: Der Browser darf dabei nach dem lokalen Netzwerk fragen). */
  async function probeAll() {
    for (const printer of printers ?? []) {
      setProbes((current) => new Map(current).set(printer.id, { status: "busy" }));
      try {
        const probe = await core.printers.probe(printer.id);
        setProbes((current) => new Map(current).set(printer.id, { status: "done", probe }));
      } catch {
        setProbes((current) => new Map(current).set(printer.id, { status: "failed" }));
      }
    }
  }

  if (state === null || draft === null || layout === undefined) {
    return (
      <Page title="Etiketten gestalten">
        {loadProblem === null ? (
          <PageLoading label="Gestaltung wird geladen …" />
        ) : (
          <>
            <Notice tone="neutral" role="status" icon={<CloudOffIcon />} title={loadProblem === "offline" ? "Die Gestaltung liegt beim Server, und der ist gerade nicht erreichbar." : loadProblem}>
              {household?.name ? <p>Papier für alle Drucker laut den Vorlagen auf diesem Gerät: {household.name}.</p> : null}
              <p>Sobald der Server wieder da ist, lädt die Seite von selbst.</p>
            </Notice>
            <ButtonLink to={ROUTES.printers}>Zurück zu den Druckern</ButtonLink>
          </>
        )}
      </Page>
    );
  }

  const format2 = needsFormat2(draft, paper);
  // Probedruck erst, wenn alles gespeichert ist und die neuen Vorlagen über den Sync da sind.
  const synced = household !== null && household.hashes.package === state.templates.package && household.hashes.zone === state.templates.zone;
  const printBlock = !hasPrinter
    ? "Für einen Probedruck fehlt ein Drucker."
    : dirty
      ? "Probedruck geht nach dem Speichern."
      : !synced
        ? "Die neue Vorlage kommt mit dem nächsten Abgleich; danach geht der Probedruck."
        : sample === EXAMPLE || sampleData === null
          ? kind === "package"
            ? "Für einen Probedruck oben eine Packung aus dem Bestand wählen."
            : "Für einen Probedruck oben eine Zone wählen."
          : null;

  // Je Drucker, wenn das Papier nicht passt: ein zu alter Druckdienst auf dem Pi, eine andere Rolle.
  const hints: PrinterHint[] = [];
  for (const printer of printers ?? []) {
    const entry = probes.get(printer.id);
    const probe = entry?.status === "done" ? entry.probe : undefined;
    if (printer.connection === "direct" && format2) {
      const old = outdatedService(2, probe, paired.paired.find((candidate) => candidate.printer_id === printer.id));
      if (old) {
        hints.push({ printer, text: `Der Druckdienst ${old.version ?? "auf dem Pi"} kann nur 62 mm endlos. Neu koppeln aktualisiert ihn.`, repair: true });
      }
    }
    const loaded = probe ? (serviceOf(probe, printer)?.loaded ?? null) : null;
    if (loaded && paper && !rollFits(loaded, paper)) {
      hints.push({ printer, text: `Eingelegt ist ${paperName(loaded, papers) ?? "eine andere Rolle"}.`, repair: false });
    }
  }
  const probing = [...probes.values()].some((entry) => entry.status === "busy");
  const probed = probes.size > 0 && !probing;

  return (
    <Page title="Etiketten gestalten" description="Gilt für den ganzen Haushalt: ein Papier für alle Drucker, je eine Gestaltung für Packungen und Zonen.">
      {online === false ? (
        <Notice tone="neutral" role="status" icon={<CloudOffIcon />} title="Ohne Verbindung zum Server">
          Die Gestaltung lässt sich ansehen. Vorschau und Speichern brauchen den Server.
        </Notice>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.previewArea}>
          <section className={styles.preview} aria-label="Vorschau">
            <SegmentedControl label="Etikettenart" options={KIND_OPTIONS} value={kind} onChange={setKind} block />
            <Select
              label="Inhalt der Vorschau"
              value={sample}
              onChange={(value) => setSamples((current) => ({ ...current, [kind]: value }))}
              options={[{ value: EXAMPLE, label: kind === "package" ? "Beispiel mit langem Namen" : "Beispiel" }, ...sampleOptions]}
            />
            <figure className={styles.frame} aria-busy={preview.busy} style={preview.preview ? { aspectRatio: `${String(preview.preview.width_px)} / ${String(preview.preview.height_px)}` } : undefined}>
              {preview.preview && preview.problem?.kind !== "invalid" ? (
                <img
                  className={cx(styles.image, preview.busy && styles.stale)}
                  src={`data:image/png;base64,${preview.preview.png}`}
                  width={preview.preview.width_px}
                  height={preview.preview.height_px}
                  alt={`Vorschau des ${kind === "package" ? "Packungs" : "Zonen"}-Etiketts`}
                />
              ) : preview.problem?.kind === "invalid" ? (
                <WarningIcon size={28} aria-hidden="true" />
              ) : serverReady ? (
                <Spinner size={22} label="Das Etikett wird gezeichnet" />
              ) : null}
            </figure>
            {preview.problem ? (
              <Notice tone={preview.problem.kind === "invalid" ? "warn" : "neutral"} role="status" icon={preview.problem.kind === "offline" ? <CloudOffIcon /> : <WarningIcon />}>
                {preview.problem.message}
              </Notice>
            ) : !serverReady ? (
              <Notice tone="neutral" role="status" icon={<CloudOffIcon />}>
                Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar.
              </Notice>
            ) : null}
            {preview.preview && preview.preview.notes.length > 0 && !preview.problem ? (
              <ul className={styles.notes} aria-label="Hinweise zur Vorschau">
                {preview.preview.notes.map((note) => (
                  <li key={note}>
                    <InfoIcon size={15} aria-hidden="true" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={styles.printRow}>
              <Button icon={<PrinterIcon />} disabled={printBlock !== null} busy={busy === "print"} onClick={() => void testPrint()}>
                Probedruck
              </Button>
              {printBlock ? <p className={styles.small}>{printBlock}</p> : null}
            </div>
          </section>
        </div>

        <div className={styles.form}>
          <Section title="Papier">
            <Select
              label="Papier für alle Drucker"
              value={draft.paper}
              onChange={(id) => {
                const chosen = papers.find((candidate) => candidate.id === id);
                if (chosen) {
                  setDraft((current) => (current ? withPaper(current, chosen, papers) : current));
                  setSaveError(null);
                }
              }}
              options={papers.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              hint={paper?.kind === "die_cut" ? "Gestanzte Etiketten haben eine feste Länge." : undefined}
            />
          </Section>

          <Section title={kind === "package" ? "Packungs-Etikett" : "Zonen-Etikett"}>
            {paper?.kind === "endless" ? (
              <Stepper
                className={styles.length}
                label="Länge in mm"
                value={layout.length_mm ?? 29}
                min={LENGTH_MIN_MM}
                max={LENGTH_MAX_MM}
                hint={`Auf der Endlosrolle ${String(LENGTH_MIN_MM)} bis ${String(LENGTH_MAX_MM)} mm.`}
                onChange={(length) => change({ ...layout, length_mm: length })}
              />
            ) : null}
            <List>
              <ListRow label="QR-Code" hint="Die kleinste Stufe scannt noch sicher." stacked>
                <div className={styles.qr}>
                  <SegmentedControl label="Seite des QR-Codes" options={SIDE_OPTIONS} value={layout.qr.side} onChange={(side) => change({ ...layout, qr: { ...layout.qr, side } })} />
                  <SegmentedControl label="Größe des QR-Codes" options={SIZE_OPTIONS} value={layout.qr.size} onChange={(size) => change({ ...layout, qr: { ...layout.qr, size } })} />
                </div>
              </ListRow>
            </List>
            <FieldGroup label="Felder" hint="Von oben nach unten, wie auf dem Etikett. Stehen Packungs-ID und Einlagerdatum direkt nacheinander, teilen sie sich die unterste Zeile.">
              <FieldList kind={kind} layout={layout} onChange={change} />
            </FieldGroup>
            <List>
              {kind === "package" ? (
                <ListRow label="Datum" stacked>
                  <SegmentedControl
                    label="Datum"
                    options={[
                      { value: "long", label: "lang (25.03.2027)" },
                      { value: "short", label: "kurz (25.03.27)" },
                    ]}
                    value={layout.date}
                    onChange={(date) => change({ ...layout, date })}
                  />
                </ListRow>
              ) : null}
              <ListRow label="Trennlinie" hint="Über der untersten Zeile.">
                <Switch label="Trennlinie" hideLabel checked={layout.divider} onChange={(divider) => change({ ...layout, divider })} />
              </ListRow>
            </List>
            <TextField
              label="Inhalt des eigenen Texts"
              value={layout.text}
              maxLength={LIMITS.label_text}
              autoComplete="off"
              onChange={(event) => change({ ...layout, text: event.target.value })}
              hint={`Steht auf dem Etikett, wenn das Feld „Eigener Text“ an ist. Höchstens ${String(LIMITS.label_text)} Zeichen.`}
            />
          </Section>

          {saveError ? (
            <Notice tone="danger" role="alert" icon={<WarningIcon />}>
              {saveError}
            </Notice>
          ) : null}
          <div className={styles.actions}>
            <Button variant="primary" busy={busy === "save"} disabled={!dirty || online === false} onClick={() => void save()}>
              Speichern
            </Button>
            <Button
              icon={<UndoIcon />}
              disabled={!dirty || busy !== null}
              onClick={() => {
                setDraft(state.design);
                setSaveError(null);
              }}
            >
              Verwerfen
            </Button>
            <Button icon={<RefreshIcon />} disabled={(state.is_default && !dirty) || online === false || busy !== null} onClick={() => setConfirmReset(true)}>
              Auf Vorgabe zurücksetzen
            </Button>
          </div>
          {online === false && dirty ? <p className={styles.small}>Speichern geht, sobald der Server wieder erreichbar ist.</p> : null}
          {state.updated_at ? <p className={styles.small}>Eigene Gestaltung des Haushalts.</p> : <p className={styles.small}>Es gelten die mitgelieferten Etiketten.</p>}

          {(printers ?? []).length > 0 ? (
            <Section title="Drucker" description="Ob die Drucker dieses Papier können und was eingelegt ist.">
              {hints.map((hint) => (
                <Notice
                  key={`${hint.printer.id}:${hint.text}`}
                  tone="warn"
                  role="status"
                  icon={<WarningIcon />}
                  title={`${hint.printer.name}: ${hint.text}`}
                  action={
                    hint.repair ? (
                      <ButtonLink to={ROUTES.printers} size="sm">
                        Zu den Druckern
                      </ButtonLink>
                    ) : undefined
                  }
                />
              ))}
              {probed && hints.length === 0 ? (
                <Notice tone="success" role="status">
                  Die geprüften Drucker passen zu diesem Papier.
                </Notice>
              ) : null}
              <div>
                <Button size="sm" busy={probing} onClick={() => void probeAll()}>
                  Eingelegte Rollen prüfen
                </Button>
              </div>
            </Section>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Auf Vorgabe zurücksetzen?"
        confirmLabel="Zurücksetzen"
        tone="danger"
        onConfirm={reset}
        errorText={(error) => errorText(error, { offline: "Zurücksetzen braucht den Server, und der ist gerade nicht erreichbar." })}
      >
        <p>Es gelten wieder die mitgelieferten Etiketten: 62 mm endlos, 29 mm lang. Die eigene Gestaltung geht dabei verloren.</p>
      </ConfirmDialog>
    </Page>
  );
}
