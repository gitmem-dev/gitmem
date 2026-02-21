/**
 * reflect_scars Tool
 *
 * End-of-session scar reflection — the closing counterpart to confirm_scars.
 * Mirrors CODA-1's [Scar Reflection] protocol for CLI/DAC/Brain agents.
 *
 * Flow:
 *   recall → confirm_scars (START: "I will...") → work
 *     → reflect_scars (END: "I did...") → session_close uses reflections
 *
 * Each scar surfaced during the session should be reflected upon with:
 *   OBEYED  — Followed the scar, with concrete evidence (min 15 chars)
 *   REFUTED — Scar didn't apply or was overridden (min 30 chars)
 */

import {
  getCurrentSession,
  getSurfacedScars,
  addReflections,
  getReflections,
} from "../services/session-state.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import { getSessionPath } from "../services/gitmem-dir.js";
import { wrapDisplay, STATUS, ANSI } from "../services/display-protocol.js";
import type {
  ReflectScarsParams,
  ReflectScarsResult,
  ScarReflection,
  ReflectionOutcome,
  SurfacedScar,
  PerformanceData,
} from "../types/index.js";
import * as fs from "fs";

// Minimum evidence lengths (matching CODA-1's refute-or-obey.test.js)
const MIN_OBEYED_LENGTH = 15;
const MIN_REFUTED_LENGTH = 30;

/**
 * Validate a single reflection.
 * Returns null if valid, or an error string if invalid.
 */
function validateReflection(
  reflection: { scar_id: string; outcome: ReflectionOutcome; evidence: string },
  scar: SurfacedScar,
): string | null {
  const { outcome, evidence } = reflection;

  if (!evidence || evidence.trim().length === 0) {
    return `${scar.scar_title}: Evidence is required for ${outcome}.`;
  }

  switch (outcome) {
    case "OBEYED":
      if (evidence.trim().length < MIN_OBEYED_LENGTH) {
        return `${scar.scar_title}: OBEYED evidence too short (${evidence.trim().length} chars, minimum ${MIN_OBEYED_LENGTH}). Provide concrete evidence of compliance.`;
      }
      break;

    case "REFUTED":
      if (evidence.trim().length < MIN_REFUTED_LENGTH) {
        return `${scar.scar_title}: REFUTED evidence too short (${evidence.trim().length} chars, minimum ${MIN_REFUTED_LENGTH}). Explain why the scar didn't apply and what was done instead.`;
      }
      break;

    default:
      return `${scar.scar_title}: Invalid outcome "${outcome}". Must be OBEYED or REFUTED.`;
  }

  return null;
}

/**
 * Format the reflection result as markdown.
 */
function formatResponse(
  valid: boolean,
  reflections: ScarReflection[],
  errors: string[],
  missingScars: string[],
): string {
  const lines: string[] = [];

  if (valid) {
    lines.push(`${STATUS.ok} SCAR REFLECTIONS ACCEPTED`);
    lines.push("");
    for (const ref of reflections) {
      const indicator = ref.outcome === "OBEYED" ? STATUS.pass : `${ANSI.yellow}!${ANSI.reset}`;
      lines.push(`${indicator} **${ref.scar_title}** → ${ref.outcome}`);
    }
    lines.push("");
    lines.push("All surfaced scars reflected upon. Session close will use these for execution_successful.");
  } else {
    lines.push(`${STATUS.rejected} SCAR REFLECTIONS REJECTED`);
    lines.push("");

    if (errors.length > 0) {
      lines.push("**Validation errors:**");
      for (const err of errors) {
        lines.push(`- ${err}`);
      }
      lines.push("");
    }

    if (missingScars.length > 0) {
      lines.push("**Unreflected scars (must reflect on all surfaced scars):**");
      for (const title of missingScars) {
        lines.push(`- ${title}`);
      }
      lines.push("");
    }

    lines.push("Fix the errors above and call reflect_scars again.");
  }

  return lines.join("\n");
}

/**
 * Persist reflections to the per-session file.
 */
function persistReflectionsToFile(reflections: ScarReflection[]): void {
  try {
    const session = getCurrentSession();
    if (!session) return;

    const sessionFilePath = getSessionPath(session.sessionId, "session.json");
    if (!fs.existsSync(sessionFilePath)) return;

    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
    data.reflections = reflections;
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
    console.error(`[reflect_scars] Reflections persisted to ${sessionFilePath}`);
  } catch (error) {
    console.warn("[reflect_scars] Failed to persist reflections to file:", error);
  }
}

/**
 * Main tool implementation: reflect_scars
 */
export async function reflectScars(params: ReflectScarsParams): Promise<ReflectScarsResult> {
  const timer = new Timer();

  // Validate session exists
  const session = getCurrentSession();
  if (!session) {
    const performance = buildPerformanceData("reflect_scars", timer.elapsed(), 0);
    const noSessionMsg = `${STATUS.rejected} No active session. Call session_start before reflect_scars.`;
    return {
      valid: false,
      errors: ["No active session. Call session_start first."],
      reflections: [],
      missing_scars: [],
      formatted_response: noSessionMsg,
      display: wrapDisplay(noSessionMsg),
      performance,
    };
  }

  // Get ALL surfaced scars (both session_start and recall — reflections cover the whole session)
  const allSurfacedScars = getSurfacedScars();

  if (allSurfacedScars.length === 0) {
    const performance = buildPerformanceData("reflect_scars", timer.elapsed(), 0);
    const noScarsMsg = `${STATUS.ok} No surfaced scars to reflect upon. Proceed to session close.`;
    return {
      valid: true,
      errors: [],
      reflections: [],
      missing_scars: [],
      formatted_response: noScarsMsg,
      display: wrapDisplay(noScarsMsg),
      performance,
    };
  }

  // Build scar lookup by ID
  const scarById = new Map<string, SurfacedScar>();
  for (const scar of allSurfacedScars) {
    scarById.set(scar.scar_id, scar);
  }

  // Validate each reflection
  const errors: string[] = [];
  const validReflections: ScarReflection[] = [];
  const reflectedIds = new Set<string>();

  if (!params.reflections || params.reflections.length === 0) {
    errors.push("No reflections provided. Each surfaced scar should be reflected upon.");
  } else {
    for (const ref of params.reflections) {
      // Check scar exists (try exact match first)
      let scar = scarById.get(ref.scar_id);

      // 8-char prefix match (same as confirm_scars)
      if (!scar && /^[0-9a-f]{8}$/i.test(ref.scar_id)) {
        let matchedId: string | null = null;
        for (const [fullId, scarData] of scarById.entries()) {
          if (fullId.startsWith(ref.scar_id)) {
            if (matchedId) {
              errors.push(`Ambiguous scar_id prefix "${ref.scar_id}" matches multiple scars. Use full UUID.`);
              scar = undefined;
              break;
            }
            matchedId = fullId;
            scar = scarData;
          }
        }
      }

      if (!scar) {
        errors.push(`Unknown scar_id "${ref.scar_id}". Only reflect on scars surfaced during this session.`);
        continue;
      }

      // Validate the reflection
      const error = validateReflection(ref, scar);
      if (error) {
        errors.push(error);
      } else {
        validReflections.push({
          scar_id: scar.scar_id,
          scar_title: scar.scar_title,
          outcome: ref.outcome,
          evidence: ref.evidence.trim(),
          reflected_at: new Date().toISOString(),
        });
        reflectedIds.add(scar.scar_id);
      }
    }
  }

  // Check for unreflected scars — advisory, not blocking
  // (Unlike confirm_scars which requires all recall scars, reflect_scars
  // is softer — missing scars are noted but don't invalidate the call)
  const previouslyReflectedIds = new Set(getReflections().map(r => r.scar_id));
  const missingScars: string[] = [];
  for (const scar of allSurfacedScars) {
    if (!reflectedIds.has(scar.scar_id) && !previouslyReflectedIds.has(scar.scar_id)) {
      missingScars.push(scar.scar_title);
    }
  }

  const valid = errors.length === 0;

  // If valid, persist to session state and file
  if (valid && validReflections.length > 0) {
    addReflections(validReflections);
    persistReflectionsToFile([...getReflections()]);
  }

  const performance = buildPerformanceData("reflect_scars", timer.elapsed(), validReflections.length);
  const formatted_response = formatResponse(valid, validReflections, errors, missingScars);

  return {
    valid,
    errors,
    reflections: validReflections,
    missing_scars: missingScars,
    formatted_response,
    display: wrapDisplay(formatted_response),
    performance,
  };
}
