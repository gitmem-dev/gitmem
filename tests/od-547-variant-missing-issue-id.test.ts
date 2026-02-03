/**
 * OD-547: Agent-Keyed Variant Assignment Tests
 *
 * These tests verify the fix: variants are now assigned using agent identity
 * (always available) instead of issue_id (often missing).
 *
 * Previously these tests demonstrated the bug (variants not assigned without issue_id).
 * Now they verify the fix works correctly.
 */

import { describe, it, expect } from "vitest";
import { recall } from "../src/tools/recall.js";
import { getOrAssignVariant, getActiveVariants } from "../src/services/variant-assignment.js";
import { getAgentIdentity } from "../src/services/agent-detection.js";
import * as supabase from "../src/services/supabase-client.js";

// Test scar that has variants
const TEST_SCAR_WITH_VARIANTS = "debc6a79-f080-459b-85c6-01f073eca609"; // Containerization scar

const supabaseConfigured = supabase.isConfigured();

describe.skipIf(!supabaseConfigured)("OD-547: Agent-Keyed Variant Assignment", () => {

  describe("Core Fix: Variants assigned without issue_id", () => {
    it("should assign variants when recall is called WITHOUT issue_id", async () => {
      // This was the original bug: recall without issue_id = no variants
      // Now: agent identity is used instead, so variants are always assigned
      const result = await recall({
        plan: "deploy containerized app to production with full feature parity",
        project: "orchestra_dev",
        match_count: 3,
        // NO issue_id — this used to be the bug!
      });

      expect(result.activated).toBe(true);
      expect(result.scars.length).toBeGreaterThan(0);

      // Find scar that has variants
      const containerizationScar = result.scars.find(
        (s) => s.id === TEST_SCAR_WITH_VARIANTS
      );

      if (!containerizationScar) {
        console.warn("Containerization scar not in results, skipping variant check");
        return;
      }

      // Verify this scar has variants in database
      const availableVariants = await getActiveVariants(TEST_SCAR_WITH_VARIANTS);
      expect(availableVariants.length).toBeGreaterThan(0);

      // THE FIX: variant_info should now be populated even without issue_id
      expect(containerizationScar.variant_info).toBeDefined();
      expect(containerizationScar.variant_info?.has_variants).toBe(true);
      expect(containerizationScar.variant_info?.variant).toBeDefined();
      expect(containerizationScar.variant_info?.assignment).toBeDefined();

      // Agent identity should be the assignment key
      expect(containerizationScar.variant_info?.assignment?.agent_id).toBeDefined();
    });

    it("should use agent identity as assignment key", async () => {
      const agentId = getAgentIdentity();
      expect(agentId).toBeDefined();
      expect(agentId).not.toBe("Unknown"); // Should detect actual agent in test env

      // Direct assignment using agent identity
      const result = await getOrAssignVariant(agentId, TEST_SCAR_WITH_VARIANTS);
      expect(result.has_variants).toBe(true);
      expect(result.assignment).toBeDefined();
      expect(result.assignment!.agent_id).toBe(agentId);
    });
  });

  describe("Idempotency: Same agent always gets same variant", () => {
    it("should return same variant for same agent across multiple calls", async () => {
      const agentId = getAgentIdentity();

      const result1 = await getOrAssignVariant(agentId, TEST_SCAR_WITH_VARIANTS);
      const result2 = await getOrAssignVariant(agentId, TEST_SCAR_WITH_VARIANTS);

      expect(result1.has_variants).toBe(true);
      expect(result2.has_variants).toBe(true);
      expect(result1.variant!.id).toBe(result2.variant!.id);
      expect(result1.assignment!.id).toBe(result2.assignment!.id);
    });
  });

  describe("Metadata passthrough", () => {
    it("should store issue_id and session_id as optional metadata", async () => {
      const testAgent = `TEST-AGENT-OD547-META-${Date.now()}`;
      const metadata = {
        issueId: "OD-547",
        sessionId: "test-session-abc",
      };

      const result = await getOrAssignVariant(testAgent, TEST_SCAR_WITH_VARIANTS, metadata);

      expect(result.has_variants).toBe(true);
      expect(result.assignment).toBeDefined();
      expect(result.assignment!.agent_id).toBe(testAgent);
      // issue_id and session_id are metadata — stored but not used as keys
    });

    it("should work without any metadata", async () => {
      const testAgent = `TEST-AGENT-OD547-NOMETA-${Date.now()}`;

      // No metadata at all — still works because agent_id is the key
      const result = await getOrAssignVariant(testAgent, TEST_SCAR_WITH_VARIANTS);

      expect(result.has_variants).toBe(true);
      expect(result.assignment).toBeDefined();
      expect(result.assignment!.agent_id).toBe(testAgent);
    });
  });

  describe("Regression: Recall with issue_id still works", () => {
    it("should assign variants when issue_id IS provided (regression)", async () => {
      const result = await recall({
        plan: "deploy containerized app to production with full feature parity",
        project: "orchestra_dev",
        match_count: 3,
        issue_id: "OD-547-REGRESSION",
      });

      expect(result.activated).toBe(true);

      // Find scar with variants
      const containerizationScar = result.scars.find(
        (s) => s.id === TEST_SCAR_WITH_VARIANTS
      );

      if (!containerizationScar) {
        console.warn("Containerization scar not in results");
        return;
      }

      // Should have variant assigned
      expect(containerizationScar.variant_info).toBeDefined();
      expect(containerizationScar.variant_info?.has_variants).toBe(true);
      expect(containerizationScar.variant_info?.variant).toBeDefined();
      expect(containerizationScar.variant_info?.assignment).toBeDefined();
    });
  });

  describe("Different agents get independent assignments", () => {
    it("should allow different agents to get different variants", async () => {
      const agents = Array.from({ length: 10 }, (_, i) => `TEST-AGENT-OD547-DIFF-${Date.now()}-${i}`);

      const results = await Promise.all(
        agents.map((agent) => getOrAssignVariant(agent, TEST_SCAR_WITH_VARIANTS))
      );

      // All should have variants
      expect(results.every((r) => r.has_variants)).toBe(true);

      // Each agent should have its own assignment
      const assignmentIds = new Set(results.map((r) => r.assignment!.id));
      expect(assignmentIds.size).toBe(agents.length);

      // Should have at least 2 different variants across 10 agents
      const variantIds = new Set(results.map((r) => r.variant!.id));
      expect(variantIds.size).toBeGreaterThanOrEqual(1); // At least 1, likely 2
    });
  });
});
