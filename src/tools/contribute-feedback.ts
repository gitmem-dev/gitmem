/**
 * contribute_feedback Tool
 *
 * Submit feedback about gitmem — feature requests, bug reports,
 * friction points, or suggestions. Always saved locally to .gitmem/feedback/.
 * If opted in via config, sent anonymously to improve gitmem.
 *
 * Rate limited to 10 submissions per session.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { getCurrentSession, getFeedbackCount, incrementFeedbackCount } from "../services/session-state.js";
import { getGitmemDir, sanitizePathComponent } from "../services/gitmem-dir.js";
import { isFeedbackEnabled, getInstallId } from "../services/gitmem-dir.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import { sanitizeFeedbackText } from "../services/feedback-sanitizer.js";
import { getEffectTracker } from "../services/effect-tracker.js";
import { wrapDisplay } from "../services/display-protocol.js";
import { Timer } from "../services/metrics.js";
import type { ContributeFeedbackParams } from "../schemas/contribute-feedback.js";

const MAX_FEEDBACK_PER_SESSION = 10;

export interface ContributeFeedbackResult {
  success: boolean;
  id?: string;
  path?: string;
  remote_submitted: boolean;
  display?: string;
  error?: string;
  performance_ms: number;
}

export async function contributeFeedback(params: ContributeFeedbackParams): Promise<ContributeFeedbackResult> {
  const timer = new Timer();

  // 1. Check active session
  const session = getCurrentSession();
  if (!session) {
    const msg = "No active session. Call session_start first.";
    return {
      success: false,
      remote_submitted: false,
      display: wrapDisplay(msg),
      error: msg,
      performance_ms: timer.stop(),
    };
  }

  // 2. Rate limit check
  const count = getFeedbackCount();
  if (count >= MAX_FEEDBACK_PER_SESSION) {
    const msg = `Feedback limit reached (${MAX_FEEDBACK_PER_SESSION}/session). Try again next session.`;
    return {
      success: false,
      remote_submitted: false,
      display: wrapDisplay(msg),
      error: msg,
      performance_ms: timer.stop(),
    };
  }
  incrementFeedbackCount();

  // 3. Sanitize text fields
  const sanitizedDescription = sanitizeFeedbackText(params.description);
  const sanitizedFix = params.suggested_fix ? sanitizeFeedbackText(params.suggested_fix) : undefined;
  const sanitizedContext = params.context ? sanitizeFeedbackText(params.context) : undefined;

  // 4. Build feedback record
  const id = uuidv4();
  const shortId = id.slice(0, 8);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const record = {
    id,
    type: params.type,
    tool: params.tool,
    description: sanitizedDescription,
    severity: params.severity,
    suggested_fix: sanitizedFix,
    context: sanitizedContext,
    timestamp: now.toISOString(),
    gitmem_version: pkg.version,
    agent_identity: getAgentIdentity(),
    session_id: session.sessionId,
  };

  // 5. Local write: .gitmem/feedback/{YYYY-MM-DD}-{type}-{short-id}.json
  const feedbackDir = path.join(getGitmemDir(), "feedback");
  if (!fs.existsSync(feedbackDir)) {
    fs.mkdirSync(feedbackDir, { recursive: true });
  }

  const filename = `${dateStr}-${params.type}-${shortId}.json`;
  sanitizePathComponent(filename, "feedback filename");
  const filePath = path.join(feedbackDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));

  // 6. Remote write (if feedback_enabled in config)
  let remoteSubmitted = false;
  if (isFeedbackEnabled()) {
    const installId = getInstallId();
    const remotePayload = {
      ...record,
      install_id: installId,
    };

    // Fire-and-forget via effect tracker
    const tracker = getEffectTracker();
    tracker.track(
      "feedback",
      "remote-submit",
      async () => {
        // Remote endpoint — POST to Supabase Edge Function or similar
        // For now, this is a placeholder that logs the intent.
        // The actual endpoint will be configured when the backend is ready.
        console.error(`[contribute-feedback] Remote feedback queued: ${id} (${params.type})`);
        // When endpoint is available:
        // const response = await fetch(FEEDBACK_ENDPOINT, {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json" },
        //   body: JSON.stringify(remotePayload),
        // });
        // if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return remotePayload;
      },
    );
    remoteSubmitted = true;
  }

  const latencyMs = timer.stop();
  const remaining = MAX_FEEDBACK_PER_SESSION - getFeedbackCount();
  const remoteNote = remoteSubmitted ? " (queued for remote)" : "";
  const display = `Feedback recorded: ${id} (${remaining} remaining this session)\nType: ${params.type} | Tool: ${params.tool} | Severity: ${params.severity}\nSaved to .gitmem/feedback/${filename}${remoteNote}\n(${latencyMs}ms)`;

  return {
    success: true,
    id,
    path: filePath,
    remote_submitted: remoteSubmitted,
    display: wrapDisplay(display),
    performance_ms: latencyMs,
  };
}
