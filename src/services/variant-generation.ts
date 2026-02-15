/**
 * Auto-Generation of Scar Enforcement Variants
 *
 * When a new scar is created via create_learning, this service generates
 * two variant rows in scar_enforcement_variants:
 *   1. "traditional" (imperative): steps-based enforcement
 *   2. "karpathy_v1" (declarative): success state + verification tests + constraints
 *
 * Generation pipeline:
 *   1. LLM-generated (via OpenRouter) — high quality, ~1-2s background
 *   2. Deterministic fallback — if no LLM available or call fails
 *
 * Pipeline is versioned via variant_version field (e.g., "gen-1.0").
 * Bump version when changing the prompt or model to track which pipeline
 * produced each variant. Old variants keep their version.
 *
 * Called fire-and-forget from create_learning — zero impact on UX latency.
 */

import * as supabase from "./supabase-client.js";

// --- Pipeline versioning ---
// Bump PIPELINE_VERSION when changing the prompt, model, or generation logic.
// Format: "gen-{major}.{minor}" — major for prompt rewrites, minor for tweaks.
const PIPELINE_VERSION = "gen-1.0";
const LLM_MODEL = "anthropic/claude-3-5-haiku-20241022";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ScarData {
  id: string;
  title: string;
  description: string;
  counter_arguments?: string[];
  action_protocol?: string[];
  self_check_criteria?: string[];
  why_this_matters?: string;
  keywords?: string[];
  domain?: string[];
}

interface EnforcementConfig {
  type: "imperative" | "declarative";
  steps?: string[];
  show_counter_arguments?: boolean;
  success_state?: string;
  verification_tests?: string[];
  constraints?: string[];
}

interface LLMVariantOutput {
  imperative: {
    steps: string[];
  };
  declarative: {
    success_state: string;
    verification_tests: string[];
    constraints?: string[];
  };
}

// --- LLM Generation ---

const SYSTEM_PROMPT = `You generate enforcement variants for institutional memory "scars" (lessons from past failures) used in blind A/B testing of LLM agent enforcement styles.

Given a scar, generate two variants that enforce the SAME lesson using different cognitive approaches:

1. **Imperative (traditional)**: Direct, step-by-step commands. Imperative mood. "STOP. Do X. Check Y. Never Z." Think: a checklist a senior engineer would tape to a monitor.

2. **Declarative (karpathy_v1)**: Define the success state and testable verification conditions. Think: a contract — "the work is correct when these conditions hold." Inspired by Karpathy's approach of defining what success looks like rather than prescribing steps.

RULES:
- Steps must be concrete and specific to THIS scar, not generic advice
- Verification tests must be objectively testable (can an observer confirm yes/no?)
- Never reference variant types, A/B testing, or experiment — the agent is blind
- Keep each step/test under 120 characters
- 3-6 imperative steps, 3-5 verification tests, 1-3 constraints
- Output ONLY valid JSON, no markdown fences, no explanation`;

function buildUserPrompt(scar: ScarData): string {
  const parts = [`# Scar: ${scar.title}`, "", scar.description];

  if (scar.counter_arguments && scar.counter_arguments.length > 0) {
    parts.push("", "## Counter-arguments (common rationalizations for ignoring this):");
    for (const ca of scar.counter_arguments) {
      parts.push(`- ${ca}`);
    }
  }

  if (scar.why_this_matters) {
    parts.push("", `## Why this matters: ${scar.why_this_matters}`);
  }

  if (scar.action_protocol && scar.action_protocol.length > 0) {
    parts.push("", "## Known action steps:");
    for (const step of scar.action_protocol) {
      parts.push(`- ${step}`);
    }
  }

  if (scar.self_check_criteria && scar.self_check_criteria.length > 0) {
    parts.push("", "## Known verification criteria:");
    for (const check of scar.self_check_criteria) {
      parts.push(`- ${check}`);
    }
  }

  if (scar.keywords && scar.keywords.length > 0) {
    parts.push("", `## Domain: ${scar.keywords.join(", ")}`);
  }

  parts.push("", "Generate the enforcement variants as JSON:");
  parts.push(`{
  "imperative": {
    "steps": ["step 1", "step 2", ...]
  },
  "declarative": {
    "success_state": "...",
    "verification_tests": ["test 1", "test 2", ...],
    "constraints": ["constraint 1", ...]
  }
}`);

  return parts.join("\n");
}

/**
 * Call LLM via OpenRouter to generate variant configs.
 * Returns parsed output or null on failure.
 */
async function generateWithLLM(scar: ScarData): Promise<LLMVariantOutput | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[variant-generation] No OPENROUTER_API_KEY — falling back to deterministic");
    return null;
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://gitmem.dev",
        "X-Title": "GitMem Variant Generation",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(scar) },
        ],
        temperature: 0.3, // Low temp for consistency
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[variant-generation] LLM error (${response.status}): ${errText}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[variant-generation] Empty LLM response");
      return null;
    }

    // Parse JSON — strip markdown fences if model adds them despite instructions
    const cleaned = content
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as LLMVariantOutput;

    // Validate structure
    if (
      !parsed.imperative?.steps ||
      !Array.isArray(parsed.imperative.steps) ||
      parsed.imperative.steps.length === 0 ||
      !parsed.declarative?.success_state ||
      !parsed.declarative?.verification_tests ||
      !Array.isArray(parsed.declarative.verification_tests) ||
      parsed.declarative.verification_tests.length === 0
    ) {
      console.error("[variant-generation] LLM output failed validation:", JSON.stringify(parsed).slice(0, 200));
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("[variant-generation] LLM generation failed:", error);
    return null;
  }
}

// --- Deterministic Fallback ---

function buildImperativeConfigFallback(scar: ScarData): EnforcementConfig {
  const steps: string[] = [];

  if (scar.action_protocol && scar.action_protocol.length > 0) {
    steps.push(...scar.action_protocol);
  } else {
    steps.push(`STOP: ${scar.title}`);
    steps.push(scar.description);

    if (scar.counter_arguments && scar.counter_arguments.length > 0) {
      for (const ca of scar.counter_arguments.slice(0, 3)) {
        const cleaned = ca.replace(/^You might think\s+/i, "Watch out: ");
        steps.push(cleaned);
      }
    }
  }

  return { type: "imperative", steps, show_counter_arguments: true };
}

function buildDeclarativeConfigFallback(scar: ScarData): EnforcementConfig {
  const successState = scar.why_this_matters
    ? `${scar.title} is addressed: ${scar.why_this_matters}`
    : `The work avoids the failure mode described by: ${scar.title}`;

  const verificationTests: string[] = [];
  if (scar.self_check_criteria && scar.self_check_criteria.length > 0) {
    verificationTests.push(...scar.self_check_criteria);
  } else if (scar.counter_arguments && scar.counter_arguments.length > 0) {
    for (const ca of scar.counter_arguments.slice(0, 4)) {
      const butIndex = ca.toLowerCase().indexOf(" — but ");
      if (butIndex > -1) {
        verificationTests.push(`Verify: ${ca.slice(butIndex + 7).replace(/\.$/, "")}`);
      } else {
        verificationTests.push(`Check: ${ca.slice(0, 120)}`);
      }
    }
  }

  const constraints: string[] = [];
  if (scar.keywords && scar.keywords.length > 0) {
    constraints.push(`Applies to: ${scar.keywords.join(", ")}`);
  }

  return {
    type: "declarative",
    success_state: successState,
    verification_tests: verificationTests,
    constraints: constraints.length > 0 ? constraints : undefined,
  };
}

// --- Main Entry Point ---

/**
 * Auto-generate imperative + declarative variants for a newly created scar.
 * Fire-and-forget — errors are logged but don't propagate.
 *
 * Pipeline:
 *   1. Try LLM generation (OpenRouter/Haiku) for high-quality variants
 *   2. Fall back to deterministic transformation if LLM unavailable/fails
 *
 * @param scar - The scar data from create_learning
 */
export async function generateVariantsForScar(scar: ScarData): Promise<void> {
  if (!supabase.isConfigured()) {
    return;
  }

  let imperativeConfig: EnforcementConfig;
  let declarativeConfig: EnforcementConfig;
  let generationSource: "llm" | "deterministic";

  // Try LLM generation first
  const llmResult = await generateWithLLM(scar);

  if (llmResult) {
    imperativeConfig = {
      type: "imperative",
      steps: llmResult.imperative.steps,
      show_counter_arguments: true,
    };
    declarativeConfig = {
      type: "declarative",
      success_state: llmResult.declarative.success_state,
      verification_tests: llmResult.declarative.verification_tests,
      constraints: llmResult.declarative.constraints,
    };
    generationSource = "llm";
  } else {
    imperativeConfig = buildImperativeConfigFallback(scar);
    declarativeConfig = buildDeclarativeConfigFallback(scar);
    generationSource = "deterministic";
  }

  const variants = [
    {
      scar_id: scar.id,
      variant_name: "traditional",
      variant_version: PIPELINE_VERSION,
      description: `Auto-generated imperative enforcement (${generationSource}) for: ${scar.title}`,
      enforcement_config: imperativeConfig,
      active: true,
    },
    {
      scar_id: scar.id,
      variant_name: "karpathy_v1",
      variant_version: PIPELINE_VERSION,
      description: `Auto-generated declarative enforcement (${generationSource}) for: ${scar.title}`,
      enforcement_config: declarativeConfig,
      active: true,
    },
  ];

  // Insert both variants in parallel
  const results = await Promise.allSettled(
    variants.map((v) =>
      supabase.directUpsert("scar_enforcement_variants", v)
    )
  );

  let created = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      created++;
    } else {
      console.error("[variant-generation] Failed to create variant:", result.reason);
    }
  }

  console.error(
    `[variant-generation] ${generationSource}: created ${created}/2 variants for scar ${scar.id} (pipeline ${PIPELINE_VERSION})`
  );
}
