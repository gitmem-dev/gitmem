/**
 * session_close Tool
 *
 * Persist session with compliance validation.
 * Validates that required fields are present based on close type.
 *
 * Performance target: <3000ms
 */

import { v4 as uuidv4 } from "uuid";
import { detectAgent } from "../services/agent-detection.js";
import * as supabase from "../services/supabase-client.js";
import { embed, isEmbeddingAvailable } from "../services/embedding.js";
import { hasSupabase, getTableName } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import { clearCurrentSession, getSurfacedScars, getConfirmations, getReflections, getObservations, getChildren, getThreads, getSessionActivity } from "../services/session-state.js";
import { normalizeThreads, mergeThreadStates, migrateStringThread, saveThreadsFile } from "../services/thread-manager.js"; // 
import { deduplicateThreadList } from "../services/thread-dedup.js";
import { syncThreadsToSupabase, loadOpenThreadEmbeddings } from "../services/thread-supabase.js";
import {
  validateSessionClose,
  buildCloseCompliance,
} from "../services/compliance-validator.js";
import { normalizeReflectionKeys } from "../constants/closing-questions.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
  updateRelevanceData,
} from "../services/metrics.js";
import { wrapDisplay, truncate, productLine, boldText, dimText, STATUS, ANSI } from "../services/display-protocol.js";
import { recordScarUsageBatch } from "./record-scar-usage-batch.js";
import { getEffectTracker } from "../services/effect-tracker.js";
import { saveTranscript } from "./save-transcript.js";
import { processTranscript } from "../services/transcript-chunker.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getGitmemPath, getGitmemDir, getSessionPath, getSessionDir } from "../services/gitmem-dir.js";
import { unregisterSession, findSessionByHostPid } from "../services/active-sessions.js";
import { loadSuggestions, saveSuggestions, detectSuggestedThreads, loadRecentSessionEmbeddings } from "../services/thread-suggestions.js";
import { writeAgentBriefing } from "../services/agent-briefing.js";
import type {
  SessionCloseParams,
  SessionCloseResult,
  CloseCompliance,
  SurfacedScar,
  ScarConfirmation,
  ScarUsageEntry,
  ThreadObject,
} from "../types/index.js";

/**
 * Normalize scars_applied to string[].
 * Handles both string (prose answer from agents) and string[] (schema-correct array).
 * When agents write Q6 as prose, splits on common delimiters.
 */
function normalizeScarsApplied(scarsApplied: string | string[] | undefined | null): string[] {
  if (!scarsApplied) return [];
  if (Array.isArray(scarsApplied)) return scarsApplied;
  const trimmed = scarsApplied.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/(?:\.\s+|\;\s*|\s+—\s+)/).filter(p => p.trim().length > 0);
  return parts.length > 0 ? parts : [trimmed];
}

/**
 * Count scars applied from closing_reflection.scars_applied.
 */
function countScarsApplied(scarsApplied: string | string[] | undefined | null): number {
  return normalizeScarsApplied(scarsApplied).length;
}

/**
 * Find transcript file path: explicit param or auto-detect from Claude Code projects dir
 */
function findTranscriptPath(explicitPath?: string): string | null {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      console.error(`[session_close] Using explicit transcript path: ${explicitPath}`);
      return explicitPath;
    }
    console.warn(`[session_close] Explicit transcript path does not exist: ${explicitPath}`);
  }
  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, ".claude", "projects");
  const cwd = process.cwd();
  const projectDirName = path.basename(cwd);
  const found = findMostRecentTranscript(projectsDir, projectDirName, cwd);
  if (found) {
    console.error(`[session_close] Auto-detected transcript: ${found}`);
  } else {
    console.error(`[session_close] No transcript file found in ${projectsDir}`);
  }
  return found;
}

/**
 * Find the most recently modified transcript file in Claude Code projects directory
 * Search by recency, not by filename matching (supports post-compaction)
 */
function findMostRecentTranscript(projectsDir: string, cwdBasename: string, cwdFull: string): string | null {
  // Claude Code names project dirs by replacing / with - in the full CWD path
  // e.g., /Users/dev/my-project -> -Users-dev-my-project
  const claudeCodeDirName = cwdFull.replace(/\//g, "-");

  const possibleDirs = [
    path.join(projectsDir, claudeCodeDirName),  // Primary: full path with dashes
    path.join(projectsDir, "-workspace"),
    path.join(projectsDir, "workspace"),
    path.join(projectsDir, cwdBasename),         // Legacy fallback
  ];

  let allTranscripts: Array<{ path: string; mtime: Date }> = [];

  for (const dir of possibleDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => {
          const fullPath = path.join(dir, f);
          const stats = fs.statSync(fullPath);
          return { path: fullPath, mtime: stats.mtime };
        });

      allTranscripts.push(...files);
    } catch (error) {
      // Ignore read errors for individual directories
      continue;
    }
  }

  if (allTranscripts.length === 0) return null;

  // Sort by modification time, most recent first
  allTranscripts.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Only consider files modified in the last 5 minutes (active session)
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  const recentTranscripts = allTranscripts.filter(t => t.mtime.getTime() > fiveMinutesAgo);

  if (recentTranscripts.length === 0) {
    console.warn("[session_close] No recently modified transcripts found (last 5 min)");
    return allTranscripts[0].path; // Fallback to most recent overall
  }

  return recentTranscripts[0].path;
}

/**
 * Extract Claude Code session ID from transcript JSONL content
 * Provides traceability between GitMem sessions and IDE sessions
 */
function extractClaudeSessionId(transcriptContent: string, filePath: string): string | null {
  try {
    // Try to parse first line of JSONL
    const firstLine = transcriptContent.split('\n')[0];
    if (!firstLine) return null;

    const firstMessage = JSON.parse(firstLine);

    // Check for session_id in message metadata
    if (firstMessage.session_id) {
      return firstMessage.session_id;
    }

    // Fallback: extract from filename (format: {session-id}.jsonl)
    const filename = path.basename(filePath, '.jsonl');
    // Validate it looks like a UUID
    if (filename.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)) {
      return filename;
    }

    return null;
  } catch (error) {
    // If parsing fails, try filename extraction
    const filename = path.basename(filePath, '.jsonl');
    if (filename.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)) {
      return filename;
    }
    return null;
  }
}

/**
 * Free tier session_close — persist locally, skip compliance/transcripts/embedding
 */
async function sessionCloseFree(
  params: SessionCloseParams,
  timer: Timer
): Promise<SessionCloseResult> {
  const storage = getStorage();
  const env = detectAgent();
  const agentIdentity = env.agent;
  const sessionId = params.session_id || uuidv4();

  // Build minimal close compliance
  const learningsCount = params.learnings_created?.length || 0;
  const closeCompliance: CloseCompliance = {
    close_type: params.close_type,
    agent: agentIdentity,
    checklist_displayed: true,
    questions_answered_by_agent: !!params.closing_reflection,
    human_asked_for_corrections: !!params.human_corrections || params.human_corrections === "",
    learnings_stored: learningsCount,
    scars_applied: countScarsApplied(params.closing_reflection?.scars_applied),
  };

  try {
    // Load existing session if available
    const existingSession = await storage.get<Record<string, unknown>>("sessions", sessionId);

    const sessionData: Record<string, unknown> = {
      ...(existingSession || {}),
      id: sessionId,
      close_compliance: closeCompliance,
    };

    if (params.closing_reflection) {
      const reflection: Record<string, unknown> = { ...params.closing_reflection };
      if (params.human_corrections) {
        reflection.human_additions = params.human_corrections;
      }
      sessionData.closing_reflection = reflection;
    }

    if (params.decisions && params.decisions.length > 0) {
      sessionData.decisions = params.decisions.map((d) => d.title);
    }

    // : Normalize threads for free tier too
    const freeSessionThreads = getThreads();
    if (params.open_threads && params.open_threads.length > 0) {
      const normalized = normalizeThreads(params.open_threads, params.session_id);
      const merged = freeSessionThreads.length > 0
        ? deduplicateThreadList(mergeThreadStates(normalized, freeSessionThreads))
        : deduplicateThreadList(normalized);
      sessionData.open_threads = merged;
    } else if (freeSessionThreads.length > 0) {
      sessionData.open_threads = freeSessionThreads;
    }

    if (params.project_state) {
      const projectStateText = `PROJECT STATE: ${params.project_state}`;
      const existing = (sessionData.open_threads || []) as ThreadObject[];
      const filtered = existing.filter((t) => {
        const text = typeof t === "string" ? t : t.text;
        return !text.startsWith("PROJECT STATE:");
      });
      sessionData.open_threads = [migrateStringThread(projectStateText, params.session_id), ...filtered];
    }

    // Persist session locally
    await storage.upsert("sessions", sessionData);

    // Record scar usage locally if provided
    if (params.scars_to_record && params.scars_to_record.length > 0) {
      for (const scar of params.scars_to_record) {
        await storage.upsert("scar_usage", {
          id: uuidv4(),
          scar_id: scar.scar_identifier,
          session_id: sessionId,
          agent: agentIdentity,
          surfaced_at: scar.surfaced_at,
          reference_type: scar.reference_type,
          reference_context: scar.reference_context,
          created_at: new Date().toISOString(),
        });
      }
    }

    // Generate agent-briefing.md for PMEM bridge
    const decisionsCount = params.decisions?.length || 0;
    await writeAgentBriefing(learningsCount, decisionsCount);

    // Clear session state
    clearCurrentSession();

    // GIT-21: Clean up session files (registry, per-session dir, legacy file)
    cleanupSessionFiles(sessionId);

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 1);
    const display = formatCloseDisplay(sessionId, closeCompliance, params, learningsCount, true);

    return {
      success: true,
      session_id: sessionId,
      close_compliance: closeCompliance,
      performance: perfData,
      display,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    clearCurrentSession();
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);
    const errorDisplay = formatCloseDisplay(sessionId, closeCompliance, params, learningsCount, false, [`Failed to persist session: ${errorMessage}`]);

    return {
      success: false,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: [`Failed to persist session: ${errorMessage}`],
      performance: perfData,
      display: errorDisplay,
    };
  }
}

/**
 * Build a pre-formatted display string for consistent CLI output.
 * Agents echo this string directly instead of formatting ad-hoc.
 */
interface TranscriptStatus {
  saved: boolean;
  path?: string;
  size_kb?: number;
  error?: string;
  patch_warning?: string;
}

function formatCloseDisplay(
  sessionId: string,
  compliance: CloseCompliance,
  params: SessionCloseParams,
  learningsCount: number,
  success: boolean,
  errors?: string[],
  transcriptStatus?: TranscriptStatus
): string {
  const lines: string[] = [];

  // Header: branded product line
  const status = success ? STATUS.complete : STATUS.failed;
  lines.push(productLine("close", status));

  // Stats line: compact one-liner with key counts
  const stats: string[] = [];
  const scarsApplied = params.scars_to_record?.filter(s => s.reference_type !== "none").length || 0;
  if (scarsApplied > 0) stats.push(`${scarsApplied} scars applied`);
  if (learningsCount > 0) stats.push(`${learningsCount} learnings`);
  if (params.decisions?.length) stats.push(`${params.decisions.length} decision${params.decisions.length > 1 ? "s" : ""}`);
  const threads = params.open_threads || [];
  const openCount = threads.filter(t => typeof t === "string" || t.status === "open").length;
  if (openCount > 0) stats.push(`${openCount} threads`);
  if (stats.length > 0) {
    lines.push(stats.join(" · "));
  }
  lines.push(dimText(`${sessionId.slice(0, 8)} · ${compliance.agent} · ${compliance.close_type}`));

  // Errors — only on failure
  if (!success && errors?.length) {
    lines.push("");
    for (const e of errors) lines.push(`  ${STATUS.miss} ${e}`);
  }

  // Reflection highlights FIRST — the most interesting part
  if (params.closing_reflection) {
    const r = params.closing_reflection;
    if (r.what_worked || r.do_differently) {
      lines.push("");
      if (r.what_worked) {
        lines.push(`${STATUS.pass} ${truncate(r.what_worked, 72)}`);
      }
      if (r.do_differently) {
        lines.push(`${ANSI.yellow}>${ANSI.reset} ${truncate(r.do_differently, 72)}`);
      }
    }
  }

  // Decisions — title only, one line each
  if (params.decisions?.length) {
    lines.push("");
    for (const d of params.decisions) {
      lines.push(`  ${dimText("d")} ${truncate(d.title, 68)}`);
    }
  }

  // Scars applied — show titles with status indicator
  if (scarsApplied > 0) {
    lines.push("");
    for (const s of params.scars_to_record!.filter(s => s.reference_type !== "none")) {
      const indicator = s.reference_type === "refuted" ? `${ANSI.yellow}!${ANSI.reset}` : STATUS.pass;
      lines.push(`  ${indicator} ${truncate(s.reference_context || s.scar_identifier || "", 70)}`);
    }
  }

  // Transcript — only on failure
  if (transcriptStatus && !transcriptStatus.saved) {
    lines.push("");
    lines.push(`${STATUS.fail} transcript: ${transcriptStatus.error || "Unknown error"}`);
  }

  // Write health — only on failure
  const healthReport = getEffectTracker().getHealthReport();
  if (healthReport.overall.failed > 0) {
    lines.push("");
    lines.push(`${STATUS.warn} ${healthReport.overall.failed} write failure${healthReport.overall.failed > 1 ? "s" : ""}`);
  }

  return wrapDisplay(lines.join("\n"));
}

/**
 * GIT-21: Clean up all session files for a closed session.
 * Unregisters from registry, deletes per-session directory, and removes legacy file.
 */
function cleanupSessionFiles(sessionId: string): void {
  // 1. Unregister from active-sessions registry
  try {
    unregisterSession(sessionId);
  } catch (error) {
    console.warn("[session_close] Failed to unregister session:", error);
  }

  // 2. Delete per-session directory (sanitized via getSessionDir to prevent traversal)
  try {
    const sessionDir = getSessionDir(sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.error(`[session_close] Cleaned up session directory: ${sessionDir}`);
    }
  } catch (error) {
    console.warn("[session_close] Failed to clean up session directory:", error);
  }

  // Legacy active-session.json cleanup removed — file is no longer written
}

// UUID and short-ID format validation for session_id
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_REGEX = /^[0-9a-f]{8}$/i;

function isValidSessionId(id: string): boolean {
  return UUID_REGEX.test(id) || SHORT_ID_REGEX.test(id);
}

/**
 * Build the session data record from params and existing session state.
 * Handles retroactive vs normal mode, reflection, decisions, threads,
 * observations, children, linear_issue, and title updates.
 */
function buildSessionRecord(
  params: SessionCloseParams,
  existingSession: Record<string, unknown> | null,
  isRetroactive: boolean,
  agentIdentity: string,
  closeCompliance: CloseCompliance,
  sessionId: string,
): Record<string, unknown> {
  let sessionData: Record<string, unknown>;

  if (isRetroactive) {
    const now = new Date().toISOString();
    sessionData = {
      id: sessionId,
      agent: agentIdentity,
      project: "default",
      session_title: "Retroactive Session",
      session_date: now,
      created_at: now,
      close_compliance: closeCompliance,
    };
  } else {
    // Remove embedding from existing to avoid re-embedding unchanged text
    const { embedding: _embedding, ...existingWithoutEmbedding } = existingSession!;
    sessionData = {
      ...existingWithoutEmbedding,
      close_compliance: closeCompliance,
    };
  }

  // Add closing reflection if provided
  if (params.closing_reflection) {
    const reflection: Record<string, unknown> = { ...params.closing_reflection };
    if (params.human_corrections) {
      reflection.human_additions = params.human_corrections;
    }
    sessionData.closing_reflection = reflection;

    // Distill Q8+Q9 into rapport_summary for cross-agent surfacing
    const q8 = params.closing_reflection.collaborative_dynamic;
    const q9 = params.closing_reflection.rapport_notes;
    if (q8 || q9) {
      const parts = [q8, q9].filter(Boolean);
      sessionData.rapport_summary = parts.join(" | ");
    }
  }

  // Add decisions if provided
  if (params.decisions && params.decisions.length > 0) {
    sessionData.decisions = params.decisions.map((d) => d.title);
  }

  // : Normalize and merge open threads
  const sessionThreads = getThreads();
  if (params.open_threads && params.open_threads.length > 0) {
    const normalized = normalizeThreads(params.open_threads, params.session_id);
    const merged = sessionThreads.length > 0
      ? deduplicateThreadList(mergeThreadStates(normalized, sessionThreads))
      : deduplicateThreadList(normalized);
    sessionData.open_threads = merged;
  } else if (sessionThreads.length > 0) {
    sessionData.open_threads = sessionThreads;
  }

  // If project_state provided, prepend it to open_threads as a ThreadObject
  if (params.project_state) {
    const projectStateText = `PROJECT STATE: ${params.project_state}`;
    const existing = (sessionData.open_threads || []) as ThreadObject[];
    const filtered = existing.filter(t => {
      const text = typeof t === "string" ? t : t.text;
      return !text.startsWith("PROJECT STATE:");
    });
    sessionData.open_threads = [migrateStringThread(projectStateText, params.session_id), ...filtered];
  }

  // v2 Phase 2: Persist observations and children from multi-agent work
  const observations = getObservations();
  if (observations.length > 0) {
    sessionData.task_observations = observations;
  }
  const sessionChildren = getChildren();
  if (sessionChildren.length > 0) {
    sessionData.children = sessionChildren;
  }

  // Add linear issue if provided
  if (params.linear_issue) {
    sessionData.linear_issue = params.linear_issue;
  }

  // Update session title if we have meaningful content
  if (params.closing_reflection?.what_worked || params.decisions?.length) {
    const titleParts: string[] = [];
    if (params.linear_issue) {
      titleParts.push(params.linear_issue);
    }
    if (params.decisions?.length) {
      titleParts.push(params.decisions[0].title);
    } else if (params.closing_reflection?.what_worked) {
      titleParts.push(params.closing_reflection.what_worked.slice(0, 50));
    }
    if (
      titleParts.length > 0 &&
      (sessionData.session_title === "Interactive Session" ||
       sessionData.session_title === "Retroactive Session")
    ) {
      sessionData.session_title = titleParts.join(" - ");
    }
  }

  return sessionData;
}

/**
 * Capture and save the conversation transcript for a session.
 * Returns transcript status and optionally the Claude Code session ID.
 */
async function captureSessionTranscript(
  sessionId: string,
  params: SessionCloseParams,
  existingSession: Record<string, unknown> | null,
  isRetroactive: boolean,
): Promise<{ status?: TranscriptStatus; claudeSessionId?: string }> {
  try {
    let transcriptFilePath: string | null = null;

    // Option 1: Explicit transcript path provided
    if (params.transcript_path) {
      if (fs.existsSync(params.transcript_path)) {
        transcriptFilePath = params.transcript_path;
        console.error(`[session_close] Using explicit transcript path: ${transcriptFilePath}`);
      } else {
        console.warn(`[session_close] Explicit transcript path does not exist: ${params.transcript_path}`);
      }
    }

    // Option 2: Auto-detect by searching for most recent transcript
    if (!transcriptFilePath) {
      const homeDir = os.homedir();
      const projectsDir = path.join(homeDir, ".claude", "projects");
      const cwd = process.cwd();
      const projectDirName = path.basename(cwd);
      transcriptFilePath = findMostRecentTranscript(projectsDir, projectDirName, cwd);
      if (transcriptFilePath) {
        console.error(`[session_close] Auto-detected transcript: ${transcriptFilePath}`);
      } else {
        console.error(`[session_close] No transcript file found in ${projectsDir}`);
      }
    }

    if (!transcriptFilePath) return {};

    const transcriptContent = fs.readFileSync(transcriptFilePath, "utf-8");

    // Extract Claude Code session ID for traceability (sync, fast)
    const claudeSessionId = extractClaudeSessionId(transcriptContent, transcriptFilePath) || undefined;
    if (claudeSessionId) {
      console.error(`[session_close] Extracted Claude session ID: ${claudeSessionId}`);
    }

    // Deterministic transcript save — await to guarantee persistence
    const transcriptProject = isRetroactive ? "default" : (existingSession?.project as string | undefined);
    const saveResult = await saveTranscript({
      session_id: sessionId,
      transcript: transcriptContent,
      format: "json",
      project: transcriptProject,
    });

    if (saveResult.success && saveResult.transcript_path) {
      const status: TranscriptStatus = {
        saved: true,
        path: saveResult.transcript_path,
        size_kb: saveResult.size_kb,
        patch_warning: saveResult.patch_warning,
      };
      console.error(`[session_close] Transcript saved: ${saveResult.transcript_path} (${saveResult.size_kb}KB)`);

      // Process transcript for semantic search (fire-and-forget — chunking is expensive)
      processTranscript(sessionId, transcriptContent, transcriptProject)
        .then(result => {
          if (result.success) {
            console.error(`[session_close] Transcript chunking completed: ${result.chunksCreated} chunks created`);
          } else {
            console.warn(`[session_close] Transcript chunking failed: ${result.error}`);
          }
        }).catch(err => {
          console.error("[session_close] Transcript chunking error:", err);
        });

      return { status, claudeSessionId };
    } else {
      console.warn(`[session_close] Failed to save transcript: ${saveResult.error}`);
      return {
        status: { saved: false, error: saveResult.error || "Unknown save error" },
        claudeSessionId,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[session_close] Exception during transcript capture:", msg);
    return {
      status: { saved: false, error: `Exception during transcript capture: ${msg}` },
    };
  }
}

/**
 * Map confirmation decisions to scar_usage reference_type.
 * APPLYING = explicit compliance, N_A = acknowledged but not applicable, REFUTED = overridden.
 */
function decisionToRefType(decision: string): "explicit" | "acknowledged" | "refuted" {
  switch (decision) {
    case "APPLYING": return "explicit";
    case "N_A": return "acknowledged";
    case "REFUTED": return "refuted";
    default: return "acknowledged";
  }
}

/**
 * Auto-bridge Q6 answers (closing_reflection.scars_applied) to scar_usage records.
 * Uses three-pass matching:
 *   1. Structured confirmations from confirm_scars (preferred, includes variant_id)
 *   2. Q6 text matching for scars without confirmations (fallback)
 *   3. Unmatched surfaced scars recorded as "none"
 * Returns empty array if no surfaced scars available.
 */
function bridgeScarsToUsageRecords(
  normalizedScarsApplied: string[],
  sessionId: string,
  agentIdentity: string,
): ScarUsageEntry[] {
  try {
    // Load surfaced scars: prefer in-memory, fall back to per-session dir, then legacy file
    let surfacedScars: SurfacedScar[] = getSurfacedScars();

    if (surfacedScars.length === 0 && sessionId) {
      // GIT-21: Try per-session directory first
      try {
        const sessionFilePath = getSessionPath(sessionId, "session.json");
        if (fs.existsSync(sessionFilePath)) {
          const fileData = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
          if (fileData.surfaced_scars && Array.isArray(fileData.surfaced_scars)) {
            surfacedScars = fileData.surfaced_scars;
            console.error(`[session_close] Loaded ${surfacedScars.length} surfaced scars from per-session file`);
          }
        }
      } catch { /* per-session file read failed */ }
    }

    if (surfacedScars.length === 0) {
      console.error("[session_close] No surfaced scars available for auto-bridge");
      return [];
    }

    const autoBridgedScars: ScarUsageEntry[] = [];
    const matchedScarIds = new Set<string>();

    // Load structured confirmations from confirm_scars (start-of-task)
    const confirmations: ScarConfirmation[] = getConfirmations();
    const confirmationMap = new Map<string, ScarConfirmation>();
    for (const conf of confirmations) {
      confirmationMap.set(conf.scar_id, conf);
    }

    // Load end-of-session reflections from reflect_scars (end-of-task)
    // Reflections provide the most accurate execution_successful signal
    const reflections = getReflections();
    const reflectionMap = new Map<string, { outcome: string; evidence: string }>();
    for (const ref of reflections) {
      reflectionMap.set(ref.scar_id, { outcome: ref.outcome, evidence: ref.evidence });
    }

    // First pass: match surfaced scars against structured confirmations
    for (const scar of surfacedScars) {
      const confirmation = confirmationMap.get(scar.scar_id);
      if (confirmation) {
        matchedScarIds.add(scar.scar_id);

        // Prefer reflect_scars outcome over confirmation default
        // reflect_scars gives actual end-of-session evidence; confirm_scars is intent
        const reflection = reflectionMap.get(scar.scar_id);
        let executionSuccessful: boolean | undefined;
        let context: string;

        if (reflection) {
          // Reflection provides definitive signal
          executionSuccessful = reflection.outcome === "OBEYED" ? true : false;
          context = `${scar.scar_title.slice(0, 60)} (${reflection.outcome})`;
        } else {
          // Fall back to confirmation-based default
          // APPLYING/N_A = task proceeded normally (true), REFUTED = outcome unknown (null)
          executionSuccessful = confirmation.decision === "REFUTED" ? undefined : true;
          context = `${scar.scar_title.slice(0, 60)} (${confirmation.decision})`;
        }

        autoBridgedScars.push({
          scar_identifier: scar.scar_id,
          session_id: sessionId,
          agent: agentIdentity,
          surfaced_at: scar.surfaced_at,
          reference_type: decisionToRefType(confirmation.decision),
          reference_context: context,
          execution_successful: executionSuccessful,
          variant_id: scar.variant_id,
        });
      }
    }

    // Second pass: fallback to Q6 text matching for scars without confirmations
    for (const scarApplied of normalizedScarsApplied) {
      const lowerApplied = scarApplied.toLowerCase();

      const match = surfacedScars.find((s) => {
        if (matchedScarIds.has(s.scar_id)) return false;
        return (
          s.scar_id === scarApplied ||
          s.scar_title.toLowerCase().includes(lowerApplied) ||
          lowerApplied.includes(s.scar_title.toLowerCase())
        );
      });

      if (match) {
        matchedScarIds.add(match.scar_id);
        autoBridgedScars.push({
          scar_identifier: match.scar_id,
          session_id: sessionId,
          agent: agentIdentity,
          surfaced_at: match.surfaced_at,
          reference_type: "acknowledged",
          reference_context: `${match.scar_title.slice(0, 60)} (Q6 match)`,
          execution_successful: true,
          variant_id: match.variant_id,
        });
      }
    }

    // For surfaced scars NOT matched by either method, record as "none"
    // execution_successful = false — scar was surfaced but ignored entirely
    for (const scar of surfacedScars) {
      if (!matchedScarIds.has(scar.scar_id)) {
        autoBridgedScars.push({
          scar_identifier: scar.scar_id,
          session_id: sessionId,
          agent: agentIdentity,
          surfaced_at: scar.surfaced_at,
          reference_type: "none",
          reference_context: `${scar.scar_title.slice(0, 60)} (not addressed)`,
          execution_successful: false,
          variant_id: scar.variant_id,
        });
      }
    }

    if (autoBridgedScars.length > 0) {
      console.error(`[session_close] Auto-bridged ${autoBridgedScars.length} scar usage records (${matchedScarIds.size} acknowledged, ${autoBridgedScars.length - matchedScarIds.size} unmentioned)`);
    }

    return autoBridgedScars;
  } catch (bridgeError) {
    console.error("[session_close] Auto-bridge failed (non-fatal):", bridgeError);
    return [];
  }
}

/**
 * Execute session_close tool
 */
export async function sessionClose(
  params: SessionCloseParams
): Promise<SessionCloseResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // Validate session_id format before any DB calls
  if (params.session_id && !isValidSessionId(params.session_id)) {
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);
    return {
      success: false,
      session_id: params.session_id,
      close_compliance: {
        close_type: params.close_type,
        agent: "Unknown",
        checklist_displayed: false,
        questions_answered_by_agent: false,
        human_asked_for_corrections: false,
        learnings_stored: 0,
        scars_applied: 0,
      },
      validation_errors: [
        `Invalid session_id format: "${params.session_id}". Expected UUID (e.g., '393adb34-a80c-4c3a-b71a-bc0053b7a7ea') or short form (e.g., '393adb34'). Run session_start first.`,
      ],
      performance: perfData,
    };
  }

  // GIT-21: Recover session_id from active-sessions registry (hostname+PID) or legacy file
  if (!params.session_id && params.close_type !== "retroactive") {
    // Try registry first (GIT-20 writes here)
    try {
      const mySession = findSessionByHostPid(os.hostname(), process.pid);
      if (mySession) {
        console.error(`[session_close] Recovered session_id from registry: ${mySession.session_id}`);
        params = { ...params, session_id: mySession.session_id };
      }
    } catch (error) {
      console.warn("[session_close] Failed to check session registry:", error);
    }

    // Legacy active-session.json fallback removed — registry is the source of truth
  }

  // 0a. File-based payload handoff: if .gitmem/closing-payload.json exists,
  // merge it with inline params (inline params take precedence).
  // This keeps the visible MCP tool call small: just session_id + close_type.
  const payloadPath = getGitmemPath("closing-payload.json");
  let payloadConsumed = false;
  try {
    if (fs.existsSync(payloadPath)) {
      const filePayload = JSON.parse(fs.readFileSync(payloadPath, "utf-8")) as Partial<SessionCloseParams>;
      // File provides defaults; inline params override
      params = { ...filePayload, ...params };
      payloadConsumed = true;
      console.error(`[session_close] Loaded closing payload from ${payloadPath}`);
      // Payload file is cleaned up AFTER successful close (see end of function).
      // If the tool crashes, the payload survives for retry.
    }
  } catch (error) {
    console.warn("[session_close] Failed to read closing-payload.json:", error);
  }

  // Sanitize scars_to_record: agents frequently write create_learning shape
  // ({title, description, severity}) instead of ScarUsageEntry shape
  // ({scar_identifier, reference_type, reference_context}).
  // Filter out entries missing required fields to prevent crashes in formatCloseDisplay.
  if (Array.isArray(params.scars_to_record) && params.scars_to_record.length > 0) {
    const valid: typeof params.scars_to_record = [];
    for (const entry of params.scars_to_record) {
      if (entry && typeof entry === "object" && typeof entry.scar_identifier === "string" && entry.scar_identifier.length > 0) {
        valid.push(entry);
      } else {
        // Try to salvage: if agent wrote {title, description} instead of {scar_identifier, reference_context}
        const raw = entry as unknown as Record<string, unknown>;
        if (raw && typeof raw.title === "string" && raw.title.length > 0) {
          valid.push({
            scar_identifier: raw.title as string,
            reference_type: (typeof raw.reference_type === "string" ? raw.reference_type : "acknowledged") as "explicit" | "implicit" | "acknowledged" | "refuted" | "none",
            reference_context: (typeof raw.description === "string" ? raw.description : "auto-coerced from payload") as string,
            surfaced_at: new Date().toISOString(),
          });
          console.error(`[session_close] Coerced malformed scar entry "${raw.title}" → scar_identifier`);
        } else {
          console.error(`[session_close] Dropped malformed scars_to_record entry: ${JSON.stringify(entry).slice(0, 100)}`);
        }
      }
    }
    params.scars_to_record = valid.length > 0 ? valid : undefined;
  }

  // Normalize closing_reflection field aliases (q1_broke → what_broke, etc.)
  // Agents frequently guess field names instead of using canonical keys from CLOSING_QUESTIONS.
  if (params.closing_reflection && typeof params.closing_reflection === "object") {
    params.closing_reflection = normalizeReflectionKeys(
      params.closing_reflection as unknown as Record<string, unknown>
    ) as unknown as typeof params.closing_reflection;
  }

  // Normalize task_completion: if agent passed a string, wrap it in the expected object shape
  if (params.task_completion && typeof params.task_completion === "string") {
    const now = new Date().toISOString();
    const fiveSecsAgo = new Date(Date.now() - 5000).toISOString();
    (params as unknown as Record<string, unknown>).task_completion = {
      questions_displayed_at: fiveSecsAgo,
      reflection_completed_at: fiveSecsAgo,
      human_asked_at: fiveSecsAgo,
      human_response_at: now,
      human_response: "auto-normalized from string payload",
    };
  }

  // Auto-generate task_completion when missing or has empty human response fields.
  // Agents write closing_reflection to the payload before asking the human, so
  // human_response_at and human_response are often empty. Rather than requiring
  // agents to edit the payload a second time, we fill these from human_corrections
  // (which the agent passes directly) and stamp the current time.
  if (params.close_type === "standard" && params.task_completion && typeof params.task_completion === "object") {
    const tc = params.task_completion as unknown as Record<string, string>;
    if (!tc.human_response || tc.human_response.trim() === "") {
      tc.human_response = params.human_corrections || "none";
      console.error("[session_close] Auto-filled task_completion.human_response from human_corrections");
    }
    if (!tc.human_response_at || tc.human_response_at.trim() === "") {
      tc.human_response_at = new Date().toISOString();
      console.error("[session_close] Auto-filled task_completion.human_response_at with current time");
    }
  }

  // Auto-generate task_completion entirely when payload has closing_reflection but no task_completion.
  // This is the common case: agent writes reflection to payload, asks human, calls session_close.
  if (params.close_type === "standard" && !params.task_completion && params.closing_reflection) {
    const now = new Date().toISOString();
    const fiveSecsAgo = new Date(Date.now() - 5000).toISOString();
    (params as unknown as Record<string, unknown>).task_completion = {
      questions_displayed_at: fiveSecsAgo,
      reflection_completed_at: fiveSecsAgo,
      human_asked_at: fiveSecsAgo,
      human_response_at: now,
      human_response: params.human_corrections || "none",
    };
    console.error("[session_close] Auto-generated task_completion from closing_reflection + human_corrections");
  }

  // Adaptive ceremony level based on session activity.
  // Three levels: micro (quick fix), standard (normal), full (long/heavy session).
  // t-f7c2fa01: If closing_reflection is already present, skip the mismatch gate.
  const hasReflection = params.closing_reflection &&
    Object.keys(params.closing_reflection).length > 0;
  const activity = getSessionActivity();

  // Compute recommended ceremony level
  let recommendedLevel: "micro" | "standard" | "full" = "standard";
  if (activity) {
    const isMinimal = activity.recall_count === 0 &&
                      activity.observation_count === 0 &&
                      activity.children_count === 0;

    if (activity.duration_min < 15 && isMinimal) {
      recommendedLevel = "micro";
    } else if (activity.duration_min >= 60 || activity.recall_count >= 3 ||
               activity.observation_count >= 3) {
      recommendedLevel = "full";
    }
  }

  if (activity && params.close_type && !hasReflection) {
    const isMinimal = activity.recall_count === 0 &&
                      activity.observation_count === 0 &&
                      activity.children_count === 0;

    // Suggest micro for short sessions requesting standard (soft nudge, not rejection)
    if (params.close_type === "standard" && recommendedLevel === "micro") {
      console.error(
        `[session_close] Hint: session qualifies for "quick" close ` +
        `(${Math.round(activity.duration_min)} min, no substantive activity). ` +
        `Proceeding with standard as requested.`
      );
    }

    if (params.close_type === "quick" && recommendedLevel === "full") {
      // Warn but don't reject — agent chose quick on a substantive session
      console.error(
        `[session_close] Warning: "quick" close on substantive session ` +
        `(${Math.round(activity.duration_min)} min, ${activity.recall_count} recalls, ` +
        `${activity.observation_count} observations). Consider "standard" close.`
      );
    }
  }

  // Free tier: simple local persistence, skip Supabase recovery and compliance
  if (!hasSupabase()) {
    return sessionCloseFree(params, timer);
  }

  // 0b. If still no session_id, fall back to Supabase query for unclosed session from today
  if (!params.session_id && params.close_type !== "retroactive") {
    const env = detectAgent();
    const agent = env.agent;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
      const sessions = await supabase.listRecords<{
        id: string;
        session_date: string;
        close_compliance: Record<string, unknown> | null;
      }>({
        table: getTableName("sessions_lite"),
        filters: { agent },
        limit: 10,
        orderBy: { column: "created_at", ascending: false },
      });

      // Find most recent unclosed session from today
      const unclosedToday = sessions.find(s =>
        !s.close_compliance &&
        s.session_date?.startsWith(today)
      );

      if (unclosedToday) {
        console.error(`[session_close] Found unclosed session from today: ${unclosedToday.id}`);
        params = { ...params, session_id: unclosedToday.id };
      } else {
        // No unclosed session found - STOP and require session_id
        const latencyMs = timer.stop();
        const perfData = buildPerformanceData("session_close", latencyMs, 0);
        return {
          success: false,
          session_id: "",  // Empty string when no session found
          close_compliance: {
            close_type: params.close_type,
            agent,
            checklist_displayed: false,
            questions_answered_by_agent: false,
            human_asked_for_corrections: false,
            learnings_stored: 0,
            scars_applied: 0,
          },
          validation_errors: [
            "No session_id provided and no unclosed session found from today.",
            "Please call session_start first or provide the session_id from an earlier session_start.",
            `Sessions checked: ${sessions.length}, none unclosed from today (${today})`
          ],
          performance: perfData,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("session_close", latencyMs, 0);
      return {
        success: false,
        session_id: "",  // Empty string when search fails
        close_compliance: {
          close_type: params.close_type,
          agent,
          checklist_displayed: false,
          questions_answered_by_agent: false,
          human_asked_for_corrections: false,
          learnings_stored: 0,
          scars_applied: 0,
        },
        validation_errors: [
          `Failed to search for unclosed sessions: ${errorMessage}`,
          "Please provide session_id explicitly."
        ],
        performance: perfData,
      };
    }
  }

  // 1. Validate parameters
  const validation = validateSessionClose(params);

  if (!validation.valid) {
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);
    return {
      success: false,
      session_id: params.session_id,
      close_compliance: {
        close_type: params.close_type,
        agent: "Unknown",
        checklist_displayed: false,
        questions_answered_by_agent: false,
        human_asked_for_corrections: false,
        learnings_stored: 0,
        scars_applied: 0,
      },
      validation_errors: validation.errors,
      performance: perfData,
    };
  }

  // 2. Get agent identity
  const env = detectAgent();
  const agentIdentity = env.agent;

  // 3. Build close compliance
  const learningsCount = params.learnings_created?.length || 0;
  const closeCompliance = buildCloseCompliance(
    params,
    agentIdentity,
    learningsCount
  );

  // Add ceremony duration if provided
  if (params.ceremony_duration_ms !== undefined) {
    closeCompliance.ceremony_duration_ms = params.ceremony_duration_ms;
  }

  // 4. Handle retroactive vs normal close modes
  const isRetroactive = params.close_type === "retroactive";
  let sessionId: string;
  let existingSession: Record<string, unknown> | null = null;

  if (isRetroactive) {
    // Retroactive mode: generate new session_id, create from scratch
    // Only used when explicitly requested (not auto-triggered)
    sessionId = uuidv4();
  } else {
    // Normal mode: require existing session
    sessionId = params.session_id;

    // Try Supabase first
    try {
      existingSession = await supabase.getRecord<Record<string, unknown>>(
        getTableName("sessions"),
        sessionId
      );
    } catch {
      // Supabase might not be configured (free tier) or session not found
    }

    // Fall back to local per-session file if Supabase didn't find it
    if (!existingSession) {
      try {
        const localSessionPath = getSessionPath(sessionId, "session.json");
        if (fs.existsSync(localSessionPath)) {
          const localData = JSON.parse(fs.readFileSync(localSessionPath, "utf-8"));
          existingSession = {
            id: sessionId,
            session_date: localData.started_at?.split("T")[0] || new Date().toISOString().split("T")[0],
            agent: localData.agent,
            project: localData.project,
            ...localData,
          };
          console.error(`[session_close] Session found in local file (not in Supabase)`);
        }
      } catch {
        // Local file read failed
      }
    }

    // Fall back to active-sessions registry as last resort
    if (!existingSession) {
      try {
        const mySession = findSessionByHostPid(os.hostname(), process.pid);
        if (mySession && mySession.session_id === sessionId) {
          existingSession = {
            id: sessionId,
            session_date: mySession.started_at?.split("T")[0] || new Date().toISOString().split("T")[0],
            agent: mySession.agent,
            project: mySession.project,
          };
          console.error(`[session_close] Session found in registry (not in Supabase or local file)`);
        }
      } catch {
        // Registry lookup failed
      }
    }

    if (!existingSession) {
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("session_close", latencyMs, 0);
      return {
        success: false,
        session_id: sessionId,
        close_compliance: closeCompliance,
        validation_errors: [`Session ${sessionId} not found in Supabase, local files, or registry. Was session_start called?`],
        performance: perfData,
      };
    }
  }

  // 5. Build session data (merge with existing or create from scratch)
  const sessionData = buildSessionRecord(
    params, existingSession, isRetroactive, agentIdentity, closeCompliance, sessionId
  );

  // Sync threads to Supabase (fire-and-forget, non-blocking)
  const closeThreads = (sessionData.open_threads || []) as ThreadObject[];
  if (closeThreads.length > 0) {
    const closeProject = isRetroactive ? "default" : (existingSession?.project as string | undefined) || "default";
    syncThreadsToSupabase(closeThreads, closeProject, sessionId).catch((err) => {
      console.error("[session_close] Thread Supabase sync failed (non-fatal):", err);
    });
  }

  // Prune threads.json: only keep open threads
  try {
    const openThreadsOnly = closeThreads.filter(t => t.status === "open" || !t.status);
    saveThreadsFile(openThreadsOnly);
    console.error(`[session_close] Pruned threads.json: ${openThreadsOnly.length} open threads (removed ${closeThreads.length - openThreadsOnly.length} resolved/archived)`);
  } catch (err) {
    console.error("[session_close] Failed to prune threads.json (non-fatal):", err);
  }

  // Capture transcript if enabled (default true for CLI/DAC)
  // Split into two phases: sync ID extraction (fast) + async upload (fire-and-forget)
  let transcriptStatus: TranscriptStatus | undefined;
  const shouldCaptureTranscript = params.capture_transcript !== false &&
    (agentIdentity === "cli" || agentIdentity === "desktop");

  if (shouldCaptureTranscript) {
    // Phase 1: Find transcript and extract Claude session ID (sync, ~10ms)
    const transcriptFilePath = findTranscriptPath(params.transcript_path);
    if (transcriptFilePath) {
      const transcriptContent = fs.readFileSync(transcriptFilePath, "utf-8");
      const claudeSessionId = extractClaudeSessionId(transcriptContent, transcriptFilePath) || undefined;
      if (claudeSessionId) {
        sessionData.claude_code_session_id = claudeSessionId;
        console.error(`[session_close] Extracted Claude session ID: ${claudeSessionId}`);
      }

      // Phase 2: Upload transcript (fire-and-forget — was blocking ~500-5000ms)
      const transcriptProject = isRetroactive ? "default" : (existingSession?.project as string | undefined);
      getEffectTracker().track("transcript", "session_close", async () => {
        const saveResult = await saveTranscript({
          session_id: sessionId,
          transcript: transcriptContent,
          format: "json",
          project: transcriptProject,
        });
        if (saveResult.success && saveResult.transcript_path) {
          console.error(`[session_close] Transcript saved: ${saveResult.transcript_path} (${saveResult.size_kb}KB)`);
          // Process transcript for semantic search (chained fire-and-forget)
          processTranscript(sessionId, transcriptContent, transcriptProject)
            .then(result => {
              if (result.success) {
                console.error(`[session_close] Transcript processed: ${result.chunksCreated} chunks`);
              }
            })
            .catch((err) => console.error("[session_close] Transcript processing failed:", err instanceof Error ? err.message : err));
        }
      });
    }
  }

  // Auto-bridge Q6 answers to scar_usage records
  const normalizedScarsApplied = normalizeScarsApplied(params.closing_reflection?.scars_applied);
  // Auto-bridge surfaced scars to usage records whenever no explicit scars_to_record.
  // Fires even when Q6 is empty — Pass 1 matches confirmations, Pass 3 catches ignored scars.
  if (!params.scars_to_record || params.scars_to_record.length === 0) {
    const bridgedScars = bridgeScarsToUsageRecords(normalizedScarsApplied, sessionId, agentIdentity);
    if (bridgedScars.length > 0) {
      params = { ...params, scars_to_record: bridgedScars };
    }
  }

  // 6. Persist to Supabase (direct REST API, bypasses ww-mcp)
  try {
    // Upsert session WITHOUT embedding (fast path)
    // Embedding + thread detection run fire-and-forget after
    await supabase.directUpsert(getTableName("sessions"), sessionData);

    // Tracked fire-and-forget embedding generation + session update + thread detection
    if (isEmbeddingAvailable()) {
      getEffectTracker().track("embedding", "session_close", async () => {
        const embeddingParts = [
          sessionData.session_title as string || "",
          params.closing_reflection?.what_worked || "",
          params.closing_reflection?.what_broke || "",
          ...(params.open_threads || []).map(t => typeof t === "string" ? t : t.text),
        ].filter(Boolean);
        const embeddingText = embeddingParts.join(" | ");
        if (embeddingText.length > 10) {
          const embeddingVector = await embed(embeddingText);
          if (embeddingVector) {
            const embeddingJson = JSON.stringify(embeddingVector);
            // Update session with embedding (PATCH, not upsert — row already exists)
            await supabase.directPatch(getTableName("sessions"),
              { id: sessionId },
              { embedding: embeddingJson }
            );
            console.error("[session_close] Embedding saved to session");

            // Phase 5: Implicit thread detection (chained after embedding)
            const suggestProject: string = (existingSession?.project as string) || "default";
            const recentSessions = await loadRecentSessionEmbeddings(suggestProject, 30, 20);
            const threadEmbs = await loadOpenThreadEmbeddings(suggestProject);
            if (recentSessions && threadEmbs) {
              const existing = loadSuggestions();
              const updated = detectSuggestedThreads(
                { session_id: sessionId, title: sessionData.session_title as string, embedding: embeddingVector },
                recentSessions,
                threadEmbs,
                existing
              );
              saveSuggestions(updated);
            }
          }
        }
      });
    }

    // Tracked fire-and-forget scar usage recording (was blocking ~200-500ms)
    // scars_to_record may now come from auto-bridge above
    if (params.scars_to_record && params.scars_to_record.length > 0) {
      const project = isRetroactive
        ? "default"
        : (existingSession!.project as string | undefined);
      getEffectTracker().track("scar_usage", "session_close_batch", () =>
        recordScarUsageBatch({
          scars: params.scars_to_record!,
          project,
        })
      );
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 1);

    // Update relevance data for memories applied during session
    if (normalizedScarsApplied.length > 0) {
      updateRelevanceData(sessionId, normalizedScarsApplied).catch((err) => console.error("[session_close] updateRelevanceData failed:", err instanceof Error ? err.message : err));
    }

    // Compute timing breakdown from task_completion timestamps.
    // The human feels two things during close:
    //   1. Agent reflection: questions_displayed_at → human_asked_at (LLM writes 9-question payload)
    //   2. Tool execution: latency_ms (DB writes after human says "none" / gives corrections)
    // The human does NOT feel: human_asked_at → human_response_at (their own thinking time)
    let agentReflectionMs: number | undefined;
    let humanWaitTimeMs: number | undefined;
    if (params.task_completion && typeof params.task_completion === "object") {
      const tc = params.task_completion as unknown as Record<string, string>;
      // Agent reflection time = when questions shown → when closing prompt shown
      if (tc.questions_displayed_at && tc.human_asked_at) {
        const started = new Date(tc.questions_displayed_at).getTime();
        const askedHuman = new Date(tc.human_asked_at).getTime();
        if (!isNaN(started) && !isNaN(askedHuman) && askedHuman > started) {
          agentReflectionMs = askedHuman - started;
        }
      }
      // Human wait time = closing prompt → human responds
      if (tc.human_asked_at && tc.human_response_at) {
        const asked = new Date(tc.human_asked_at).getTime();
        const responded = new Date(tc.human_response_at).getTime();
        if (!isNaN(asked) && !isNaN(responded) && responded > asked) {
          humanWaitTimeMs = responded - asked;
        }
      }
    }

    // Record metrics
    recordMetrics({
      id: metricsId,
      session_id: sessionId,
      agent: agentIdentity as "cli" | "desktop" | "autonomous" | "local" | "cloud",
      tool_name: "session_close",
      tables_searched: [getTableName("sessions")],
      latency_ms: latencyMs,
      result_count: 1,
      phase_tag: "session_close",
      linear_issue: params.linear_issue,
      metadata: {
        close_type: params.close_type,
        learnings_created: learningsCount,
        scars_applied: closeCompliance.scars_applied,
        decisions_count: params.decisions?.length || 0,
        open_threads_count: params.open_threads?.length || 0,
        ceremony_duration_ms: params.ceremony_duration_ms,
        agent_reflection_ms: agentReflectionMs,
        human_wait_time_ms: humanWaitTimeMs,
        retroactive: isRetroactive,
      },
    }).catch(() => {});

    // Clear session state after successful close
    clearCurrentSession();

    // Generate agent-briefing.md for PMEM bridge
    const decisionsCount = params.decisions?.length || 0;
    await writeAgentBriefing(learningsCount, decisionsCount);

    // GIT-21: Clean up session files (registry, per-session dir, legacy file)
    cleanupSessionFiles(sessionId);

    // Clean up payload file AFTER successful close (not before — crash safety)
    if (payloadConsumed) {
      try { fs.unlinkSync(payloadPath); } catch { /* already gone */ }
    }

    const display = formatCloseDisplay(sessionId, closeCompliance, params, learningsCount, true, validation.warnings.length > 0 ? validation.warnings : undefined, transcriptStatus);

    return {
      success: true,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: validation.warnings.length > 0 ? validation.warnings : undefined,
      performance: perfData,
      display,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);

    // Clear session state even on error (session is done either way)
    clearCurrentSession();

    const errorDisplay = formatCloseDisplay(sessionId, closeCompliance, params, learningsCount, false, [`Failed to persist session: ${errorMessage}`], transcriptStatus);

    return {
      success: false,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: [`Failed to persist session: ${errorMessage}`],
      performance: perfData,
      display: errorDisplay,
    };
  }
}
