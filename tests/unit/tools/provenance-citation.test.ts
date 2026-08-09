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
import { CITATION_LINE } from "../../../src/services/display-protocol.js";

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
  it("emits the shared citation rule when scars are present", () => {
    const scars = [makeFormattableScar()];
    const { payload } = formatCompact(scars, "test plan", 2000);

    // GIT-74/R14: this surface carried the fourth un-unified literal
    // ("Cite record IDs for any factual claims from these scars."). It now
    // imports the one constant like the other three, so the assertion moves
    // off the prose and onto the constant.
    expect(payload).toContain(CITATION_LINE);
  });

  it("renders a citable record id for every scar", () => {
    // GIT-74/R14: instruction and capability travel together. This payload
    // tells a sub-agent to cite record IDs, so it must carry them.
    const scars = [
      makeFormattableScar({ id: "eeeeeeee-1111-2222-3333-444444444444", title: "First" }),
      makeFormattableScar({ id: "ffffffff-5555-6666-7777-888888888888", title: "Second" }),
    ];
    const { payload } = formatCompact(scars, "test plan", 2000);

    expect(payload).toContain("id:eeeeeeee");
    expect(payload).toContain("id:ffffffff");
  });

  it("does not include citation reminder when no scars match", () => {
    const { payload } = formatCompact([], "empty plan", 2000);

    // Empty scars = just the header, no citation line
    expect(payload).not.toContain(CITATION_LINE);
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
  hasProInsights: () => false,
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
  // GIT-93: recall records/clears a retrieval-failure marker so confirm_scars
  // can tell "found nothing" from "never reached the store".
  setRecallFailure: vi.fn(),
  clearRecallFailure: vi.fn(),
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
  it("emits the shared citation rule when results found (remote)", async () => {
    setupSearchRemote([makeSearchScar()]);

    const result = await search({ query: "EPS strategy" });

    // Invariant, not prose: whatever CITATION_LINE says, search emits it.
    expect(result.display).toContain(CITATION_LINE);
  });

  it("emits the shared citation rule when results found (free tier)", async () => {
    setupSearchFreeTier([makeSearchScar()]);

    const result = await search({ query: "test query" });

    expect(result.display).toContain(CITATION_LINE);
  });

  it("renders a citable record id for every result", async () => {
    // The citation rule is only honourable if the ids it asks for are on the
    // page. Assert the rendered id-form, not the worked example that used to
    // sit inside the rule text.
    setupSearchRemote([
      makeSearchScar({ id: "aaaaaaaa-1111-2222-3333-444444444444", title: "First" }),
      makeSearchScar({ id: "bbbbbbbb-5555-6666-7777-888888888888", title: "Second" }),
    ]);

    const result = await search({ query: "citable ids" });

    expect(result.display).toContain("id:aaaaaaaa");
    expect(result.display).toContain("id:bbbbbbbb");
  });

  it("display omits CITATION RULE when no results", async () => {
    setupSearchRemote([]);

    const result = await search({ query: "nonexistent topic" });

    expect(result.display).not.toContain(CITATION_LINE);
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

    // Invariant, not prose: the payload carries the shared constant verbatim.
    expect(result.memory_payload).toContain(CITATION_LINE);
  });

  it("emits the citation rule exactly once, as the shared constant", async () => {
    setupPrepareRemote([makePrepareContextScar()]);

    const result = await prepareContext({
      plan: "check edge metrics",
      format: "full",
    });

    // prepare_context is the sub-agent injection path, so it pushes the rule
    // without ANSI dimming while recall/search dim it. The *text* must still be
    // the one constant — this is the assertion that would have caught the
    // original three-way drift, which the old shared-prefix check did not.
    const payload = result.memory_payload;
    const occurrences = payload.split(CITATION_LINE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders a citable record id for every scar", async () => {
    // GIT-74/R14: this surface instructed citation while rendering no ids at
    // all — it commanded the impossible, and the predictable failure mode is
    // fabricated or absent citations from sub-agents. Ids now travel with the
    // scars, and this is the test that keeps them there.
    setupPrepareRemote([
      makePrepareContextScar({ id: "12345678-1111-2222-3333-444444444444", title: "First" }),
      makePrepareContextScar({ id: "87654321-5555-6666-7777-888888888888", title: "Second" }),
    ]);

    const result = await prepareContext({ plan: "citable ids", format: "full" });

    expect(result.memory_payload).toContain("id:12345678");
    expect(result.memory_payload).toContain("id:87654321");
  });

  it("omits CITATION RULE when no scars found (full format)", async () => {
    setupPrepareRemote([]);

    const result = await prepareContext({
      plan: "no matching scars",
      format: "full",
    });

    expect(result.memory_payload).not.toContain(CITATION_LINE);
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
    const citationIdx = payload.indexOf(CITATION_LINE);

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
    why_this_matters: overrides.why_this_matters ?? undefined,
    similarity: overrides.similarity ?? 0.7,
    source_linear_issue: overrides.source_linear_issue ?? null,
    learning_type: overrides.learning_type ?? "scar",
  };
}

describe("recall: citation protocol", () => {
  it("display includes CITATION RULE when scars found (remote)", async () => {
    setupRecallRemote([makeRecallScar()]);

    const result = await recall({ plan: "deploy edge function" });

    // Invariant, not prose: whatever CITATION_LINE says, recall emits it.
    expect(result.display).toContain(CITATION_LINE);
  });

  it("renders a citable record id for every scar", async () => {
    // Replaces the assertion on the retired worked example ("[id:48ebca14]").
    // What actually has to hold is that each surfaced scar carries the id an
    // agent is being told to cite, in the documented 8-char id: form.
    setupRecallRemote([
      makeRecallScar({ id: "cccccccc-1111-2222-3333-444444444444", title: "First" }),
      makeRecallScar({ id: "dddddddd-5555-6666-7777-888888888888", title: "Second" }),
    ]);

    const result = await recall({ plan: "check metrics" });

    expect(result.display).toContain("id:cccccccc");
    expect(result.display).toContain("id:dddddddd");
  });

  it("display includes CITATION RULE (free tier)", async () => {
    setupRecallFreeTier([makeRecallScar()]);

    const result = await recall({ plan: "free tier recall test" });

    expect(result.display).toContain(CITATION_LINE);
  });

  it("display omits CITATION RULE when no scars found", async () => {
    setupRecallRemote([]);

    const result = await recall({ plan: "no matching scars here" });

    expect(result.display).not.toContain(CITATION_LINE);
  });

  it("citation protocol appears before results (before 'Acknowledge these lessons')", async () => {
    setupRecallRemote([makeRecallScar()]);

    const result = await recall({ plan: "test ordering" });

    const display = result.display!;
    const ackIdx = display.indexOf("Acknowledge these lessons");
    const citationIdx = display.indexOf(CITATION_LINE);

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

  // GIT-49: stub low-confidence scars (< 0.55) — header only, skip the heavy body
  it("stubs sub-0.55 scars: header shown but description and counter_arguments omitted", async () => {
    setupRecallRemote([
      makeRecallScar({
        id: "weak-stub",
        title: "Weak stub scar",
        similarity: 0.5,
        description: "UNIQUE_STUB_BODY_should_be_omitted_for_low_confidence",
        counter_arguments: ["UNIQUE_STUB_COUNTERARG_should_be_omitted"],
      }),
    ]);

    const result = await recall({ plan: "stub test" });
    const display = result.display!;

    // Scar stays visible + confirmable: title and the tag still render
    expect(display).toContain("Weak stub scar");
    expect(display).toContain("[low confidence]");
    // Heavy body is skipped
    expect(display).not.toContain("UNIQUE_STUB_BODY_should_be_omitted_for_low_confidence");
    expect(display).not.toContain("UNIQUE_STUB_COUNTERARG_should_be_omitted");
    expect(display).not.toContain("You might think");
  });

  // GIT-74/R11 replaced the flat "stub below 0.55, full body at or above it"
  // split with four bands. The old assertion (full description at 0.7) now
  // encodes a rule that no longer exists, so it is replaced by the band table
  // itself, read off LOW_CONFIDENCE_THRESHOLD / EXTENDED_THRESHOLD rather than
  // restated as literals.
  //
  //   stub      < 0.55                  header only
  //   compact   0.55 – 0.75             + why_this_matters / applies_when
  //   extended  >= 0.75 OR the top hit  + first counter-argument
  //   full      blocking verification   + description
  //
  // NOTE: the top hit is escalated to extended regardless of score, so a
  // single-scar fixture can never exercise the compact band. Each band test
  // below therefore pins a decoy top hit above the scar under test.
  it("compact band (0.55–0.75, not top hit): lesson fields render, counter-arguments do not", async () => {
    setupRecallRemote([
      makeRecallScar({ id: "top-hit-decoy", title: "Decoy top hit", similarity: 0.9 }),
      makeRecallScar({
        id: "compact-band",
        title: "Compact band scar",
        similarity: 0.7,
        description: "UNIQUE_COMPACT_DESCRIPTION_must_not_render",
        why_this_matters: "UNIQUE_COMPACT_WHY_must_render",
        applies_when: ["UNIQUE_COMPACT_APPLIES_must_render"],
        counter_arguments: ["UNIQUE_COMPACT_COUNTERARG_must_not_render"],
      }),
    ]);

    const display = (await recall({ plan: "compact band test" })).display!;

    expect(display).toContain("Compact band scar");
    expect(display).toContain("UNIQUE_COMPACT_WHY_must_render");
    expect(display).toContain("UNIQUE_COMPACT_APPLIES_must_render");
    // The heavy fields belong to deeper bands only.
    expect(display).not.toContain("UNIQUE_COMPACT_DESCRIPTION_must_not_render");
    expect(display).not.toContain("UNIQUE_COMPACT_COUNTERARG_must_not_render");
    expect(display).not.toContain("[low confidence]");
  });

  it("extended band (>=0.75): adds the first counter-argument", async () => {
    setupRecallRemote([
      makeRecallScar({ id: "top-hit-decoy", title: "Decoy top hit", similarity: 0.95 }),
      makeRecallScar({
        id: "extended-band",
        title: "Extended band scar",
        similarity: 0.8,
        why_this_matters: "UNIQUE_EXTENDED_WHY_must_render",
        counter_arguments: [
          "UNIQUE_EXTENDED_COUNTERARG_first_must_render",
          "UNIQUE_EXTENDED_COUNTERARG_second_must_not_render",
        ],
      }),
    ]);

    const display = (await recall({ plan: "extended band test" })).display!;

    expect(display).toContain("UNIQUE_EXTENDED_WHY_must_render");
    expect(display).toContain("You might think");
    expect(display).toContain("UNIQUE_EXTENDED_COUNTERARG_first_must_render");
    // "first counter-argument", singular — the band is capped, not unbounded.
    expect(display).not.toContain("UNIQUE_EXTENDED_COUNTERARG_second_must_not_render");
  });

  it("the top hit is escalated to extended even below the extended threshold", async () => {
    // This is the rule that makes single-scar fixtures misleading, so it gets
    // its own test rather than living as an implicit assumption.
    setupRecallRemote([
      makeRecallScar({
        id: "sole-top-hit",
        title: "Sole top hit",
        similarity: 0.6, // compact band by score alone
        counter_arguments: ["UNIQUE_TOPHIT_COUNTERARG_must_render"],
      }),
    ]);

    const display = (await recall({ plan: "top hit escalation test" })).display!;

    expect(display).toContain("UNIQUE_TOPHIT_COUNTERARG_must_render");
  });

  it("never stubs blocking-verification scars, even below threshold", async () => {
    setupRecallRemote([
      {
        ...makeRecallScar({
          id: "blocking-weak",
          title: "Blocking weak scar",
          similarity: 0.5,
          description: "UNIQUE_BLOCKING_BODY_must_render_despite_low_score",
        }),
        required_verification: {
          when: "before deploy",
          queries: ["SELECT 1;"],
          must_show: "the row count",
          blocking: true,
        },
      },
    ]);

    const result = await recall({ plan: "blocking exemption test" });

    // Below threshold (so still tagged) but the body must NOT be stubbed
    expect(result.display).toContain("UNIQUE_BLOCKING_BODY_must_render_despite_low_score");
  });

  it("stubbing reduces output length for low-confidence scars", async () => {
    const heavy = {
      description: "A".repeat(400),
      counter_arguments: ["B".repeat(120), "C".repeat(120)],
    };

    setupRecallRemote([
      makeRecallScar({ id: "len-full", title: "Length scar", similarity: 0.7, ...heavy }),
    ]);
    const fullLen = (await recall({ plan: "length baseline" })).display!.length;

    setupRecallRemote([
      makeRecallScar({ id: "len-stub", title: "Length scar", similarity: 0.5, ...heavy }),
    ]);
    const stubLen = (await recall({ plan: "length stubbed" })).display!.length;

    expect(stubLen).toBeLessThan(fullLen);
  });
});

// ============================================================
// Part 5: Cross-cutting provenance guarantees
// ============================================================

describe("provenance: citation rule is one constant across all four surfaces", () => {
  // The predecessors of these two tests asserted a box-drawing separator and a
  // prose prefix ("CITATION RULE: When referencing facts from these"). The
  // separator was retired from the retrieval surfaces by the GIT-74 token audit
  // and the prose was compacted, so both tests were asserting chrome rather
  // than the guarantee. Worse, the prefix check passed while the three literals
  // had already drifted — a shared prefix is not shared text.
  //
  // The guarantee that actually matters: one exported constant, emitted whole
  // by every surface. Assert that, and the tests survive the next rewording.
  //
  // R12 unified three surfaces; formatCompact kept a fourth literal, so the
  // drift R12 fixed could silently reopen on the hook path. R14 folded it in,
  // and these tests now span all four.

  // One id per surface, so each assertion names the exact string that surface
  // was given rather than guessing at a character class.
  const SURFACE_ID = {
    search: "5ea12c00-1111-2222-3333-444444444444",
    recall: "5eca1100-5555-6666-7777-888888888888",
    prepare_context: "9cc07e00-9999-aaaa-bbbb-cccccccccccc",
    formatCompact: "c0m9ac70-dddd-eeee-ffff-000000000000",
  } as const;

  /** Every surface that emits the citation rule, rendered from one fixture set. */
  async function allSurfaces(): Promise<Record<keyof typeof SURFACE_ID, string>> {
    setupSearchRemote([makeSearchScar({ id: SURFACE_ID.search })]);
    const searchDisplay = (await search({ query: "consistency" })).display!;

    setupRecallRemote([makeRecallScar({ id: SURFACE_ID.recall })]);
    const recallDisplay = (await recall({ plan: "consistency" })).display!;

    setupPrepareRemote([makePrepareContextScar({ id: SURFACE_ID.prepare_context })]);
    const pcPayload = (await prepareContext({ plan: "consistency", format: "full" }))
      .memory_payload;

    const compactPayload = formatCompact(
      [makeFormattableScar({ id: SURFACE_ID.formatCompact })],
      "consistency",
      2000,
    ).payload;

    return { search: searchDisplay, recall: recallDisplay, prepare_context: pcPayload, formatCompact: compactPayload };
  }

  it("all four surfaces emit the identical citation constant", async () => {
    for (const [name, surface] of Object.entries(await allSurfaces())) {
      expect(surface, `${name} must emit CITATION_LINE`).toContain(CITATION_LINE);
    }
  });

  it("no surface ships a second, drifted copy of the rule", async () => {
    // Catches the original defect class directly: a surface that keeps its own
    // literal alongside the import, or emits the rule twice.
    for (const [name, surface] of Object.entries(await allSurfaces())) {
      expect(surface.split(CITATION_LINE).length - 1, `${name} must emit it exactly once`).toBe(1);
      // The retired prose must not reappear anywhere alongside the constant.
      expect(surface).not.toContain("CITATION RULE: When referencing facts");
      expect(surface).not.toContain("factual claims from these scars");
    }
  });

  it("every surface that instructs citation also renders citable ids", async () => {
    // GIT-74/R14, the invariant behind invariant (b): an instruction ships only
    // on surfaces that render the capability to obey it. This is the test that
    // makes a fifth id-less-but-instructing surface structurally impossible.
    const surfaces = await allSurfaces();

    for (const [name, surface] of Object.entries(surfaces)) {
      const expectedId = `id:${SURFACE_ID[name as keyof typeof SURFACE_ID].slice(0, 8)}`;
      expect(surface, `${name} instructs citation, so it must render ${expectedId}`).toContain(
        expectedId,
      );
    }
  });
});
