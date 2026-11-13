import type { Live } from "@/contract";

/** Ein veränderlicher Wert, der die `Live`-Schnittstelle erfüllt. */
export class LiveValue<T> implements Live<T> {
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
 * Ein aus einem anderen Wert berechneter Wert.
 *
 * `inputs` nennt, wovon das Ergebnis abhängt. Solange sich diese Eingaben nicht ändern,
 * liefert `get()` dieselbe Referenz. Das verlangt die `Live`-Schnittstelle, sonst
 * rendert React endlos.
 */
export function derived<S, T>(source: LiveValue<S>, inputs: (value: S) => readonly unknown[], compute: (value: S) => T): Live<T> {
  let lastInputs = inputs(source.get());
  let output = compute(source.get());
  return {
    get() {
      const value = source.get();
      const nextInputs = inputs(value);
      if (!sameInputs(nextInputs, lastInputs)) {
        lastInputs = nextInputs;
        output = compute(value);
      }
      return output;
    },
    subscribe(listener) {
      return source.subscribe(listener);
    },
  };
}
