/**
 * Tests for recall tool
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock external dependencies before importing the tool ---
//
// Factory defaults use plain arrow functions rather than
// `vi.fn().mockReturnValue(...)`. A `vi.fn()` built inside a hoisted
// `vi.mock` factory is subject to the suite-wide `clearMocks`/`restoreMocks`
// settings in vitest.config.ts, which strip the implementation and leave the
// mock returning `undefined`. For `hasSupabase()` that silently routes recall
// down its free-tier branch. Plain functions cannot be cleared.

// Mock the tier module to simulate pro/dev tier (Supabase available)
vi.mock("../../../src/services/tier.js", () => ({
  getTier: () => "pro",
  hasSupabase: () => true,
  hasVariants: () => false,
  hasMetrics: () => false,
  hasProInsights: () => false,
  hasCacheManagement: () => true,
  hasCompliance: () => false,
  hasTranscripts: () => false,
  hasBatchOperations: () => false,
  hasEmbeddings: () => true,
  hasAdvancedAgentDetection: () => false,
  hasMultiProject: () => false,
  hasEnforcementFields: () => false,
  getTablePrefix: () => "gitmem_",
  getTableName: (base: string) => `gitmem_${base}`,
}));

// Mock the supabase client
vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(),
  cachedScarSearch: vi.fn(), // now uses cached version
  upsertRecord: () => Promise.resolve(undefined), // For metrics recording
  directUpsert: () => Promise.resolve(undefined), // For variant metrics
  fetchRelatedTriples: () => Promise.resolve(new Map()),
  safeInFilter: (values: string[]) => values.join(","), // used by behavioral-decay
}));

// Force the Supabase branch — local vector search must report "not ready"
vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: () => false,
  localScarSearch: () => Promise.resolve([]),
}));

import { recall } from "../../../src/tools/recall.js";
import * as supabase from "../../../src/services/supabase-client.js";

describe("recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when Supabase not configured", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(false);

    const result = await recall({ plan: "deploy to production" });

    expect(result.activated).toBe(false);
    expect(result.formatted_response).toContain("not configured");
  });

  it("returns scars when found", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
      results: [
        {
          id: "test-scar-1",
          title: "Test Scar",
          description: "This is a test scar about deployment",
          severity: "high",
          counter_arguments: ["You might think it's easy", "You might skip testing"],
          applies_when: ["deploying", "releasing"],
          similarity: 0.85,
        },
      ],
      cache_hit: false,
    });

    const result = await recall({ plan: "deploy to production" });

    expect(result.activated).toBe(true);
    expect(result.scars).toHaveLength(1);
    expect(result.scars[0].title).toBe("Test Scar");
    expect(result.scars[0].severity).toBe("high");
    expect(result.scars[0].similarity).toBe(0.85);
    // Header pluralizes on count (nudge-variants.ts) — one scar reads "1 scar"
    expect(result.formatted_response).toContain("1 scar to review");
    expect(result.formatted_response).toContain("Test Scar");
  });

  it("returns empty when no scars found", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({ results: [], cache_hit: false });

    const result = await recall({ plan: "unique task with no history" });

    expect(result.activated).toBe(false);
    expect(result.scars).toHaveLength(0);
    expect(result.formatted_response).toContain("No relevant scars found");
    // Empty-state copy was rewritten in 4d02930 (signal-to-noise pass); the
    // old "new territory" phrasing is gone.
    expect(result.formatted_response).toContain("Scars accumulate as you work");
  });

  it("uses default project and match_count", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({ results: [], cache_hit: false });

    const result = await recall({ plan: "test plan" });

    expect(result.project).toBe("default");
    expect(result.match_count).toBe(3);
    expect(supabase.cachedScarSearch).toHaveBeenCalledWith("test plan", 3, "default");
  });

  it("respects custom project and match_count", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({ results: [], cache_hit: false });

    const result = await recall({
      plan: "custom project feature",
      project: "other-project",
      match_count: 5,
    });

    expect(result.project).toBe("other-project");
    expect(result.match_count).toBe(5);
    expect(supabase.cachedScarSearch).toHaveBeenCalledWith("custom project feature", 5, "other-project");
  });

  it("handles search errors gracefully", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockRejectedValue(new Error("Network error"));

    const result = await recall({ plan: "test plan" });

    expect(result.activated).toBe(false);
    expect(result.formatted_response).toContain("Error querying institutional memory");
    expect(result.formatted_response).toContain("Network error");
  });

  it("includes performance data", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({ results: [], cache_hit: false });

    const result = await recall({ plan: "test plan" });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.performance.target_ms).toBe(2000);
    expect(result.performance.meets_target).toBe(true);
    expect(result.performance.result_count).toBe(0);
  });

  it("includes memories_surfaced in performance when scars found", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
      results: [
        { id: "scar-1", title: "Test", description: "Test", severity: "high", similarity: 0.9 },
        { id: "scar-2", title: "Test 2", description: "Test 2", severity: "medium", similarity: 0.8 },
      ],
      cache_hit: true,
      cache_age_ms: 5000,
    });

    const result = await recall({ plan: "test plan", match_count: 2 });

    expect(result.performance.result_count).toBe(2);
    expect(result.performance.memories_surfaced).toEqual(["scar-1", "scar-2"]);
    expect(result.performance.similarity_scores).toEqual([0.9, 0.8]);
    expect(result.performance.cache_hit).toBe(true);
  });

  it("formats severity with correct emoji", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
      results: [
        { id: "1", title: "Critical Scar", description: "desc", severity: "critical", similarity: 0.9 },
        { id: "2", title: "High Scar", description: "desc", severity: "high", similarity: 0.8 },
        { id: "3", title: "Medium Scar", description: "desc", severity: "medium", similarity: 0.7 },
      ],
      cache_hit: false,
    });

    const result = await recall({ plan: "test", match_count: 3 });

    expect(result.formatted_response).toContain("[!!]");
    expect(result.formatted_response).toContain("[!]");
    expect(result.formatted_response).toContain("[~]");
  });

  it("includes cache_hit in performance data", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
      results: [],
      cache_hit: true,
      cache_age_ms: 12345,
    });

    const result = await recall({ plan: "test plan" });

    expect(result.performance.cache_hit).toBe(true);
    expect(result.performance.cache_age_ms).toBe(12345);
  });

});
