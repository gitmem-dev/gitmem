/**
 * Unit tests for thread schema max length enforcement
 */

import { describe, it, expect } from "vitest";
import {
  ThreadObjectSchema,
  ResolveThreadParamsSchema,
  ListThreadsParamsSchema,
} from "../../../src/schemas/thread.js";

describe("ThreadObjectSchema max length enforcement", () => {
  const validThread = {
    id: "t-aabbccdd",
    text: "Valid thread text",
    status: "open" as const,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("accepts valid thread", () => {
    expect(ThreadObjectSchema.safeParse(validThread).success).toBe(true);
  });

  it("rejects id exceeding 100 chars", () => {
    const result = ThreadObjectSchema.safeParse({
      ...validThread,
      id: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects text exceeding 3000 chars", () => {
    const result = ThreadObjectSchema.safeParse({
      ...validThread,
      text: "x".repeat(3001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects resolution_note exceeding 1000 chars", () => {
    const result = ThreadObjectSchema.safeParse({
      ...validThread,
      status: "resolved",
      resolution_note: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts text at exactly 3000 chars", () => {
    const result = ThreadObjectSchema.safeParse({
      ...validThread,
      text: "x".repeat(3000),
    });
    expect(result.success).toBe(true);
  });
});

describe("ResolveThreadParamsSchema max length enforcement", () => {
  it("rejects thread_id exceeding 100 chars", () => {
    const result = ResolveThreadParamsSchema.safeParse({
      thread_id: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects text_match exceeding 500 chars", () => {
    const result = ResolveThreadParamsSchema.safeParse({
      text_match: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects resolution_note exceeding 1000 chars", () => {
    const result = ResolveThreadParamsSchema.safeParse({
      thread_id: "t-aabbccdd",
      resolution_note: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid resolve params", () => {
    const result = ResolveThreadParamsSchema.safeParse({
      thread_id: "t-aabbccdd",
      resolution_note: "Done",
    });
    expect(result.success).toBe(true);
  });
});

describe("ListThreadsParamsSchema", () => {
  it("accepts valid params", () => {
    const result = ListThreadsParamsSchema.safeParse({
      status: "open",
      include_resolved: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = ListThreadsParamsSchema.safeParse({
      status: "invalid",
    });
    expect(result.success).toBe(false);
  });
});
