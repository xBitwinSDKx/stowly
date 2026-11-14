import { useEffect, useMemo, useRef, useState } from "react";

import { useCore, useLive, type Zone, type ZoneMode } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { printerForZone } from "@/features/printers/model";
import { usePrinting } from "@/features/printers/usePrinting";
import { errorText, List, ListRow, Notice, packagesText, Section, Select } from "@/ui";
import { Badge, Button, IconButton, SegmentedControl, useToast, zoneColor, ZoneIcon } from "@/ui/base";
import { ArrowDownIcon, ArrowUpIcon, InfoIcon, PlusIcon, PrinterIcon, QrCodeIcon } from "@/ui/icons";

import { DeleteZoneDialog } from "./DeleteZoneDialog";
import { ZoneDialog } from "./ZoneDialog";
import { ZoneQrDialog } from "./ZoneQrDialog";
import styles from "./ZonesPage.module.css";

type DialogState = { kind: "create" } | { kind: "edit"; zone_id: string } | { kind: "delete"; zone_id: string } | { kind: "qr"; zone_ids: string[] } | null;

type Direction = "up" | "down";

/**
 * Welche Schaltfläche einer verschobenen Zone den Fokus bekommt: dieselbe, mit der verschoben
 * wurde; steht die Zone danach am Rand der Liste, wo diese gesperrt ist, die andere derselben Zeile.
 * @param index Platz der Zone nach dem Verschieben
 */
function moveFocusTarget(direction: Direction, index: number, count: number): Direction {
  if (direction === "up" && index === 0) {
    return "down";
  }
  if (direction === "down" && index === count - 1) {
    return "up";
  }
  return direction;
}

const MODE_TEXT: Record<ZoneMode, string> = {
  primary:
    "Eingelagert wird in die Primärzone. Wer beim Scannen die Zone wechselt, lagert genau einen Vorgang dort ein; danach gilt wieder die Primärzone.",
  equal: "Alle Zonen sind gleichwertig. Ein Zonenwechsel beim Scannen bleibt bestehen, bis wieder gewechselt wird.",
};

/**
 * Lagerzonen verwalten: anlegen, umbenennen, Symbol und Farbe, Reihenfolge, löschen;
 * dazu der Modus fürs Scannen und je Zone der QR-Code.
 */
export function ZonesPage() {
  const core = useCore();
  const toast = useToast();
  const zones = useLive(core.data.zones);
  const packages = useLive(core.data.packages);
  const settings = useLive(core.data.settings);
  const printing = usePrinting();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [serial, setSerial] = useState(0);
  /** Die Schaltflächen „nach oben" und „nach unten" je Zone, für den Fokus nach dem Verschieben. */
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  /**
   * Nach dem Verschieben gehört der Fokus wieder an die Schaltfläche, die ihn hatte. React hängt
   * dafür Zeilen um (`insertBefore`), und der Browser nimmt einer umgehängten Zeile dabei den Fokus.
   * Gemerkt wird, wohin die Zone wandert; sobald die Liste sie dort zeigt, bekommt die Schaltfläche
   * den Fokus zurück.
   */
  const [refocus, setRefocus] = useState<{ zone_id: string; direction: Direction; index: number } | null>(null);

  useEffect(() => {
    if (refocus === null || !zones) {
      return;
    }
    const index = zones.findIndex((zone) => zone.id === refocus.zone_id);
    if (index === -1) {
      setRefocus(null);
      return;
    }
    if (index !== refocus.index) {
      return; // Die Liste zeigt die neue Reihenfolge noch nicht.
    }
    const target = moveFocusTarget(refocus.direction, index, zones.length);
    moveButtons.current.get(`${refocus.zone_id}:${target}`)?.focus();
    setRefocus(null);
  }, [refocus, zones]);

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const pkg of packages ?? []) {
      result.set(pkg.zone_id, (result.get(pkg.zone_id) ?? 0) + 1);
    }
    return result;
  }, [packages]);

  if (!zones || !settings) {
    return (
      <Page title="Zonen">
        <PageLoading label="Zonen werden geladen …" />
      </Page>
    );
  }

  const multiZone = zones.length > 1;
  // Zeigt der Verweis ins Leere, gilt die erste Zone der Reihenfolge (Vertrag).
  const primaryZone = zones.find((zone) => zone.id === settings.primary_zone_id) ?? zones[0];
  const byId = (id: string) => zones.find((zone) => zone.id === id);

  function open(next: DialogState) {
    setDialog(next);
    setSerial((current) => current + 1);
  }
  const close = () => setDialog(null);

  function report(error: unknown) {
    toast.show({ message: errorText(error), tone: "danger" });
  }

  function move(zone: Zone, offset: -1 | 1) {
    const ids = (zones ?? []).map((candidate) => candidate.id);
    const from = ids.indexOf(zone.id);
    const to = from + offset;
    if (from === -1 || to < 0 || to >= ids.length) {
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, zone.id);
    // Nur wenn die Schaltfläche den Fokus hatte (Tastatur, Klick): Dann soll er bei ihr bleiben.
    const direction: Direction = offset < 0 ? "up" : "down";
    const focused = document.activeElement === moveButtons.current.get(`${zone.id}:${direction}`);
    if (focused) {
      setRefocus({ zone_id: zone.id, direction, index: to });
    }
    core.zones.reorder(ids).catch((caught: unknown) => {
      setRefocus(null);
      report(caught);
    });
  }

  /** Merkt sich die Schaltfläche „nach oben" oder „nach unten" einer Zone. */
  function moveButton(zoneId: string, direction: Direction) {
    return (element: HTMLButtonElement | null) => {
      const key = `${zoneId}:${direction}`;
      if (element) {
        moveButtons.current.set(key, element);
      } else {
        moveButtons.current.delete(key);
      }
    };
  }

  const editing = dialog?.kind === "edit" ? byId(dialog.zone_id) : undefined;
  const deleting = dialog?.kind === "delete" ? byId(dialog.zone_id) : undefined;
  const qrZones = dialog?.kind === "qr" ? dialog.zone_ids.map(byId).filter((zone): zone is Zone => zone !== undefined) : [];

  return (
    <Page
      title="Zonen"
      description="Lagerorte wie Keller, Vorratsregal oder Gefrierschrank. Jede Packung liegt in genau einer Zone."
      actions={
        <>
          {multiZone ? (
            <Button icon={<PrinterIcon />} onClick={() => open({ kind: "qr", zone_ids: zones.map((zone) => zone.id) })}>
              Alle QR-Codes
            </Button>
          ) : null}
          <Button variant="primary" icon={<PlusIcon />} onClick={() => open({ kind: "create" })}>
            Zone anlegen
          </Button>
        </>
      }
    >
      {multiZone ? null : (
        <Notice tone="info" icon={<InfoIcon />} title="Es gibt nur eine Zone">
          Solange das so ist, blendet Stowly alles zu Zonen aus. Mit einer zweiten Zone erscheinen die Zonen-Karten und der Zonen-Filter im Bestand und
          die Zonenleiste beim Scannen.
        </Notice>
      )}

      <ul className={styles.zones}>
        {zones.map((zone, index) => {
          const count = counts.get(zone.id) ?? 0;
          return (
            <li key={zone.id} className={styles.zone}>
              <span className={styles.tile} style={{ color: zoneColor(zone.color) }}>
                <ZoneIcon icon={zone.icon} size={24} />
              </span>
              <div className={styles.text}>
                <div className={styles.name}>
                  <span className={styles.nameText}>{zone.name}</span>
                  {multiZone && settings.zone_mode === "primary" && primaryZone?.id === zone.id ? <Badge tone="accent">Primärzone</Badge> : null}
                </div>
                <div className={styles.sub}>
                  {count === 0 ? "leer" : packagesText(count)}
                  {multiZone && printing.hasPrinter ? ` · Etiketten: ${printerForZone(zone.id, printing.data)?.name ?? "kein Drucker"}` : ""}
                </div>
              </div>
              {multiZone ? (
                <div className={styles.order}>
                  <IconButton ref={moveButton(zone.id, "up")} label={`${zone.name} nach oben`} disabled={index === 0} onClick={() => move(zone, -1)}>
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton ref={moveButton(zone.id, "down")} label={`${zone.name} nach unten`} disabled={index === zones.length - 1} onClick={() => move(zone, 1)}>
                    <ArrowDownIcon />
                  </IconButton>
                </div>
              ) : null}
              <div className={styles.actions}>
                <Button size="sm" icon={<QrCodeIcon />} aria-label={`QR-Code: ${zone.name}`} onClick={() => open({ kind: "qr", zone_ids: [zone.id] })}>
                  QR-Code
                </Button>
                <Button size="sm" aria-label={`Bearbeiten: ${zone.name}`} onClick={() => open({ kind: "edit", zone_id: zone.id })}>
                  Bearbeiten
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Löschen: ${zone.name}`}
                  disabled={!multiZone}
                  title={multiZone ? undefined : "Die letzte Zone lässt sich nicht löschen."}
                  onClick={() => open({ kind: "delete", zone_id: zone.id })}
                >
                  Löschen
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {multiZone ? (
        <Section title="Beim Scannen" description="Gilt für alle Geräte des Haushalts.">
          <List>
            <ListRow label="Zonenmodus" hint={MODE_TEXT[settings.zone_mode]} stacked>
              <SegmentedControl<ZoneMode>
                className={styles.mode}
                label="Zonenmodus"
                block
                value={settings.zone_mode}
                onChange={(zone_mode) => void core.settings.update({ zone_mode }).catch(report)}
                options={[
                  { value: "primary", label: "Primärzone" },
                  { value: "equal", label: "Gleichwertig" },
                ]}
              />
            </ListRow>
            {settings.zone_mode === "primary" ? (
              <ListRow label="Primärzone" hint="Hier wird eingelagert, solange niemand die Zone wechselt.">
                <Select
                  className={styles.primarySelect}
                  label="Primärzone"
                  hideLabel
                  value={primaryZone?.id ?? ""}
                  onChange={(primary_zone_id) => void core.settings.update({ primary_zone_id }).catch(report)}
                  options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                />
              </ListRow>
            ) : null}
          </List>
        </Section>
      ) : null}

      {dialog?.kind === "create" ? <ZoneDialog key={serial} onClose={close} /> : null}
      {editing ? <ZoneDialog key={serial} zone={editing} onClose={close} /> : null}
      {deleting ? (
        <DeleteZoneDialog
          key={serial}
          zone={deleting}
          zones={zones}
          packageCount={counts.get(deleting.id) ?? 0}
          primary={primaryZone?.id === deleting.id && settings.zone_mode === "primary"}
          onClose={close}
        />
      ) : null}
      {qrZones.length > 0 ? <ZoneQrDialog key={serial} zones={qrZones} onClose={close} /> : null}
    </Page>
  );
}
