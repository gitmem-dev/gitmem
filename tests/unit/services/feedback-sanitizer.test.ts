import { describe, it, expect } from "vitest";
import { sanitizeFeedbackText } from "../../../src/services/feedback-sanitizer.js";

describe("sanitizeFeedbackText", () => {
  it("strips home directory paths (Unix)", () => {
    const input = "Error at /home/user/project/src/file.ts:42";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[PATH]");
    expect(result).not.toContain("/home/user");
  });

  it("strips home directory paths (macOS)", () => {
    const input = "Config loaded from /Users/john/code/.gitmem/config.json";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[PATH]");
    expect(result).not.toContain("/Users/john");
  });

  it("strips home directory paths (Windows)", () => {
    const input = "Found at C:\\Users\\admin\\Documents\\project";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[PATH]");
    expect(result).not.toContain("C:\\Users\\admin");
  });

  it("strips email addresses", () => {
    const input = "Contact dev@example.com for help";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[EMAIL]");
    expect(result).not.toContain("dev@example.com");
  });

  it("strips API keys (sk_test pattern)", () => {
    const input = "Using key sk_test_1234567890abcdef";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[KEY]");
    expect(result).not.toContain("sk_test_1234567890abcdef");
  });

  it("strips API keys (sk_live pattern)", () => {
    const input = "Key: sk_live_abcdefghij1234567890";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[KEY]");
    expect(result).not.toContain("sk_live_abcdefghij1234567890");
  });

  it("strips JWT tokens", () => {
    const input = "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[TOKEN]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("strips Bearer tokens", () => {
    const input = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[TOKEN]");
    expect(result).not.toContain("Bearer eyJ");
  });

  it("strips code blocks", () => {
    const input = "The issue is in:\n```typescript\nconst secret = 'abc123';\nconsole.log(secret);\n```\nThis fails.";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[CODE_BLOCK]");
    expect(result).not.toContain("secret = 'abc123'");
    expect(result).toContain("The issue is in:");
    expect(result).toContain("This fails.");
  });

  it("strips env var assignments", () => {
    const input = "Set $SUPABASE_KEY=eyJhbGciOiJIUzI... and $DATABASE_URL=postgres://host:5432/db";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[ENV_VAR]");
    expect(result).not.toContain("$SUPABASE_KEY=");
    expect(result).not.toContain("$DATABASE_URL=");
  });

  it("handles multiple patterns in one string", () => {
    const input = "Error in /home/user/project with key sk_test_abcdefghij emailed to dev@test.com";
    const result = sanitizeFeedbackText(input);
    expect(result).toContain("[PATH]");
    expect(result).toContain("[KEY]");
    expect(result).toContain("[EMAIL]");
  });

  it("leaves clean text unchanged", () => {
    const input = "The recall tool returns results too slowly when there are many scars in the cache.";
    const result = sanitizeFeedbackText(input);
    expect(result).toBe(input);
  });

  it("handles empty string", () => {
    expect(sanitizeFeedbackText("")).toBe("");
  });
});
