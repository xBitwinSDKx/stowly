import { useEffect, useState } from "react";

import { ENDPOINTS, type ServerHealth } from "@/contract";
import { Button } from "@/ui/base";

type ServerState = { status: "checking" } | { status: "reachable"; health: ServerHealth } | { status: "unreachable" };

/**
 * Wird gezeigt, wenn der Kern beim Start scheitert. Die App ist dann nicht benutzbar;
 * die Seite sagt, warum, und ob wenigstens der Server antwortet.
 */
export function BootError({ error }: { error: unknown }) {
  const [server, setServer] = useState<ServerState>({ status: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    fetch(ENDPOINTS.health.path, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<ServerHealth>)
      .then((health) => setServer(health.app === "stowly" ? { status: "reachable", health } : { status: "unreachable" }))
      .catch(() => setServer({ status: "unreachable" }));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const message = error instanceof Error ? error.message : String(error);

  return (
    <main style={{ maxWidth: "36rem", margin: "0 auto", padding: "var(--space-12) var(--space-4)", display: "grid", gap: "var(--space-4)" }}>
      <h1>Stowly konnte nicht starten</h1>
      <p style={{ color: "var(--color-danger)" }}>{message}</p>
      <p style={{ color: "var(--color-text-muted)" }}>
        {server.status === "checking" && "Server wird geprüft …"}
        {server.status === "reachable" &&
          `Der Server antwortet (Version ${server.health.version}, Protokoll ${server.health.protocol}${server.health.configured ? "" : ", kein Passwort gesetzt"}).`}
        {server.status === "unreachable" && "Der Server antwortet nicht."}
      </p>
      <p>
        <Button onClick={() => window.location.reload()}>Neu laden</Button>
      </p>
    </main>
  );
}
