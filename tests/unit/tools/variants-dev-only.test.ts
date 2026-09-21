/**
 * GIT-106: scar variant A/B testing is dev-tier only.
 *
 * The variant tables are not provisioned by schema/setup.sql
 * (scar_enforcement_variants has no `active` column; variant_assignments and
 * variant_performance_metrics do not exist), so on a customer (pro) store every
 * variant read and write failed. All three variant paths must consult
 * hasVariants(), and hasVariants() must be false on pro.
 *
 * Uses the REAL tier module, driven by GITMEM_TIER, so the predicate itself is
 * under test rather than a mock of it.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const directUpsert = vi.fn(async () => ({ id: "row-id" }));
const cachedScarSearch = vi.fn();
const getOrAssignVariant = vi.fn();
const generateVariantsForScar = vi.fn(async () => undefined);

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: () => true,
  directUpsert: (...a: unknown[]) => directUpsert(...a),
  cachedScarSearch: (...a: unknown[]) => cachedScarSearch(...a),
  upsertRecord: async () => undefined,
  fetchRelatedTriples: async () => new Map(),
}));

// Force recall onto the Supabase branch (not the local vector cache).
vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: () => false,
  localScarSearch: async () => [],
}));

vi.mock("../../../src/services/variant-assignment.js", () => ({
  getOrAssignVariant: (...a: unknown[]) => getOrAssignVariant(...a),
  formatVariantEnforcement: (_v: unknown, title: string) => title,
}));

vi.mock("../../../src/services/variant-generation.js", () => ({
  generateVariantsForScar: (...a: unknown[]) => generateVariantsForScar(...a),
}));

// create_learning collaborators that would otherwise reach the network or disk.
vi.mock("../../../src/services/embedding.js", () => ({
  embed: async () => null,
  isEmbeddingAvailable: () => false,
}));
vi.mock("../../../src/services/startup.js", () => ({ flushCache: async () => undefined }));
vi.mock("../../../src/services/triple-writer.js", () => ({ writeTriplesForLearning: async () => 0 }));

const { resetTier, hasVariants } = await import("../../../src/services/tier.js");
const { recall } = await import("../../../src/tools/recall.js");
const { createLearning } = await import("../../../src/tools/create-learning.js");
const { setGitmemDir, clearGitmemDirCache } = await import("../../../src/services/gitmem-dir.js");

const ORIGINAL_TIER = process.env.GITMEM_TIER;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git106-"));

function useTier(tier: "free" | "pro" | "dev") {
  process.env.GITMEM_TIER = tier;
  resetTier();
}

beforeEach(() => {
  setGitmemDir(tmpDir);
  cachedScarSearch.mockResolvedValue({
    results: [{
      id: "scar-1", title: "Scar one", description: "about deploys", severity: "high",
      counter_arguments: [], applies_when: [], similarity: 0.9,
    }],
    cache_hit: false,
  });
  getOrAssignVariant.mockResolvedValue({
    has_variants: true,
    variant: { id: "variant-1", variant_name: "traditional", enforcement_config: { type: "imperative", steps: [] } },
  });
});

afterAll(() => {
  if (ORIGINAL_TIER === undefined) delete process.env.GITMEM_TIER;
  else process.env.GITMEM_TIER = ORIGINAL_TIER;
  resetTier();
  clearGitmemDirCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const variantMetricWrites = () =>
  directUpsert.mock.calls.filter(([table]) => table === "variant_performance_metrics");

describe("hasVariants() is dev-only (GIT-106)", () => {
  it.each([
    ["free", false],
    ["pro", false],
    ["dev", true],
  ] as const)("%s tier → %s", (tier, expected) => {
    useTier(tier);
    expect(hasVariants()).toBe(expected);
  });
});

describe("recall: variant assignment and variant_performance_metrics (GIT-106)", () => {
  it("skips both on pro", async () => {
    useTier("pro");
    const result = await recall({ plan: "deploy to production" });

    expect(result.scars?.length ?? 0).toBeGreaterThan(0); // recall itself still works
    expect(getOrAssignVariant).not.toHaveBeenCalled();
    expect(variantMetricWrites()).toHaveLength(0);
  });

  it("runs both on dev (control)", async () => {
    useTier("dev");
    await recall({ plan: "deploy to production" });
    await new Promise((r) => setTimeout(r, 0)); // metrics write is fire-and-forget

    expect(getOrAssignVariant).toHaveBeenCalled();
    expect(variantMetricWrites().length).toBeGreaterThan(0);
  });
});

describe("create_learning: variant generation (GIT-106)", () => {
  const scar = {
    learning_type: "scar" as const,
    title: "Variant gating test scar",
    description: "A scar created to check that variant generation is tier-gated.",
    severity: "medium" as const,
    counter_arguments: ["You might think X — but Y", "Another counter"],
    project: "test-project",
  };

  it("does not generate variants on pro", async () => {
    useTier("pro");
    await createLearning(scar);
    expect(generateVariantsForScar).not.toHaveBeenCalled();
  });

  it("generates variants on dev (control)", async () => {
    useTier("dev");
    await createLearning(scar);
    expect(generateVariantsForScar).toHaveBeenCalledTimes(1);
  });
});
