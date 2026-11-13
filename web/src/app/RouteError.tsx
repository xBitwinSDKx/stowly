import { useRouteError } from "react-router";

import { ROUTES } from "@/contract";
import { EmptyState } from "@/ui";
import { Button, ButtonLink } from "@/ui/base";
import { CloudOffIcon, RefreshIcon, WarningIcon } from "@/ui/icons";

import { PageBody, usePageTitle } from "./Page";
import { isLoadError } from "./pages";

/**
 * Wird gezeigt, wenn eine Ansicht beim Zeichnen scheitert. Der Bestand selbst ist davon
 * nicht betroffen: Er liegt im Kern, nicht in der Ansicht.
 *
 * Ein eigener Fall ist ein Teil der App, der sich nicht nachladen ließ (kein Netz, oder die
 * App wurde inzwischen aktualisiert und der alte Teil ist fort): Dann hilft nur „Neu laden".
 */
export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error);
  const loading = isLoadError(error);
  usePageTitle("Fehler");
  return (
    <PageBody>
      {loading ? (
        <EmptyState
          pageTitle
          icon={<CloudOffIcon />}
          title="Dieser Teil der App ließ sich nicht laden"
          actions={
            <>
              <ButtonLink to={ROUTES.stock}>Zum Bestand</ButtonLink>
              <Button variant="primary" icon={<RefreshIcon />} onClick={() => window.location.reload()}>
                Neu laden
              </Button>
            </>
          }
        >
          Vermutlich fehlt gerade die Verbindung zum Server, oder Stowly wurde inzwischen aktualisiert. „Neu laden“ holt den aktuellen Stand; die Daten sind davon nicht betroffen.
        </EmptyState>
      ) : (
        <EmptyState
          pageTitle
          icon={<WarningIcon />}
          title="Diese Ansicht konnte nicht angezeigt werden"
          actions={
            <>
              <ButtonLink to={ROUTES.stock}>Zum Bestand</ButtonLink>
              <Button variant="primary" onClick={() => window.location.reload()}>
                Neu laden
              </Button>
            </>
          }
        >
          Die Daten sind davon nicht betroffen. Fehlermeldung: {message}
        </EmptyState>
      )}
    </PageBody>
  );
}
