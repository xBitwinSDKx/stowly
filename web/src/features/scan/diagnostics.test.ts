import { describe, expect, it } from "vitest";

import type { ScannerDiagnostics } from "@/core/scanner";

import { describeDiagnostics } from "./ScanPage";

describe("Kamera-Infos (?diagnose)", () => {
  it("nennt Stand, Gerät, Erkennung, Kamera und Zoom so, wie der Browser sie meldet", () => {
    const info: ScannerDiagnostics = {
      apple_mobile: true,
      engine: "worker",
      camera: "Rückseitige Kamera",
      cameras: ["Rückseitige Kamera", "Rückseitige Ultraweitwinkel-Kamera"],
      capabilities: { zoom: { min: 1, max: 10, step: 0.1 }, focusMode: ["continuous", "manual"] },
      settings: { zoom: 1, width: 1920, height: 1080 },
      video: "1920 × 1080",
      frame: 864,
      display: "390 × 560",
      fps: 30,
      starts: 1,
      paused: false,
      detect_ms: { last: 12.3, average: 10.5 },
    };
    const text = describeDiagnostics(info, "14.11.2026, 01:15");
    expect(text).toContain("Stowly 0.0.0-test, Stand 14.11.2026, 01:15");
    expect(text).toContain("iPhone/iPad erkannt: ja");
    expect(text).toContain("Erkennung: worker · zuletzt 12.3 ms · Mittel 10.5 ms");
    expect(text).toContain("Kamera: Rückseitige Kamera");
    expect(text).toContain("Kameras: Rückseitige Kamera | Rückseitige Ultraweitwinkel-Kamera");
    expect(text).toContain("Bild: 1920 × 1080 · Ausschnitt 864 · angezeigt 390 × 560");
    expect(text).toContain("Bilder je Sekunde: 30 · Kamera geöffnet: 1× · wertet aus");
    expect(text).toContain("Zoom möglich: min 1 · max 10 · step 0.1");
    expect(text).toContain("Zoom eingestellt: 1");
    expect(text).toContain("Fokus möglich: continuous, manual · Abstand –");
  });

  it("kommt ohne Kamera und ohne Angaben des Browsers aus", () => {
    const text = describeDiagnostics(
      {
        apple_mobile: false,
        engine: null,
        camera: null,
        cameras: [],
        capabilities: null,
        settings: null,
        video: null,
        frame: null,
        display: null,
        fps: null,
        starts: 0,
        paused: true,
        detect_ms: { last: null, average: null },
      },
      "",
    );
    expect(text.split("\n")[0]).toBe("Stowly 0.0.0-test");
    expect(text).toContain("Zoom möglich: –");
    expect(text).toContain("Kamera: –");
  });
});
