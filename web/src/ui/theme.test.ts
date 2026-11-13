import { afterEach, beforeEach, describe, expect, it } from "vitest";

import initScript from "../../public/theme-init.js?raw";
import {
  ACCENT_STORAGE_KEY,
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  getThemeState,
  resetThemeForTests,
  setAccent,
  setTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  THEMES,
} from "./theme";

function attributes() {
  const root = document.documentElement;
  return {
    theme: root.getAttribute("data-theme"),
    accent: root.getAttribute("data-accent"),
    color: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  };
}

/** Führt public/theme-init.js aus, wie es der Browser vor dem Start der App tut. */
function runInitScript() {
  new Function(initScript)();
  return attributes();
}

beforeEach(() => {
  localStorage.clear();
  resetThemeForTests();
  document.head.innerHTML = '<meta name="theme-color" content="">';
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
});

afterEach(() => {
  localStorage.clear();
  resetThemeForTests();
});

describe("Thema und Akzentfarbe", () => {
  it("beginnt dunkel mit Mint", () => {
    expect(getThemeState()).toEqual({ theme: "dark", accent: "mint", resolved: "dark" });
    expect(DEFAULT_THEME).toBe("dark");
    expect(DEFAULT_ACCENT).toBe("mint");
  });

  it("merkt sich die Wahl und setzt die Attribute", () => {
    setTheme("light");
    setAccent("blue");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("blue");
    expect(attributes()).toEqual({ theme: "light", accent: "blue", color: THEME_COLORS.light });

    resetThemeForTests();
    expect(getThemeState()).toEqual({ theme: "light", accent: "blue", resolved: "light" });
  });

  it("ignoriert unbekannte gespeicherte Werte", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    localStorage.setItem(ACCENT_STORAGE_KEY, "gold");
    expect(getThemeState()).toEqual({ theme: "dark", accent: "mint", resolved: "dark" });
  });
});

describe("public/theme-init.js", () => {
  it("setzt ohne gespeicherte Wahl dieselben Vorgaben", () => {
    expect(runInitScript()).toEqual({ theme: "dark", accent: "mint", color: THEME_COLORS.dark });
  });

  it("kommt für jede Kombination zum selben Ergebnis wie theme.ts", () => {
    for (const theme of THEMES) {
      for (const { key: accent } of ACCENTS) {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
        localStorage.setItem(ACCENT_STORAGE_KEY, accent);
        const fromScript = runInitScript();

        resetThemeForTests();
        setTheme(theme);
        setAccent(accent);
        expect(fromScript, `${theme}/${accent}`).toEqual(attributes());
      }
    }
  });

  it("ignoriert unbekannte gespeicherte Werte", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    localStorage.setItem(ACCENT_STORAGE_KEY, "gold");
    expect(runInitScript()).toEqual({ theme: "dark", accent: "mint", color: THEME_COLORS.dark });
  });
});
