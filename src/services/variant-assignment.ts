/**
 * Scar Variant Assignment Service
 * OD-525: Integrates variant assignment into enforcement engine
 * OD-547: Switched from issue-keyed to agent-keyed assignment
 *
 * Handles:
 * - Random variant assignment for scars with variants
 * - Idempotent assignment (same agent+scar always gets same variant)
 * - Legacy scar fallback (scars without variants use original description)
 * - Blind testing (agent doesn't know which variant they received)
 */

import * as supabase from "./supabase-client.js";

/**
 * Variant record from database
 */
export interface ScarVariant {
  id: string;
  variant_name: string;
  variant_version: string;
  description: string;
  enforcement_config: {
    type: "imperative" | "declarative";
    show_counter_arguments?: boolean;
    steps?: string[];
    success_state?: string;
    verification_tests?: string[];
    constraints?: string[];
  };
  active: boolean;
}

/**
 * Assignment record
 * OD-547: Primary key is (agent_id, scar_id), issue_id/session_id are metadata
 */
export interface VariantAssignment {
  id: string;
  agent_id: string;
  scar_id: string;
  variant_id: string;
  assigned_at: string;
  issue_id?: string;
  session_id?: string;
}

/**
 * Result of variant retrieval for a scar
 */
export interface ScarWithVariant {
  scar_id: string;
  has_variants: boolean;
  variant?: ScarVariant;
  assignment?: VariantAssignment;
}

/**
 * Get active variants for a scar
 */
export async function getActiveVariants(scarId: string): Promise<ScarVariant[]> {
  if (!supabase.isConfigured()) {
    return [];
  }

  try {
    // Use directQuery to bypass ww-mcp and query Supabase REST API directly
    const variants = await supabase.directQuery<ScarVariant>(
      "scar_enforcement_variants",
      {
        select: "*",
        filters: {
          scar_id: scarId,
          active: "true",
        },
      }
    );

    return variants;
  } catch (error) {
    console.error(`[variant-assignment] Exception fetching variants:`, error);
    return [];
  }
}

/**
 * Get existing assignment for an agent + scar pair
 * OD-547: Changed from issue-keyed to agent-keyed lookup
 */
export async function getExistingAssignment(
  agentId: string,
  scarId: string
): Promise<VariantAssignment | null> {
  if (!supabase.isConfigured()) {
    return null;
  }

  try {
    const assignments = await supabase.directQuery<VariantAssignment>(
      "variant_assignments",
      {
        select: "*",
        filters: {
          agent_id: agentId,
        },
        limit: 10,
      }
    );

    // Filter by scar_id locally
    const match = assignments.find(a => a.scar_id === scarId);
    return match || null;
  } catch (error) {
    console.error(`[variant-assignment] Exception fetching assignment:`, error);
    return null;
  }
}

/**
 * Create random variant assignment
 * OD-547: Agent-keyed with optional issue/session metadata
 */
export async function createVariantAssignment(
  agentId: string,
  scarId: string,
  variants: ScarVariant[],
  metadata?: { issueId?: string; sessionId?: string }
): Promise<VariantAssignment | null> {
  if (!supabase.isConfigured() || variants.length === 0) {
    return null;
  }

  try {
    // Random selection from active variants
    const randomIndex = Math.floor(Math.random() * variants.length);
    const selectedVariant = variants[randomIndex];

    const result = await supabase.directUpsert<VariantAssignment>(
      "variant_assignments",
      {
        agent_id: agentId,
        scar_id: scarId,
        variant_id: selectedVariant.id,
        issue_id: metadata?.issueId || null,
        session_id: metadata?.sessionId || null,
      }
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle race condition: unique constraint violation
    if (errorMessage.includes("23505") || errorMessage.includes("duplicate key")) {
      console.error(`[variant-assignment] Assignment already exists (race condition), fetching...`);
      return await getExistingAssignment(agentId, scarId);
    }

    console.error(`[variant-assignment] Exception creating assignment:`, error);
    return null;
  }
}

/**
 * Get or create variant assignment for a scar
 * This is the main entry point for enforcement integration
 *
 * OD-547: Changed from issue-keyed to agent-keyed assignment.
 * Agent identity is always available, so variants are always assigned.
 *
 * @param agentId - Agent identity (e.g., 'CLI', 'DAC', 'CODA-1')
 * @param scarId - UUID of the scar
 * @param metadata - Optional issue_id and session_id for triple traversals
 * @returns Scar with variant info, or has_variants=false for legacy scars
 */
export async function getOrAssignVariant(
  agentId: string,
  scarId: string,
  metadata?: { issueId?: string; sessionId?: string }
): Promise<ScarWithVariant> {
  // Step 1: Check for active variants
  const variants = await getActiveVariants(scarId);

  if (variants.length === 0) {
    // Legacy scar - no variants available
    return {
      scar_id: scarId,
      has_variants: false,
    };
  }

  // Step 2: Check for existing assignment (idempotent per agent+scar)
  let assignment = await getExistingAssignment(agentId, scarId);

  // Step 3: Create assignment if it doesn't exist
  if (!assignment) {
    assignment = await createVariantAssignment(agentId, scarId, variants, metadata);
    if (!assignment) {
      // Assignment failed, fall back to legacy mode
      return {
        scar_id: scarId,
        has_variants: false,
      };
    }
  }

  // Step 4: Find the assigned variant
  const variant = variants.find((v) => v.id === assignment!.variant_id);

  if (!variant) {
    console.error(`[variant-assignment] Variant ${assignment.variant_id} not found in active variants`);
    return {
      scar_id: scarId,
      has_variants: false,
    };
  }

  return {
    scar_id: scarId,
    has_variants: true,
    variant,
    assignment,
  };
}

/**
 * Format enforcement text based on variant type
 * Returns formatted description with variant-specific structure
 *
 * This is BLIND - agent never sees variant name or type indicator
 */
export function formatVariantEnforcement(variant: ScarVariant, scarTitle: string): string {
  const config = variant.enforcement_config;

  if (config.type === "imperative") {
    // Traditional format: imperative steps
    const lines: string[] = [];

    if (config.steps && config.steps.length > 0) {
      for (const step of config.steps) {
        lines.push(step);
      }
    } else {
      // Fallback to description if no steps
      lines.push(variant.description);
    }

    return lines.join("\n\n");
  } else if (config.type === "declarative") {
    // Karpathy format: success state + verification tests + constraints
    const lines: string[] = [];

    if (config.success_state) {
      lines.push("## Success State");
      lines.push("");
      lines.push(config.success_state);
      lines.push("");
    }

    if (config.verification_tests && config.verification_tests.length > 0) {
      lines.push("## Verification Tests");
      lines.push("");
      for (const test of config.verification_tests) {
        lines.push(`- ${test}`);
      }
      lines.push("");
    }

    if (config.constraints && config.constraints.length > 0) {
      lines.push("## Constraints");
      lines.push("");
      for (const constraint of config.constraints) {
        lines.push(`- ${constraint}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // Fallback
  return variant.description;
}
