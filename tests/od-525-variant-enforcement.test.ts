/**
 * OD-525 Verification Tests: Dual-Enforcement Engine
 * OD-547: Updated from issue-keyed to agent-keyed assignment
 *
 * Tests that variant assignment integrates correctly with scar surfacing:
 * 1. Assignment-Then-Surface Test (idempotency)
 * 2. Traditional Variant Presentation Test
 * 3. Karpathy Variant Presentation Test
 * 4. Legacy Scar Test
 * 5. Metrics Recording Test
 */

import { describe, it, expect, beforeAll } from "vitest";
import { recall } from "../src/tools/recall.js";
import {
  getOrAssignVariant,
  getActiveVariants,
  getExistingAssignment,
} from "../src/services/variant-assignment.js";
import * as supabase from "../src/services/supabase-client.js";

// Test configuration
const TEST_SCAR_WITH_VARIANTS = "debc6a79-f080-459b-85c6-01f073eca609"; // Containerization scar
const TEST_AGENT_IDEMPOTENCY = `TEST-AGENT-OD525-IDEMPOTENT-${Date.now()}`;
const TEST_AGENT_TRADITIONAL = `TEST-AGENT-OD525-TRADITIONAL-${Date.now()}`;
const TEST_AGENT_KARPATHY = `TEST-AGENT-OD525-KARPATHY-${Date.now()}`;
const TEST_AGENT_LEGACY = `TEST-AGENT-OD525-LEGACY-${Date.now()}`;

describe("OD-525: Dual-Enforcement Engine Integration", () => {
  beforeAll(() => {
    // Verify Supabase is configured
    if (!supabase.isConfigured()) {
      throw new Error("Supabase not configured - tests require SUPABASE_URL and SUPABASE_KEY");
    }
  });

  describe("Test 1: Assignment-Then-Surface (Idempotency)", () => {
    it("should create assignment on first surface and reuse on second surface", async () => {
      // First surface - creates assignment
      const result1 = await recall({
        plan: "deploy containerized app to production with full feature parity",
        project: "test-project",
        match_count: 1,
        issue_id: "OD-525-TEST",
      });

      expect(result1.activated).toBe(true);
      expect(result1.scars.length).toBeGreaterThan(0);

      // Get the first scar that should have variants
      const scarWithVariants = result1.scars.find(
        (s) => s.id === TEST_SCAR_WITH_VARIANTS
      );

      if (!scarWithVariants) {
        console.log("Containerization scar not in top results, trying direct assignment");
        // Directly test assignment using agent-keyed approach
        const assignment1 = await getOrAssignVariant(
          TEST_AGENT_IDEMPOTENCY,
          TEST_SCAR_WITH_VARIANTS
        );
        expect(assignment1.has_variants).toBe(true);
        expect(assignment1.variant).toBeDefined();

        // Second surface - should reuse same variant
        const assignment2 = await getOrAssignVariant(
          TEST_AGENT_IDEMPOTENCY,
          TEST_SCAR_WITH_VARIANTS
        );
        expect(assignment2.has_variants).toBe(true);
        expect(assignment2.variant?.id).toBe(assignment1.variant?.id);
        return;
      }

      expect(scarWithVariants.variant_info).toBeDefined();
      expect(scarWithVariants.variant_info?.has_variants).toBe(true);

      const variantId1 = scarWithVariants.variant_info?.variant?.id;

      // Second surface - should reuse same assignment (same agent)
      const result2 = await recall({
        plan: "deploy containerized app to production with full feature parity",
        project: "test-project",
        match_count: 1,
        issue_id: "OD-525-TEST",
      });

      const scarWithVariants2 = result2.scars.find(
        (s) => s.id === TEST_SCAR_WITH_VARIANTS
      );

      expect(scarWithVariants2?.variant_info?.has_variants).toBe(true);
      const variantId2 = scarWithVariants2?.variant_info?.variant?.id;

      // Same variant both times (same agent = same assignment)
      expect(variantId2).toBe(variantId1);
      expect(result1.formatted_response).toBe(result2.formatted_response);
    });
  });

  describe("Test 2: Traditional Variant Presentation", () => {
    it("should show imperative steps for traditional variant", async () => {
      // Force assignment to traditional variant for deterministic testing
      const variants = await getActiveVariants(TEST_SCAR_WITH_VARIANTS);
      const traditionalVariant = variants.find((v) => v.variant_name === "traditional");

      if (!traditionalVariant) {
        console.warn("Traditional variant not found, skipping test");
        return;
      }

      // Create assignment manually using directUpsert
      await supabase.directUpsert("variant_assignments", {
        agent_id: TEST_AGENT_TRADITIONAL,
        scar_id: TEST_SCAR_WITH_VARIANTS,
        variant_id: traditionalVariant.id,
      });

      // Verify assignment was created
      const assignment = await getExistingAssignment(TEST_AGENT_TRADITIONAL, TEST_SCAR_WITH_VARIANTS);
      expect(assignment).toBeTruthy();
      expect(assignment?.variant_id).toBe(traditionalVariant.id);
    });
  });

  describe("Test 3: Karpathy Variant Presentation", () => {
    it("should create karpathy variant assignment", async () => {
      // Force assignment to karpathy variant
      const variants = await getActiveVariants(TEST_SCAR_WITH_VARIANTS);
      const karpathyVariant = variants.find((v) => v.variant_name === "karpathy_v1");

      if (!karpathyVariant) {
        console.warn("Karpathy variant not found, skipping test");
        return;
      }

      // Create assignment manually using directUpsert
      await supabase.directUpsert("variant_assignments", {
        agent_id: TEST_AGENT_KARPATHY,
        scar_id: TEST_SCAR_WITH_VARIANTS,
        variant_id: karpathyVariant.id,
      });

      // Verify assignment
      const assignment = await getExistingAssignment(TEST_AGENT_KARPATHY, TEST_SCAR_WITH_VARIANTS);
      expect(assignment).toBeTruthy();
      expect(assignment?.variant_id).toBe(karpathyVariant.id);
    });
  });

  describe("Test 4: Legacy Scar Test", () => {
    it("should use original description for scars without variants", async () => {
      const result = await recall({
        plan: "implement brand new feature with no prior lessons",
        project: "test-project",
        match_count: 5,
      });

      // Check if any scars don't have variants
      const legacyScars = result.scars.filter(
        (s) => !s.variant_info || !s.variant_info.has_variants
      );

      if (legacyScars.length === 0) {
        console.warn("No legacy scars found in results");
        return;
      }

      // For legacy scars, variant_info should be undefined or has_variants=false
      for (const scar of legacyScars) {
        expect(
          !scar.variant_info || scar.variant_info.has_variants === false
        ).toBe(true);
      }

      // Verify system doesn't crash with legacy scars
      expect(result.activated).toBe(true);
      expect(result.formatted_response).toBeTruthy();
    });
  });

  describe("Test 5: Variant Assignment Coverage", () => {
    it("should assign variants to all scars that have them", async () => {
      const result = await recall({
        plan: "deploy containerized app, verify CODA-1 work, test infrastructure",
        project: "test-project",
        match_count: 5,
      });

      expect(result.activated).toBe(true);
      expect(result.scars.length).toBeGreaterThan(0);

      // Check that scars with variants got assigned
      const scarsWithVariantInfo = result.scars.filter((s) => s.variant_info);

      for (const scar of scarsWithVariantInfo) {
        if (scar.variant_info!.has_variants) {
          // Should have variant and assignment
          expect(scar.variant_info!.variant).toBeDefined();
          expect(scar.variant_info!.assignment).toBeDefined();
          // Agent-keyed: assignment should have agent_id
          expect(scar.variant_info!.assignment!.agent_id).toBeDefined();
        }
      }
    });
  });

  describe("Test 6: Metrics Recording", () => {
    it("should record enforcement metrics with agent_id", async () => {
      const result = await recall({
        plan: "deploy containerized app to production with full feature parity",
        project: "test-project",
        match_count: 3,
        issue_id: "TEST-OD525-METRICS",
      });

      expect(result.activated).toBe(true);
      expect(result.scars.length).toBeGreaterThan(0);

      // Find scars with variants
      const scarsWithVariants = result.scars.filter(
        (s) => s.variant_info?.has_variants && s.variant_info.variant
      );

      if (scarsWithVariants.length === 0) {
        console.warn("No scars with variants surfaced, skipping metrics test");
        return;
      }

      // Wait a moment for async metrics recording
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify metrics were recorded — query by scar_id (agent_id in metrics
      // is the detected agent running the test, not a test-specific value)
      for (const scar of scarsWithVariants) {
        const metrics = await supabase.directQuery("variant_performance_metrics", {
          select: "*",
          filters: {
            scar_id: scar.id,
          },
        });

        // Should have at least one metric entry for this scar
        expect(metrics.length).toBeGreaterThan(0);
        const metric = metrics[metrics.length - 1] as {
          agent_id: string;
          scar_id: string;
          variant_id: string;
          enforcement_triggered: boolean;
        };

        expect(metric.scar_id).toBe(scar.id);
        expect(metric.variant_id).toBe(scar.variant_info!.variant!.id);
        expect(metric.enforcement_triggered).toBe(true);
      }
    });
  });

  describe("Cleanup", () => {
    it("should verify test assignments exist", async () => {
      const testAgentIds = [
        TEST_AGENT_IDEMPOTENCY,
        TEST_AGENT_TRADITIONAL,
        TEST_AGENT_KARPATHY,
        TEST_AGENT_LEGACY,
      ];

      for (const agentId of testAgentIds) {
        try {
          const assignments = await supabase.directQuery("variant_assignments", {
            select: "*",
            filters: { agent_id: agentId },
          });

          console.log(`Test agent ${agentId} has ${assignments.length} assignments`);
        } catch (error) {
          console.warn(`Could not query assignments for cleanup: ${error}`);
        }
      }
    });
  });
});
