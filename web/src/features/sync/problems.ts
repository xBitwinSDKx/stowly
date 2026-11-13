/**
 * Sync-Probleme als deutsche Sätze: was nicht übernommen wurde und warum.
 * Abgeleitet aus der Art des Befehls (`command.type`) und dem Grund (`code`).
 * Reine Logik ohne React.
 */
import { productTitle, type Command, type Package, type Printer, type Product, type RejectCode, type SyncProblem, type Zone } from "@/contract";

/** Was die Sätze nachschlagen dürfen. Fehlt etwas, steht ein allgemeiner Ausdruck im Satz. */
export interface ProblemLookup {
  products: readonly Product[];
  zones: readonly Zone[];
  printers: readonly Printer[];
  /** Bestand und Lösch-Historie. */
  packages: readonly Package[];
}

export interface ProblemText {
  /** Ein ganzer Satz: was nicht übernommen wurde und warum. */
  text: string;
  /** Was jetzt zu tun ist, falls es etwas zu tun gibt. */
  advice: string | null;
  /** Die Bearbeitung liegt in der Lösch-Historie und lässt sich dort übernehmen. */
  inHistory: boolean;
}

function quoted(name: string): string {
  return `„${name}“`;
}

/** Ein Hauptwort in den Fällen, die die Sätze brauchen. */
interface Noun {
  /** Wer? „die Zone „Keller“" (zugleich der Wen-Fall nach „für") */
  nom: string;
  /** Wem? „der Zone „Keller“" */
  dat: string;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Was der Befehl tun sollte, als Satzanfang bis vor „…, weil". */
function subject(command: Command, lookup: ProblemLookup): string {
  const product = (id: string): Noun => {
    const found = lookup.products.find((candidate) => candidate.id === id);
    return found
      ? { nom: `das Produkt ${quoted(productTitle(found))}`, dat: `dem Produkt ${quoted(productTitle(found))}` }
      : { nom: "ein Produkt", dat: "einem Produkt" };
  };
  const zone = (id: string): Noun => {
    const found = lookup.zones.find((candidate) => candidate.id === id);
    return found ? { nom: `die Zone ${quoted(found.name)}`, dat: `der Zone ${quoted(found.name)}` } : { nom: "eine Zone", dat: "einer Zone" };
  };
  const printer = (id: string): Noun => {
    const found = lookup.printers.find((candidate) => candidate.id === id);
    return found
      ? { nom: `der Drucker ${quoted(found.name)}`, dat: `dem Drucker ${quoted(found.name)}` }
      : { nom: "ein Drucker", dat: "einem Drucker" };
  };
  /** „die Packung A2B3C (Basmati Reis)" */
  const pkg = (id: string, productId?: string): Noun => {
    const owner = productId ?? lookup.packages.find((candidate) => candidate.id === id)?.product_id;
    const found = owner === undefined ? undefined : lookup.products.find((candidate) => candidate.id === owner);
    const suffix = found ? ` (${productTitle(found)})` : "";
    return { nom: `die Packung ${id}${suffix}`, dat: `der Packung ${id}${suffix}` };
  };

  switch (command.type) {
    case "product.create": {
      const name = command.name?.trim() || command.barcodes?.[0];
      return `${name ? `Das Produkt ${quoted(name)}` : "Ein neues Produkt"} wurde nicht angelegt`;
    }
    case "product.update":
      return `Die Änderung an ${product(command.product_id).dat} wurde nicht übernommen`;
    case "product.add_barcode":
      return `Der Barcode ${command.barcode} wurde ${product(command.product_id).dat} nicht zugeordnet`;
    case "product.remove_barcode":
      return `Der Barcode ${command.barcode} wurde nicht von ${product(command.product_id).dat} entfernt`;
    case "product.merge":
      return `${capital(product(command.source_id).nom)} wurde nicht mit ${product(command.target_id).dat} zusammengeführt`;
    case "package.create":
      return `${capital(pkg(command.package_id, command.product_id).nom)} wurde nicht eingelagert`;
    case "package.update":
      return `Die Änderung an ${pkg(command.package_id).dat} wurde nicht übernommen`;
    case "package.remove":
      return `${capital(pkg(command.package_id).nom)} wurde nicht entnommen`;
    case "package.restore":
      return `${capital(pkg(command.package_id).nom)} wurde nicht wiederhergestellt`;
    case "zone.create":
      return `Die Zone ${quoted(command.name)} wurde nicht angelegt`;
    case "zone.update":
      return `Die Änderung an ${zone(command.zone_id).dat} wurde nicht übernommen`;
    case "zone.delete":
      return `${capital(zone(command.zone_id).nom)} wurde nicht gelöscht`;
    case "settings.update":
      return "Die Änderung an den Einstellungen des Haushalts wurde nicht übernommen";
    case "printer.create":
      return `Der Drucker ${quoted(command.name)} wurde nicht angelegt`;
    case "printer.update":
      return `Die Änderung an ${printer(command.printer_id).dat} wurde nicht übernommen`;
    case "printer.delete":
      return `${capital(printer(command.printer_id).nom)} wurde nicht gelöscht`;
    case "printer.report":
      return `Der Zustand von ${printer(command.printer_id).dat} wurde nicht gemeldet`;
    case "print.request":
      if (command.package_id) {
        return `Das Etikett für ${pkg(command.package_id).nom} wurde nicht angefordert`;
      }
      return command.zone_id ? `Das Etikett für ${zone(command.zone_id).nom} wurde nicht angefordert` : "Ein Etikett wurde nicht angefordert";
    case "print.report":
      return "Der Stand eines Etiketts wurde nicht gemeldet";
  }
}

/** Warum der Server abgelehnt hat, als Nebensatz ohne Punkt. */
function reason(command: Command, code: RejectCode | null, message: string | null): string {
  switch (code) {
    case "invalid":
      return "weil der Server die Angaben für ungültig hält";
    case "id_conflict":
      return command.type === "package.create" ? "weil ihre ID schon vergeben ist" : "weil es diese Kennung auf dem Server schon gibt";
    case "last_zone":
      return "weil die letzte Zone nicht gelöscht werden kann";
    case "internal":
      return "weil im Server ein Fehler aufgetreten ist";
    case "not_found":
      switch (command.type) {
        case "package.create":
          return "weil es ihr Produkt oder ihre Zone auf dem Server nicht gibt";
        case "package.update":
        case "package.remove":
        case "package.restore":
          return "weil es die Packung auf dem Server nicht gibt";
        case "product.update":
        case "product.add_barcode":
        case "product.remove_barcode":
          return "weil es das Produkt auf dem Server nicht gibt";
        case "product.merge":
          return "weil es eines der beiden Produkte auf dem Server nicht gibt";
        case "zone.update":
          return "weil es die Zone auf dem Server nicht mehr gibt";
        case "zone.delete":
          return "weil es die Zone oder die Zielzone auf dem Server nicht gibt";
        case "printer.update":
        case "printer.delete":
        case "printer.report":
          return "weil es den Drucker auf dem Server nicht mehr gibt";
        case "print.request":
        case "print.report":
          return "weil es die Packung, die Zone oder das Etikett auf dem Server nicht gibt";
        default:
          return "weil es den Eintrag auf dem Server nicht gibt";
      }
    default:
      return message ? `Meldung des Servers: ${message.replace(/[.\s]+$/, "")}` : "der Server nennt keinen Grund";
  }
}

/**
 * Beschreibt ein Sync-Problem in einem deutschen Satz.
 *
 * - "rejected": Der Server hat die Änderung abgelehnt; sie ist verworfen.
 * - "displaced": Die Bearbeitung traf eine schon entnommene Packung (Löschen gewinnt).
 *   Sie liegt in der Lösch-Historie und lässt sich beim Wiederherstellen übernehmen.
 */
export function describeProblem(problem: SyncProblem, lookup: ProblemLookup): ProblemText {
  const { command } = problem;
  if (problem.status === "displaced") {
    const id = "package_id" in command && command.package_id ? command.package_id : null;
    const owner = id === null ? undefined : lookup.packages.find((candidate) => candidate.id === id)?.product_id;
    const product = owner === undefined ? undefined : lookup.products.find((candidate) => candidate.id === owner);
    const what = id === null ? "einer Packung" : product ? `der Packung ${id} (${productTitle(product)})` : `der Packung ${id}`;
    return {
      text: `Die Bearbeitung ${what} kam zu spät: Die Packung war schon entnommen.`,
      advice: "Die Bearbeitung liegt in der Lösch-Historie und lässt sich dort beim Wiederherstellen übernehmen.",
      inHistory: true,
    };
  }

  const why = reason(command, problem.code, problem.message);
  const text = why.startsWith("weil") ? `${subject(command, lookup)}, ${why}.` : `${subject(command, lookup)}; ${why}.`;
  let advice: string | null = null;
  if (problem.code === "id_conflict" && command.type === "package.create") {
    advice = "Bitte die Packung neu einlagern und das Etikett ersetzen.";
  } else if (problem.code === "internal") {
    advice = "Bitte die Änderung noch einmal vornehmen.";
  }
  return { text, advice, inHistory: false };
}
