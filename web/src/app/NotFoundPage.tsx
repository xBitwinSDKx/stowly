import { ROUTES } from "@/contract";
import { EmptyState } from "@/ui";
import { ButtonLink } from "@/ui/base";
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
          <ButtonLink to={ROUTES.stock} variant="primary">
            Zum Bestand
          </ButtonLink>
        }
      >
        Diese Adresse gibt es in Stowly nicht.
      </EmptyState>
    </PageBody>
  );
}
