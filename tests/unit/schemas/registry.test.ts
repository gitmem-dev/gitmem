/**
 * Tests for schema registry — server-level Zod validation
 */

import { describe, it, expect } from "vitest";
import { validateToolArgs, resolveToolName } from "../../../src/schemas/registry.js";

describe("resolveToolName", () => {
  it("resolves aliases to canonical names", () => {
    expect(resolveToolName("gitmem-r")).toBe("recall");
    expect(resolveToolName("gitmem-sc")).toBe("session_close");
    expect(resolveToolName("gm-close")).toBe("session_close");
    expect(resolveToolName("gitmem-ss")).toBe("session_start");
    expect(resolveToolName("gm-open")).toBe("session_start");
    expect(resolveToolName("gitmem-cl")).toBe("create_learning");
    expect(resolveToolName("gm-scar")).toBe("create_learning");
  });

  it("returns canonical names unchanged", () => {
    expect(resolveToolName("recall")).toBe("recall");
    expect(resolveToolName("session_close")).toBe("session_close");
    expect(resolveToolName("search")).toBe("search");
  });

  it("returns unknown names unchanged", () => {
    expect(resolveToolName("unknown_tool")).toBe("unknown_tool");
  });
});

describe("validateToolArgs", () => {
  it("returns null for valid session_close params", () => {
    const error = validateToolArgs("session_close", {
      session_id: "test-session",
      close_type: "quick",
    });
    expect(error).toBeNull();
  });

  it("returns null for valid alias params", () => {
    const error = validateToolArgs("gitmem-sc", {
      session_id: "test-session",
      close_type: "quick",
    });
    expect(error).toBeNull();
  });

  it("returns error for missing required field", () => {
    const error = validateToolArgs("session_close", {
      close_type: "quick",
    });
    expect(error).not.toBeNull();
    expect(error).toContain("session_id");
  });

  it("returns error for invalid close_type", () => {
    const error = validateToolArgs("session_close", {
      session_id: "test",
      close_type: "invalid_type",
    });
    expect(error).not.toBeNull();
    expect(error).toContain("session_close");
  });

  it("returns error for invalid ceremony_duration_ms", () => {
    const error = validateToolArgs("session_close", {
      session_id: "test",
      close_type: "quick",
      ceremony_duration_ms: -100,
    });
    expect(error).not.toBeNull();
  });

  it("returns null for tools without schemas (passthrough)", () => {
    const error = validateToolArgs("gitmem-help", {});
    expect(error).toBeNull();
  });

  it("returns null for unknown tools (passthrough)", () => {
    const error = validateToolArgs("nonexistent_tool", { anything: true });
    expect(error).toBeNull();
  });

  it("validates recall params", () => {
    expect(validateToolArgs("recall", { plan: "test plan" })).toBeNull();
    expect(validateToolArgs("gitmem-r", { plan: "test" })).toBeNull();

    const error = validateToolArgs("recall", {});
    expect(error).not.toBeNull();
    expect(error).toContain("plan");
  });

  it("validates create_learning params", () => {
    const error = validateToolArgs("create_learning", {
      learning_type: "scar",
      title: "Test",
      // missing description
    });
    expect(error).not.toBeNull();
    expect(error).toContain("description");
  });

  it("validates search params", () => {
    expect(validateToolArgs("search", { query: "test" })).toBeNull();

    const error = validateToolArgs("gitmem-search", {});
    expect(error).not.toBeNull();
    expect(error).toContain("query");
  });
});
