/**
 * Vorbereitung jeder Testdatei: eine IndexedDB im Arbeitsspeicher, damit der Kern (Dexie)
 * unter Node läuft. Jede Testdatei bekommt ihre eigene, leere.
 */
import "fake-indexeddb/auto";
