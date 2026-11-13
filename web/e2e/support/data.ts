/**
 * Kleine Helfer für Testdaten.
 */
import { gtinCheckDigit, type Package, type Product, type Zone } from "@/contract";

import { value, type Device } from "./device";

let serial = 0;

/** Ein gültiger, nicht ladeninterner EAN-13; bei jedem Aufruf ein anderer. */
export function freshBarcode(): string {
  serial += 1;
  const body = `40${String(process.pid % 100_000).padStart(5, "0")}${String(serial).padStart(5, "0")}`;
  return body + String(gtinCheckDigit(body));
}

/** Die erste Zone in der Reihenfolge des Geräts. */
export function firstZone(device: Device): Zone {
  const zone = value(device.core.data.zones)[0];
  if (!zone) {
    throw new Error(`${device.name} kennt keine Zone.`);
  }
  return zone;
}

export function zoneByName(device: Device, name: string): Zone {
  const zone = value(device.core.data.zones).find((candidate) => candidate.name === name);
  if (!zone) {
    throw new Error(`${device.name} kennt die Zone ${name} nicht.`);
  }
  return zone;
}

export function productByName(device: Device, name: string): Product {
  const product = value(device.core.data.products).find((candidate) => candidate.name === name);
  if (!product) {
    throw new Error(`${device.name} kennt das Produkt ${name} nicht.`);
  }
  return product;
}

/** Eine Packung im Bestand des Geräts; wirft, wenn sie dort nicht (mehr) steht. */
export function stocked(device: Device, id: string): Package {
  const pkg = value(device.core.data.packages).find((candidate) => candidate.id === id);
  if (!pkg) {
    throw new Error(`${device.name}: Die Packung ${id} steht nicht im Bestand.`);
  }
  return pkg;
}

/** Eine Packung in der Lösch-Historie des Geräts; wirft, wenn sie dort nicht steht. */
export function removed(device: Device, id: string): Package {
  const pkg = value(device.core.data.removedPackages).find((candidate) => candidate.id === id);
  if (!pkg) {
    throw new Error(`${device.name}: Die Packung ${id} steht nicht in der Lösch-Historie.`);
  }
  return pkg;
}

/** Die Packungs-IDs im Bestand des Geräts, die zu einem Produkt gehören, sortiert. */
export function stockedOf(device: Device, productId: string): string[] {
  return value(device.core.data.packages)
    .filter((pkg) => pkg.product_id === productId)
    .map((pkg) => pkg.id)
    .sort();
}
