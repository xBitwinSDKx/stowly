import { ROUTES } from "@/contract";
import { EmptyState, LinkButton } from "@/ui";
import { SearchIcon } from "@/ui/icons";

import { PageBody, usePageTitle } from "./Page";

export function NotFoundPage() {
  usePageTitle("Seite nicht gefunden");
  return (
    <PageBody>
      <EmptyState
        pageTitle
        icon={<SearchIcon />}
        title="Seite nicht gefunden"
        actions={
          <LinkButton to={ROUTES.stock} variant="primary">
            Zum Bestand
          </LinkButton>
        }
      >
        Diese Adresse gibt es in Stowly nicht.
      </EmptyState>
    </PageBody>
  );
}
