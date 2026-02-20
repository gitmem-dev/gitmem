/**
 * Unit tests for prepare_context tool
 *
 * Tests the three format modes (full, compact, gate), token budgets,
 * severity sorting, error handling, and performance data.
 *
 * Strategy: Mock all external dependencies (supabase, local-vector-search,
 * tier, storage, metrics) and test through the exported prepareContext function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all external dependencies before importing the tool ---

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(() => true),
  cachedScarSearch: vi.fn(() =>
    Promise.resolve({ results: [], cache_hit: false, cache_age_ms: undefined })
  ),
}));

vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: vi.fn(() => false),
  localScarSearch: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => true),
  getTableName: vi.fn((base: string) => `orchestra_${base}`),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: vi.fn(() => ({
    search: vi.fn(() => Promise.resolve([])),
  })),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

import { prepareContext } from "../../../src/tools/prepare-context.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { isLocalSearchReady, localScarSearch } from "../../../src/services/local-vector-search.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { getStorage } from "../../../src/services/storage.js";

// --- Test fixtures ---

function makeScar(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "scar-001",
    title: overrides.title ?? "Test scar title",
    description: overrides.description ?? "Test scar description. Second sentence here.",
    severity: overrides.severity ?? "medium",
    counter_arguments: overrides.counter_arguments ?? [],
    similarity: overrides.similarity ?? 0.5,
    source_linear_issue: overrides.source_linear_issue ?? null,
    required_verification: overrides.required_verification ?? undefined,
    why_this_matters: overrides.why_this_matters ?? undefined,
    action_protocol: overrides.action_protocol ?? undefined,
    self_check_criteria: overrides.self_check_criteria ?? undefined,
  };
}

const MIXED_SEVERITY_SCARS = [
  makeScar({ id: "s1", title: "Low scar", severity: "low", similarity: 0.3 }),
  makeScar({ id: "s2", title: "Critical scar", severity: "critical", similarity: 0.8 }),
  makeScar({ id: "s3", title: "High scar", severity: "high", similarity: 0.6 }),
  makeScar({ id: "s4", title: "Medium scar", severity: "medium", similarity: 0.4 }),
];

const BLOCKING_SCAR = makeScar({
  id: "blocking-1",
  title: "Must verify before deploy",
  severity: "critical",
  required_verification: {
    when: "Before modifying production",
    queries: ["SELECT count(*) FROM important_table"],
    must_show: "Row count before proceeding",
    blocking: true,
  },
});

// --- Helper to set up mocks for remote search ---

function setupRemoteSearch(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  vi.mocked(isLocalSearchReady).mockReturnValue(false);
  vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
    results: scars as any,
    cache_hit: false,
    cache_age_ms: undefined,
  });
}

function setupLocalSearch(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  vi.mocked(isLocalSearchReady).mockReturnValue(true);
  vi.mocked(localScarSearch).mockResolvedValue(scars as any);
}

function setupFreeTier(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(false);
  vi.mocked(getStorage).mockReturnValue({
    search: vi.fn(() => Promise.resolve(scars)),
  } as any);
}

function setupNotConfigured() {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(false);
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepare_context: compact format", () => {
  it("produces correct structure with header and one line per scar", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "review auth middleware",
      format: "compact",
    });

    expect(result.format).toBe("compact");
    expect(result.memory_payload).toContain("[INSTITUTIONAL MEMORY");
    expect(result.memory_payload).toContain("review auth middleware");
    expect(result.scars_included).toBe(4);
  });

  it("sorts scars by severity (critical first)", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "test severity sorting",
      format: "compact",
    });

    const lines = result.memory_payload.split("\n");
    // Line 0 is header, line 1 should be critical, line 2 high, etc.
    expect(lines[1]).toContain("CRITICAL");
    expect(lines[2]).toContain("HIGH");
    expect(lines[3]).toContain("MEDIUM");
    expect(lines[4]).toContain("LOW");
  });

  it("uses correct severity emojis", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "test emojis",
      format: "compact",
    });

    expect(result.memory_payload).toContain("[!!] CRITICAL");
    expect(result.memory_payload).toContain("[!] HIGH");
    expect(result.memory_payload).toContain("[~] MEDIUM");
    expect(result.memory_payload).toContain("[-] LOW");
  });

  it("truncates to token budget", async () => {
    // Create scars with long descriptions to exceed a small budget
    const verboseScars = Array.from({ length: 5 }, (_, i) =>
      makeScar({
        id: `verbose-${i}`,
        title: `Verbose scar number ${i} with a longer title`,
        description: "A".repeat(200) + ". More text after.",
        severity: "medium",
      })
    );

    setupRemoteSearch(verboseScars);

    const result = await prepareContext({
      plan: "test truncation",
      format: "compact",
      max_tokens: 150,
    });

    // Should include fewer than all 5 scars due to budget
    expect(result.scars_included).toBeLessThan(5);
    // But always at least 1
    expect(result.scars_included).toBeGreaterThanOrEqual(1);
    // Token estimate should be near or under budget
    expect(result.token_estimate).toBeLessThanOrEqual(200); // some tolerance for header
  });

  it("always includes at least one scar even if over budget", async () => {
    const longScar = makeScar({
      title: "Very long title ".repeat(20),
      description: "Very long description ".repeat(50),
    });

    setupRemoteSearch([longScar]);

    const result = await prepareContext({
      plan: "test minimum inclusion",
      format: "compact",
      max_tokens: 10, // impossibly small
    });

    expect(result.scars_included).toBe(1);
  });
});

describe("prepare_context: gate format", () => {
  it("returns PASS when no blocking scars", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS); // none have blocking: true

    const result = await prepareContext({
      plan: "deploy edge function",
      format: "gate",
    });

    expect(result.format).toBe("gate");
    expect(result.memory_payload).toBe("[MEMORY GATE: PASS — no blocking scars]");
    expect(result.scars_included).toBe(0);
    expect(result.blocking_scars).toBe(0);
  });

  it("returns BLOCK with details when blocking scars present", async () => {
    setupRemoteSearch([...MIXED_SEVERITY_SCARS, BLOCKING_SCAR]);

    const result = await prepareContext({
      plan: "modify production database",
      format: "gate",
    });

    expect(result.memory_payload).toContain("MEMORY GATE:");
    expect(result.memory_payload).toContain("1 blocking scar");
    expect(result.memory_payload).toContain("[!!] BLOCK");
    expect(result.memory_payload).toContain("Before modifying production");
    expect(result.memory_payload).toContain("SELECT count(*)");
    expect(result.memory_payload).toContain("MUST SHOW");
    expect(result.scars_included).toBe(1);
    expect(result.blocking_scars).toBe(1);
  });

  it("handles multiple blocking scars", async () => {
    const blocking2 = makeScar({
      id: "blocking-2",
      title: "Must check auth",
      severity: "high",
      required_verification: {
        when: "Before auth changes",
        queries: ["SELECT count(*) FROM auth.users"],
        must_show: "User count",
        blocking: true,
      },
    });

    setupRemoteSearch([BLOCKING_SCAR, blocking2]);

    const result = await prepareContext({
      plan: "modify auth and production",
      format: "gate",
    });

    expect(result.memory_payload).toContain("2 blocking scars");
    expect(result.blocking_scars).toBe(2);
    expect(result.scars_included).toBe(2);
  });
});

describe("prepare_context: full format", () => {
  it("produces rich markdown with header", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "review code for security",
      format: "full",
    });

    expect(result.format).toBe("full");
    expect(result.memory_payload).toContain("scars to review");
    expect(result.memory_payload).toContain("Acknowledge these lessons before proceeding.");
    expect(result.scars_included).toBe(4);
  });

  it("includes counter arguments when present", async () => {
    const scarWithCounters = makeScar({
      counter_arguments: [
        "You might think X — but Y",
        "You might assume A — but B",
      ],
    });

    setupRemoteSearch([scarWithCounters]);

    const result = await prepareContext({
      plan: "test counter args",
      format: "full",
    });

    expect(result.memory_payload).toContain("You might think");
    expect(result.memory_payload).toContain("You might assume");
  });

  it("includes enriched scar fields when present", async () => {
    const enrichedScar = makeScar({
      why_this_matters: "This is critically important because...",
      action_protocol: ["Step 1: do X", "Step 2: do Y"],
      self_check_criteria: ["Is X done?", "Is Y verified?"],
    });

    setupRemoteSearch([enrichedScar]);

    const result = await prepareContext({
      plan: "test enriched fields",
      format: "full",
    });

    expect(result.memory_payload).toContain("Why this matters:");
    expect(result.memory_payload).toContain("Action Protocol:");
    expect(result.memory_payload).toContain("Step 1: do X");
    expect(result.memory_payload).toContain("Self-Check:");
    expect(result.memory_payload).toContain("Is X done?");
  });

  it("handles empty results gracefully", async () => {
    setupRemoteSearch([]);

    const result = await prepareContext({
      plan: "something with no matching scars",
      format: "full",
    });

    expect(result.memory_payload).toContain("no relevant scars");
    expect(result.memory_payload).toContain("Proceed with caution");
    expect(result.scars_included).toBe(0);
  });

  it("includes blocking verification section when present", async () => {
    setupRemoteSearch([BLOCKING_SCAR, ...MIXED_SEVERITY_SCARS]);

    const result = await prepareContext({
      plan: "modify production",
      format: "full",
    });

    expect(result.memory_payload).toContain("VERIFICATION REQUIRED");
    expect(result.memory_payload).toContain("YOU MUST RUN:");
    expect(result.memory_payload).toContain("SELECT count(*)");
    expect(result.blocking_scars).toBe(1);
  });
});

describe("prepare_context: Supabase not configured", () => {
  it("returns graceful fallback when Supabase not configured", async () => {
    setupNotConfigured();

    const result = await prepareContext({
      plan: "test without supabase",
      format: "compact",
    });

    expect(result.memory_payload).toContain("not configured");
    expect(result.scars_included).toBe(0);
    expect(result.blocking_scars).toBe(0);
    expect(result.format).toBe("compact");
  });
});

describe("prepare_context: free tier local search", () => {
  it("uses storage.search when hasSupabase is false", async () => {
    const freeTierScars = [
      makeScar({ id: "free-1", title: "Free tier scar", severity: "high" }),
    ];
    setupFreeTier(freeTierScars);

    const result = await prepareContext({
      plan: "test free tier path",
      format: "compact",
    });

    expect(result.scars_included).toBe(1);
    expect(result.memory_payload).toContain("Free tier scar");
    // Should NOT call supabase
    expect(supabase.cachedScarSearch).not.toHaveBeenCalled();
  });

  it("returns error payload when free tier search fails", async () => {
    vi.mocked(hasSupabase).mockReturnValue(false);
    vi.mocked(getStorage).mockReturnValue({
      search: vi.fn(() => Promise.reject(new Error("disk full"))),
    } as any);

    const result = await prepareContext({
      plan: "test free tier error",
      format: "full",
    });

    expect(result.memory_payload).toContain("error loading scars");
    expect(result.scars_included).toBe(0);
  });
});

describe("prepare_context: local vector search path", () => {
  it("uses localScarSearch when local cache is ready", async () => {
    const localScars = [
      makeScar({ id: "local-1", title: "Local cached scar", severity: "medium", similarity: 0.6 }),
    ];
    setupLocalSearch(localScars);

    const result = await prepareContext({
      plan: "test local search",
      format: "compact",
    });

    expect(localScarSearch).toHaveBeenCalledWith("test local search", 5, "default");
    expect(supabase.cachedScarSearch).not.toHaveBeenCalled();
    expect(result.scars_included).toBe(1);
    expect(result.performance.search_mode).toBe("local");
    expect(result.performance.cache_hit).toBe(true);
  });
});

describe("prepare_context: performance data", () => {
  it("includes performance data in compact response", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "test perf compact",
      format: "compact",
    });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.performance.meets_target).toBe("boolean");
    expect(result.performance.result_count).toBe(4);
  });

  it("includes performance data in gate response", async () => {
    setupRemoteSearch([]);

    const result = await prepareContext({
      plan: "test perf gate",
      format: "gate",
    });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("includes performance data in full response", async () => {
    setupRemoteSearch(MIXED_SEVERITY_SCARS);

    const result = await prepareContext({
      plan: "test perf full",
      format: "full",
    });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.performance.result_count).toBe(4);
  });

  it("includes performance data in error responses", async () => {
    setupNotConfigured();

    const result = await prepareContext({
      plan: "test perf error",
      format: "compact",
    });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("prepare_context: default max_tokens per format", () => {
  it("defaults compact to 500 tokens", async () => {
    // Create enough scars that a 500 token budget matters
    const scars = Array.from({ length: 10 }, (_, i) =>
      makeScar({ id: `tok-${i}`, title: `Scar ${i}`, severity: "medium" })
    );
    setupRemoteSearch(scars);

    const result = await prepareContext({
      plan: "test default compact tokens",
      format: "compact",
      // no max_tokens — should default to 500
    });

    // Token estimate should be reasonable for compact format
    expect(result.token_estimate).toBeLessThanOrEqual(600); // 500 + header tolerance
  });

  it("gate format has minimal token output", async () => {
    setupRemoteSearch([]); // PASS case

    const result = await prepareContext({
      plan: "test gate tokens",
      format: "gate",
    });

    // Gate PASS is very small
    expect(result.token_estimate).toBeLessThan(50);
  });

  it("full format has no token limit", async () => {
    const scars = Array.from({ length: 5 }, (_, i) =>
      makeScar({
        id: `full-${i}`,
        title: `Full scar ${i}`,
        description: "Long description. ".repeat(20),
        severity: "medium",
        counter_arguments: ["Counter 1", "Counter 2"],
      })
    );
    setupRemoteSearch(scars);

    const result = await prepareContext({
      plan: "test full no limit",
      format: "full",
    });

    // Full format includes all scars regardless of token count
    expect(result.scars_included).toBe(5);
  });
});

describe("prepare_context: search error handling", () => {
  it("returns error payload when remote search throws", async () => {
    vi.mocked(hasSupabase).mockReturnValue(true);
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(isLocalSearchReady).mockReturnValue(false);
    vi.mocked(supabase.cachedScarSearch).mockRejectedValue(new Error("network timeout"));

    const result = await prepareContext({
      plan: "test search error",
      format: "compact",
    });

    expect(result.memory_payload).toContain("error");
    expect(result.memory_payload).toContain("network timeout");
    expect(result.scars_included).toBe(0);
    expect(result.performance).toBeDefined();
  });
});

describe("prepare_context: project parameter", () => {
  it("defaults to 'default' project", async () => {
    setupLocalSearch([]);

    await prepareContext({
      plan: "test default project",
      format: "compact",
    });

    expect(isLocalSearchReady).toHaveBeenCalledWith("default");
  });

  it("passes custom project through", async () => {
    setupLocalSearch([]);

    await prepareContext({
      plan: "test custom project",
      format: "compact",
      project: "other-project",
    });

    expect(isLocalSearchReady).toHaveBeenCalledWith("other-project");
  });
});

describe("prepare_context: token_estimate accuracy", () => {
  it("token_estimate increases with more content", async () => {
    setupRemoteSearch([makeScar()]);
    const small = await prepareContext({ plan: "x", format: "compact" });

    const manyScars = Array.from({ length: 5 }, (_, i) =>
      makeScar({ id: `est-${i}`, title: `Estimation scar ${i}` })
    );
    setupRemoteSearch(manyScars);
    const large = await prepareContext({ plan: "x", format: "full" });

    expect(large.token_estimate).toBeGreaterThan(small.token_estimate);
  });
});
