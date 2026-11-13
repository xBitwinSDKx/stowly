import { describe, expect, it } from "vitest";

import type { PrintJob } from "@/contract";

import { labelStatus, labelStatusText } from "./label-status";

const job = (id: string, state: PrintJob["state"]) => ({ id, state });

describe("Stand der Etiketten nach dem Einlagern", () => {
  it("sagt nichts, wenn keine Etiketten angefordert wurden", () => {
    expect(labelStatus([job("a", "pending")], [])).toBeNull();
    expect(labelStatus([], ["a"])).toBeNull();
  });

  it("steht aus, solange eines noch bei keinem Druckdienst angekommen ist", () => {
    expect(labelStatus([job("a", "pending"), job("b", "printed")], ["a", "b"])).toBe("pending");
  });

  it("wird gedruckt, sobald alle beim Druckdienst sind", () => {
    expect(labelStatus([job("a", "queued"), job("b", "printed")], ["a", "b"])).toBe("printing");
    expect(labelStatus([job("a", "printing")], ["a"])).toBe("printing");
  });

  it("ist gedruckt, wenn alle gedruckt oder übertragen sind", () => {
    expect(labelStatus([job("a", "printed"), job("b", "sent"), job("c", "pending")], ["a", "b"])).toBe("printed");
  });

  it("meldet ein Problem vor allem anderen", () => {
    expect(labelStatus([job("a", "failed"), job("b", "pending")], ["a", "b"])).toBe("problem");
    expect(labelStatus([job("a", "unknown")], ["a"])).toBe("problem");
    expect(labelStatus([job("a", "cancelled"), job("b", "printed")], ["a", "b"])).toBe("problem");
  });

  it("unterscheidet Einzahl und Mehrzahl", () => {
    expect(labelStatusText("pending", 1)).toBe("Etikett steht aus");
    expect(labelStatusText("pending", 3)).toBe("Etiketten stehen aus");
    expect(labelStatusText("printing", 2)).toBe("Etiketten werden gedruckt");
    expect(labelStatusText("printed", 1)).toBe("Etikett gedruckt");
  });
});
