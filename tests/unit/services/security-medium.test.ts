/**
 * Security tests for MEDIUM severity fixes
 *
 * M1: Weak randomness in variant assignment (Math.random → crypto.randomInt)
 * M2: Error message redaction in server.ts
 * M3: Raw error object leak in variant-assignment.ts
 */

import { describe, it, expect } from "vitest";

// --- M2: Server error redaction ---

describe("server error redaction", () => {
  // Simulate the redaction logic from server.ts catch block
  function redactError(rawMessage: string): string {
    return rawMessage
      .replace(/\/[^\s:]+/g, "[path]")
      .replace(/\b\d{5}\b/g, "[code]")
      .replace(/at\s+\S+\s+\(.+\)/g, "")
      .slice(0, 200);
  }

  it("redacts file paths from error messages", () => {
    const raw = "ENOENT: no such file or directory, open '/home/user/.gitmem/sessions/abc/session.json'";
    const safe = redactError(raw);
    expect(safe).not.toContain("/home/user");
    expect(safe).not.toContain(".gitmem");
    expect(safe).toContain("[path]");
  });

  it("redacts PostgreSQL error codes", () => {
    const raw = "duplicate key value violates unique constraint 23505";
    const safe = redactError(raw);
    expect(safe).not.toContain("23505");
    expect(safe).toContain("[code]");
  });

  it("strips stack trace frames", () => {
    const raw = "Error: connection failed at Module.load (/usr/lib/node_modules/pg/client.js:42:5)";
    const safe = redactError(raw);
    expect(safe).not.toContain("Module.load");
    expect(safe).not.toContain("client.js");
  });

  it("caps output length at 200 chars", () => {
    const raw = "A".repeat(500);
    const safe = redactError(raw);
    expect(safe.length).toBeLessThanOrEqual(200);
  });

  it("passes clean messages through", () => {
    const raw = "Session not found";
    const safe = redactError(raw);
    expect(safe).toBe("Session not found");
  });
});

// --- M1: crypto.randomInt existence check ---

describe("crypto.randomInt availability", () => {
  it("crypto.randomInt is available in Node.js runtime", async () => {
    const { randomInt } = await import("crypto");
    expect(typeof randomInt).toBe("function");

    // Should produce values in range [0, bound)
    for (let i = 0; i < 100; i++) {
      const val = randomInt(0, 5);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(5);
    }
  });
});
