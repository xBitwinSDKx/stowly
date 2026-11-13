import { createContext } from "react";

/**
 * Der Zugang zum Abmelden; Anbieter und Hook stehen in logout.tsx.
 *
 * Bewusst eine eigene Datei ohne weitere Abhängigkeiten: Beim Entwickeln lädt der
 * Entwicklungsserver logout.tsx nach fast jeder Änderung an der Oberfläche neu. Läge der
 * Kontext dort, entstünde dabei jedes Mal ein neuer, und der schon gezeichnete Anbieter
 * und die neu geladenen Nutzer fänden sich nicht mehr.
 */
export const LogoutContext = createContext<(() => void) | null>(null);
