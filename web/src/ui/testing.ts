/**
 * Hilfen für die Tests der Oberfläche. Nur aus Tests und aus test-setup.ts verwenden.
 */

type Listener = () => void;

let width = 1280;
let coarse = false;
const listeners = new Set<Listener>();

/** Wertet die Medienabfragen aus, die die Oberfläche stellt: Breiten in rem oder px, Zeigerart. */
function evaluate(query: string): boolean {
  const toPx = (value: string, unit: string) => Number(value) * (unit === "rem" || unit === "em" ? 16 : 1);
  const min = /\(min-width:\s*([\d.]+)(px|rem|em)\)/.exec(query);
  if (min?.[1] && min[2]) {
    return width >= toPx(min[1], min[2]);
  }
  const max = /\(max-width:\s*([\d.]+)(px|rem|em)\)/.exec(query);
  if (max?.[1] && max[2]) {
    return width <= toPx(max[1], max[2]);
  }
  if (/\(pointer:\s*coarse\)/.test(query)) {
    return coarse;
  }
  // Alles andere (bevorzugtes Farbschema, weniger Bewegung): trifft nicht zu.
  return false;
}

function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const list = {
      media: query,
      onchange: null,
      get matches() {
        return evaluate(query);
      },
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    };
    return list as unknown as MediaQueryList;
  };
}

/**
 * Stellt die Breite des Test-Fensters ein und benachrichtigt die Oberfläche.
 * @param nextWidth Breite in Pixeln: 1280 = Desktop, 800 = Tablet, 375 = Handy
 * @param touch     Bedienung mit dem Finger (`pointer: coarse`); Vorgabe: unter 768 Pixeln
 */
export function setTestViewport(nextWidth: number, touch: boolean = nextWidth < 768): void {
  width = nextWidth;
  coarse = touch;
  installMatchMedia();
  for (const listener of [...listeners]) {
    listener();
  }
}
