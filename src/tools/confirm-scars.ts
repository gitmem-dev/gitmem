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
  getConfirmationLog,
  getRecallFailure,
  isKnownSessionId,
} from "../services/session-state.js";
import { ownerOf, resolveCallerSessionId, sameSessionId, shortSessionId } from "../services/scar-ownership.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import { wrapDisplay, productLine, STATUS, ANSI } from "../services/display-protocol.js";
import type {
  ConfirmScarsParams,
  ConfirmScarsResult,
  ScarConfirmation,
  ConfirmationDecision,
  SurfacedScar,
  PerformanceData,
} from "../types/index.js";

// Minimum evidence length per decision type
const MIN_EVIDENCE_LENGTH = 50;

// Future-tense patterns — APPLYING must use past tense
// Only catch first-person forward-looking language, not third-person "will"
const FUTURE_PATTERNS = /\b(I will|I'll|we will|we'll|I'm going to|we're going to|I plan to|I intend to|I shall|I aim to|I expect to)\b/i;

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
interface MissingScar {
  title: string;
  owner: string; // session the scar was recalled under
}

function formatResponse(
  valid: boolean,
  confirmations: ScarConfirmation[],
  errors: string[],
  missingScars: MissingScar[],
  ownSessionId: string,
  callerNamedSession: boolean,
): string {
  const lines: string[] = [];

  if (valid) {
    lines.push(`${STATUS.ok} SCAR CONFIRMATIONS ACCEPTED`);
    lines.push("");
    const shown = new Set<string>();
    for (const conf of confirmations) {
      if (shown.has(conf.scar_id)) continue; // one line per scar, however many sessions it covered
      shown.add(conf.scar_id);
      const indicator = conf.decision === "APPLYING" ? STATUS.pass : conf.decision === "N_A" ? `${ANSI.dim}-${ANSI.reset}` : `${ANSI.yellow}!${ANSI.reset}`;
      lines.push(`${indicator} **${conf.scar_title}** → ${conf.decision}`);
    }
    lines.push("");
    lines.push("All recalled scars addressed. Consequential actions are now unblocked.");
  } else {
    lines.push(`${STATUS.rejected} SCAR CONFIRMATIONS REJECTED`);
    lines.push("");

    if (errors.length > 0) {
      lines.push("**Validation errors:**");
      for (const err of errors) {
        lines.push(`- ${err}`);
      }
      lines.push("");
    }

    if (missingScars.length > 0) {
      // GIT-143: name the session each scar was recalled under, so an agent can
      // see when a scar is not its own.
      lines.push("**Unaddressed scars (must confirm all recalled scars):**");
      for (const m of missingScars) {
        const own = sameSessionId(m.owner, ownSessionId);
        lines.push(`- ${m.title} (recalled by session ${shortSessionId(m.owner)}${own ? ", this session" : ""})`);
      }
      lines.push("");
      if (!callerNamedSession && missingScars.some((m) => !sameSessionId(m.owner, ownSessionId))) {
        lines.push(
          "Some of these were recalled by another session that shares this gitmem server. " +
          "If they are not yours, pass your session id as gitmem_session_id to recall() and " +
          "confirm_scars(); you will then be asked only for the scars you recalled.",
        );
        lines.push("");
      }
    }

    lines.push("Fix the errors above and call confirm_scars again.");
  }

  return lines.join("\n");
}

/** A refusal before any scar is looked at. Nothing is recorded. */
function rejectEarly(error: string, timer: Timer): ConfirmScarsResult {
  const msg = `${STATUS.rejected} ${error}`;
  return {
    valid: false,
    errors: [error],
    confirmations: [],
    missing_scars: [],
    formatted_response: msg,
    display: wrapDisplay(msg),
    performance: buildPerformanceData("confirm_scars", timer.elapsed(), 0),
  };
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
    const noSessionMsg = `${STATUS.rejected} No active session. Call session_start before confirm_scars.`;
    return {
      valid: false,
      errors: ["No active session. Call session_start first."],
      confirmations: [],
      missing_scars: [],
      formatted_response: noSessionMsg,
      display: wrapDisplay(noSessionMsg),
      performance,
    };
  }

  // GIT-143: whose scars this call answers for. With an id, only the scars
  // recalled under that session; without one, every scar in this process's
  // current session, as before. Entries without a stamp belong to that session.
  const holder = session.sessionId;
  const caller = resolveCallerSessionId(params, holder);
  if (!caller.ok) {
    return rejectEarly(`${caller.error} Nothing was recorded.`, timer);
  }
  if (caller.id && !isKnownSessionId(caller.id)) {
    return rejectEarly(
      `Session ${caller.id} is not known to this gitmem server. Pass the session id from session_start. Nothing was recorded.`,
      timer,
    );
  }
  const ownSessionId = caller.id ?? holder;
  const isMine = (owner: string) => !caller.id || sameSessionId(owner, caller.id);

  // Get recall-surfaced scars (only source: "recall", not "session_start")
  const allRecallScars = getSurfacedScars().filter(s => s.source === "recall");
  const recallScars = allRecallScars.filter(s => isMine(ownerOf(s, holder)));
  const otherSessionsScars = allRecallScars.filter(s => !isMine(ownerOf(s, holder)));

  if (recallScars.length === 0) {
    const performance = buildPerformanceData("confirm_scars", timer.elapsed(), 0);

    // GIT-93: an empty scar set has two causes and they are not interchangeable.
    // Retrieval ran and matched nothing — safe to proceed. Or retrieval never
    // reached the store, in which case nothing has been checked and "proceed
    // freely" is an assurance nobody earned. This used to answer both the same
    // way, which is how a retrieval path that 404'd on every call since it was
    // written went unnoticed: the system reported success for a failure.
    const failure = getRecallFailure();
    if (failure) {
      const failedMsg = [
        `${STATUS.rejected} Cannot confirm — institutional memory was not reached.`,
        "",
        `recall() failed at ${failure.at}: ${failure.message}`,
        "",
        "This is NOT the same as no relevant scars. Nothing was checked, so any",
        "warning that applies to this work is still unseen. Treat it as memory",
        "being unavailable, not as a clean bill of health.",
        "",
        "Retry recall(). If it keeps failing, say so rather than proceeding as",
        "though the check had passed.",
      ].join("\n");

      return {
        valid: false,
        errors: [`recall() failed — institutional memory unavailable: ${failure.message}`],
        confirmations: [],
        missing_scars: [],
        formatted_response: failedMsg,
        display: wrapDisplay(failedMsg),
        performance,
      };
    }

    const noScarsLines = [`${STATUS.ok} No recall-surfaced scars to confirm. Proceed freely.`];
    if (otherSessionsScars.length > 0) {
      // GIT-143: say so when the only scars here belong to other sessions. If
      // this session called recall() without its id, its scars were recorded
      // under the server's current session and are among these.
      const owners = [...new Set(otherSessionsScars.map(s => shortSessionId(ownerOf(s, holder))))];
      noScarsLines.push(
        "",
        `None were recalled by session ${shortSessionId(ownSessionId)}. ${otherSessionsScars.length} scar(s) on this server ` +
          `belong to other sessions (${owners.join(", ")}) and were not required. If you called recall() without ` +
          "gitmem_session_id, call it again with the same id you passed here.",
      );
    }
    const noScarsMsg = noScarsLines.join("\n");
    return {
      valid: true,
      errors: [],
      confirmations: [],
      missing_scars: [],
      formatted_response: noScarsMsg,
      display: wrapDisplay(noScarsMsg),
      performance,
    };
  }

  // Build scar lookup by ID. One scar can have an entry per session that
  // recalled it (GIT-143); a confirmation covers every entry it is answering for.
  const scarsById = new Map<string, SurfacedScar[]>();
  for (const scar of recallScars) {
    scarsById.set(scar.scar_id, [...(scarsById.get(scar.scar_id) ?? []), scar]);
  }

  // Validate each confirmation
  const errors: string[] = [];
  const validConfirmations: ScarConfirmation[] = [];
  const confirmedKeys = new Set<string>();
  const entryKey = (scarId: string, owner: string) => `${scarId}|${owner.toLowerCase()}`;

  if (!params.confirmations || params.confirmations.length === 0) {
    errors.push("No confirmations provided. Each recalled scar must be addressed.");
  } else {
    for (const conf of params.confirmations) {
      // Check scar exists in recalled set (try exact match first)
      let entries = scarsById.get(conf.scar_id);

      // If not found and looks like 8-char prefix, try prefix match
      // This allows agents to copy IDs from recall display (which shows truncated IDs)
      let ambiguous = false;
      if (!entries && /^[0-9a-f]{8}$/i.test(conf.scar_id)) {
        let matchedId: string | null = null;
        for (const [fullId, scarEntries] of scarsById.entries()) {
          if (fullId.startsWith(conf.scar_id)) {
            if (matchedId) {
              // Ambiguous prefix - multiple matches
              errors.push(`Ambiguous scar_id prefix "${conf.scar_id}" matches multiple scars. Use full UUID.`);
              entries = undefined;
              ambiguous = true;
              break;
            }
            matchedId = fullId;
            entries = scarEntries;
          }
        }
      }
      if (ambiguous) continue;

      if (!entries || entries.length === 0) {
        // GIT-143: a scar another session recalled is not this caller's to clear.
        const foreign = otherSessionsScars.find(
          s => s.scar_id === conf.scar_id || (/^[0-9a-f]{8}$/i.test(conf.scar_id) && s.scar_id.startsWith(conf.scar_id)),
        );
        if (foreign) {
          errors.push(
            `${foreign.scar_title}: recalled by session ${shortSessionId(ownerOf(foreign, holder))}, not by session ` +
              `${shortSessionId(ownSessionId)}. Only that session can confirm it.`,
          );
        } else {
          errors.push(`Unknown scar_id "${conf.scar_id}". Only confirm scars returned by recall().`);
        }
        continue;
      }
      const scar = entries[0];

      // Validate the confirmation
      const error = validateConfirmation(conf, scar);
      if (error) {
        errors.push(error);
      } else {
        // Derive default relevance from decision if not provided
        const relevance = conf.relevance ??
          (conf.decision === "APPLYING" ? "high" : conf.decision === "N_A" ? "low" : "low");
        const confirmedAt = new Date().toISOString();
        for (const entry of entries) {
          const owner = ownerOf(entry, holder);
          validConfirmations.push({
            scar_id: scar.scar_id, // Use full UUID from matched scar, not potentially truncated input
            scar_title: scar.scar_title,
            decision: conf.decision,
            evidence: conf.evidence.trim(),
            confirmed_at: confirmedAt,
            relevance,
            session_id: owner,
          });
          confirmedKeys.add(entryKey(scar.scar_id, owner));
        }
      }
    }
  }

  // Check for missing scars (all recall scars must be addressed)
  // Credit scars already confirmed in a previous call, by the same session (GIT-143)
  const previouslyConfirmed = new Set(getConfirmationLog().map(c => entryKey(c.scar_id, ownerOf(c, holder))));
  const missing: MissingScar[] = [];
  for (const scar of recallScars) {
    const key = entryKey(scar.scar_id, ownerOf(scar, holder));
    if (!confirmedKeys.has(key) && !previouslyConfirmed.has(key)) {
      missing.push({ title: scar.scar_title, owner: ownerOf(scar, holder) });
    }
  }
  const missingScars = [...new Set(missing.map(m => m.title))];

  // If valid, persist to session state and file. GIT-128: appended, never
  // replacing earlier confirmations, and refused when another process now
  // serves this session — an ACCEPTED that did not persist is the failure the
  // ticket was opened on.
  if (errors.length === 0 && missingScars.length === 0) {
    const notRecorded = addConfirmations(validConfirmations);
    if (notRecorded) {
      errors.push(`Confirmations were not recorded: ${notRecorded}. Nothing was unblocked.`);
    }
  }
  const valid = errors.length === 0 && missingScars.length === 0;

  const performance = buildPerformanceData("confirm_scars", timer.elapsed(), validConfirmations.length);
  const formatted_response = formatResponse(valid, validConfirmations, errors, missing, ownSessionId, Boolean(caller.id));

  return {
    valid,
    errors,
    confirmations: validConfirmations,
    missing_scars: missingScars,
    formatted_response,
    display: wrapDisplay(formatted_response),
    performance,
  };
}
