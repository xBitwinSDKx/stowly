import { Component, type ErrorInfo, type ReactNode } from "react";

import { EmptyState } from "@/ui";
import { Button } from "@/ui/base";
import { WarningIcon } from "@/ui/icons";

import styles from "./SessionGate.module.css";

interface State {
  error: Error | null;
}

/**
 * Fängt Fehler beim Zeichnen ab, die keine Ansicht innerhalb des Rahmens betreffen
 * (die fängt der Router mit `RouteError`): Anmeldung, Schranke, Rückfragen.
 * Statt einer leeren Seite steht dann da, was los ist, mit einem Weg zurück.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Für die Fehlersuche; die Seite selbst zeigt nur die Meldung.
    console.error("Stowly konnte die Oberfläche nicht zeichnen.", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <main className={styles.loading}>
        <EmptyState
          pageTitle
          icon={<WarningIcon />}
          title="Stowly konnte nicht angezeigt werden"
          actions={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Neu laden
            </Button>
          }
        >
          Die Daten sind davon nicht betroffen. Fehlermeldung: {error.message}
        </EmptyState>
      </main>
    );
  }
}
