/**
 * Provenance & Citation Protocol Tests (OD-795)
 *
 * Verifies that all retrieval paths enforce citation rules and confidence tiers.
 * Root cause: AI agents retrieving institutional memory garble prose-embedded
 * metrics because there's no instruction to cite sources. This test suite
 * ensures the citation protocol is present across all four retrieval paths:
 *
 *   1. recall (primary retrieval)
 *   2. search (exploration)
 *   3. prepare_context full (sub-agent injection)
 *   4. formatCompact (compact sub-agent + hook auto-inject)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Part 1: format-utils (compact format) — no mocking needed
// ============================================================

import {
  formatCompact,
  formatGate,
  type FormattableScar,
} from "../../../src/hooks/format-utils.js";

function makeFormattableScar(overrides: Partial<FormattableScar> = {}): FormattableScar {
  return {
    id: "test-scar-001",
    title: "Test Scar",
    description: "Test description with a number 3.07. More text here.",
    severity: "medium",
    counter_arguments: [],
    similarity: 0.7,
    ...overrides,
  };
}

describe("formatCompact: citation protocol", () => {
  it("includes citation reminder when scars are present", () => {
    const scars = [makeFormattableScar()];
    const { payload } = formatCompact(scars, "test plan", 2000);

    expect(payload).toContain("Cite record IDs");
    expect(payload).toContain("factual claims");
  });

  it("does not include citation reminder when no scars match", () => {
    const { payload } = formatCompact([], "empty plan", 2000);

    // Empty scars = just the header, no citation line
    expect(payload).not.toContain("Cite record IDs");
  });

  it("citation reminder appears after all scar lines", () => {
    const scars = [
      makeFormattableScar({ id: "s1", title: "First Scar" }),
      makeFormattableScar({ id: "s2", title: "Second Scar" }),
    ];
    const { payload } = formatCompact(scars, "test", 2000);

    const lines = payload.split("\n");
    const citationLineIdx = lines.findIndex((l) => l.includes("Cite record IDs"));
    const lastScarLineIdx = lines.reduce(
      (max, line, idx) => (line.includes("MEDIUM") ? idx : max),
      -1
    );

    expect(citationLineIdx).toBeGreaterThan(lastScarLineIdx);
  });
});

describe("formatGate: no citation needed", () => {
  it("gate PASS format has no citation protocol (no factual claims)", () => {
    const { payload } = formatGate([]);
    expect(payload).not.toContain("CITATION");
    expect(payload).not.toContain("Cite record IDs");
  });

  it("gate BLOCK format has no citation protocol (operational only)", () => {
    const blocking = makeFormattableScar({
      required_verification: {
        when: "Before deploy",
        queries: ["SELECT 1"],
        must_show: "Result exists",
        blocking: true,
      },
    });
    const { payload } = formatGate([blocking]);
    expect(payload).not.toContain("CITATION");
    expect(payload).not.toContain("Cite record IDs");
  });
});

// ============================================================
// Part 2: search tool — requires mocking
// ============================================================

// Mock all search dependencies
vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(() => true),
  cachedScarSearch: vi.fn(() =>
    Promise.resolve({ results: [], cache_hit: false, cache_age_ms: undefined })
  ),
  fetchRelatedTriples: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: vi.fn(() => false),
  localScarSearch: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => true),
  hasVariants: vi.fn(() => false),
  hasMetrics: vi.fn(() => false),
  hasEmbeddings: vi.fn(() => true),
  getTableName: vi.fn((base: string) => `orchestra_${base}`),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: vi.fn(() => ({
    search: vi.fn(() => Promise.resolve([])),
    query: vi.fn(() => Promise.resolve([])),
  })),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("../../../src/services/session-state.js", () => ({
  getProject: vi.fn(() => "default"),
  getCurrentSession: vi.fn(() => null),
  addSurfacedScars: vi.fn(),
  setRecallCalled: vi.fn(),
}));

vi.mock("../../../src/services/agent-detection.js", () => ({
  getAgentIdentity: vi.fn(() => "cli"),
}));

vi.mock("../../../src/services/variant-assignment.js", () => ({
  getOrAssignVariant: vi.fn(() => Promise.resolve(null)),
  formatVariantEnforcement: vi.fn(() => ""),
}));

vi.mock("../../../src/services/behavioral-decay.js", () => ({
  fetchDismissalCounts: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getSessionPath: vi.fn(() => "/tmp/test-session"),
  getGitMemDir: vi.fn(() => "/tmp/.gitmem"),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-provenance"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { search } from "../../../src/tools/search.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { isLocalSearchReady } from "../../../src/services/local-vector-search.js";
import { getStorage } from "../../../src/services/storage.js";

function setupSearchRemote(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  vi.mocked(isLocalSearchReady).mockReturnValue(false);
  vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
    results: scars as any,
    cache_hit: false,
    cache_age_ms: undefined,
  });
}

function setupSearchFreeTier(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(false);
  vi.mocked(getStorage).mockReturnValue({
    search: vi.fn(() => Promise.resolve(scars)),
    query: vi.fn(() => Promise.resolve([])),
  } as any);
}

function makeSearchScar(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "search-scar-001",
    title: overrides.title ?? "Search test scar",
    description: overrides.description ?? "Description with metric 3.07 embedded.",
    severity: overrides.severity ?? "medium",
    learning_type: overrides.learning_type ?? "scar",
    counter_arguments: overrides.counter_arguments ?? [],
    similarity: overrides.similarity ?? 0.7,
    source_linear_issue: overrides.source_linear_issue ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search: citation protocol", () => {
  it("display includes CITATION RULE when results found (remote)", async () => {
    setupSearchRemote([makeSearchScar()]);

    const result = await search({ query: "EPS strategy" });

    expect(result.display).toContain("CITATION RULE");
    expect(result.display).toContain("cite the record ID");
    expect(result.display).toContain("not in institutional memory");
  });

  it("display includes CITATION RULE when results found (free tier)", async () => {
    setupSearchFreeTier([makeSearchScar()]);

    const result = await search({ query: "test query" });

    expect(result.display).toContain("CITATION RULE");
    expect(result.display).toContain("cite the record ID");
  });

  it("display omits CITATION RULE when no results", async () => {
    setupSearchRemote([]);

    const result = await search({ query: "nonexistent topic" });

    expect(result.display).not.toContain("CITATION RULE");
  });
});

describe("search: confidence tiers", () => {
  it("marks results below 0.55 similarity as [low confidence]", async () => {
    setupSearchRemote([
      makeSearchScar({ id: "strong", title: "Strong match", similarity: 0.72 }),
      makeSearchScar({ id: "weak", title: "Weak match", similarity: 0.49 }),
    ]);

    const result = await search({ query: "test confidence" });

    expect(result.display).toContain("[low confidence]");
    // The strong match (0.72) should NOT have low confidence tag
    // Check that the display contains the strong match without low confidence nearby
    const lines = result.display!.split("\n");
    const strongLine = lines.find((l) => l.includes("Strong match"));
    const weakLine = lines.find((l) => l.includes("Weak match"));

    expect(weakLine).toContain("[low confidence]");
    // Strong match line should NOT contain low confidence
    expect(strongLine).not.toContain("[low confidence]");
  });

  it("does not mark results at exactly 0.55 as low confidence", async () => {
    setupSearchRemote([
      makeSearchScar({ id: "boundary", title: "Boundary match", similarity: 0.55 }),
    ]);

    const result = await search({ query: "boundary test" });

    expect(result.display).not.toContain("[low confidence]");
  });

  it("marks results at 0.54 as low confidence", async () => {
    setupSearchRemote([
      makeSearchScar({ id: "just-below", title: "Just below", similarity: 0.54 }),
    ]);

    const result = await search({ query: "threshold test" });

    expect(result.display).toContain("[low confidence]");
  });
});

// ============================================================
// Part 3: prepare_context — uses existing mock setup
// ============================================================

import { prepareContext } from "../../../src/tools/prepare-context.js";

function setupPrepareRemote(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  vi.mocked(isLocalSearchReady).mockReturnValue(false);
  vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
    results: scars as any,
    cache_hit: false,
    cache_age_ms: undefined,
  });
}

function makePrepareContextScar(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "pc-scar-001",
    title: overrides.title ?? "Prepare context scar",
    description: overrides.description ?? "Metric embedded: edge 3.07. Details here.",
    severity: overrides.severity ?? "medium",
    counter_arguments: overrides.counter_arguments ?? [],
    similarity: overrides.similarity ?? 0.65,
    source_linear_issue: overrides.source_linear_issue ?? null,
    required_verification: overrides.required_verification ?? undefined,
    why_this_matters: overrides.why_this_matters ?? undefined,
    action_protocol: overrides.action_protocol ?? undefined,
    self_check_criteria: overrides.self_check_criteria ?? undefined,
  };
}

describe("prepare_context full: citation protocol", () => {
  it("includes CITATION RULE in full format output", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "review deployment metrics",
      format: "full",
    });

    expect(result.memory_payload).toContain("CITATION RULE");
    expect(result.memory_payload).toContain("cite the record ID");
    expect(result.memory_payload).toContain("not in institutional memory");
  });

  it("includes example with record ID format in full output", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "check edge metrics",
      format: "full",
    });

    // The example shows how to properly cite: [id:48ebca14]
    expect(result.memory_payload).toContain("[id:48ebca14]");
    expect(result.memory_payload).toContain("not paraphrased numbers");
  });

  it("omits CITATION RULE when no scars found (full format)", async () => {
    setupPrepareRemote([]);

    const result = await prepareContext({
      plan: "no matching scars",
      format: "full",
    });

    expect(result.memory_payload).not.toContain("CITATION RULE");
    expect(result.memory_payload).toContain("no relevant scars");
  });

  it("citation protocol appears before results (before 'Acknowledge these lessons')", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "test ordering",
      format: "full",
    });

    const payload = result.memory_payload;
    const ackIdx = payload.indexOf("Acknowledge these lessons");
    const citationIdx = payload.indexOf("CITATION RULE");

    expect(ackIdx).toBeGreaterThan(-1);
    expect(citationIdx).toBeGreaterThan(-1);
    expect(citationIdx).toBeLessThan(ackIdx);
  });
});

describe("prepare_context compact: citation protocol", () => {
  it("includes citation reminder in compact format", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "deploy to production",
      format: "compact",
    });

    expect(result.memory_payload).toContain("Cite record IDs");
  });

  it("compact citation is concise (one line)", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "compact test",
      format: "compact",
    });

    const lines = result.memory_payload.split("\n");
    const citationLines = lines.filter((l) => l.includes("Cite record IDs"));
    expect(citationLines).toHaveLength(1);
  });
});

describe("prepare_context gate: no citation needed", () => {
  it("gate format does not include citation protocol", async () => {
    setupPrepareRemote([
      makePrepareContextScar({
        required_verification: {
          when: "Before deploy",
          queries: ["SELECT 1"],
          must_show: "OK",
          blocking: true,
        },
      }),
    ]);

    const result = await prepareContext({
      plan: "deploy with gate",
      format: "gate",
    });

    expect(result.memory_payload).not.toContain("CITATION");
    expect(result.memory_payload).not.toContain("Cite record IDs");
  });
});

// ============================================================
// Part 4: recall — test through the exported function
// ============================================================

import { recall } from "../../../src/tools/recall.js";

function setupRecallRemote(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(true);
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  vi.mocked(isLocalSearchReady).mockReturnValue(false);
  vi.mocked(supabase.cachedScarSearch).mockResolvedValue({
    results: scars as any,
    cache_hit: false,
    cache_age_ms: undefined,
  });
}

function setupRecallFreeTier(scars: unknown[]) {
  vi.mocked(hasSupabase).mockReturnValue(false);
  vi.mocked(getStorage).mockReturnValue({
    search: vi.fn(() => Promise.resolve(scars)),
    query: vi.fn(() => Promise.resolve([])),
  } as any);
}

function makeRecallScar(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "recall-scar-001",
    title: overrides.title ?? "Recall test scar",
    description: overrides.description ?? "Description with edge metric 3.07 embedded.",
    severity: overrides.severity ?? "medium",
    counter_arguments: overrides.counter_arguments ?? [],
    applies_when: overrides.applies_when ?? [],
    similarity: overrides.similarity ?? 0.7,
    source_linear_issue: overrides.source_linear_issue ?? null,
    learning_type: overrides.learning_type ?? "scar",
  };
}

describe("recall: citation protocol", () => {
  it("display includes CITATION RULE when scars found (remote)", async () => {
    setupRecallRemote([makeRecallScar()]);

    const result = await recall({ plan: "deploy edge function" });

    expect(result.display).toContain("CITATION RULE");
    expect(result.display).toContain("cite the record ID");
    expect(result.display).toContain("not in institutional memory");
  });

  it("display includes example with [id:] format", async () => {
    setupRecallRemote([makeRecallScar()]);

    const result = await recall({ plan: "check metrics" });

    expect(result.display).toContain("[id:48ebca14]");
    expect(result.display).toContain("not paraphrased numbers");
  });

  it("display includes CITATION RULE (free tier)", async () => {
    setupRecallFreeTier([makeRecallScar()]);

    const result = await recall({ plan: "free tier recall test" });

    expect(result.display).toContain("CITATION RULE");
  });

  it("display omits CITATION RULE when no scars found", async () => {
    setupRecallRemote([]);

    const result = await recall({ plan: "no matching scars here" });

    expect(result.display).not.toContain("CITATION RULE");
  });

  it("citation protocol appears before results (before 'Acknowledge these lessons')", async () => {
    setupRecallRemote([makeRecallScar()]);

    const result = await recall({ plan: "test ordering" });

    const display = result.display!;
    const ackIdx = display.indexOf("Acknowledge these lessons");
    const citationIdx = display.indexOf("CITATION RULE");

    expect(ackIdx).toBeGreaterThan(-1);
    expect(citationIdx).toBeGreaterThan(-1);
    expect(citationIdx).toBeLessThan(ackIdx);
  });
});

describe("recall: confidence tiers", () => {
  it("marks scars below 0.55 similarity as [low confidence]", async () => {
    setupRecallRemote([
      makeRecallScar({ id: "strong-r", title: "Strong recall", similarity: 0.68 }),
      makeRecallScar({ id: "weak-r", title: "Weak recall", similarity: 0.48 }),
    ]);

    const result = await recall({ plan: "confidence test" });

    const display = result.display!;
    const lines = display.split("\n");

    const strongLine = lines.find((l) => l.includes("Strong recall"));
    const weakLine = lines.find((l) => l.includes("Weak recall"));

    expect(weakLine).toContain("[low confidence]");
    expect(strongLine).not.toContain("[low confidence]");
  });

  it("does not mark scars at exactly 0.55 as low confidence", async () => {
    setupRecallRemote([
      makeRecallScar({ id: "exact", title: "Exact boundary", similarity: 0.55 }),
    ]);

    const result = await recall({ plan: "boundary test" });

    expect(result.display).not.toContain("[low confidence]");
  });
});

// ============================================================
// Part 5: Cross-cutting provenance guarantees
// ============================================================

describe("provenance: separator consistency", () => {
  it("citation protocol uses consistent separator across all full-format paths", async () => {
    const SEPARATOR = "───────────────────────────────────────────────────";

    // Search
    setupSearchRemote([makeSearchScar()]);
    const searchResult = await search({ query: "separator test" });
    expect(searchResult.display).toContain(SEPARATOR);

    // Recall
    setupRecallRemote([makeRecallScar()]);
    const recallResult = await recall({ plan: "separator test" });
    expect(recallResult.display).toContain(SEPARATOR);

    // Prepare context full
    setupPrepareRemote([makePrepareContextScar()]);
    const pcResult = await prepareContext({ plan: "separator test", format: "full" });
    expect(pcResult.memory_payload).toContain(SEPARATOR);
  });
});

describe("provenance: citation text consistency", () => {
  it("all paths use the same citation rule text", async () => {
    const CITATION_TEXT = "CITATION RULE: When referencing facts from these";

    // Search
    setupSearchRemote([makeSearchScar()]);
    const searchResult = await search({ query: "consistency" });
    expect(searchResult.display).toContain(CITATION_TEXT);

    // Recall
    setupRecallRemote([makeRecallScar()]);
    const recallResult = await recall({ plan: "consistency" });
    expect(recallResult.display).toContain(CITATION_TEXT);

    // Prepare context full
    setupPrepareRemote([makePrepareContextScar()]);
    const pcResult = await prepareContext({ plan: "consistency", format: "full" });
    expect(pcResult.memory_payload).toContain(CITATION_TEXT);
  });
});
