/**
 * Zod schema for create_learning tool parameters
 */

import { z } from "zod";
import { LearningTypeSchema, ScarSeveritySchema, ProjectSchema } from "./common.js";

/**
 * Create learning parameters schema
 *
 * Type-specific validation:
 * - Scars require severity and at least 2 counter_arguments
 * - Wins and patterns have more relaxed requirements
 */
export const CreateLearningParamsSchema = z
  .object({
    learning_type: LearningTypeSchema,
    title: z.string().min(1, "title is required").max(1000),
    description: z.string().min(1, "description is required").max(5000),
    severity: ScarSeveritySchema.optional(),
    scar_type: z.string().max(100).optional(),
    counter_arguments: z.array(z.string().max(2000)).optional(),
    problem_context: z.string().max(2000).optional(),
    solution_approach: z.string().max(2000).optional(),
    applies_when: z.array(z.string().max(500)).optional(),
    domain: z.array(z.string().max(100)).optional(),
    keywords: z.array(z.string().max(100)).optional(),
    source_linear_issue: z.string().max(100).optional(),
    project: ProjectSchema.optional(),
    // LLM-cooperative enforcement fields
    why_this_matters: z.string().max(2000).optional(),
    action_protocol: z.array(z.string().max(1000)).optional(),
    self_check_criteria: z.array(z.string().max(1000)).optional(),
  })
  .superRefine((data, ctx) => {
    // Scars require severity
    if (data.learning_type === "scar" && !data.severity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scars require severity (critical, high, medium, low)",
        path: ["severity"],
      });
    }

    // Scars require at least 2 counter_arguments
    if (data.learning_type === "scar") {
      if (!data.counter_arguments || data.counter_arguments.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Scars require at least 2 counter_arguments",
          path: ["counter_arguments"],
        });
      }
    }
  });

export type CreateLearningParams = z.infer<typeof CreateLearningParamsSchema>;

/**
 * Validate create_learning params
 */
export function validateCreateLearningParams(params: unknown): {
  success: boolean;
  data?: CreateLearningParams;
  error?: string;
} {
  const result = CreateLearningParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}
