/**
 * Unit tests for sanitizePathComponent (path traversal prevention)
 */

import { describe, it, expect } from "vitest";
import { sanitizePathComponent } from "../../../src/services/gitmem-dir.js";

describe("sanitizePathComponent", () => {
  it("accepts valid UUID", () => {
    expect(() => sanitizePathComponent("a1b2c3d4-e5f6-7890-abcd-ef1234567890", "test")).not.toThrow();
  });

  it("accepts valid short hex ID", () => {
    expect(() => sanitizePathComponent("a1b2c3d4", "test")).not.toThrow();
  });

  it("accepts simple filename", () => {
    expect(() => sanitizePathComponent("session.json", "test")).not.toThrow();
  });

  it("rejects double-dot traversal", () => {
    expect(() => sanitizePathComponent("../../etc/passwd", "test")).toThrow("path traversal rejected");
  });

  it("rejects forward slash", () => {
    expect(() => sanitizePathComponent("sessions/evil", "test")).toThrow("path traversal rejected");
  });

  it("rejects backslash", () => {
    expect(() => sanitizePathComponent("sessions\\evil", "test")).toThrow("path traversal rejected");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizePathComponent("session\0.json", "test")).toThrow("path traversal rejected");
  });

  it("rejects empty string", () => {
    expect(() => sanitizePathComponent("", "test")).toThrow("non-empty string");
  });

  it("includes label in error message", () => {
    expect(() => sanitizePathComponent("../evil", "sessionId")).toThrow("sessionId");
  });
});
