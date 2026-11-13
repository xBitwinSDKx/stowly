/**
 * Reaktive Werte des Kerns (`Live<T>` aus dem Vertrag).
 *
 * `Signal` hält einen veränderlichen Wert. `derived` berechnet daraus einen zweiten und
 * liefert dieselbe Referenz, solange sich seine Eingaben nicht ändern: Das verlangt die
 * Schnittstelle, sonst rendert React endlos.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import type { Live } from "@/contract/core";

export class Signal<T> implements Live<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) {
      return;
    }
    this.value = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  update(change: (current: T) => T): void {
    this.set(change(this.value));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/**
 * Ein aus `source` berechneter Wert.
 *
 * `inputs` nennt, wovon das Ergebnis abhängt. Nur wenn sich diese Eingaben ändern, wird neu
 * gerechnet, und nur dann erfahren die Abonnenten davon. Eine Änderung an den Zonen weckt
 * also niemanden, der die Packungen liest.
 */
export function derived<S, T>(source: Signal<S>, inputs: (value: S) => readonly unknown[], compute: (value: S) => T | undefined): Live<T> {
  let lastInputs: readonly unknown[] | null = null;
  let output: T | undefined;

  function read(): T | undefined {
    const value = source.get();
    const nextInputs = inputs(value);
    if (lastInputs === null || !sameInputs(nextInputs, lastInputs)) {
      lastInputs = nextInputs;
      output = compute(value);
    }
    return output;
  }

  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let announced: T | undefined;

  return {
    get: read,
    subscribe(listener) {
      listeners.add(listener);
      if (unsubscribe === null) {
        announced = read();
        unsubscribe = source.subscribe(() => {
          const next = read();
          if (Object.is(next, announced)) {
            return;
          }
          announced = next;
          for (const current of [...listeners]) {
            current();
          }
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },
  };
}
