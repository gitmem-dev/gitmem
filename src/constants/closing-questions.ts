/**
 * Single Source of Truth: Closing Reflection Questions
 *
 * All 7 closing questions defined once. Used by:
 * - definitions.ts (JSON schema for tool registration)
 * - compliance-validator.ts (validation error messages)
 * - schemas/session-close.ts (Zod schema)
 * - types/index.ts (ClosingReflection interface)
 *
 * Changing a question here propagates everywhere.
 */

export interface ClosingQuestion {
  /** Field name in closing_reflection object */
  key: string;
  /** Question number (Q1-Q7) */
  number: number;
  /** Full question text */
  question: string;
  /** What type of institutional memory this question surfaces */
  memoryType: "scar" | "win" | "decision" | "synthesis" | null;
  /** Whether compliance validator enforces a non-empty answer */
  required: boolean;
  /** JSON schema type for the field */
  fieldType: "string" | "string[]";
}

export const CLOSING_QUESTIONS: ClosingQuestion[] = [
  {
    key: "what_broke",
    number: 1,
    question: "What broke that you didn't expect?",
    memoryType: "scar",
    required: true,
    fieldType: "string",
  },
  {
    key: "what_took_longer",
    number: 2,
    question: "What took longer than it should have?",
    memoryType: "scar",
    required: true,
    fieldType: "string",
  },
  {
    key: "do_differently",
    number: 3,
    question: "What would you do differently next time?",
    memoryType: "scar",
    required: true,
    fieldType: "string",
  },
  {
    key: "what_worked",
    number: 4,
    question: "What pattern or approach worked well?",
    memoryType: "win",
    required: true,
    fieldType: "string",
  },
  {
    key: "wrong_assumption",
    number: 5,
    question: "What assumption was wrong?",
    memoryType: "scar",
    required: true,
    fieldType: "string",
  },
  {
    key: "scars_applied",
    number: 6,
    question: "Which scars or institutional knowledge did you apply?",
    memoryType: null,
    required: false,
    fieldType: "string[]",
  },
  {
    key: "institutional_memory_items",
    number: 7,
    question:
      "What from this session should be captured as institutional memory? " +
      "Review Q1-Q6 first — Q1/Q5 are scar candidates, Q3 is almost always a scar, " +
      "Q4 is a win, and any significant design choice is a decision.",
    memoryType: "synthesis",
    required: false,
    fieldType: "string",
  },
];

/**
 * Build JSON schema properties for closing_reflection in tool definitions.
 * Returns the `properties` object for the closing_reflection schema.
 */
export function closingReflectionSchemaProperties(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const q of CLOSING_QUESTIONS) {
    if (q.fieldType === "string[]") {
      properties[q.key] = {
        type: "array",
        items: { type: "string" },
      };
    } else {
      properties[q.key] = { type: "string" };
    }
  }
  return properties;
}

/**
 * Build the full closing_reflection JSON schema object for tool definitions.
 */
export function closingReflectionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: closingReflectionSchemaProperties(),
    description: `Answers to ${CLOSING_QUESTIONS.length} closing questions (required for standard close)`,
  };
}

/**
 * Build a description string listing all questions (for tool descriptions or prompts).
 */
export function closingReflectionDescription(): string {
  return CLOSING_QUESTIONS.map(
    (q) => `Q${q.number} (${q.key}): ${q.question}`
  ).join("\n");
}
