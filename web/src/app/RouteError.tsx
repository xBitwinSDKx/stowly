import { useRouteError } from "react-router";

import { ROUTES } from "@/contract";
import { EmptyState, LinkButton } from "@/ui";
import { Button } from "@/ui/base";
import { WarningIcon } from "@/ui/icons";

import { PageBody, usePageTitle } from "./Page";

/**
 * Wird gezeigt, wenn eine Ansicht beim Zeichnen scheitert. Der Bestand selbst ist davon
 * nicht betroffen: Er liegt im Kern, nicht in der Ansicht.
 */
export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error);
  usePageTitle("Fehler");
  return (
    <PageBody>
      <EmptyState
        pageTitle
        icon={<WarningIcon />}
        title="Diese Ansicht konnte nicht angezeigt werden"
        actions={
          <>
            <LinkButton to={ROUTES.stock}>Zum Bestand</LinkButton>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Neu laden
            </Button>
          </>
        }
      >
        Die Daten sind davon nicht betroffen. Fehlermeldung: {message}
      </EmptyState>
    </PageBody>
  );
}
