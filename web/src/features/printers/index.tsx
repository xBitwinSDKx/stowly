import { formatTimestamp, useCore, useLive } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Card } from "@/ui/base";

/** Drucker und Etiketten. Grundgerüst; Verwaltung, Vorschau und ausstehende Etiketten folgen in Runde 2. */
export function PrintersPage() {
  const core = useCore();
  const printers = useLive(core.data.printers, []);
  const status = useLive(core.data.printerStatus, []);
  const jobs = useLive(core.data.printJobs, []);
  const open = jobs.filter((job) => job.state === "pending" || job.state === "queued" || job.state === "printing").length;

  return (
    <Page title="Drucker">
      <p style={{ color: "var(--color-text-muted)" }}>
        Ausstehende Etiketten: <Badge tone={open > 0 ? "warn" : "neutral"}>{open}</Badge>
      </p>
      {printers.length === 0 ? (
        <Card>
          <p style={{ color: "var(--color-text-muted)" }}>Noch kein Drucker eingerichtet.</p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))" }}>
          {printers.map((printer) => {
            const seen = status.find((entry) => entry.printer_id === printer.id);
            return (
              <Card key={printer.id}>
                <strong>{printer.name}</strong>
                <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                  {printer.connection === "server" ? "am Server" : "direkt vom Handy (Pi)"}
                  <br />
                  {seen ? `zuletzt gesehen ${formatTimestamp(seen.observed_at)}` : "noch nie gesehen"}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}
