import { useId, useState, type FormEvent } from "react";

import { useCore, type Zone, type ZoneChanges } from "@/contract";
import { errorText, focusOnOpen, Notice, Swatch, TileChoice, useReturnFocus } from "@/ui";
import {
  Button,
  DEFAULT_ZONE_ICON,
  Dialog,
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

/** Zone anlegen oder ändern: Name, Symbol, Farbe. */
export function ZoneDialog({ zone, onClose }: ZoneDialogProps) {
  useReturnFocus();
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState(zone?.name ?? "");
  const [icon, setIcon] = useState<ZoneIconKey>(iconKey(zone?.icon));
  const [color, setColor] = useState<ZoneColorKey>(colorKey(zone?.color));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameError = trimmed === "" ? "Bitte einen Namen eingeben." : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (nameError) {
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
        if (Object.keys(changes).length > 0) {
          await core.zones.update(zone.id, changes);
        }
      } else {
        await core.zones.create({ name: trimmed, icon, color: colorValue });
        toast.show({ message: `Zone „${trimmed}“ angelegt`, tone: "success" });
      }
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Diese Zone gibt es nicht mehr.", invalid: "Der Name ist ungültig. Erlaubt sind 1 bis 60 Zeichen." }));
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
          maxLength={60}
          autoComplete="off"
          ref={focusOnOpen}
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
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
