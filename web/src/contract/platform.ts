/**
 * Auf welchem Gerät die App läuft: für Anleitungen, die je Plattform verschieden sind (der CA von
 * Stowly vertrauen, die App installieren, Push). Ohne DOM: Die Angaben des Browsers kommen herein.
 */

/** Was die Erkennung aus `navigator` braucht. */
export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  /** User-Agent Client Hints (Chromium); Safari und Firefox kennen sie nicht. */
  userAgentData?: { platform?: string } | null;
}

export type Platform = "ios" | "android" | "windows" | "macos" | "other";

export interface PlatformInfo {
  platform: Platform;
  /** Firefox hat unter Windows und macOS vor Version 120 einen eigenen Speicher für Zertifikate. */
  isFirefox: boolean;
}

/**
 * iPhone, iPad oder iPod. iPadOS gibt sich als Mac aus; verraten wird es durch den
 * Touchscreen, den ein Mac nicht hat.
 */
export function isAppleMobile(nav: NavigatorLike | undefined): boolean {
  if (!nav) {
    return false;
  }
  const agent = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(agent)) {
    return true;
  }
  return (nav.platform === "MacIntel" || /Macintosh/.test(agent)) && (nav.maxTouchPoints ?? 0) > 1;
}

const HINTS: Readonly<Record<string, Platform>> = { android: "android", windows: "windows", macos: "macos", ios: "ios" };

/**
 * Die Plattform: zuerst aus `userAgentData.platform` (Chromium), sonst aus dem User-Agent. Ein iPad
 * gilt als iOS, auch wenn es sich als Mac ausgibt (`isAppleMobile`).
 */
export function detectPlatform(nav: NavigatorLike | undefined): PlatformInfo {
  const agent = nav?.userAgent ?? "";
  const isFirefox = /Firefox\/\d/.test(agent);
  const hint = (nav?.userAgentData?.platform ?? "").toLowerCase();
  let platform: Platform;
  if (hint !== "") {
    platform = HINTS[hint] ?? "other";
  } else if (isAppleMobile(nav)) {
    platform = "ios";
  } else if (/Android/.test(agent)) {
    platform = "android";
  } else if (/Windows/.test(agent)) {
    platform = "windows";
  } else if (/Macintosh|Mac OS X/.test(agent)) {
    platform = "macos";
  } else {
    platform = "other";
  }
  return { platform, isFirefox };
}
