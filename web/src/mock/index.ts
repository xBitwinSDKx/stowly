/**
 * Die Attrappe des Offline-Kerns: `import { createMockCore } from "@/mock"`.
 *
 * - Starten der App auf der Attrappe: `npm run dev:mock` (siehe src/entry.mock.ts)
 * - In Tests: `createMockCore({ latency: 0 })`, bei Bedarf mit eigenen Daten über `data`
 *
 * Nur Tests und src/entry.mock.ts dürfen die Attrappe importieren.
 */
export {
  createMockCore,
  MOCK_PASSWORD,
  MOCK_SCENARIOS,
  type MockControl,
  type MockCore,
  type MockOptions,
  type MockPushPermission,
  type MockScenario,
} from "./core";
export { derived, LiveValue } from "./live";
export {
  createEmptyData,
  createSampleData,
  createSingleZoneData,
  DEVICE_IDS,
  PRINTER_IDS,
  sampleBarcode,
  samplePackageId,
  sampleUuid,
  ZONE_IDS,
  type MockData,
} from "./sample";
export { MockScanPage } from "./ScanPlaceholder";
