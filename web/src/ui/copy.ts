/**
 * Text in die Zwischenablage, auch dort, wo `navigator.clipboard` fehlt.
 *
 * `navigator.clipboard` gibt es nur im sicheren Kontext (HTTPS, localhost); über
 * http://<LAN-IP> fehlt es, und gerade dort beginnt die Einrichtung. Dann hilft der alte Weg: eine
 * unsichtbare `textarea` mit `readonly` (sonst öffnet iOS die Tastatur), ganz markieren
 * (`setSelectionRange`, sonst markiert iOS nichts) und `document.execCommand("copy")`.
 */

/** Kopiert `text`; true, wenn einer der beiden Wege gelang. Wirft nicht. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (globalThis.isSecureContext === true && typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Verweigert (etwa ohne Fokus auf der Seite): der alte Weg.
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  // Unsichtbar, aber im Dokument; 16 px, damit iOS beim Markieren nicht zoomt.
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", fontSize: "16px", pointerEvents: "none" });
  document.body.append(area);
  let copied = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    // Der Fokus gehört wieder der Schaltfläche, die kopiert hat.
    focused?.focus({ preventScroll: true });
  }
  return copied;
}
