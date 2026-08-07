/**
 * create_learning field persistence — the class-killing test (GIT-76 / R13b)
 *
 * The defect this guards is not "applies_when was dropped". It is the SHAPE
 * that dropped it: a field assigned inside one learning_type's branch is
 * silently discarded for every other type. Schema acceptance is not
 * persistence — the write validated the field, reported success, and stored
 * nothing.
 *
 * Three fields had that exact shape at the exact same site (applies_when,
 * problem_context, solution_approach) and anti_pattern had no branch at all.
 * R13b's scope guard is therefore ONE parameterized assertion rather than four
 * targeted ones: every schema-accepted field persists to the stored row, for
 * every learning_type. That is what makes a fifth sibling structurally
 * impossible instead of merely absent.
 *
 * The assertion is made against the row handed to directUpsert — the stored
 * row — never against the tool's own success message. A success message
 * describing submitted content rather than stored content is the defect class
 * 1.7.0 exists to close.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock dependencies (mirrors create-learning-errors.test.ts) ---

const mockDirectUpsert = vi.fn(() => Promise.resolve({ id: "test-learning-id" }));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(() => true),
  directUpsert: (...args: unknown[]) => mockDirectUpsert(...args),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => true),
  getTableName: vi.fn((base: string) => `orchestra_${base}`),
  hasProInsights: () => false,
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: vi.fn(() => Promise.resolve(null)),
  isEmbeddingAvailable: vi.fn(() => false),
}));

vi.mock("../../../src/services/agent-detection.js", () => ({
  getAgentIdentity: vi.fn(() => "CLI"),
}));

vi.mock("../../../src/services/display-protocol.js", () => ({
  wrapDisplay: vi.fn((msg: string) => msg),
  TYPE: { scar: "S", win: "W", pattern: "P", anti_pattern: "A" },
  SEV: { critical: "!", high: "H", medium: "M", low: "L" },
}));

vi.mock("../../../src/services/startup.js", () => ({
  flushCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/triple-writer.js", () => ({
  writeTriplesForLearning: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/variant-generation.js", () => ({
  generateVariantsForScar: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: vi.fn(() => ({
    track: vi.fn((_cat: string, _label: string, fn: () => Promise<void>) => fn()),
  })),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: vi.fn(() => ({
    upsert: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock("../../../src/services/session-state.js", () => ({
  getProject: vi.fn(() => "test-project"),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-learning"),
}));

import { createLearning } from "../../../src/tools/create-learning.js";
import type { CreateLearningParams, LearningType } from "../../../src/types/index.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockDirectUpsert.mockResolvedValue({ id: "test-learning-id" });
});

/** The row actually handed to the store, not the tool's success message. */
function storedRow(): Record<string, unknown> {
  expect(mockDirectUpsert, "the write must have been attempted").toHaveBeenCalled();
  return mockDirectUpsert.mock.calls[0][1] as unknown as Record<string, unknown>;
}

const ALL_TYPES: LearningType[] = ["scar", "win", "pattern", "anti_pattern"];

/**
 * Every optional field the schema accepts, with a distinctive value and the
 * check that proves it survived. Add a field to CreateLearningParams and it
 * belongs here — that is the point of the table.
 */
const SCHEMA_FIELDS: Array<{
  field: keyof CreateLearningParams;
  value: unknown;
  /** Fields that are type-specific BY DESIGN, with the reason. */
  onlyFor?: LearningType[];
}> = [
  { field: "applies_when", value: ["UNIQUE_APPLIES_WHEN"] },
  { field: "problem_context", value: "UNIQUE_PROBLEM_CONTEXT" },
  { field: "solution_approach", value: "UNIQUE_SOLUTION_APPROACH" },
  { field: "why_this_matters", value: "UNIQUE_WHY_THIS_MATTERS" },
  { field: "action_protocol", value: ["UNIQUE_ACTION_PROTOCOL"] },
  { field: "self_check_criteria", value: ["UNIQUE_SELF_CHECK"] },
  { field: "keywords", value: ["UNIQUE_KEYWORD"] },
  { field: "domain", value: ["UNIQUE_DOMAIN"] },
  // counter_arguments is scar-only by design: R12a called for the per-field
  // intent to be confirmed rather than assumed, and this is that confirmation.
  { field: "counter_arguments", value: ["UNIQUE_CA_ONE", "UNIQUE_CA_TWO"], onlyFor: ["scar"] },
];

/** Minimum valid params for a type, so validation never masks a drop. */
function baseParams(type: LearningType): CreateLearningParams {
  return {
    learning_type: type,
    title: `Test ${type}`,
    description: `Description for ${type}`,
    ...(type === "scar" && {
      severity: "high" as const,
      counter_arguments: ["You might think X", "But Y"],
    }),
  };
}

describe("create_learning: every schema-accepted field persists, for every learning_type", () => {
  // The class-killer. One assertion, every type × every universal field.
  for (const type of ALL_TYPES) {
    for (const { field, value, onlyFor } of SCHEMA_FIELDS) {
      if (onlyFor && !onlyFor.includes(type)) continue;

      it(`${type}: persists ${String(field)} to the stored row`, async () => {
        const result = await createLearning({
          ...baseParams(type),
          [field]: value,
        } as CreateLearningParams);

        expect(result.success, `create must succeed: ${JSON.stringify(result.errors)}`).toBe(true);
        expect(
          storedRow()[field as string],
          `${String(field)} was accepted for ${type} but never reached the row`,
        ).toEqual(value);
      });
    }
  }
});

describe("create_learning: type-specific fields stay type-specific", () => {
  it("counter_arguments is written only for scars", async () => {
    for (const type of ALL_TYPES.filter((t) => t !== "scar")) {
      vi.clearAllMocks();
      mockDirectUpsert.mockResolvedValue({ id: "test-learning-id" });

      await createLearning({
        ...baseParams(type),
        counter_arguments: ["UNIQUE_SHOULD_NOT_PERSIST"],
      } as CreateLearningParams);

      expect(storedRow().counter_arguments, `${type} must not carry counter_arguments`)
        .toBeUndefined();
    }
  });
});

describe("create_learning: every learning_type gets a severity", () => {
  // anti_pattern had no branch at all, so it fell through with severity
  // undefined — the same omission one level up from the field drops.
  for (const type of ALL_TYPES) {
    it(`${type}: stored row carries a severity even when none is submitted`, async () => {
      const params = baseParams(type);
      if (type !== "scar") delete (params as { severity?: unknown }).severity;

      const result = await createLearning(params);

      expect(result.success).toBe(true);
      expect(storedRow().severity, `${type} must not reach the row without a severity`)
        .toBeDefined();
    });
  }
});

describe("create_learning: win behaviour unchanged (GIT-76 regression)", () => {
  // R13b normalizes three fields into a universal block; win's long-standing
  // empty-string floor for two of them must survive that refactor.
  it("win still writes problem_context and solution_approach as '' when omitted", async () => {
    const result = await createLearning({
      learning_type: "win",
      title: "Test win",
      description: "No context or approach submitted",
    });

    expect(result.success).toBe(true);
    expect(storedRow().problem_context).toBe("");
    expect(storedRow().solution_approach).toBe("");
  });

  it("win still defaults severity to medium", async () => {
    await createLearning({
      learning_type: "win",
      title: "Test win",
      description: "No severity submitted",
    });

    expect(storedRow().severity).toBe("medium");
  });
});
