import { formatTimestamp, useCore, useLive } from "@/contract";
import { Page } from "@/app/Page";
import { EmptyState, List, ListRow, Notice, plural, Section, timeAgo, useNow } from "@/ui";
import { Badge } from "@/ui/base";
import { InfoIcon, PrinterIcon } from "@/ui/icons";

import styles from "./PrintersPage.module.css";

/**
 * Drucker und Etiketten. Platzhalter: Die Druckerverwaltung, die Etikett-Vorschau und die
 * ausstehenden Etiketten folgen in Runde 2. Bis dahin zeigt die Ansicht nur, was es gibt.
 */
export function PrintersPage() {
  const core = useCore();
  const printers = useLive(core.data.printers, []);
  const status = useLive(core.data.printerStatus, []);
  const jobs = useLive(core.data.printJobs, []);
  const now = useNow();
  const open = jobs.filter((job) => job.state === "pending" || job.state === "queued" || job.state === "printing").length;

  return (
    <Page title="Drucker" narrow description="Etikettendrucker des Haushalts: am Server im Heimnetz oder am Raspberry Pi im Keller.">
      <Notice tone="info" icon={<InfoIcon />} title="Die Druckerverwaltung folgt">
        Drucker einrichten, Etiketten ansehen und ausstehende Etiketten drucken: Das kommt mit dem nächsten Ausbauschritt. Eingelagert wird schon jetzt;
        die Packungs-ID lässt sich bis dahin von Hand auf die Packung schreiben.
      </Notice>

      {printers.length === 0 ? (
        <EmptyState icon={<PrinterIcon size={26} />} title="Noch kein Drucker eingerichtet">
          Ohne Drucker fordert Stowly keine Etiketten an.
        </EmptyState>
      ) : (
        <Section title="Eingerichtete Drucker">
          <List>
            {printers.map((printer) => {
              const seen = status.find((entry) => entry.printer_id === printer.id);
              return (
                <ListRow
                  key={printer.id}
                  label={printer.name}
                  hint={printer.connection === "server" ? "Am Server: Der Server druckt." : "Direkt: Das Handy schickt den Auftrag an den Druckdienst."}
                >
                  <span className={styles.value}>
                    {seen ? `Zuletzt gesehen ${timeAgo(seen.observed_at, now)}` : "Noch nie gesehen"}
                    {seen ? <span className={styles.time}>{formatTimestamp(seen.observed_at)}</span> : null}
                  </span>
                </ListRow>
              );
            })}
            <ListRow label="Ausstehende Etiketten" hint="Angefordert, aber noch nicht gedruckt.">
              <Badge tone={open > 0 ? "warn" : "neutral"}>{plural(open, "Etikett", "Etiketten")}</Badge>
            </ListRow>
          </List>
        </Section>
      )}
    </Page>
  );
}
