/**
 * Etiketten gestalten und Produktdaten neu abfragen: der echte Kern (src/core/labels.ts,
 * nachgeladen) gegen die Nachbildung des Servers (docs/plan-0.5.md, 1 und 2).
 */
import { afterEach, describe, expect, it } from "vitest";

import { gtinCheckDigit, type LabelLayout } from "@/contract";

import { FAKE_DEFAULT_DESIGN, FAKE_TOO_SHORT } from "./testing/fake-labels";
import { commandsOf, disposeAll, expectCoreError, firstZoneId, signedIn, value } from "./testing/harness";

afterEach(disposeAll);

const CROWDED: LabelLayout = {
  ...FAKE_DEFAULT_DESIGN.package,
  length_mm: 25,
  fields: (["title", "subtitle", "quantity", "brand", "best_before", "stored", "id", "zone", "text"] as const).map((field) => ({ field, size: "l" as const, lines: field === "title" ? 3 : null })),
};

/** Eine EAN-13 aus zwölf Ziffern samt Prüfziffer. */
function ean(body: string): string {
  return body + String(gtinCheckDigit(body));
}

describe("Etiketten gestalten", () => {
  it("lädt die Gestaltung mit dem Papier-Katalog; gespeichert bringt der Abgleich die neuen Vorlagen", async () => {
    const { core, server } = await signedIn();
    const state = await core.labels.design();
    expect(state).toMatchObject({ is_default: true, updated_at: null, design: { paper: "62" } });
    expect(state.papers.map((paper) => paper.id)).toEqual(expect.arrayContaining(["62", "29", "62x29", "29x90"]));
    // Die Vorlagen im Sync: die mitgelieferten, ohne Papier (die 62-mm-Endlosrolle), Format 1.
    expect(await core.labels.templates()).toEqual({ paper: "62", schema: 1, hashes: { package: state.templates.package, zone: state.templates.zone } });

    const saved = await core.labels.save({
      paper: "29",
      package: { ...FAKE_DEFAULT_DESIGN.package, length_mm: 50 },
      // Quer auf der 29-mm-Rolle sind knapp 26 mm hoch: Der große QR-Code der Zone passt nicht.
      zone: { ...FAKE_DEFAULT_DESIGN.zone, length_mm: 40, qr: { side: "left", size: "m" } },
    });
    expect(saved).toMatchObject({ is_default: false, design: { paper: "29", package: { length_mm: 50 } } });
    expect(saved.updated_at).not.toBeNull();
    expect(saved.templates.package).not.toBe(state.templates.package);
    // Der Kern gleicht nach dem Speichern von selbst ab.
    await expect.poll(async () => (await core.labels.templates()).hashes).toEqual(saved.templates);
    expect(await core.labels.templates()).toMatchObject({ paper: "29", schema: 2 });
    expect(server.data.label_templates.get("package")?.body).toMatchObject({ schema: 2, media: { id: "29", length_mm: 50 }, rotate: 90 });

    // Zurück zur Vorgabe: die mitgelieferten Vorlagen mit ihrem alten `hash`.
    const reset = await core.labels.reset();
    expect(reset).toMatchObject({ is_default: true, updated_at: null, templates: state.templates });
    await expect.poll(async () => (await core.labels.templates()).hashes).toEqual(state.templates);
  });

  it("lehnt eine zu volle Gestaltung mit dem Satz des Servers ab, in der Vorschau wie beim Speichern", async () => {
    const { core } = await signedIn();
    const preview = await expectCoreError(core.labels.preview({ kind: "package", paper: "62", layout: CROWDED, data: null }), "invalid");
    expect(preview.message).toBe(FAKE_TOO_SHORT);
    const save = await expectCoreError(core.labels.save({ ...FAKE_DEFAULT_DESIGN, package: CROWDED }), "invalid");
    expect(save.message).toBe(FAKE_TOO_SHORT);
    expect((await core.labels.design()).is_default).toBe(true);
  });

  it("rendert die Vorschau in der Größe des Papiers, so wie man das Etikett liest", async () => {
    const { core, server } = await signedIn();
    const endless = await core.labels.preview({ kind: "package", paper: "62", layout: FAKE_DEFAULT_DESIGN.package, data: { qr: "STOWLY/P/A2B3C", title: "Reis" } });
    expect(endless).toMatchObject({ width_px: 696, height_px: 342, notes: [] });
    expect(atob(endless.png).slice(1, 4)).toBe("PNG");
    // Auf knapp 23 mm Höhe (62 × 29 mm gestanzt) passt nur der kleine QR-Code und eine Zeile weniger.
    const small = { side: "left" as const, size: "s" as const };
    const fewer = FAKE_DEFAULT_DESIGN.package.fields.filter((field) => field.field !== "subtitle");
    expect(await core.labels.preview({ kind: "package", paper: "62x29", layout: { ...FAKE_DEFAULT_DESIGN.package, length_mm: null, qr: small, fields: fewer }, data: null })).toMatchObject({
      width_px: 696,
      height_px: 271,
    });
    // 29 mm endlos und 62 mm lang: gedreht gedruckt, ungedreht gezeigt.
    expect(await core.labels.preview({ kind: "zone", paper: "29", layout: { ...FAKE_DEFAULT_DESIGN.zone, length_mm: 62, qr: small }, data: null })).toMatchObject({ width_px: 732, height_px: 306 });
    // Mit der Vorgabe ist der QR-Code dort zu groß: der Satz des Servers und die Stelle.
    const refused = await expectCoreError(core.labels.preview({ kind: "package", paper: "62x29", layout: { ...FAKE_DEFAULT_DESIGN.package, length_mm: null }, data: null }), "invalid");
    expect(refused.message).toBe("Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen.");
    expect(refused.details).toMatchObject({ status: 422, errors: [{ loc: ["body", "layout"] }] });
    // Der Inhalt geht so hinaus, wie ihn die App gibt.
    expect(server.previews[0]).toMatchObject({ kind: "package", paper: "62", data: { qr: "STOWLY/P/A2B3C", title: "Reis" } });
  });

  it("braucht den Server, außer für die Vorlagen im Sync", async () => {
    const { core, network } = await signedIn();
    network.offline = true;
    await expectCoreError(core.labels.design(), "offline");
    await expectCoreError(core.labels.save(FAKE_DEFAULT_DESIGN), "offline");
    expect((await core.labels.templates()).paper).toBe("62");
  });
});

describe("Produktdaten neu abfragen", () => {
  it("fragt Open Food Facts neu, auch nach „unbekannt“, bremst je Barcode und ändert kein Produkt", async () => {
    const { core, server, clock } = await signedIn();
    const barcode = ean("400638133390");
    // Ungerade Endziffer: Die Nachbildung kennt den Barcode zuerst nicht.
    const odd = Number(barcode.at(-1)) % 2 === 1 ? barcode : ean("400638133391");
    const stored = await core.stock.store({ product: { kind: "barcode", barcode: odd }, zone_id: firstZoneId(core), best_before: null, count: 1, labels: false });
    await core.sync.now();
    expect(await core.products.refreshLookup(odd)).toMatchObject({ barcode: odd, state: "not_found", throttled: false });

    server.offProducts.set(odd, { name: "Bio Haferdrink", brand: "Hofgut", quantity: "1 l", image_id: "bild-hafer" });
    server.images.add("bild-hafer");
    // Innerhalb der Minute: der gespeicherte Stand, gebremst.
    expect(await core.products.refreshLookup(odd)).toMatchObject({ state: "not_found", throttled: true });
    clock.advance(61_000);
    const found = await core.products.refreshLookup(odd);
    expect(found).toEqual({ barcode: odd, state: "found", name: "Bio Haferdrink", brand: "Hofgut", quantity: "1 l", image_id: "bild-hafer", fetched_at: clock.now().toISOString(), throttled: false });

    // Kein Produkt ändert sich: Was übernommen wird, entscheidet der Anwender.
    await core.sync.now();
    expect(value(core.data.products).find((product) => product.id === stored.product.id)).toMatchObject({ name: "", image: null });
  });

  it("fragt ladeninterne Codes nicht und lehnt Ungültiges ohne Anfrage ab", async () => {
    const { core, network } = await signedIn();
    const internal = ean("200123400001");
    const before = network.calls.length;
    expect(await core.products.refreshLookup(internal)).toMatchObject({ state: "skipped", throttled: false, fetched_at: null });
    await expectCoreError(core.products.refreshLookup("12345"), "invalid");
    expect(network.calls.length).toBe(before);
  });

  it("setzt das Bild auf eines, das Stowly hat; ein eben offline angelegtes Produkt wird vorher abgeglichen", async () => {
    const { core, server, network } = await signedIn();
    server.images.add("bild-reis");
    // Offline angelegt: Der Server kennt das Produkt noch nicht.
    network.offline = true;
    const product = await core.products.create({ name: "Reis" });
    network.offline = false;
    await core.products.setImage(product.id, "bild-reis");
    // Erst der Abgleich mit dem Anlegen, dann das Bild.
    const created = network.calls.findIndex((call) => call.path === "/api/sync" && commandsOf(call.body as Record<string, unknown>).some((command) => command.type === "product.create"));
    const image = network.calls.findIndex((call) => call.path === `/api/products/${product.id}/image`);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(image).toBeGreaterThan(created);
    // Das Bild kommt mit dem Abgleich, den der Kern danach anstößt.
    await expect.poll(() => value(core.data.products).find((candidate) => candidate.id === product.id)?.image).toBe("bild-reis");

    await expectCoreError(core.products.setImage(product.id, "fremdes-bild"), "invalid");
    await core.products.setImage(product.id, null);
    await expect.poll(() => value(core.data.products).find((candidate) => candidate.id === product.id)?.image).toBeNull();
    await expectCoreError(core.products.setImage("00000000-0000-4000-8000-000000000000", null), "not_found");
    network.offline = true;
    await expectCoreError(core.products.setImage(product.id, "bild-reis"), "offline");
  });
});
