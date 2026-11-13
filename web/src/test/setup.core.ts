/**
 * Zusätzliche Vorbereitung für die Tests des Offline-Kerns (Projekt "core"):
 * eine IndexedDB im Arbeitsspeicher, damit Dexie ohne Browser läuft.
 *
 * Jede Testdatei bekommt ihre eigene, leere IndexedDB. Wer innerhalb einer Datei
 * zwischen Tests aufräumen will: `indexedDB = new IDBFactory()` aus "fake-indexeddb".
 */
import "fake-indexeddb/auto";
