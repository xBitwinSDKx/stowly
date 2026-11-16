import type { PiPairing } from "@/contract";
import { PairPi } from "@/features/printers/PairPi";

import styles from "./SetupPage.module.css";

export interface PrinterStepProps {
  /** Die Kopplung, vom Assistenten gehalten: Sie übersteht Zurück und Weiter. */
  pairing: PiPairing | null;
  onPairing: (pairing: PiPairing | null) => void;
  /** Der Pi ist gekoppelt: Der Schritt ist erledigt. */
  onPaired: () => void;
}

/** „Drucker": ein Raspberry Pi mit Etikettendrucker, gekoppelt mit einem Befehl (`PairPi`). */
export function PrinterStep({ pairing, onPairing, onPaired }: PrinterStepProps) {
  return (
    <>
      <p className={styles.lead}>
        Ein Raspberry Pi mit Brother-Etikettendrucker druckt für jede Packung ein Etikett mit QR-Code. Wer keinen hat, überspringt diesen Schritt; Drucker lassen sich
        später unter „Drucker“ einrichten.
      </p>
      <PairPi pairing={pairing} onPairing={onPairing} onPaired={onPaired} />
    </>
  );
}
