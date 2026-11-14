import { useMemo, useState } from "react";

import { formatTimestamp, ROUTES, useCore, useLive } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { List, ListRow, Notice, Section, timeAgo, useNow } from "@/ui";
import { Badge, Button, ButtonLink } from "@/ui/base";
import { CircleCheckIcon, CloudOffIcon, RefreshIcon, WarningIcon } from "@/ui/icons";

import { describeProblem, type ProblemLookup } from "./problems";
import { summarizeSync, syncErrorText } from "./status";
import styles from "./SyncPage.module.css";

/**
 * Sync-Status: Ist der Server erreichbar, was wartet noch, wann wurde zuletzt abgeglichen.
 * Darunter die Sync-Probleme: Änderungen, die der Server abgelehnt oder verdrängt hat.
 */
export function SyncPage() {
  const core = useCore();
  const status = useLive(core.sync.status);
  const problems = useLive(core.sync.problems);
  const app = useLive(core.app.state);
  const products = useLive(core.data.products);
  const zones = useLive(core.data.zones);
  const printers = useLive(core.data.printers);
  const packages = useLive(core.data.packages);
  const removed = useLive(core.data.removedPackages);
  const printJobs = useLive(core.data.printJobs);
  const shoppingItems = useLive(core.data.shoppingItems);
  const now = useNow();
  const [busy, setBusy] = useState(false);

  const lookup: ProblemLookup = useMemo(
    () => ({
      products: products ?? [],
      zones: zones ?? [],
      printers: printers ?? [],
      packages: [...(packages ?? []), ...(removed ?? [])],
      printJobs: printJobs ?? [],
      shoppingItems: shoppingItems ?? [],
    }),
    [products, zones, printers, packages, removed, printJobs, shoppingItems],
  );

  if (!status) {
    return (
      <Page title="Sync-Status" narrow>
        <PageLoading />
      </Page>
    );
  }

  const summary = summarizeSync(status);
  const syncing = busy || status.phase === "syncing";

  async function syncNow() {
    setBusy(true);
    try {
      // Wirft nicht: Ein Fehlschlag steht danach in `status.last_error`.
      await core.sync.now();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Sync-Status"
      narrow
      description="Stowly arbeitet immer auf der Kopie dieses Geräts und gleicht sie mit dem Server ab, sobald er erreichbar ist."
      actions={
        <Button variant="primary" icon={<RefreshIcon />} busy={syncing} onClick={() => void syncNow()}>
          Jetzt abgleichen
        </Button>
      }
    >
      {summary.tone === "offline" ? (
        <Notice tone="warn" icon={<CloudOffIcon />} title="Der Server ist nicht erreichbar" role="status">
          Alles funktioniert weiter. Änderungen bleiben auf diesem Gerät und werden gesendet, sobald der Server wieder da ist.
        </Notice>
      ) : summary.tone === "error" ? (
        <Notice tone="danger" icon={<WarningIcon />} title="Der letzte Abgleich ist gescheitert" role="status">
          {status.last_error ? syncErrorText(status.last_error) : "Der Grund ist nicht bekannt."} Stowly versucht es von selbst erneut.
        </Notice>
      ) : null}

      <List>
        <ListRow label="Server" inline>
          {status.online === null ? (
            <Badge>wird geprüft</Badge>
          ) : status.online ? (
            <Badge tone="success">erreichbar</Badge>
          ) : (
            <Badge tone="warn">nicht erreichbar</Badge>
          )}
        </ListRow>
        <ListRow label="Ungesendete Änderungen" hint="Was auf diesem Gerät geändert, aber noch nicht beim Server angekommen ist." inline>
          <Badge tone={status.pending > 0 ? "warn" : "neutral"}>{status.pending}</Badge>
        </ListRow>
        <ListRow label="Letzter Abgleich" hint={status.last_synced_at ? formatTimestamp(status.last_synced_at) : undefined} inline>
          <span className={styles.value}>
            {status.phase === "syncing" ? "läuft gerade …" : status.last_synced_at ? timeAgo(status.last_synced_at, now) : "noch nie"}
          </span>
        </ListRow>
        {status.last_error ? (
          <ListRow label="Letzter Fehler" hint={syncErrorText(status.last_error)}>
            <span className={styles.value}>{formatTimestamp(status.last_error.at)}</span>
          </ListRow>
        ) : null}
        <ListRow label="Versionen">
          <span className={styles.value}>
            App {app?.version ?? "–"} · Server {status.server_version ?? "unbekannt"}
          </span>
        </ListRow>
      </List>

      <Section
        title="Sync-Probleme"
        description="Änderungen von diesem Gerät, die der Server nicht oder nicht wie gewünscht übernommen hat. Der Bestand zeigt wieder den Stand des Servers."
      >
        {!problems ? (
          <PageLoading />
        ) : problems.length === 0 ? (
          <div className={styles.none}>
            <CircleCheckIcon size={20} aria-hidden="true" />
            Keine: Der Server hat alle Änderungen übernommen.
          </div>
        ) : (
          <ul className={styles.problems}>
            {problems.map((problem) => {
              const text = describeProblem(problem, lookup);
              return (
                <li key={problem.id} className={styles.problem}>
                  <div className={styles.problemHead}>
                    <Badge tone={problem.status === "rejected" ? "danger" : "info"}>{problem.status === "rejected" ? "abgelehnt" : "verdrängt"}</Badge>
                    <span className={styles.time}>Geändert am {formatTimestamp(problem.at)}</span>
                  </div>
                  <p>{text.text}</p>
                  {text.advice ? <p className={styles.advice}>{text.advice}</p> : null}
                  <div className={styles.problemActions}>
                    {text.inHistory ? (
                      <ButtonLink to={ROUTES.history} size="sm">
                        Zur Lösch-Historie
                      </ButtonLink>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => void core.sync.dismissProblem(problem.id)}>
                      Ausblenden
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </Page>
  );
}
