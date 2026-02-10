/**
 * Common Zod schemas shared across tools
 */

import { z } from "zod";

/**
 * Project namespace enum
 */
export const ProjectSchema = z.string().default("default");
export type Project = string;

/**
 * Agent identity enum
 */
export const AgentIdentitySchema = z.enum([
  "CLI",
  "DAC",
  "CODA-1",
  "Brain_Local",
  "Brain_Cloud",
  "Unknown",
]);
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/**
 * Learning type enum (scar, win, pattern)
 */
export const LearningTypeSchema = z.enum(["scar", "win", "pattern", "anti_pattern"]);
export type LearningType = z.infer<typeof LearningTypeSchema>;

/**
 * Scar severity enum
 */
export const ScarSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ScarSeverity = z.infer<typeof ScarSeveritySchema>;

/**
 * Close type enum
 */
export const CloseTypeSchema = z.enum(["standard", "quick", "autonomous", "retroactive"]);
export type CloseType = z.infer<typeof CloseTypeSchema>;

/**
 * Reference type for scar usage
 */
export const ReferenceTypeSchema = z.enum([
  "explicit",
  "implicit",
  "acknowledged",
  "refuted",
  "none",
]);
export type ReferenceType = z.infer<typeof ReferenceTypeSchema>;

/**
 * ISO timestamp string (validates format)
 */
export const ISOTimestampSchema = z.string().refine(
  (val) => {
    const date = new Date(val);
    return !isNaN(date.getTime());
  },
  { message: "Invalid ISO timestamp" }
);

/**
 * UUID string format
 */
export const UUIDSchema = z.string().uuid();

/**
 * Non-empty string (trims and checks length)
 */
export const NonEmptyStringSchema = z.string().min(1, "String cannot be empty");

/**
 * Positive integer
 */
export const PositiveIntSchema = z.number().int().positive();

/**
 * Non-negative integer
 */
export const NonNegativeIntSchema = z.number().int().nonnegative();
