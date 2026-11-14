/**
 * Derselbe Wert wird zwei Sekunden lang ignoriert (docs/recherche.md, Abschnitt 1).
 *
 * Die Kamera sieht einen Code zehnmal je Sekunde. Gemeldet wird er einmal; solange er im
 * Bild bleibt, beginnen die zwei Sekunden mit jeder Sichtung neu. Erst wenn er zwei Sekunden
 * lang nicht zu sehen war, zählt er wieder: So bucht ein Etikett, das ruhig vor der Kamera
 * liegt, nicht alle zwei Sekunden erneut.
 *
 * Nach einem Dialog (die Auswertung war angehalten) gilt für Werte, die eine Rückfrage
 * auslösen (Produkt-Barcodes: Einlagern fragt nach dem MHD), eine kurze Lücke statt der zwei
 * Sekunden (`RESCAN_GAP_MS`): Bleibt der Code durchgehend im Bild, öffnet sich der Dialog nicht
 * von selbst wieder; kurz wegschwenken genügt, um ihn erneut zu scannen. Etiketten, die ohne
 * Rückfrage buchen, behalten die zwei Sekunden.
 *
 * Dazu das Zurückstellen: Was mit im Bild war, als ein anderer Code gemeldet wurde (der
 * Barcode neben dem Etikett derselben Packung), zählt für eine feste Frist nicht. Diese
 * Frist verlängert sich nicht mit jeder Sichtung: Wer danach bewusst auf den zweiten Code
 * zielt, wird nach spätestens zwei Sekunden bedient.
 */

export const SAME_VALUE_WINDOW_MS = 2_000;

/**
 * So lange muss ein Produkt-Barcode nach einem Dialog nicht zu sehen sein, bevor er wieder
 * zählt: 0,8 Sekunden. Bewusstes Wegschwenken und wieder Hinhalten dauert länger (die Kamera
 * muss danach auch erst wieder scharf stellen), ein Aussetzer der Erkennung bei ruhig
 * gehaltenem Code ist dagegen kürzer: Bei zehn Auswertungen je Sekunde wären es acht
 * Fehlschläge hintereinander, bei einer langsamen Erkennung (drei je Sekunde) noch zwei bis drei.
 */
export const RESCAN_GAP_MS = 800;

/**
 * - "new": neu oder lange genug nicht gesehen; soll gemeldet werden
 * - "repeat": vor Kurzem gemeldet und seither im Bild
 * - "held": zurückgestellt, weil er beim Melden eines anderen Codes mit im Bild war
 */
export type Sighting = "new" | "repeat" | "held";

export class ScanDeduper {
  /** Gemeldete Werte mit dem Zeitpunkt ihrer letzten Sichtung. */
  private readonly seen = new Map<string, number>();
  /** Zurückgestellte Werte mit dem Ende ihrer Frist. */
  private readonly held = new Map<string, number>();
  /** Werte, die nach einem Dialog schon nach der kurzen Lücke wieder zählen. */
  private readonly rearming = new Set<string>();

  constructor(
    private readonly windowMs: number = SAME_VALUE_WINDOW_MS,
    private readonly rescanGapMs: number = RESCAN_GAP_MS,
  ) {}

  /** Meldet eine Sichtung des Codes, auf den gezielt wird, und sagt, was sie bedeutet. */
  check(value: string, nowMs: number): Sighting {
    const last = this.seen.get(value);
    const heldUntil = this.held.get(value);
    if (heldUntil !== undefined) {
      if (nowMs < heldUntil) {
        if (last !== undefined) {
          // Schon einmal gemeldet und weiter im Bild: bleibt auch nach der Frist gesperrt.
          this.seen.set(value, nowMs);
        }
        return "held";
      }
      this.held.delete(value);
    }
    this.seen.set(value, nowMs);
    if (this.seen.size > 32) {
      this.prune(nowMs);
    }
    const gap = this.rearming.has(value) ? this.rescanGapMs : this.windowMs;
    if (last === undefined || nowMs - last >= gap) {
      this.rearming.delete(value);
      return "new";
    }
    return "repeat";
  }

  /**
   * Wartet dieser Wert nach einem Dialog nur noch auf die kurze Lücke? Dann ist er seit dem
   * Dialog durchgehend im Bild, und die Ansicht sagt, dass kurzes Wegschwenken genügt.
   */
  waitsForGap(value: string): boolean {
    return this.rearming.has(value);
  }

  /** Wie `check`; true = dieser Wert ist neu (oder lange genug weg gewesen) und soll gemeldet werden. */
  accept(value: string, nowMs: number): boolean {
    return this.check(value, nowMs) === "new";
  }

  /**
   * Eine Sichtung am Rand, auf die nicht gezielt wird. Ein schon gemeldeter Wert bleibt
   * dadurch gesperrt, solange er im Bild ist; ein noch nicht gemeldeter bleibt neu.
   */
  see(value: string, nowMs: number): void {
    if (this.seen.has(value)) {
      this.seen.set(value, nowMs);
    }
  }

  /** Würde dieser Wert jetzt nicht gemeldet (vor Kurzem gemeldet oder zurückgestellt)? Ändert nichts. */
  suppressed(value: string, nowMs: number): boolean {
    const heldUntil = this.held.get(value);
    if (heldUntil !== undefined && nowMs < heldUntil) {
      return true;
    }
    const last = this.seen.get(value);
    return last !== undefined && nowMs - last < this.windowMs;
  }

  /** Stellt einen Wert für die Dauer des Fensters zurück, gerechnet ab jetzt. */
  hold(value: string, nowMs: number): void {
    this.held.set(value, nowMs + this.windowMs);
    if (this.held.size > 32) {
      this.prune(nowMs);
    }
  }

  /**
   * Die Auswertung war angehalten (ein Dialog war offen): Was davor im Bild war, gilt als
   * gerade eben gesehen. Sonst öffnete das Produkt, das noch vor der Kamera liegt, sofort
   * den nächsten Dialog. Was schon beim Anhalten (`pausedAtMs`) länger nicht mehr zu sehen
   * war, bleibt dagegen vergessen: Es soll nach dem Dialog sofort wieder zählen.
   *
   * @param quick Werte, die nach dem Dialog schon nach der kurzen Lücke wieder zählen
   *              (`RESCAN_GAP_MS`); alle anderen erst nach den zwei Sekunden.
   */
  refresh(nowMs: number, pausedAtMs: number = nowMs, quick: (value: string) => boolean = () => false): void {
    for (const [value, at] of this.seen) {
      if (pausedAtMs - at < this.windowMs) {
        this.seen.set(value, nowMs);
        if (quick(value)) {
          this.rearming.add(value);
        }
      }
    }
  }

  /** Vergisst einen Wert (oder alle): Er wird bei der nächsten Sichtung wieder gemeldet. */
  forget(value?: string): void {
    if (value === undefined) {
      this.seen.clear();
      this.held.clear();
      this.rearming.clear();
    } else {
      this.seen.delete(value);
      this.held.delete(value);
      this.rearming.delete(value);
    }
  }

  private prune(nowMs: number): void {
    for (const [value, at] of this.seen) {
      if (nowMs - at >= this.windowMs) {
        this.seen.delete(value);
        this.rearming.delete(value);
      }
    }
    for (const [value, until] of this.held) {
      if (nowMs >= until) {
        this.held.delete(value);
      }
    }
  }
}
