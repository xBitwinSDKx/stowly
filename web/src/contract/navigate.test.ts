import { describe, expect, it } from "vitest";

import { NAVIGATE_MESSAGE, navigateTarget } from "./routes";

const ORIGIN = "https://stowly.example";

describe("Nachricht des Service Workers: wechsle die Ansicht", () => {
  it("liefert den Pfad mit Suche und Anker im eigenen Ursprung", () => {
    expect(navigateTarget({ type: NAVIGATE_MESSAGE, url: `${ORIGIN}/warnungen` }, ORIGIN)).toBe("/warnungen");
    expect(navigateTarget({ type: NAVIGATE_MESSAGE, url: `${ORIGIN}/einstellungen?x=1#app` }, ORIGIN)).toBe("/einstellungen?x=1#app");
    expect(navigateTarget({ type: NAVIGATE_MESSAGE, url: "/einkaufsliste" }, ORIGIN)).toBe("/einkaufsliste");
  });

  it("übergeht fremde Ziele und andere Nachrichten", () => {
    for (const data of [
      { type: NAVIGATE_MESSAGE, url: "https://example.org/warnungen" },
      { type: NAVIGATE_MESSAGE, url: "https://stowly.example:8443/warnungen" },
      { type: NAVIGATE_MESSAGE, url: "" },
      { type: NAVIGATE_MESSAGE, url: 42 },
      { type: "SKIP_WAITING" },
      "stowly:navigate",
      null,
      undefined,
    ]) {
      expect(navigateTarget(data, ORIGIN), JSON.stringify(data)).toBeNull();
    }
  });
});
