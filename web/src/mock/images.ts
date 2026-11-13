/**
 * Produktbilder der Attrappe.
 *
 * Der echte Kern liefert für `Product.image` eine Adresse am Server (`/api/images/…`). Die
 * Attrappe hat keinen Server; ihre Bilder liegen als selbst gezeichnete Grafiken in diesem
 * Ordner und werden als `data:`-Adresse ausgeliefert. Nichts davon kommt von außen.
 */
import jar from "./images/vorratsglas.svg?raw";

/** Bild-ID des Beispielbilds, so wie sie in `Product.image` steht. */
export const SAMPLE_IMAGE_ID = "attrappe-vorratsglas.svg";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Bild-ID zu Adresse für `<img src>`. */
export const MOCK_IMAGES: Readonly<Record<string, string>> = {
  [SAMPLE_IMAGE_ID]: svgDataUrl(jar),
};
