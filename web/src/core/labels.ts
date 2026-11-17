/**
 * Etiketten gestalten und Produktdaten neu abfragen (seit 0.5.0; docs/plan-0.5.md, 1 und 2).
 *
 * Ein eigener, nachgeladener Teil des Kerns wie admin.ts: `createCore` holt ihn erst beim ersten
 * Aufruf (index.ts, `later`). So bleibt er aus dem Hauptpaket. Alles braucht den Server und eine
 * Anmeldung (`CoreRuntime.server`), außer `labels.templates`, das nur liest, was der Sync gebracht
 * hat. Gespeichert wird hier nichts: Die Gestaltung liegt beim Server, die Vorlagen kommen über den
 * Sync, und das Produkt mit neuem Bild ebenso.
 */
import {
  CoreError,
  ENDPOINTS,
  isStoreInternalBarcode,
  isValidBarcode,
  type LabelDesign,
  type LabelDesignState,
  type LabelPreview,
  type LabelPreviewInput,
  type LabelsApi,
  type LabelTemplatesInfo,
  type LookupResult,
  type LookupResultState,
  type ProductImageInput,
  type ProductsApi,
} from "@/contract";

import type { CoreRuntime } from "./api/runtime";
import { ApiClient, isCount, isRecord, isText, isTextOrNull, REQUEST_TIMEOUT_MS, type Endpoint, type FetchLike } from "./http";

/** Die Vorschau rendert der Server; auf einem kleinen NAS dauert das einen Moment. */
export const LABEL_PREVIEW_TIMEOUT_MS = 20_000;
/** „Online abfragen": So lange wartet der Server höchstens auf Open Food Facts (`?wait=`, höchstens 8). */
export const REFRESH_WAIT_S = 8;
/** … dazu der Weg. */
export const REFRESH_TIMEOUT_MS = 12_000;

const LOOKUP_STATES: ReadonlySet<string> = new Set<LookupResultState>(["found", "not_found", "pending", "skipped", "disabled"]);

/** Prüfung der Form, soweit die App sie liest: Was nicht so aussieht, stammt nicht vom Stowly-Server. */
function isDesignState(value: unknown): value is LabelDesignState {
  const design = isRecord(value) ? value.design : undefined;
  return (
    isRecord(value) &&
    isRecord(design) &&
    isText(design.paper) &&
    isRecord(design.package) &&
    isRecord(design.zone) &&
    typeof value.is_default === "boolean" &&
    isTextOrNull(value.updated_at) &&
    isRecord(value.templates) &&
    Array.isArray(value.papers) &&
    value.papers.every((paper) => isRecord(paper) && isText(paper.id) && isText(paper.name) && isText(paper.kind))
  );
}

function isPreview(value: unknown): value is LabelPreview {
  return isRecord(value) && isText(value.png) && isCount(value.width_px) && isCount(value.height_px) && Array.isArray(value.notes) && value.notes.every(isText);
}

function isLookupResult(value: unknown): value is LookupResult {
  return (
    isRecord(value) &&
    isText(value.barcode) &&
    isText(value.state) &&
    LOOKUP_STATES.has(value.state) &&
    isText(value.name) &&
    isText(value.brand) &&
    isText(value.quantity) &&
    isTextOrNull(value.image_id) &&
    isTextOrNull(value.fetched_at ?? null) &&
    typeof (value.throttled ?? false) === "boolean"
  );
}

/** Die Aufrufe dieses Teils, gebaut auf `ApiClient`. */
class LabelsClient extends ApiClient {
  design(token: string, endpoint: Endpoint, body?: LabelDesign): Promise<LabelDesignState> {
    return this.checked(endpoint, endpoint.path, { token, body, timeoutMs: REQUEST_TIMEOUT_MS }, isDesignState);
  }

  preview(token: string, input: LabelPreviewInput): Promise<LabelPreview> {
    return this.checked(ENDPOINTS.preview_label, ENDPOINTS.preview_label.path, { token, body: input, timeoutMs: LABEL_PREVIEW_TIMEOUT_MS }, isPreview);
  }

  async refresh(token: string, barcode: string): Promise<LookupResult> {
    const path = `${ENDPOINTS.refresh_lookup.path.replace("{barcode}", encodeURIComponent(barcode))}?wait=${String(REFRESH_WAIT_S)}`;
    const answer = await this.checked(ENDPOINTS.refresh_lookup, path, { token, timeoutMs: REFRESH_TIMEOUT_MS }, isLookupResult);
    return { ...answer, fetched_at: answer.fetched_at ?? null, throttled: answer.throttled === true };
  }

  async setImage(token: string, productId: string, imageId: string | null): Promise<void> {
    const path = ENDPOINTS.set_product_image.path.replace("{product_id}", encodeURIComponent(productId));
    const body: ProductImageInput = { image_id: imageId };
    await this.checked(ENDPOINTS.set_product_image, path, { token, body, timeoutMs: REQUEST_TIMEOUT_MS }, isRecord);
  }
}

/** Was dieser Teil vom Kern braucht, über `CoreRuntime` hinaus. */
export interface LabelsDeps {
  /**
   * Gleicht ab, bevor ein Aufruf etwas braucht, das erst mit dem Abgleich beim Server ankommt;
   * wartet darauf höchstens 10 Sekunden (`PrintRuntime.syncFirst`). Wirft nicht.
   */
  syncFirst(): Promise<void>;
  /** Stößt einen Abgleich an, ohne zu warten: Er bringt, was der Server eben geändert hat. */
  synced(): void;
}

export interface Labels {
  labels: LabelsApi;
  products: Pick<ProductsApi, "refreshLookup" | "setImage">;
}

/** Etiketten gestalten und Produktdaten neu abfragen für `createCore`; `fetchFn` ist das `fetch` des Kerns. */
export function createLabels(runtime: CoreRuntime, fetchFn: FetchLike, deps: LabelsDeps): Labels {
  const client = new LabelsClient(fetchFn);
  const server = runtime.server.bind(runtime);

  /** Gestaltung gespeichert oder zurückgesetzt: Der Abgleich bringt die neuen Vorlagen. */
  async function changed(call: (token: string) => Promise<LabelDesignState>): Promise<LabelDesignState> {
    const state = await server(call);
    deps.synced();
    return state;
  }

  return {
    labels: {
      design: () => server((token) => client.design(token, ENDPOINTS.get_label_design)),
      preview: (input) => server((token) => client.preview(token, input)),
      save: (design) => changed((token) => client.design(token, ENDPOINTS.put_label_design, design)),
      reset: () => changed((token) => client.design(token, ENDPOINTS.reset_label_design)),
      async templates(): Promise<LabelTemplatesInfo> {
        await runtime.ready;
        const view = runtime.store.snapshot.view;
        const info: LabelTemplatesInfo = { paper: null, schema: 1, hashes: { package: null, zone: null } };
        for (const kind of ["package", "zone"] as const) {
          const template = view.label_templates.get(kind);
          if (!template) {
            continue;
          }
          // Aus der Vorlage liest die App nur `schema` und `media.id` (wie `templateNeeds` in print/content.ts).
          const { schema, media } = template.body as { schema?: unknown; media?: { id?: unknown } };
          info.hashes[kind] = template.hash;
          info.paper ??= typeof media?.id === "string" ? media.id : "62";
          if (typeof schema === "number" && schema > info.schema) {
            info.schema = schema;
          }
        }
        return info;
      },
    },
    products: {
      async refreshLookup(barcode) {
        if (typeof barcode !== "string" || !isValidBarcode(barcode)) {
          throw new CoreError("invalid", "Kein gültiger Barcode.");
        }
        // Ladeninterne Codes (Präfix 2) gehen nie hinaus, wie beim Nachschlagen beim Scannen.
        if (isStoreInternalBarcode(barcode)) {
          return { barcode, state: "skipped", name: "", brand: "", quantity: "", image_id: null, fetched_at: null, throttled: false };
        }
        return server((token) => client.refresh(token, barcode));
      },
      async setImage(productId, imageId) {
        await runtime.ready;
        // Wartet ein Befehl zu diesem Produkt noch (etwa sein Anlegen), kennt es der Server noch nicht.
        if (runtime.store.snapshot.outbox.some(({ command }) => "product_id" in command && command.product_id === productId)) {
          await deps.syncFirst();
        }
        await server((token) => client.setImage(token, productId, imageId));
        deps.synced();
      },
    },
  };
}
