import { RefreshCw } from "lucide-react";

import { formatTimestamp, useCore, useLive } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Button, Card } from "@/ui/base";

/** Sync-Status und abgelehnte Änderungen. Grundgerüst; die Ausgestaltung folgt in Runde 1. */
export function SyncPage() {
  const core = useCore();
  const status = useLive(core.sync.status);
  const problems = useLive(core.sync.problems, []);

  return (
    <Page
      title="Sync"
      actions={
        <Button icon={<RefreshCw />} busy={status?.phase === "syncing"} onClick={() => void core.sync.now()}>
          Jetzt abgleichen
        </Button>
      }
    >
      <Card style={{ display: "grid", gap: "var(--space-2)" }}>
        <div>
          Server:{" "}
          {status?.online === null || status === undefined ? (
            <Badge>unbekannt</Badge>
          ) : status.online ? (
            <Badge tone="success">erreichbar</Badge>
          ) : (
            <Badge tone="danger">nicht erreichbar</Badge>
          )}
        </div>
        <div>
          Noch nicht gesendet: <Badge tone={status && status.pending > 0 ? "warn" : "neutral"}>{status?.pending ?? 0}</Badge>
        </div>
        <div style={{ color: "var(--color-text-muted)" }}>
          Letzter Abgleich: {status?.last_synced_at ? formatTimestamp(status.last_synced_at) : "noch nie"}
        </div>
        {status?.last_error ? <div style={{ color: "var(--color-danger)" }}>{status.last_error.message}</div> : null}
      </Card>

      {problems.length > 0 ? (
        <Card padding="none">
          <ul>
            {problems.map((problem) => (
              <li
                key={problem.id}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)", borderTop: "var(--border-width) solid var(--color-border)" }}
              >
                <span>
                  <Badge tone={problem.status === "rejected" ? "danger" : "info"}>{problem.status === "rejected" ? "abgelehnt" : "verdrängt"}</Badge>{" "}
                  {problem.command.type}
                  {problem.message ? ` · ${problem.message}` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void core.sync.dismissProblem(problem.id)}>
                  Ausblenden
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}
