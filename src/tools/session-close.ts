/**
 * session_close Tool
 *
 * Persist session with compliance validation.
 * Validates that required fields are present based on close type.
 *
 * Performance target: <3000ms (OD-429)
 */

import { v4 as uuidv4 } from "uuid";
import { detectAgent } from "../services/agent-detection.js";
import * as supabase from "../services/supabase-client.js";
import { embed, isEmbeddingAvailable } from "../services/embedding.js";
import { hasSupabase } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import { clearCurrentSession, getSurfacedScars, getObservations, getChildren } from "../services/session-state.js"; // OD-547, OD-552, v2 Phase 2
import {
  validateSessionClose,
  buildCloseCompliance,
} from "../services/compliance-validator.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
  updateRelevanceData,
} from "../services/metrics.js";
import { recordScarUsageBatch } from "./record-scar-usage-batch.js";
import { saveTranscript } from "./save-transcript.js";
import { processTranscript } from "../services/transcript-chunker.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  SessionCloseParams,
  SessionCloseResult,
  CloseCompliance,
  SurfacedScar,
  ScarUsageEntry,
} from "../types/index.js";

/**
 * Find the most recently modified transcript file in Claude Code projects directory
 * OD-538: Search by recency, not by filename matching (supports post-compaction)
 */
function findMostRecentTranscript(projectsDir: string, cwdBasename: string, cwdFull: string): string | null {
  // Claude Code names project dirs by replacing / with - in the full CWD path
  // e.g., /Users/chriscrawford/nTEG-Labs -> -Users-chriscrawford-nTEG-Labs
  const claudeCodeDirName = cwdFull.replace(/\//g, "-");

  const possibleDirs = [
    path.join(projectsDir, claudeCodeDirName),  // Primary: full path with dashes (e.g., -Users-chriscrawford-nTEG-Labs)
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
 * OD-538: Provides traceability between GitMem sessions and IDE sessions
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
    scars_applied: params.closing_reflection?.scars_applied?.length || 0,
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

    if (params.open_threads && params.open_threads.length > 0) {
      sessionData.open_threads = params.open_threads;
    }

    if (params.project_state) {
      const projectStateThread = `PROJECT STATE: ${params.project_state}`;
      const existing = (sessionData.open_threads as string[]) || [];
      const filtered = existing.filter((t) => !t.startsWith("PROJECT STATE:"));
      sessionData.open_threads = [projectStateThread, ...filtered];
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

    // Clear session state
    clearCurrentSession();

    // Clean up active session file
    try {
      const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
      if (fs.existsSync(activeSessionPath)) {
        fs.unlinkSync(activeSessionPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 1);

    return {
      success: true,
      session_id: sessionId,
      close_compliance: closeCompliance,
      performance: perfData,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    clearCurrentSession();
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);

    return {
      success: false,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: [`Failed to persist session: ${errorMessage}`],
      performance: perfData,
    };
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

  // 0. If session_id is missing, try to recover from .gitmem/active-session.json first (OD-549)
  // This file survives context compaction — written by session_start, read here.
  if (!params.session_id && params.close_type !== "retroactive") {
    try {
      const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
      if (fs.existsSync(activeSessionPath)) {
        const activeSession = JSON.parse(fs.readFileSync(activeSessionPath, "utf-8"));
        if (activeSession.session_id) {
          console.error(`[session_close] Recovered session_id from active-session.json: ${activeSession.session_id}`);
          params = { ...params, session_id: activeSession.session_id };
        }
      }
    } catch (error) {
      console.warn("[session_close] Failed to read active-session.json:", error);
    }
  }

  // 0a. File-based payload handoff: if .gitmem/closing-payload.json exists,
  // merge it with inline params (inline params take precedence).
  // This keeps the visible MCP tool call small: just session_id + close_type.
  const payloadPath = path.join(process.cwd(), ".gitmem", "closing-payload.json");
  try {
    if (fs.existsSync(payloadPath)) {
      const filePayload = JSON.parse(fs.readFileSync(payloadPath, "utf-8")) as Partial<SessionCloseParams>;
      // File provides defaults; inline params override
      params = { ...filePayload, ...params };
      console.error(`[session_close] Loaded closing payload from ${payloadPath}`);
      // Clean up payload file
      try { fs.unlinkSync(payloadPath); } catch { /* ignore */ }
    }
  } catch (error) {
    console.warn("[session_close] Failed to read closing-payload.json:", error);
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
        table: "orchestra_sessions_lite",
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
    // Normal mode: require existing session (guaranteed to exist by step 0 above)
    sessionId = params.session_id;

    try {
      existingSession = await supabase.getRecord<Record<string, unknown>>(
        "orchestra_sessions",
        sessionId
      );
    } catch {
      // Session might not exist yet, which is fine
    }

    if (!existingSession) {
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("session_close", latencyMs, 0);
      return {
        success: false,
        session_id: sessionId,
        close_compliance: closeCompliance,
        validation_errors: [`Session ${sessionId} not found. Was session_start called?`],
        performance: perfData,
      };
    }
  }

  // 5. Build session data (merge with existing or create from scratch)
  let sessionData: Record<string, unknown>;

  if (isRetroactive) {
    // Retroactive mode: create minimal session from scratch
    const now = new Date().toISOString();
    sessionData = {
      id: sessionId,
      agent: agentIdentity,
      project: "orchestra_dev", // Default for retroactive
      session_title: "Retroactive Session", // Will be updated below if we have content
      session_date: now,
      created_at: now,
      close_compliance: closeCompliance,
    };
  } else {
    // Normal mode: merge with existing session
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

    // Add human corrections to reflection if provided
    if (params.human_corrections) {
      reflection.human_additions = params.human_corrections;
    }
    sessionData.closing_reflection = reflection;
  }

  // Add decisions if provided
  if (params.decisions && params.decisions.length > 0) {
    sessionData.decisions = params.decisions.map((d) => d.title);
  }

  // Add open threads if provided (OD-534: project_state auto-prepends)
  if (params.open_threads && params.open_threads.length > 0) {
    sessionData.open_threads = params.open_threads;
  }

  // OD-534: If project_state provided, prepend it to open_threads
  if (params.project_state) {
    const projectStateThread = `PROJECT STATE: ${params.project_state}`;
    const existing = sessionData.open_threads as string[] || [];
    // Replace existing PROJECT STATE if present, otherwise prepend
    const filtered = existing.filter(t => !t.startsWith("PROJECT STATE:"));
    sessionData.open_threads = [projectStateThread, ...filtered];
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
      // Use first 50 chars of what_worked as title hint
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

  // OD-538: Capture transcript if enabled (default true for CLI/DAC)
  const shouldCaptureTranscript = params.capture_transcript !== false &&
    (agentIdentity === "CLI" || agentIdentity === "DAC");

  if (shouldCaptureTranscript) {
    try {
      let transcriptFilePath: string | null = null;

      // Option 1: Explicit transcript path provided (overrides auto-detection)
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

      // If we found a transcript, capture it
      if (transcriptFilePath) {
        const transcriptContent = fs.readFileSync(transcriptFilePath, "utf-8");

        // Extract Claude Code session ID for traceability
        const claudeSessionId = extractClaudeSessionId(transcriptContent, transcriptFilePath);
        if (claudeSessionId) {
          sessionData.claude_code_session_id = claudeSessionId;
          console.error(`[session_close] Extracted Claude session ID: ${claudeSessionId}`);
        }

        // Call save_transcript tool
        const saveResult = await saveTranscript({
          session_id: sessionId,
          transcript: transcriptContent,
          format: "json",
          project: isRetroactive ? "orchestra_dev" : (existingSession?.project as "orchestra_dev" | "weekend_warrior" | undefined),
        });

        if (saveResult.success && saveResult.transcript_path) {
          sessionData.transcript_path = saveResult.transcript_path;
          console.error(`[session_close] Transcript saved: ${saveResult.transcript_path} (${saveResult.size_kb}KB)`);

          // OD-540: Process transcript for semantic search (async, don't block session close)
          processTranscript(
            sessionId,
            transcriptContent,
            isRetroactive ? "orchestra_dev" : (existingSession?.project as "orchestra_dev" | "weekend_warrior" | undefined)
          ).then(result => {
            if (result.success) {
              console.error(`[session_close] Transcript chunking completed: ${result.chunksCreated} chunks created`);
            } else {
              console.warn(`[session_close] Transcript chunking failed: ${result.error}`);
            }
          }).catch(err => {
            console.error("[session_close] Transcript chunking error:", err);
          });
        } else {
          console.warn(`[session_close] Failed to save transcript: ${saveResult.error}`);
        }
      }
    } catch (error) {
      // Don't fail session close if transcript capture fails
      console.error("[session_close] Exception during transcript capture:", error);
    }
  }

  // OD-552: Auto-bridge Q6 answers (closing_reflection.scars_applied) to scar_usage records
  // This is the core fix: CLI/DAC sessions answer Q6 with scar names but these never
  // became structured scar_usage records. Now we match Q6 answers against surfaced scars.
  if (
    (!params.scars_to_record || params.scars_to_record.length === 0) &&
    params.closing_reflection?.scars_applied?.length
  ) {
    try {
      // Load surfaced scars: prefer in-memory, fall back to active-session.json
      let surfacedScars: SurfacedScar[] = getSurfacedScars();

      if (surfacedScars.length === 0) {
        // Fall back to file-based surfaced scars
        try {
          const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
          if (fs.existsSync(activeSessionPath)) {
            const activeSession = JSON.parse(fs.readFileSync(activeSessionPath, "utf-8"));
            if (activeSession.surfaced_scars && Array.isArray(activeSession.surfaced_scars)) {
              surfacedScars = activeSession.surfaced_scars;
              console.error(`[session_close] Loaded ${surfacedScars.length} surfaced scars from active-session.json`);
            }
          }
        } catch (fileError) {
          console.warn("[session_close] Failed to load surfaced scars from file:", fileError);
        }
      }

      if (surfacedScars.length > 0) {
        const autoBridgedScars: ScarUsageEntry[] = [];
        const matchedScarIds = new Set<string>();

        // For each Q6 answer, try to match against surfaced scars
        for (const scarApplied of params.closing_reflection.scars_applied) {
          const lowerApplied = scarApplied.toLowerCase();

          // Match by UUID or title substring
          const match = surfacedScars.find((s) => {
            if (matchedScarIds.has(s.scar_id)) return false; // Don't double-match
            return (
              s.scar_id === scarApplied || // Exact UUID match
              s.scar_title.toLowerCase().includes(lowerApplied) || // Title contains answer
              lowerApplied.includes(s.scar_title.toLowerCase()) // Answer contains title
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
              reference_context: `Auto-bridged from Q6 answer: "${scarApplied}"`,
            });
          }
        }

        // For surfaced scars NOT mentioned in Q6, record as "none" (surfaced but ignored)
        for (const scar of surfacedScars) {
          if (!matchedScarIds.has(scar.scar_id)) {
            autoBridgedScars.push({
              scar_identifier: scar.scar_id,
              session_id: sessionId,
              agent: agentIdentity,
              surfaced_at: scar.surfaced_at,
              reference_type: "none",
              reference_context: `Surfaced during ${scar.source} but not mentioned in closing reflection`,
            });
          }
        }

        if (autoBridgedScars.length > 0) {
          params = { ...params, scars_to_record: autoBridgedScars };
          console.error(`[session_close] Auto-bridged ${autoBridgedScars.length} scar usage records (${matchedScarIds.size} acknowledged, ${autoBridgedScars.length - matchedScarIds.size} unmentioned)`);
        }
      } else {
        console.error("[session_close] No surfaced scars available for auto-bridge");
      }
    } catch (bridgeError) {
      console.error("[session_close] Auto-bridge failed (non-fatal):", bridgeError);
    }
  }

  // 6. Persist to Supabase (direct REST API, bypasses ww-mcp)
  try {
    // Generate embedding for session data
    if (isEmbeddingAvailable()) {
      try {
        const embeddingParts = [
          sessionData.session_title as string || "",
          params.closing_reflection?.what_worked || "",
          params.closing_reflection?.what_broke || "",
          ...(params.open_threads || []),
        ].filter(Boolean);
        const embeddingText = embeddingParts.join(" | ");
        if (embeddingText.length > 10) {
          const embeddingVector = await embed(embeddingText);
          if (embeddingVector) {
            sessionData.embedding = JSON.stringify(embeddingVector);
          }
        }
      } catch (embError) {
        console.warn("[session_close] Embedding generation failed (non-fatal):", embError);
      }
    }

    await supabase.directUpsert("orchestra_sessions", sessionData);

    // 7. Record scar usage if provided (parallel with metrics)
    // OD-552: scars_to_record may now come from auto-bridge above
    let scarRecordingResults;
    if (params.scars_to_record && params.scars_to_record.length > 0) {
      const project = isRetroactive
        ? "orchestra_dev"
        : (existingSession!.project as "orchestra_dev" | "weekend_warrior" | undefined);
      scarRecordingResults = await recordScarUsageBatch({
        scars: params.scars_to_record,
        project,
      });
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 1);

    // Update relevance data for memories applied during session
    if (params.closing_reflection?.scars_applied?.length) {
      updateRelevanceData(sessionId, params.closing_reflection.scars_applied).catch(() => {});
    }

    // Record metrics
    recordMetrics({
      id: metricsId,
      session_id: sessionId,
      agent: agentIdentity as "CLI" | "DAC" | "CODA-1" | "Brain_Local" | "Brain_Cloud",
      tool_name: "session_close",
      tables_searched: ["orchestra_sessions"],
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
        scars_recorded_batch: scarRecordingResults?.resolved_count || 0,
        scars_failed_batch: scarRecordingResults?.failed_count || 0,
        retroactive: isRetroactive,
      },
    }).catch(() => {});

    // OD-547: Clear session state after successful close
    clearCurrentSession();

    // OD-549: Clean up active session file
    try {
      const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
      if (fs.existsSync(activeSessionPath)) {
        fs.unlinkSync(activeSessionPath);
        console.error("[session_close] Cleaned up active-session.json");
      }
    } catch (error) {
      console.warn("[session_close] Failed to clean up active-session.json:", error);
    }

    return {
      success: true,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: validation.warnings.length > 0 ? validation.warnings : undefined,
      performance: perfData,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("session_close", latencyMs, 0);

    // OD-547: Clear session state even on error (session is done either way)
    clearCurrentSession();

    return {
      success: false,
      session_id: sessionId,
      close_compliance: closeCompliance,
      validation_errors: [`Failed to persist session: ${errorMessage}`],
      performance: perfData,
    };
  }
}
