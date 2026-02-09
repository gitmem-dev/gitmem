/**
 * confirm_scars Tool
 *
 * Validates scar confirmations (refute-or-obey protocol) for CLI agents.
 * Ported from CODA-1's verify-completion.js but adapted for structured input
 * (agents send JSON params, not free-text output to parse).
 *
 * Flow:
 *   recall(plan) → surfaces scars → agent reads scars
 *     → confirm_scars(confirmations) → validates each → writes to session state
 *     → PreToolUse hook checks confirmation state before consequential actions
 *
 * Each recalled scar must be addressed with:
 *   APPLYING  — Scar is relevant, past-tense evidence with artifact reference
 *   N_A       — Scar doesn't apply, scenario comparison required
 *   REFUTED   — Overriding scar, risk acknowledgment required
 */

import {
  getCurrentSession,
  getSurfacedScars,
  addConfirmations,
} from "../services/session-state.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import { getSessionPath } from "../services/gitmem-dir.js";
import type {
  ConfirmScarsParams,
  ConfirmScarsResult,
  ScarConfirmation,
  ConfirmationDecision,
  SurfacedScar,
  PerformanceData,
} from "../types/index.js";
import * as fs from "fs";
import * as path from "path";

// Minimum evidence length per decision type
const MIN_EVIDENCE_LENGTH = 50;

// Future-tense patterns — APPLYING must use past tense
const FUTURE_PATTERNS = /\b(will|going to|plan to|intend to|I'll|we'll|shall|about to|aim to|expect to)\b/i;

/**
 * Validate a single confirmation against its surfaced scar.
 * Returns null if valid, or an error string if invalid.
 */
function validateConfirmation(
  confirmation: { scar_id: string; decision: ConfirmationDecision; evidence: string },
  scar: SurfacedScar,
): string | null {
  const { decision, evidence } = confirmation;

  // Check evidence length
  if (!evidence || evidence.trim().length < MIN_EVIDENCE_LENGTH) {
    return `${scar.scar_title}: Evidence too short (${evidence?.trim().length || 0} chars, minimum ${MIN_EVIDENCE_LENGTH}). Provide substantive ${decision === "APPLYING" ? "past-tense evidence with artifact" : decision === "N_A" ? "scenario comparison" : "risk acknowledgment"}.`;
  }

  // Decision-specific validation
  switch (decision) {
    case "APPLYING":
      // Must use past tense — no forward-looking language
      if (FUTURE_PATTERNS.test(evidence)) {
        return `${scar.scar_title}: APPLYING evidence must be past-tense (what you DID, not what you WILL do). Found forward-looking language. Rewrite with past-tense evidence and artifact reference.`;
      }
      break;

    case "N_A":
      // Must explain why the scar doesn't apply (scenario comparison)
      // No strict pattern check — just length is enough
      break;

    case "REFUTED":
      // Must acknowledge the risk of overriding
      // Check for risk-related language
      if (!/\b(risk|despite|overrid|acknowledg|accept|aware|trade.?off|exception)\b/i.test(evidence)) {
        return `${scar.scar_title}: REFUTED evidence must acknowledge the risk of overriding this scar. Include explicit risk acknowledgment.`;
      }
      break;

    default:
      return `${scar.scar_title}: Invalid decision "${decision}". Must be APPLYING, N_A, or REFUTED.`;
  }

  return null;
}

/**
 * Format the confirmation result as markdown for agent context.
 */
function formatResponse(
  valid: boolean,
  confirmations: ScarConfirmation[],
  errors: string[],
  missingScars: string[],
): string {
  const lines: string[] = [];

  if (valid) {
    lines.push("✅ SCAR CONFIRMATIONS ACCEPTED");
    lines.push("");
    for (const conf of confirmations) {
      const emoji = conf.decision === "APPLYING" ? "🟢" : conf.decision === "N_A" ? "⚪" : "🟠";
      lines.push(`${emoji} **${conf.scar_title}** → ${conf.decision}`);
    }
    lines.push("");
    lines.push("All recalled scars addressed. Consequential actions are now unblocked.");
  } else {
    lines.push("⛔ SCAR CONFIRMATIONS REJECTED");
    lines.push("");

    if (errors.length > 0) {
      lines.push("**Validation errors:**");
      for (const err of errors) {
        lines.push(`- ${err}`);
      }
      lines.push("");
    }

    if (missingScars.length > 0) {
      lines.push("**Unaddressed scars (must confirm all recalled scars):**");
      for (const title of missingScars) {
        lines.push(`- ${title}`);
      }
      lines.push("");
    }

    lines.push("Fix the errors above and call confirm_scars again.");
  }

  return lines.join("\n");
}

/**
 * Update per-session dir with confirmation data.
 */
function persistConfirmationsToFile(confirmations: ScarConfirmation[]): void {
  try {
    const session = getCurrentSession();
    if (!session) return;

    const sessionFilePath = getSessionPath(session.sessionId, "session.json");
    if (!fs.existsSync(sessionFilePath)) return;

    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
    data.confirmations = confirmations;
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
    console.error(`[confirm_scars] Confirmations persisted to ${sessionFilePath}`);
  } catch (error) {
    console.warn("[confirm_scars] Failed to persist confirmations to file:", error);
  }
}

/**
 * Main tool implementation: confirm_scars
 */
export async function confirmScars(params: ConfirmScarsParams): Promise<ConfirmScarsResult> {
  const timer = new Timer();

  // Validate session exists
  const session = getCurrentSession();
  if (!session) {
    const performance = buildPerformanceData("confirm_scars", timer.elapsed(), 0);
    return {
      valid: false,
      errors: ["No active session. Call session_start first."],
      confirmations: [],
      missing_scars: [],
      formatted_response: "⛔ No active session. Call session_start before confirm_scars.",
      performance,
    };
  }

  // Get recall-surfaced scars (only source: "recall", not "session_start")
  const allSurfacedScars = getSurfacedScars();
  const recallScars = allSurfacedScars.filter(s => s.source === "recall");

  if (recallScars.length === 0) {
    const performance = buildPerformanceData("confirm_scars", timer.elapsed(), 0);
    return {
      valid: true,
      errors: [],
      confirmations: [],
      missing_scars: [],
      formatted_response: "✅ No recall-surfaced scars to confirm. Proceed freely.",
      performance,
    };
  }

  // Build scar lookup by ID
  const scarById = new Map<string, SurfacedScar>();
  for (const scar of recallScars) {
    scarById.set(scar.scar_id, scar);
  }

  // Validate each confirmation
  const errors: string[] = [];
  const validConfirmations: ScarConfirmation[] = [];
  const confirmedIds = new Set<string>();

  if (!params.confirmations || params.confirmations.length === 0) {
    errors.push("No confirmations provided. Each recalled scar must be addressed.");
  } else {
    for (const conf of params.confirmations) {
      // Check scar exists in recalled set
      const scar = scarById.get(conf.scar_id);
      if (!scar) {
        errors.push(`Unknown scar_id "${conf.scar_id}". Only confirm scars returned by recall().`);
        continue;
      }

      // Validate the confirmation
      const error = validateConfirmation(conf, scar);
      if (error) {
        errors.push(error);
      } else {
        validConfirmations.push({
          scar_id: conf.scar_id,
          scar_title: scar.scar_title,
          decision: conf.decision,
          evidence: conf.evidence.trim(),
          confirmed_at: new Date().toISOString(),
        });
        confirmedIds.add(conf.scar_id);
      }
    }
  }

  // Check for missing scars (all recall scars must be addressed)
  const missingScars: string[] = [];
  for (const scar of recallScars) {
    if (!confirmedIds.has(scar.scar_id)) {
      missingScars.push(scar.scar_title);
    }
  }

  const valid = errors.length === 0 && missingScars.length === 0;

  // If valid, persist to session state and file
  if (valid) {
    addConfirmations(validConfirmations);
    persistConfirmationsToFile(validConfirmations);
  }

  const performance = buildPerformanceData("confirm_scars", timer.elapsed(), validConfirmations.length);
  const formatted_response = formatResponse(valid, validConfirmations, errors, missingScars);

  return {
    valid,
    errors,
    confirmations: validConfirmations,
    missing_scars: missingScars,
    formatted_response,
    performance,
  };
}
