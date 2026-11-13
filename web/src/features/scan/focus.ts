/**
 * Fokus auf ein Eingabefeld in einem `Dialog`.
 *
 * `<dialog>.showModal()` setzt den Fokus selbst: auf das erste Element mit dem HTML-Attribut
 * `autofocus`, sonst auf das erste bedienbare, und das ist beim Grundbaustein `Dialog` die
 * Schaltfläche zum Schließen. Reacts `autoFocus` hilft hier nicht: React ruft nur `focus()`
 * und schreibt das Attribut nicht ins Dokument, und der Dialog öffnet sich erst danach.
 *
 * Als `ref` an das Feld gehängt, setzt diese Funktion das Attribut, bevor der Dialog sich
 * öffnet. So landet die Eingabe sofort im Feld, und Enter schließt nicht versehentlich den Dialog.
 */
export function focusInDialog(element: HTMLInputElement | null): void {
  if (!element) {
    return;
  }
  element.setAttribute("autofocus", "");
  // Für Umgebungen, die das Attribut beim Öffnen nicht beachten.
  setTimeout(() => {
    if (element.isConnected && document.activeElement !== element && element.closest("dialog[open]")) {
      element.focus();
    }
  }, 0);
}
