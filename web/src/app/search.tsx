import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Die Suche des Rahmens. Das Suchfeld sitzt in der Kopfzeile, die Treffer zeigt die
 * Bestandsliste; dazwischen liegt dieser Zustand. Er lebt, solange der Rahmen steht.
 */
export interface SearchState {
  /** Der Text im Suchfeld. */
  query: string;
  setQuery: (query: string) => void;
}

const SearchContext = createContext<SearchState>({ query: "", setQuery: () => undefined });

export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

/** Die Suche des Rahmens. Außerhalb des Rahmens: leere Suche, Eingaben verpuffen. */
export function useSearch(): SearchState {
  return useContext(SearchContext);
}
