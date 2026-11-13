/** Kennung des Inhalts einer Ansicht im Rahmen (`<main>` in Shell.tsx), Ziel von „Zum Inhalt springen". */
export const CONTENT_ID = "inhalt";

/**
 * Gibt den Fokus an den Inhalt der Ansicht, falls er verloren gegangen ist: Ein Hinweis unter der
 * Kopfzeile schließt sich nach einer Antwort samt der Schaltfläche, die den Fokus hatte. Ohne das
 * begänne die Tabulatortaste danach wieder ganz oben auf der Seite.
 */
export function refocusContent(): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.getElementById(CONTENT_ID)?.focus({ preventScroll: true });
    }
  }, 0);
}
