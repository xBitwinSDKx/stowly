/**
 * Vertrag der Einrichtung: neue Passwörter, Kontakt für die Push-Dienste, Adressen des Assistenten
 * und die Erkennung des Geräts.
 */
import { describe, expect, it } from "vitest";

import { LIMITS } from "./api.gen";
import { CoreError } from "./errors";
import { checkNewPassword, checkPushContact } from "./input";
import { detectPlatform, isAppleMobile } from "./platform";
import { ROUTES, SETUP_SLUGS, setupPath, setupStepOf } from "./routes";

function invalid(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("invalid");
    return (error as CoreError).message;
  }
  throw new Error("Erwartet war CoreError invalid");
}

describe("checkNewPassword", () => {
  it("verlangt mindestens LIMITS.password_min Zeichen, gezählt wie im Server, und höchstens LIMITS.password", () => {
    expect(LIMITS.password_min).toBe(8);
    expect(() => checkNewPassword("acht Zei")).not.toThrow();
    expect(invalid(() => checkNewPassword("sieben!"))).toBe("Das Passwort braucht mindestens 8 Zeichen.");
    // Vier Zeichen außerhalb der Grundebene sind acht UTF-16-Einheiten, aber nur vier Zeichen.
    expect(invalid(() => checkNewPassword("🔑🔑🔑🔑"))).toBe("Das Passwort braucht mindestens 8 Zeichen.");
    expect(invalid(() => checkNewPassword(undefined))).toBe("Das Passwort braucht mindestens 8 Zeichen.");
    expect(() => checkNewPassword("x".repeat(LIMITS.password))).not.toThrow();
    expect(invalid(() => checkNewPassword("x".repeat(LIMITS.password + 1)))).toBe(`Das Passwort ist zu lang (höchstens ${String(LIMITS.password)} Zeichen).`);
    // Nicht gekürzt: Leerzeichen zählen mit.
    expect(() => checkNewPassword("  sechs ")).not.toThrow();
  });
});

describe("checkPushContact", () => {
  it("nimmt eine E-Mail-Adresse mit oder ohne mailto: und eine https-Adresse, wie der Server", () => {
    expect(checkPushContact(" haushalt@example.org ")).toBe("mailto:haushalt@example.org");
    expect(checkPushContact("mailto:haushalt@example.org")).toBe("mailto:haushalt@example.org");
    expect(checkPushContact("https://example.org/kontakt")).toBe("https://example.org/kontakt");
  });

  it("lehnt alles andere mit einem Satz ab", () => {
    const sentence = "Erwartet ist eine E-Mail-Adresse wie haushalt@example.org oder eine https-Adresse.";
    for (const value of ["haushalt", "haushalt@example", "zwei worte@example.org", "http://example.org", "https://nutzer:geheim@example.org", "mailto:", "müller@example.org"]) {
      expect(invalid(() => checkPushContact(value)), value).toBe(sentence);
    }
    expect(invalid(() => checkPushContact("  "))).toBe("Bitte eine Kontakt-Adresse eingeben.");
    expect(invalid(() => checkPushContact(`${"a".repeat(LIMITS.push_contact)}@example.org`))).toBe(sentence);
  });
});

describe("Adressen der Einrichtung", () => {
  it("haben ein Kürzel je Schritt und führen ohne Kürzel zum ersten offenen", () => {
    expect(ROUTES.setup).toBe("/einrichtung");
    expect(setupPath()).toBe("/einrichtung");
    expect(Object.values(SETUP_SLUGS)).toEqual(["sicher", "drucker", "updates", "mitteilungen", "fertig"]);
    expect(setupPath("printer")).toBe("/einrichtung/drucker");
    expect(setupPath("done")).toBe("/einrichtung/fertig");
    expect(setupStepOf("mitteilungen")).toBe("notifications");
    expect(setupStepOf("sicher")).toBe("https");
    expect(setupStepOf(undefined)).toBeNull();
    expect(setupStepOf("https")).toBeNull();
  });
});

describe("Erkennung des Geräts", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1";
  const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36";
  const WINDOWS_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
  const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";

  it("fragt zuerst userAgentData, sonst den User-Agent", () => {
    expect(detectPlatform({ userAgent: LINUX, userAgentData: { platform: "Windows" } })).toEqual({ platform: "windows", isFirefox: false });
    expect(detectPlatform({ userAgent: ANDROID, userAgentData: { platform: "Android" } })).toEqual({ platform: "android", isFirefox: false });
    expect(detectPlatform({ userAgent: IPAD, userAgentData: { platform: "macOS" } }).platform).toBe("macos");
    expect(detectPlatform({ userAgent: LINUX, userAgentData: { platform: "Linux" } }).platform).toBe("other");
    expect(detectPlatform({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })).toEqual({ platform: "ios", isFirefox: false });
    expect(detectPlatform({ userAgent: ANDROID, maxTouchPoints: 5 }).platform).toBe("android");
    expect(detectPlatform({ userAgent: WINDOWS_FIREFOX })).toEqual({ platform: "windows", isFirefox: true });
    expect(detectPlatform({ userAgent: IPAD, platform: "MacIntel", maxTouchPoints: 0 }).platform).toBe("macos");
    expect(detectPlatform({ userAgent: LINUX }).platform).toBe("other");
    expect(detectPlatform(undefined)).toEqual({ platform: "other", isFirefox: false });
  });

  it("hält ein iPad, das sich als Mac ausgibt, für iOS", () => {
    expect(isAppleMobile({ userAgent: IPAD, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(detectPlatform({ userAgent: IPAD, platform: "MacIntel", maxTouchPoints: 5 }).platform).toBe("ios");
    expect(isAppleMobile({ userAgent: IPAD, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });
});
