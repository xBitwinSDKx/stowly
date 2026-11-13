import { useId, useState, type FormEvent } from "react";

import { useCore, useLive, type Zone, type ZoneChanges } from "@/contract";
import { errorText, focusFirstInvalid, Notice, Select, Swatch, TileChoice } from "@/ui";
import {
  Button,
  DEFAULT_ZONE_ICON,
  Dialog,
  dialogFocus,
  TextField,
  useToast,
  ZONE_COLOR_KEYS,
  ZONE_COLORS,
  ZONE_ICON_KEYS,
  ZONE_ICONS,
  zoneColor,
  ZoneIcon,
  type ZoneColorKey,
  type ZoneIconKey,
} from "@/ui/base";

import styles from "./ZoneDialog.module.css";

export interface ZoneDialogProps {
  /** Die Zone, die bearbeitet wird; ohne Angabe wird eine neue angelegt. */
  zone?: Zone;
  onClose: () => void;
}

function iconKey(icon: string | undefined): ZoneIconKey {
  return icon !== undefined && Object.hasOwn(ZONE_ICONS, icon) ? (icon as ZoneIconKey) : DEFAULT_ZONE_ICON;
}

/** `Zone.color` ist null für die Akzentfarbe; die Auswahl führt sie als "accent". */
function colorKey(color: string | null | undefined): ZoneColorKey {
  return color && Object.hasOwn(ZONE_COLORS, color) ? (color as ZoneColorKey) : "accent";
}

/** Wert der Auswahl für „kein eigener Drucker". */
const NO_PRINTER = "";

/** Zone anlegen oder ändern: Name, Symbol, Farbe und, wenn es Drucker gibt, der Drucker ihrer Etiketten. */
export function ZoneDialog({ zone, onClose }: ZoneDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState(zone?.name ?? "");
  const [icon, setIcon] = useState<ZoneIconKey>(iconKey(zone?.icon));
  const [color, setColor] = useState<ZoneColorKey>(colorKey(zone?.color));
  const printers = useLive(core.data.printers, []);
  const zoneCount = useLive(core.data.zones, []).length;
  const settings = useLive(core.data.settings);
  const [printerId, setPrinterId] = useState(zone?.printer_id ?? NO_PRINTER);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameError = trimmed === "" ? "Bitte einen Namen eingeben." : null;
  // Bei nur einer Zone gibt es keine Zuordnung je Zone: Dann druckt der Standarddrucker alles.
  const assignable = printers.length > 0 && (zone === undefined || zoneCount > 1);
  const defaultPrinter = printers.find((printer) => printer.id === settings?.default_printer_id);
  // Zeigt die Zone auf einen gelöschten Drucker, gilt er als nicht gesetzt.
  const chosenPrinter = printers.some((printer) => printer.id === printerId) ? printerId : NO_PRINTER;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (nameError) {
      focusFirstInvalid(formId);
      return;
    }
    setBusy(true);
    setError(null);
    const colorValue = color === "accent" ? null : color;
    try {
      if (zone) {
        const changes: ZoneChanges = {};
        if (trimmed !== zone.name) {
          changes.name = trimmed;
        }
        if (icon !== zone.icon) {
          changes.icon = icon;
        }
        if (colorValue !== zone.color) {
          changes.color = colorValue;
        }
        // Nur wenn die Auswahl angefasst wurde: Ein Verweis auf einen gelöschten Drucker bleibt sonst, wie er ist.
        const touched = printerId !== (zone.printer_id ?? NO_PRINTER);
        const nextPrinter = chosenPrinter === NO_PRINTER ? null : chosenPrinter;
        if (assignable && touched && nextPrinter !== zone.printer_id) {
          changes.printer_id = nextPrinter;
        }
        if (Object.keys(changes).length > 0) {
          await core.zones.update(zone.id, changes);
        }
      } else {
        await core.zones.create({ name: trimmed, icon, color: colorValue, ...(assignable && chosenPrinter !== NO_PRINTER ? { printer_id: chosenPrinter } : {}) });
        toast.show({ message: `Zone „${trimmed}“ angelegt`, tone: "success" });
      }
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Diese Zone gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={zone ? "Zone bearbeiten" : "Zone anlegen"}
      variant="sheet"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            {zone ? "Speichern" : "Anlegen"}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.preview} style={{ color: zoneColor(color === "accent" ? null : color) }}>
          <span className={styles.tile}>
            <ZoneIcon icon={icon} size={26} />
          </span>
          <span className={styles.previewName}>{trimmed === "" ? "Neue Zone" : trimmed}</span>
        </div>
        <TextField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          ref={dialogFocus}
          placeholder="z. B. Keller, Gefrierschrank, Vorratsregal"
          error={tried ? nameError : null}
        />
        <TileChoice
          label="Symbol"
          value={icon}
          onChange={setIcon}
          options={ZONE_ICON_KEYS.map((key) => ({ value: key, label: ZONE_ICONS[key].label, content: <ZoneIcon icon={key} size={22} /> }))}
        />
        <TileChoice
          label="Farbe"
          value={color}
          onChange={setColor}
          options={ZONE_COLOR_KEYS.map((key) => ({ value: key, label: ZONE_COLORS[key].label, content: <Swatch color={ZONE_COLORS[key].css} /> }))}
        />
        {assignable ? (
          <Select
            label="Drucker"
            value={chosenPrinter}
            onChange={setPrinterId}
            hint="Druckt die Etiketten der Packungen in dieser Zone."
            options={[
              { value: NO_PRINTER, label: defaultPrinter ? `Standarddrucker (${defaultPrinter.name})` : "Kein eigener Drucker" },
              ...printers.map((printer) => ({ value: printer.id, label: printer.name })),
            ]}
          />
        ) : null}
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
