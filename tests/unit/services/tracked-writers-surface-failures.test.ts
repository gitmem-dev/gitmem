/**
 * GIT-104: writers that run under getEffectTracker().track() must let the
 * tracker see their failures. writeTriples and generateVariantsForScar used to
 * catch every write error and resolve normally, so `health` counted them as
 * successes.
 */

import { describe, it, expect, vi } from "vitest";

// Implementations are reset between tests by the config (clearMocks/restoreMocks).
const directUpsert = vi.fn();

vi.mock("../../../src/services/supabase-client.js", () => ({
  directUpsert: (...args: unknown[]) => directUpsert(...args),
  isConfigured: () => true,
}));
vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: () => true,
  getTableName: (base: string) => `gitmem_${base}`,
}));
vi.mock("../../../src/services/license.js", () => ({
  getProConfig: () => ({}),
}));

const { writeTriples } = await import("../../../src/services/triple-writer.js");
const { generateVariantsForScar } = await import("../../../src/services/variant-generation.js");
const { EffectTracker } = await import("../../../src/services/effect-tracker.js");

const candidate = (object: string) => ({
  subject: "Session: s1",
  predicate: "created_thread",
  object,
  half_life_days: 30,
  source_type: "thread",
  source_id: "t-abc12345",
  project: "test-project",
  created_by: "cli",
});

describe("writeTriples", () => {
  it("attempts every triple, then rejects if any failed", async () => {
    directUpsert
      .mockRejectedValueOnce(new Error("Supabase upsert error: 400 - invalid input syntax for type uuid"))
      .mockResolvedValueOnce({ id: "ok" });

    await expect(writeTriples([candidate("a"), candidate("b")])).rejects.toThrow(
      "1/2 triples failed: Supabase upsert error: 400"
    );
    expect(directUpsert).toHaveBeenCalledTimes(2);
  });

  it("resolves with the count when every triple is written", async () => {
    directUpsert.mockResolvedValue({ id: "ok" });
    await expect(writeTriples([candidate("a"), candidate("b")])).resolves.toBe(2);
  });

  it("is recorded as a failure by the effect tracker", async () => {
    directUpsert.mockImplementation(async () => { throw new Error("400"); });
    const tracker = new EffectTracker();

    await tracker.track("triple_write", "thread_creation", () => writeTriples([candidate("a")]));

    expect(tracker.getHealthReport().byPath.triple_write).toMatchObject({ succeeded: 0, failed: 1 });
  });
});

describe("generateVariantsForScar", () => {
  const scar = { id: "scar-1", title: "t", description: "d" };

  it("rejects when a variant insert fails", async () => {
    directUpsert
      .mockResolvedValueOnce({ id: "v1" })
      .mockRejectedValueOnce(new Error("column scar_enforcement_variants.active does not exist"));

    await expect(generateVariantsForScar(scar)).rejects.toThrow(
      "created 1/2 variants: column scar_enforcement_variants.active does not exist"
    );
  });

  it("resolves when both variants are written", async () => {
    directUpsert.mockResolvedValue({ id: "v" });
    await expect(generateVariantsForScar(scar)).resolves.toBeUndefined();
  });
});
