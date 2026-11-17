/**
 * Suchbegriffe aus Produktnamen und die Such-Links zu Cookidoo und Chefkoch (docs/plan-0.6.md, 1).
 */
import { describe, expect, it } from "vitest";

import { chefkochUrl, cookidooUrl, searchTerm, searchWords, TERM_MAX_CHARS } from "./terms";

/** Ein Produkt, wie `searchTerm` es liest. */
function product(name: string, brand = "", quantity = "") {
  return { name, brand, quantity };
}

describe("searchTerm", () => {
  it.each([
    ["Barilla Spaghetti n.5 500g", "Barilla", "500 g", "Spaghetti"],
    ["Bio Vollmilch 3,8 % Fett", "", "1 l", "Vollmilch"],
    ["Kokosmilch 2x400ml", "", "", "Kokosmilch"],
    ["ja! Basmati Reis", "ja!", "1 kg", "Basmati Reis"],
    ["Thunfisch in eigenem Saft", "", "", "Thunfisch"],
  ])("macht aus „%s“ (Marke „%s“, Größe „%s“) „%s“", (name, brand, quantity, term) => {
    expect(searchTerm(product(name, brand, quantity))).toBe(term);
  });

  it("lässt Mengen, Nummern, Klammern, Zeichen und Füllwörter weg", () => {
    expect(searchTerm(product("Erbsen (TK)", "Frostgarten", "750 g"))).toBe("Erbsen");
    expect(searchTerm(product("Weizenmehl Type 405", "Mühlenglück", "1 kg"))).toBe("Weizenmehl");
    expect(searchTerm(product("H-Milch 3,5 %", "Almhof", "1 l"))).toBe("H-Milch");
    expect(searchTerm(product("Spaghetti Nr. 5"))).toBe("Spaghetti");
    expect(searchTerm(product("Penne No 7 1kg"))).toBe("Penne");
    expect(searchTerm(product("6 Stück Eier"))).toBe("Eier");
    expect(searchTerm(product("Hafermilch 1,5 l"))).toBe("Hafermilch");
    expect(searchTerm(product("Nutella® Nuss-Nougat-Creme"))).toBe("Nutella Nuss-Nougat-Creme");
    expect(searchTerm(product("„Omas“ Apfelmus"))).toBe("Omas Apfelmus");
    expect(searchTerm(product("Original Klassische Premium Tomatensoße"))).toBe("Tomatensoße");
    expect(searchTerm(product("ÖKO Linsen [rot]"))).toBe("Linsen");
    expect(searchTerm(product("Joghurt 1,5% fettarm"))).toBe("Joghurt fettarm");
    // Der Text der Packungsgröße, auch ohne Leerzeichen geschrieben.
    expect(searchTerm(product("Reis 2,5kg Beutel", "", "2,5 kg"))).toBe("Reis Beutel");
  });

  it("vergleicht die Marke ohne Groß- und Kleinschreibung und Akzente, Wort für Wort", () => {
    expect(searchTerm(product("GUT & GÜNSTIG Spaghetti", "Gut & Günstig"))).toBe("Spaghetti");
    expect(searchTerm(product("Spaghetti Barilla", "barilla"))).toBe("Spaghetti");
    expect(searchTerm(product("MULLER Milchreis", "Müller"))).toBe("Milchreis");
    // Nur ganze Wörter der Marke: „Müllers" ist ein anderes Wort als „Müller".
    expect(searchTerm(product("Müllers Haferflocken", "Müller"))).toBe("Müllers Haferflocken");
  });

  it("schneidet ab der ersten Präposition ab, wenn davor etwas bleibt", () => {
    expect(searchTerm(product("Thunfisch in Öl", "Nordkap", "150 g"))).toBe("Thunfisch");
    expect(searchTerm(product("Hähnchenbrust mit Kräutern"))).toBe("Hähnchenbrust");
    expect(searchTerm(product("Müsli ohne Zucker"))).toBe("Müsli");
    expect(searchTerm(product("Brühe für Gemüse"))).toBe("Brühe");
    expect(searchTerm(product("Bohnen aus der Dose"))).toBe("Bohnen");
    expect(searchTerm(product("Bohnen im Glas"))).toBe("Bohnen");
    // Steht die Präposition vorn, bleibt alles.
    expect(searchTerm(product("Mit Liebe gebacken"))).toBe("Mit Liebe gebacken");
  });

  it("nimmt höchstens vier Wörter und 40 Zeichen", () => {
    expect(searchTerm(product("Rote Bete Salat süß sauer eingelegt"))).toBe("Rote Bete Salat süß");
    const long = searchTerm(product("Donaudampfschifffahrtsgesellschaftskapitänsmütze Kuchen"));
    expect(long.length).toBeLessThanOrEqual(TERM_MAX_CHARS);
    expect(long).toBe("Donaudampfschifffahrtsgesellschaftskapit");
    expect(searchTerm(product("Gemüsebrühe Instant Pulver Würfel Extra"))).toBe("Gemüsebrühe Instant Pulver Würfel");
  });

  it("nimmt den gekürzten Namen, wenn sonst nichts bleibt; Platzhalter haben keinen Begriff", () => {
    expect(searchTerm(product("Barilla", "Barilla"))).toBe("Barilla");
    expect(searchTerm(product("500 g", "", "500 g"))).toBe("500 g");
    expect(searchTerm(product("Bio"))).toBe("Bio");
    expect(searchTerm(product("", "Kornhaus", "1 kg"))).toBe("");
    expect(searchTerm(product("   "))).toBe("");
  });
});

describe("Such-Links", () => {
  it("bauen die Adressen von Cookidoo und Chefkoch wie live geprüft", () => {
    expect(cookidooUrl(["spaghetti", "paprika"])).toBe("https://cookidoo.de/search/de-DE?query=spaghetti%20paprika");
    expect(chefkochUrl(["spaghetti", "paprika"])).toBe("https://www.chefkoch.de/rs/s0/spaghetti+paprika/Rezepte.html");
  });

  it("nehmen alle Wörter aller Begriffe, Umlaute kodiert", () => {
    expect(chefkochUrl(["Passierte Tomaten", "Käse"])).toBe("https://www.chefkoch.de/rs/s0/Passierte+Tomaten+K%C3%A4se/Rezepte.html");
    expect(cookidooUrl(["Passierte Tomaten", "Käse"])).toBe("https://cookidoo.de/search/de-DE?query=Passierte%20Tomaten%20K%C3%A4se");
  });

  it("bleiben bei den festen Rechnern, was auch im Begriff steht", () => {
    // Suchbegriffe aus Claudes Antwort sind Daten: kein Pfad, keine Abfrage, kein anderer Rechner.
    const sneaky = ["../../evil.example/x?y=1#z", "https://evil.example", "Tomate/../../admin"];
    const chefkoch = chefkochUrl(sneaky) ?? "";
    const cookidoo = cookidooUrl(sneaky) ?? "";
    expect(new URL(chefkoch).host).toBe("www.chefkoch.de");
    expect(new URL(chefkoch).pathname.startsWith("/rs/s0/")).toBe(true);
    expect(new URL(chefkoch).search).toBe("");
    expect(new URL(chefkoch).hash).toBe("");
    expect(chefkoch).not.toContain("..");
    expect(new URL(cookidoo).host).toBe("cookidoo.de");
    expect([...new URL(cookidoo).searchParams.keys()]).toEqual(["query"]);
    expect(searchWords(sneaky)).toEqual(["evil", "example", "x", "y", "1", "z", "https", "evil", "example", "Tomate", "admin"]);
  });

  it("gibt es ohne Wort nicht", () => {
    expect(cookidooUrl([])).toBeNull();
    expect(chefkochUrl(["  ", "!!!"])).toBeNull();
    expect(searchWords(["-Bindestrich-", "H-Milch"])).toEqual(["Bindestrich", "H-Milch"]);
  });
});
