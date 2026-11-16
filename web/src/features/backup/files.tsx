import { useRef, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/ui/base";

/** Speichert eine Datei, die im Browser als Blob vorliegt (eine Sicherung, die Schlüsseldatei). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Der Download hat die Adresse zu diesem Zeitpunkt sicher übernommen.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Lädt die Seite neu: nach dem Zurückspielen, damit nichts vom alten Bestand stehen bleibt. In Tests ersetzbar (`vi.mock`). */
export function reloadPage(): void {
  window.location.reload();
}

/** Liest eine kleine Textdatei (die Schlüsseldatei); höchstens `maxBytes`, sonst null. */
export async function readText(file: Blob, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) {
    return null;
  }
  return file.text();
}

export interface FilePickerProps extends Omit<ButtonProps, "onClick" | "onChange" | "children"> {
  children: ReactNode;
  /** Die gewählte Datei; nichts, wenn der Anwender abbricht. */
  onFile: (file: File) => void;
}

/**
 * „Datei wählen" als gewöhnliche Schaltfläche: Sie öffnet die Auswahl des Browsers. Bewusst ohne
 * `accept`: Das iPhone bietet mit einem Filter für unbekannte Endungen (`.age`) gar keine Datei an.
 */
export function FilePicker({ children, onFile, ...button }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Dieselbe Datei soll sich auch ein zweites Mal wählen lassen.
          event.target.value = "";
          if (file) {
            onFile(file);
          }
        }}
      />
      <Button {...button} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}
