import { useMemo, useState } from "react";
import { useLocation } from "react-router";

import { ROUTES } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { groupByProduct } from "@/features/stock/model";
import { useStock, type StockData } from "@/features/stock/useStock";
import { EmptyState, Section } from "@/ui";
import { ButtonLink } from "@/ui/base";
import { ChefHatIcon } from "@/ui/icons";

import { AiIdeas } from "./AiIdeas";
import { Ingredients } from "./Ingredients";
import { cookCandidates, ingredientTerms, preselect, requestedIds, type Ingredient } from "./model";
import { SearchLinks } from "./SearchLinks";

const TITLE = "Was koche ich?";
const DESCRIPTION = "Rezeptideen aus dem Vorrat, zuerst mit dem, was bald abläuft.";

/** Eine gewählte Zutat, wie die Seite sie sich merkt: welcher Kandidat, mit welchem Begriff. */
interface Choice {
  key: string;
  term: string;
}

function CookContent({ stock, search }: { stock: StockData; search: string }) {
  const groups = useMemo(() => groupByProduct(stock.entries, stock.zones), [stock.entries, stock.zones]);
  const byProduct = useMemo(() => new Map(groups.map((group) => [group.product_id, group])), [groups]);
  const candidates = useMemo(() => cookCandidates(groups), [groups]);
  // Die Vorwahl gilt beim Öffnen; was danach im Bestand geschieht, ändert die Wahl nicht, nur was wegfällt.
  const [choices, setChoices] = useState<Choice[]>(() => preselect(candidates, requestedIds(search)).map((candidate) => ({ key: candidate.key, term: candidate.term })));
  const ingredients = useMemo(() => {
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    return choices.flatMap((choice): Ingredient[] => {
      const candidate = byKey.get(choice.key);
      return candidate ? [{ candidate, term: choice.term }] : [];
    });
  }, [candidates, choices]);

  if (candidates.length === 0) {
    return (
      <EmptyState
        icon={<ChefHatIcon size={26} />}
        title="Nichts im Vorrat"
        actions={
          <ButtonLink to={ROUTES.stock} variant="primary">
            Zum Bestand
          </ButtonLink>
        }
      >
        Sobald etwas mit Namen eingelagert ist, schlägt diese Seite Rezepte daraus vor.
      </EmptyState>
    );
  }

  return (
    <>
      <Section title="Zutaten" description="Vorgewählt ist, was bald abläuft, das Dringendste zuerst.">
        <Ingredients ingredients={ingredients} candidates={candidates} onChange={(next) => setChoices(next.map((entry) => ({ key: entry.candidate.key, term: entry.term })))} />
      </Section>
      <Section title="Rezepte suchen" description="Bei Cookidoo (Thermomix) und Chefkoch, mit den Begriffen der Zutaten. Das geht auch ohne Verbindung zum Server.">
        <SearchLinks terms={ingredientTerms(ingredients)} />
      </Section>
      <Section title="Vorschläge von Claude" id="claude" description="Drei Gerichte, die den Vorrat aufbrauchen, mit den gewählten Zutaten vorn.">
        <AiIdeas ingredients={ingredients} groups={byProduct} />
      </Section>
    </>
  );
}

/**
 * Was koche ich? (seit 0.6.0; docs/plan-0.6.md): Zutaten aus dem Vorrat, vorgewählt nach Dringlichkeit,
 * als Chips mit Suchbegriff; Such-Links zu Cookidoo und Chefkoch, die die App selbst baut (auch offline);
 * darunter Vorschläge von Claude über den Server. `?mit=<Produkt-ID>` wählt genau diese Zutaten vor.
 */
export function CookPage() {
  const stock = useStock();
  const { search } = useLocation();
  return (
    <Page title={TITLE} description={DESCRIPTION}>
      {stock.ready ? <CookContent key={search} stock={stock} search={search} /> : <PageLoading label="Vorrat wird geladen …" />}
    </Page>
  );
}
