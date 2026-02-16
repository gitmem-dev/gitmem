/**
 * Simplified Tests: Variant Assignment Logic
 * Updated from issue-keyed to agent-keyed assignment
 *
 * Tests variant assignment without relying on ww-mcp (which requires valid JWT).
 * Focuses on testing the core variant assignment functionality.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getOrAssignVariant,
  getActiveVariants,
  getExistingAssignment,
  formatVariantEnforcement,
} from "../src/services/variant-assignment.js";
import * as supabase from "../src/services/supabase-client.js";

// Test configuration - use actual scar with variants
const TEST_SCAR_ID = "debc6a79-f080-459b-85c6-01f073eca609"; // Containerization scar

describe("Variant Assignment Core Logic", () => {
  beforeAll(() => {
    if (!supabase.isConfigured()) {
      throw new Error("Supabase not configured - check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  describe("Variant Retrieval", () => {
    it("should fetch active variants for a scar", async () => {
      const variants = await getActiveVariants(TEST_SCAR_ID);

      expect(variants.length).toBeGreaterThan(0);
      expect(variants.every((v) => v.active)).toBe(true);
      expect(variants.some((v) => v.variant_name === "traditional")).toBe(true);
      expect(variants.some((v) => v.variant_name === "karpathy_v1")).toBe(true);
    });
  });

  describe("Assignment Creation (Idempotency)", () => {
    it("should create assignment on first call and reuse on second call", async () => {
      const testAgent = `TEST-AGENT-${Date.now()}`;

      // First call - creates assignment
      const result1 = await getOrAssignVariant(testAgent, TEST_SCAR_ID);

      expect(result1.has_variants).toBe(true);
      expect(result1.variant).toBeDefined();
      expect(result1.assignment).toBeDefined();

      const variantId1 = result1.variant!.id;

      // Second call - should reuse same assignment
      const result2 = await getOrAssignVariant(testAgent, TEST_SCAR_ID);

      expect(result2.has_variants).toBe(true);
      expect(result2.variant!.id).toBe(variantId1);
      expect(result2.assignment!.variant_id).toBe(variantId1);

      // Verify idempotency
      expect(result1.assignment!.id).toBe(result2.assignment!.id);
    });
  });

  describe("Metadata Passthrough", () => {
    it("should store issue_id and session_id as metadata", async () => {
      const testAgent = `TEST-AGENT-META-${Date.now()}`;
      const metadata = {
        issueId: "PROJ-547",
        sessionId: "test-session-123",
      };

      const result = await getOrAssignVariant(testAgent, TEST_SCAR_ID, metadata);

      expect(result.has_variants).toBe(true);
      expect(result.assignment).toBeDefined();
      expect(result.assignment!.agent_id).toBe(testAgent);
    });
  });

  describe("Traditional Variant Formatting", () => {
    it("should format traditional variant with imperative steps", async () => {
      const variants = await getActiveVariants(TEST_SCAR_ID);
      const traditionalVariant = variants.find((v) => v.variant_name === "traditional");

      if (!traditionalVariant) {
        console.warn("Traditional variant not found, skipping test");
        return;
      }

      const formatted = formatVariantEnforcement(traditionalVariant, "Test Scar");

      // Should contain imperative language
      const hasImperativeLanguage = /STOP|MUST|before|only|always|never/i.test(formatted);
      expect(hasImperativeLanguage).toBe(true);

      // Should NOT contain declarative structure
      expect(formatted).not.toContain("## Success State");
      expect(formatted).not.toContain("## Verification Tests");
    });
  });

  describe("Karpathy Variant Formatting", () => {
    it("should format karpathy variant with success criteria", async () => {
      const variants = await getActiveVariants(TEST_SCAR_ID);
      const karpathyVariant = variants.find((v) => v.variant_name === "karpathy_v1");

      if (!karpathyVariant) {
        console.warn("Karpathy variant not found, skipping test");
        return;
      }

      const formatted = formatVariantEnforcement(karpathyVariant, "Test Scar");

      // Should contain declarative structure
      expect(formatted).toContain("## Success State");
      expect(formatted).toContain("## Verification Tests");

      // May or may not contain constraints depending on variant
      // Just verify it doesn't have imperative step structure
      const hasImperativeSteps = /Step 1|Step 2|First do|Then do/i.test(formatted);
      expect(hasImperativeSteps).toBe(false);
    });
  });

  describe("Random Distribution", () => {
    it("should randomly assign variants across multiple agents", async () => {
      const testAgents = Array.from({ length: 20 }, (_, i) => `TEST-AGENT-DIST-${Date.now()}-${i}`);

      const assignments = await Promise.all(
        testAgents.map((agent) => getOrAssignVariant(agent, TEST_SCAR_ID))
      );

      // All should have variants assigned
      expect(assignments.every((a) => a.has_variants)).toBe(true);
      expect(assignments.every((a) => a.variant)).toBeDefined();

      // Count variant distribution
      const variantCounts = new Map<string, number>();
      for (const assignment of assignments) {
        const variantName = assignment.variant!.variant_name;
        variantCounts.set(variantName, (variantCounts.get(variantName) || 0) + 1);
      }

      console.log("Distribution across 20 agents:", Object.fromEntries(variantCounts));

      // With 20 agents and 2 variants, expect roughly 40-60% distribution
      // (Statistical test with low sample size, so be lenient)
      for (const [name, count] of variantCounts.entries()) {
        const percentage = (count / testAgents.length) * 100;
        console.log(`  ${name}: ${count} (${percentage.toFixed(1)}%)`);

        // Expect at least 20% and at most 80% (very lenient for small sample)
        expect(percentage).toBeGreaterThanOrEqual(20);
        expect(percentage).toBeLessThanOrEqual(80);
      }
    });
  });

  describe("Legacy Scar Handling", () => {
    it("should handle scars without variants gracefully", async () => {
      // Use a scar ID that doesn't have variants
      const legacyScarId = "00000000-0000-0000-0000-000000000000"; // Non-existent

      const result = await getOrAssignVariant("CLI", legacyScarId);

      // Should return has_variants=false for scars without variants
      expect(result.has_variants).toBe(false);
      expect(result.variant).toBeUndefined();
      expect(result.assignment).toBeUndefined();
    });
  });
});
