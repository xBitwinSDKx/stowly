import { useEffect } from "react";
import { useNavigate } from "react-router";

import { navigateTarget } from "@/contract";

/**
 * Ein Tipp auf eine Mitteilung bei offener App: Der Service Worker holt sie nach vorn und schickt
 * ihr das Ziel (`NAVIGATE_MESSAGE`, docs/integrationen.md 4.5). Die App wechselt dorthin, ohne
 * neu zu laden. Fremde Ziele und andere Nachrichten übergeht sie.
 */
export function useNotificationNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!container) {
      return;
    }
    function onMessage(event: MessageEvent) {
      const path = navigateTarget(event.data, window.location.origin);
      if (path !== null) {
        void navigate(path);
      }
    }
    container.addEventListener("message", onMessage);
    // Nachrichten, die vor dem Zuhören kamen (die App startete eben erst), jetzt zustellen.
    container.startMessages();
    return () => container.removeEventListener("message", onMessage);
  }, [navigate]);
}
