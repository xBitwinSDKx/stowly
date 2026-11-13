import { Link } from "react-router";

import { ROUTES } from "@/contract";

import { Page } from "./Page";

export function NotFoundPage() {
  return (
    <Page title="Seite nicht gefunden">
      <p>
        Diese Adresse gibt es nicht. <Link to={ROUTES.stock}>Zum Bestand</Link>
      </p>
    </Page>
  );
}
