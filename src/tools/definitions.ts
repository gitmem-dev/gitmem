/**
 * MCP Tool Definitions
 *
 * All tool registrations (names, descriptions, JSON schemas) for the GitMem MCP server.
 * Extracted from server.ts for maintainability.
 */

import {
  hasBatchOperations,
  hasTranscripts,
  hasCacheManagement,
  hasSupabase,
  hasFullAliases,
} from "../services/tier.js";


/**
 * Tool definitions for MCP
 */
export const TOOLS = [
  {
    name: "recall",
    description: "Check institutional memory for relevant scars before taking action. Returns matching scars and their lessons. Integrates variant assignment when issue_id provided.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What you're about to do (e.g., 'implement auth layer', 'deploy to production')",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        match_count: {
          type: "number",
          description: "Number of scars to return (default: 3)",
        },
        issue_id: {
          type: "string",
          description: "Linear issue identifier for variant assignment (e.g., 'PROJ-123'). When provided, scars with variants will be randomly assigned and formatted accordingly.",
        },
        similarity_threshold: {
          type: "number",
          description: "Minimum similarity score (0-1) to include results. Weak matches below threshold are suppressed. Default: 0.4 (free tier BM25), 0.35 (pro tier embeddings).",
        },
      },
      required: ["plan"],
    },
  },
  {
    name: "confirm_scars",
    description: "Confirm surfaced scars with APPLYING/N_A/REFUTED decisions and evidence. REQUIRED after recall() before consequential actions. Each recalled scar must be addressed. APPLYING: past-tense evidence of compliance. N_A: explain why scar doesn't apply. REFUTED: acknowledge risk of overriding.",
    inputSchema: {
      type: "object" as const,
      properties: {
        confirmations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_id: {
                type: "string",
                description: "UUID of the surfaced scar (from recall result)",
              },
              decision: {
                type: "string",
                enum: ["APPLYING", "N_A", "REFUTED"],
                description: "APPLYING: scar is relevant, evidence of compliance. N_A: scar doesn't apply, explain why. REFUTED: overriding scar, acknowledge risk.",
              },
              evidence: {
                type: "string",
                description: "Past-tense evidence (APPLYING), scenario comparison (N_A), or risk acknowledgment (REFUTED). Minimum 50 characters.",
              },
              relevance: {
                type: "string",
                enum: ["high", "low", "noise"],
                description: "How relevant was this scar to your plan? high=directly applicable, low=tangentially related, noise=not relevant to this context. Helps improve future recall quality.",
              },
            },
            required: ["scar_id", "decision", "evidence"],
          },
          description: "One confirmation per recalled scar. All recalled scars must be addressed.",
        },
      },
      required: ["confirmations"],
    },
  },
  {
    name: "session_start",
    description: "Initialize session, detect agent, load institutional context (last session, recent decisions, open threads). Scars surface on-demand via recall(). DISPLAY: The result includes a pre-formatted 'display' field visible in the tool result. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["cli", "desktop", "autonomous", "local", "cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., PROJ-123)",
        },
        issue_title: {
          type: "string",
          description: "Issue title for scar context",
        },
        issue_description: {
          type: "string",
          description: "Issue description for scar context",
        },
        issue_labels: {
          type: "array",
          items: { type: "string" },
          description: "Issue labels for scar context",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists",
        },
      },
    },
  },
  {
    name: "session_refresh",
    description: "Re-surface institutional context (threads, decisions) for the current active session without creating a new session. Use mid-session when you need to remember where you left off, after context compaction, or after a long gap. DISPLAY: The result includes a pre-formatted 'display' field visible in the tool result. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (default: from active session). Free-form string (e.g., 'my-project').",
        },
      },
    },
  },
  {
    name: "session_close",
    description: "Persist session with compliance validation. IMPORTANT: Before calling this tool, write all heavy payload data (closing_reflection, task_completion, human_corrections, scars_to_record, open_threads, decisions, learnings_created) to {gitmem_dir}/closing-payload.json using your file write tool — the gitmem_dir path is returned by session_start (also shown in session start display as 'Payload path'). Then call this tool with ONLY session_id and close_type. The tool reads the payload file automatically and deletes it after processing. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from session_start",
        },
        close_type: {
          type: "string",
          enum: ["standard", "quick", "autonomous"],
          description: "Type of close (standard requires full reflection)",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "create_learning",
    description: "Create scar, win, or pattern entry in institutional memory. Frame as 'what we now know' — lead with the factual/architectural discovery, not what went wrong. Good: 'Fine-grained PATs are scoped to one resource owner'. Bad: 'Should have checked PAT type first'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Type of learning",
        },
        title: {
          type: "string",
          description: "Frame as a knowledge discovery — what we now know. Lead with the factual insight, not self-criticism.",
        },
        description: {
          type: "string",
          description: "Detailed description. Include the architectural/behavioral fact that makes this retrievable by domain.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Severity level (required for scars)",
        },
        scar_type: {
          type: "string",
          enum: ["process", "incident", "context"],
          description: "Scar type (process, incident, or context). Defaults to 'process'.",
        },
        counter_arguments: {
          type: "array",
          items: { type: "string" },
          description: "Counter-arguments for scars (min 2 required)",
        },
        problem_context: {
          type: "string",
          description: "Problem context (for wins)",
        },
        solution_approach: {
          type: "string",
          description: "Solution approach (for wins)",
        },
        applies_when: {
          type: "array",
          items: { type: "string" },
          description: "When this pattern applies",
        },
        domain: {
          type: "array",
          items: { type: "string" },
          description: "Domain tags",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Search keywords",
        },
        source_linear_issue: {
          type: "string",
          description: "Source Linear issue",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["learning_type", "title", "description"],
    },
  },
  {
    name: "create_decision",
    description: "Log architectural/operational decision to institutional memory",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Decision title",
        },
        decision: {
          type: "string",
          description: "What was decided",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made",
        },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternatives that were rejected",
        },
        personas_involved: {
          type: "array",
          items: { type: "string" },
          description: "Personas involved in decision",
        },
        docs_affected: {
          type: "array",
          items: { type: "string" },
          description:
            "Docs/files affected by this decision (relative paths from repo root)",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        session_id: {
          type: "string",
          description: "Current session ID",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["title", "decision", "rationale"],
    },
  },
  {
    name: "record_scar_usage",
    description: "Track scar application for effectiveness measurement",
    inputSchema: {
      type: "object" as const,
      properties: {
        scar_id: {
          type: "string",
          description: "UUID of the scar",
        },
        issue_id: {
          type: "string",
          description: "Linear issue UUID",
        },
        issue_identifier: {
          type: "string",
          description: "Linear issue identifier (e.g., PROJ-123)",
        },
        surfaced_at: {
          type: "string",
          description: "ISO timestamp when scar was retrieved",
        },
        acknowledged_at: {
          type: "string",
          description: "ISO timestamp when scar was acknowledged",
        },
        reference_type: {
          type: "string",
          enum: ["explicit", "implicit", "acknowledged", "refuted", "none"],
          description: "How the scar was referenced",
        },
        reference_context: {
          type: "string",
          description: "How the scar was applied (1-2 sentences)",
        },
        execution_successful: {
          type: "boolean",
          description: "Whether the task succeeded after applying scar",
        },
        session_id: {
          type: "string",
          description: "GitMem session UUID (for non-issue session tracking)",
        },
        agent: {
          type: "string",
          description: "Agent identity (e.g., cli, desktop, autonomous)",
        },
        variant_id: {
          type: "string",
          description: "UUID of the assigned variant from scar_enforcement_variants (for A/B testing)",
        },
      },
      required: ["scar_id", "surfaced_at", "reference_type", "reference_context"],
    },
  },
  {
    name: "record_scar_usage_batch",
    description: "Track multiple scar applications in a single batch operation (reduces session close latency)",
    inputSchema: {
      type: "object" as const,
      properties: {
        scars: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_identifier: {
                type: "string",
                description: "UUID or title/description of scar (tool resolves to UUID)",
              },
              issue_id: {
                type: "string",
                description: "Linear issue UUID",
              },
              issue_identifier: {
                type: "string",
                description: "Linear issue identifier (e.g., PROJ-123)",
              },
              surfaced_at: {
                type: "string",
                description: "ISO timestamp when scar was retrieved",
              },
              acknowledged_at: {
                type: "string",
                description: "ISO timestamp when scar was acknowledged",
              },
              reference_type: {
                type: "string",
                enum: ["explicit", "implicit", "acknowledged", "refuted", "none"],
                description: "How the scar was referenced",
              },
              reference_context: {
                type: "string",
                description: "How the scar was applied (1-2 sentences)",
              },
              execution_successful: {
                type: "boolean",
                description: "Whether the task succeeded after applying scar",
              },
              session_id: {
                type: "string",
                description: "GitMem session UUID (for non-issue session tracking)",
              },
              agent: {
                type: "string",
                description: "Agent identity (e.g., cli, desktop, autonomous)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Array of scar usage entries to record",
        },
        project: {
          type: "string",

          description: "Project scope for scar resolution",
        },
      },
      required: ["scars"],
    },
  },
  {
    name: "save_transcript",
    description: "Save full session transcript to storage for training data and post-mortems",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to associate transcript with",
        },
        transcript: {
          type: "string",
          description: "Full conversation transcript content",
        },
        format: {
          type: "string",
          enum: ["json", "markdown"],
          description: "Transcript format (default: json)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["session_id", "transcript"],
    },
  },
  {
    name: "get_transcript",
    description: "Retrieve a session transcript from storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to retrieve transcript for",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "search_transcripts",
    description: "Semantic search over session transcript chunks. Generates embedding for query and calls match_transcript_chunks RPC to find relevant conversation fragments across all indexed sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'deployment verification discussion', 'what was decided about caching')",
        },
        match_count: {
          type: "number",
          description: "Maximum number of chunks to return (default: 10, max: 50)",
        },
        similarity_threshold: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0.3). Higher values return more relevant results.",
        },
        project: {
          type: "string",
          description: "Project namespace to filter by (e.g., 'my-project')",
        },
      },
      required: ["query"],
    },
  },
  // ============================================================================
  // SEARCH & LOG TOOLS
  // ============================================================================
  {
    name: "search",
    description: "Search institutional memory by query. Unlike recall (which is action-oriented), search is exploration-oriented — returns matching scars/wins/patterns without side effects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'deployment failures', 'Supabase RLS')",
        },
        match_count: {
          type: "number",
          description: "Number of results to return (default: 5)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by learning type",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "log",
    description: "List recent learnings chronologically (like git log). Shows scars, wins, and patterns ordered by creation date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of entries to return (default: 10)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by learning type",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level",
        },
        since: {
          type: "number",
          description: "Days to look back (e.g., 7 = last week)",
        },
      },
    },
  },

  // ============================================================================
  // PREPARE CONTEXT
  // ============================================================================
  {
    name: "prepare_context",
    description: "Generate portable memory payload for sub-agent injection. Formats institutional memory into compact or gate payloads that fit in Task tool prompts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What the team is about to do (e.g., 'review auth middleware', 'deploy edge function')",
        },
        format: {
          type: "string",
          enum: ["full", "compact", "gate"],
          description: "Output format: full (rich markdown), compact (~500 tokens, one-line per scar), gate (~100 tokens, blocking scars only)",
        },
        max_tokens: {
          type: "number",
          description: "Token budget for payload (default: 500 for compact, 100 for gate, unlimited for full)",
        },
        agent_role: {
          type: "string",
          description: "Sub-agent role for relevance filtering (e.g., 'reviewer', 'deployer') — reserved for Phase 3",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["plan", "format"],
    },
  },

  // ============================================================================
  // ABSORB OBSERVATIONS (GitMem v2 Phase 2)
  // ============================================================================
  {
    name: "absorb_observations",
    description: "Capture observations from sub-agents and teammates. The lead agent parses findings from sub-agent responses, then calls this to persist and analyze them. Identifies scar candidates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "Linear issue or task identifier (optional)",
        },
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: 'Who made this observation (e.g., "Sub-Agent: code review")' },
              text: { type: "string", description: "What was observed" },
              severity: { type: "string", enum: ["info", "warning", "scar_candidate"], description: "Observation severity" },
              context: { type: "string", description: "File, function, or area (optional)" },
            },
            required: ["source", "text", "severity"],
          },
          description: "Array of observations from sub-agents/teammates",
        },
      },
      required: ["observations"],
    },
  },

  // --- Thread Lifecycle Tools () ---

  {
    name: "list_threads",
    description:
      "List open threads across recent sessions. Shows unresolved work items that carry over between sessions, with IDs for resolution. Use resolve_thread to mark threads as done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "resolved"],
          description: "Filter by status (default: open)",
        },
        include_resolved: {
          type: "boolean",
          description: "Include recently resolved threads (default: false)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "resolve_thread",
    description:
      "Mark an open thread as resolved. Use thread_id for exact match or text_match for fuzzy matching. Updates session state and .gitmem/threads.json.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread_id: {
          type: "string",
          description: 'Thread ID (e.g., "t-a1b2c3d4") for exact resolution',
        },
        text_match: {
          type: "string",
          description:
            "Fuzzy text match against thread descriptions (fallback if no thread_id)",
        },
        resolution_note: {
          type: "string",
          description: "Brief note explaining how/why thread was resolved",
        },
      },
    },
  },
  {
    name: "create_thread",
    description:
      "Create an open thread to track unresolved work across sessions. Includes semantic dedup: if a similar open thread exists (cosine similarity > 0.85), returns the existing thread instead. Check the 'deduplicated' field in the response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Thread description — what needs to be tracked or resolved",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue (e.g., PROJ-123)",
        },
      },
      required: ["text"],
    },
  },

  // --- Thread Suggestion Tools (Phase 5: Implicit Thread Detection) ---

  {
    name: "promote_suggestion",
    description:
      "Promote a suggested thread to an open thread. Takes a suggestion_id from session_start's suggested_threads list and creates a real thread from it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: {
          type: "string",
          description: 'Suggestion ID (e.g., "ts-a1b2c3d4") from suggested_threads list',
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["suggestion_id"],
    },
  },
  {
    name: "dismiss_suggestion",
    description:
      "Dismiss a suggested thread. Incremented dismiss count — suggestions dismissed 3+ times are permanently suppressed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: {
          type: "string",
          description: 'Suggestion ID (e.g., "ts-a1b2c3d4") from suggested_threads list',
        },
      },
      required: ["suggestion_id"],
    },
  },

  // --- Thread Lifecycle Cleanup Tool (Phase 6) ---

  {
    name: "cleanup_threads",
    description:
      "Triage open threads by lifecycle health. Groups threads as active/cooling/dormant with vitality scores. Use auto_archive=true to archive threads dormant 30+ days. Review and resolve stale threads to keep your thread list healthy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        auto_archive: {
          type: "boolean",
          description: "If true, auto-archive threads that have been dormant for 30+ days",
        },
      },
    },
  },

  // --- Effect Health Tool ---

  {
    name: "health",
    description:
      "Show write health for the current session. Reports success/failure rates for all tracked fire-and-forget operations (metrics, cache, triple writes, embeddings, scar usage). Use this to diagnose silent failures.",
    inputSchema: {
      type: "object" as const,
      properties: {
        failure_limit: {
          type: "number",
          description: "Max number of recent failures to return (default: 10)",
        },
      },
    },
  },

  // ============================================================================
  // SHORT ALIASES (gitmem-*)
  // Self-documenting: each description includes both alias and full name
  // ============================================================================
  {
    name: "gitmem-r",
    description: "gitmem-r (recall) - Check institutional memory for relevant scars before taking action",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What you're about to do (e.g., 'implement auth layer', 'deploy to production')",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        match_count: {
          type: "number",
          description: "Number of scars to return (default: 3)",
        },
      },
      required: ["plan"],
    },
  },
  {
    name: "gitmem-cs",
    description: "gitmem-cs (confirm_scars) - Confirm recalled scars with APPLYING/N_A/REFUTED decisions",
    inputSchema: {
      type: "object" as const,
      properties: {
        confirmations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_id: { type: "string", description: "UUID of the surfaced scar" },
              decision: { type: "string", enum: ["APPLYING", "N_A", "REFUTED"], description: "Confirmation decision" },
              evidence: { type: "string", description: "Evidence (min 50 chars)" },
            },
            required: ["scar_id", "decision", "evidence"],
          },
          description: "One confirmation per recalled scar",
        },
      },
      required: ["confirmations"],
    },
  },
  {
    name: "gitmem-ss",
    description: "gitmem-ss (session_start) - Initialize session with institutional context. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["cli", "desktop", "autonomous", "local", "cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., PROJ-123)",
        },
        issue_title: {
          type: "string",
          description: "Issue title for scar context",
        },
        issue_description: {
          type: "string",
          description: "Issue description for scar context",
        },
        issue_labels: {
          type: "array",
          items: { type: "string" },
          description: "Issue labels for scar context",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists",
        },
      },
    },
  },
  {
    name: "gitmem-sr",
    description: "gitmem-sr (session_refresh) - Refresh institutional context for the active session without creating a new session. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (default: from active session). Free-form string (e.g., 'my-project').",
        },
      },
    },
  },
  {
    name: "gitmem-sc",
    description: "gitmem-sc (session_close) - Close session with compliance validation. IMPORTANT: Write all heavy payload data (closing_reflection, task_completion, human_corrections, scars_to_record, open_threads, decisions, learnings_created) to {gitmem_dir}/closing-payload.json BEFORE calling this tool — gitmem_dir is from session_start. Only pass session_id and close_type inline. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from session_start",
        },
        close_type: {
          type: "string",
          enum: ["standard", "quick", "autonomous"],
          description: "Type of close (standard requires full reflection)",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "gitmem-cl",
    description: "gitmem-cl (create_learning) - Create scar/win/pattern. Frame as 'what we now know' — factual discovery, not self-criticism.",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Type of learning",
        },
        title: {
          type: "string",
          description: "Learning title",
        },
        description: {
          type: "string",
          description: "Detailed description",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Severity level (required for scars)",
        },
        scar_type: {
          type: "string",
          enum: ["process", "incident", "context"],
          description: "Scar type (process, incident, or context). Defaults to 'process'.",
        },
        counter_arguments: {
          type: "array",
          items: { type: "string" },
          description: "Counter-arguments for scars (min 2 required)",
        },
        problem_context: {
          type: "string",
          description: "Problem context (for wins)",
        },
        solution_approach: {
          type: "string",
          description: "Solution approach (for wins)",
        },
        applies_when: {
          type: "array",
          items: { type: "string" },
          description: "When this pattern applies",
        },
        domain: {
          type: "array",
          items: { type: "string" },
          description: "Domain tags",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Search keywords",
        },
        source_linear_issue: {
          type: "string",
          description: "Source Linear issue",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["learning_type", "title", "description"],
    },
  },
  {
    name: "gitmem-cd",
    description: "gitmem-cd (create_decision) - Log architectural/operational decision",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Decision title",
        },
        decision: {
          type: "string",
          description: "What was decided",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made",
        },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternatives that were rejected",
        },
        personas_involved: {
          type: "array",
          items: { type: "string" },
          description: "Personas involved in decision",
        },
        docs_affected: {
          type: "array",
          items: { type: "string" },
          description:
            "Docs/files affected by this decision (relative paths from repo root)",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        session_id: {
          type: "string",
          description: "Current session ID",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["title", "decision", "rationale"],
    },
  },
  {
    name: "gitmem-rs",
    description: "gitmem-rs (record_scar_usage) - Track scar application for effectiveness measurement",
    inputSchema: {
      type: "object" as const,
      properties: {
        scar_id: {
          type: "string",
          description: "UUID of the scar",
        },
        issue_id: {
          type: "string",
          description: "Linear issue UUID",
        },
        issue_identifier: {
          type: "string",
          description: "Linear issue identifier (e.g., PROJ-123)",
        },
        surfaced_at: {
          type: "string",
          description: "ISO timestamp when scar was retrieved",
        },
        acknowledged_at: {
          type: "string",
          description: "ISO timestamp when scar was acknowledged",
        },
        reference_type: {
          type: "string",
          enum: ["explicit", "implicit", "acknowledged", "refuted", "none"],
          description: "How the scar was referenced",
        },
        reference_context: {
          type: "string",
          description: "How the scar was applied (1-2 sentences)",
        },
        execution_successful: {
          type: "boolean",
          description: "Whether the task succeeded after applying scar",
        },
        session_id: {
          type: "string",
          description: "GitMem session UUID (for non-issue session tracking)",
        },
        agent: {
          type: "string",
          description: "Agent identity (e.g., cli, desktop, autonomous)",
        },
        variant_id: {
          type: "string",
          description: "UUID of the assigned variant from scar_enforcement_variants (for A/B testing)",
        },
      },
      required: ["scar_id", "surfaced_at", "reference_type", "reference_context"],
    },
  },
  {
    name: "gitmem-rsb",
    description: "gitmem-rsb (record_scar_usage_batch) - Track multiple scars in batch (reduces latency)",
    inputSchema: {
      type: "object" as const,
      properties: {
        scars: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_identifier: {
                type: "string",
                description: "UUID or title/description of scar (tool resolves to UUID)",
              },
              issue_id: {
                type: "string",
                description: "Linear issue UUID",
              },
              issue_identifier: {
                type: "string",
                description: "Linear issue identifier (e.g., PROJ-123)",
              },
              surfaced_at: {
                type: "string",
                description: "ISO timestamp when scar was retrieved",
              },
              acknowledged_at: {
                type: "string",
                description: "ISO timestamp when scar was acknowledged",
              },
              reference_type: {
                type: "string",
                enum: ["explicit", "implicit", "acknowledged", "refuted", "none"],
                description: "How the scar was referenced",
              },
              reference_context: {
                type: "string",
                description: "How the scar was applied (1-2 sentences)",
              },
              execution_successful: {
                type: "boolean",
                description: "Whether the task succeeded after applying scar",
              },
              session_id: {
                type: "string",
                description: "GitMem session UUID (for non-issue session tracking)",
              },
              agent: {
                type: "string",
                description: "Agent identity (e.g., cli, desktop, autonomous)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Array of scar usage entries to record",
        },
        project: {
          type: "string",

          description: "Project scope for scar resolution",
        },
      },
      required: ["scars"],
    },
  },
  {
    name: "gitmem-st",
    description: "gitmem-st (save_transcript) - Save session transcript to storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to associate transcript with",
        },
        transcript: {
          type: "string",
          description: "Full conversation transcript content",
        },
        format: {
          type: "string",
          enum: ["json", "markdown"],
          description: "Transcript format (default: json)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["session_id", "transcript"],
    },
  },
  {
    name: "gitmem-gt",
    description: "gitmem-gt (get_transcript) - Retrieve session transcript from storage",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to retrieve transcript for",
        },
      },
      required: ["session_id"],
    },
  },
  // gitmem-stx / gm-stx (search_transcripts)
  {
    name: "gitmem-stx",
    description: "gitmem-stx (search_transcripts) - Semantic search over transcript chunks",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        match_count: {
          type: "number",
          description: "Maximum number of chunks to return (default: 10, max: 50)",
        },
        similarity_threshold: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0.3)",
        },
        project: {
          type: "string",
          description: "Project namespace to filter by",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gm-stx",
    description: "gm-stx (search_transcripts) - Semantic search over transcript chunks",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        match_count: {
          type: "number",
          description: "Maximum number of chunks to return (default: 10, max: 50)",
        },
        similarity_threshold: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0.3)",
        },
        project: {
          type: "string",
          description: "Project namespace to filter by",
        },
      },
      required: ["query"],
    },
  },
  // gitmem-search
  {
    name: "gitmem-search",
    description: "gitmem-search (search) - Search institutional memory by query (exploration, no side effects)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        match_count: {
          type: "number",
          description: "Number of results to return (default: 5)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by type",
        },
      },
      required: ["query"],
    },
  },
  // gitmem-log
  {
    name: "gitmem-log",
    description: "gitmem-log (log) - List recent learnings chronologically",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of entries (default: 10)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by type",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        since: {
          type: "number",
          description: "Days to look back",
        },
      },
    },
  },
  // gitmem-pc (prepare_context)
  {
    name: "gitmem-pc",
    description: "gitmem-pc (prepare_context) - Generate portable memory payload for sub-agent injection",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What the team is about to do",
        },
        format: {
          type: "string",
          enum: ["full", "compact", "gate"],
          description: "Output format: full, compact (~500 tokens), gate (~100 tokens)",
        },
        max_tokens: {
          type: "number",
          description: "Token budget for payload",
        },
        agent_role: {
          type: "string",
          description: "Sub-agent role for filtering (reserved for Phase 3)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["plan", "format"],
    },
  },
  // gitmem-ao (absorb_observations) — v2 Phase 2
  {
    name: "gitmem-ao",
    description: "gitmem-ao (absorb_observations) - Capture sub-agent/teammate observations",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Linear issue or task identifier (optional)" },
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Who made this observation" },
              text: { type: "string", description: "What was observed" },
              severity: { type: "string", enum: ["info", "warning", "scar_candidate"] },
              context: { type: "string", description: "File/function/area (optional)" },
            },
            required: ["source", "text", "severity"],
          },
          description: "Observations from sub-agents/teammates",
        },
      },
      required: ["observations"],
    },
  },
  // gitmem-lt (list_threads) — 
  {
    name: "gitmem-lt",
    description: "gitmem-lt (list_threads) - List open threads across sessions",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["open", "resolved"], description: "Filter by status (default: open)" },
        include_resolved: { type: "boolean", description: "Include recently resolved threads (default: false)" },
        project: { type: "string", description: "Project namespace for organizing memories" },
      },
    },
  },
  // gitmem-rt (resolve_thread) — 
  {
    name: "gitmem-rt",
    description: "gitmem-rt (resolve_thread) - Mark a thread as resolved",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string", description: 'Thread ID (e.g., "t-a1b2c3d4")' },
        text_match: { type: "string", description: "Fuzzy text match against thread descriptions" },
        resolution_note: { type: "string", description: "Brief note explaining resolution" },
      },
    },
  },
  // gitmem-ct (create_thread)
  {
    name: "gitmem-ct",
    description: "gitmem-ct (create_thread) - Create an open thread with semantic dedup (cosine > 0.85 blocks duplicates)",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Thread description" },
        linear_issue: { type: "string", description: "Associated Linear issue" },
      },
      required: ["text"],
    },
  },
  // gitmem-ps (promote_suggestion) — Phase 5
  {
    name: "gitmem-ps",
    description: "gitmem-ps (promote_suggestion) - Promote a suggested thread to an open thread",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: { type: "string", description: "Suggestion ID (e.g., ts-a1b2c3d4)" },
        project: { type: "string", description: "Project namespace for organizing memories" },
      },
      required: ["suggestion_id"],
    },
  },
  // gitmem-ds (dismiss_suggestion) — Phase 5
  {
    name: "gitmem-ds",
    description: "gitmem-ds (dismiss_suggestion) - Dismiss a suggested thread",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: { type: "string", description: "Suggestion ID (e.g., ts-a1b2c3d4)" },
      },
      required: ["suggestion_id"],
    },
  },
  // gitmem-cleanup (cleanup_threads) — Phase 6
  {
    name: "gitmem-cleanup",
    description: "gitmem-cleanup (cleanup_threads) - Triage threads by lifecycle health",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string" },
        auto_archive: { type: "boolean", description: "Auto-archive dormant threads (30+ days)" },
      },
    },
  },
  // gitmem-health (health) — Effect Tracker health report
  {
    name: "gitmem-health",
    description: "gitmem-health (health) - Show write health for fire-and-forget operations this session",
    inputSchema: {
      type: "object" as const,
      properties: {
        failure_limit: { type: "number", description: "Max recent failures to return (default: 10)" },
      },
    },
  },

  // ============================================================================
  // GM-* SHORT, MEMORABLE ALIASES (user-facing ergonomics)
  // ============================================================================
  {
    name: "gm-open",
    description: "gm-open (session_start) - Open a GitMem session and load institutional context. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["cli", "desktop", "autonomous", "local", "cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., PROJ-123)",
        },
        issue_title: {
          type: "string",
          description: "Issue title for scar context",
        },
        issue_description: {
          type: "string",
          description: "Issue description for scar context",
        },
        issue_labels: {
          type: "array",
          items: { type: "string" },
          description: "Issue labels for scar context",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists",
        },
      },
    },
  },
  {
    name: "gm-confirm",
    description: "gm-confirm (confirm_scars) - Confirm recalled scars with APPLYING/N_A/REFUTED",
    inputSchema: {
      type: "object" as const,
      properties: {
        confirmations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_id: { type: "string", description: "UUID of the surfaced scar" },
              decision: { type: "string", enum: ["APPLYING", "N_A", "REFUTED"] },
              evidence: { type: "string", description: "Evidence (min 50 chars)" },
            },
            required: ["scar_id", "decision", "evidence"],
          },
          description: "One confirmation per recalled scar",
        },
      },
      required: ["confirmations"],
    },
  },
  {
    name: "gm-refresh",
    description: "gm-refresh (session_refresh) - Refresh context for the active session without creating a new one. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (default: from active session). Free-form string (e.g., 'my-project').",
        },
      },
    },
  },
  {
    name: "gm-close",
    description: "gm-close (session_close) - Close a GitMem session. IMPORTANT: Write all heavy payload data (closing_reflection, task_completion, human_corrections, scars_to_record, open_threads, decisions, learnings_created) to {gitmem_dir}/closing-payload.json BEFORE calling this tool — gitmem_dir is from session_start. Only pass session_id and close_type inline. DISPLAY: The result includes a pre-formatted 'display' field. Output the display field verbatim as your response — tool results are collapsed in the CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from session_start",
        },
        close_type: {
          type: "string",
          enum: ["standard", "quick", "autonomous"],
          description: "Type of close (standard requires full reflection)",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "gm-scar",
    description: "gm-scar (create_learning) - Create a scar/win/pattern. Frame as 'what we now know' — factual discovery, not self-criticism.",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Type of learning",
        },
        title: {
          type: "string",
          description: "Learning title",
        },
        description: {
          type: "string",
          description: "Detailed description",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Severity level (required for scars)",
        },
        scar_type: {
          type: "string",
          enum: ["process", "incident", "context"],
          description: "Scar type (process, incident, or context). Defaults to 'process'.",
        },
        counter_arguments: {
          type: "array",
          items: { type: "string" },
          description: "Counter-arguments for scars (min 2 required)",
        },
        problem_context: {
          type: "string",
          description: "Problem context (for wins)",
        },
        solution_approach: {
          type: "string",
          description: "Solution approach (for wins)",
        },
        applies_when: {
          type: "array",
          items: { type: "string" },
          description: "When this pattern applies",
        },
        domain: {
          type: "array",
          items: { type: "string" },
          description: "Domain tags",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Search keywords",
        },
        source_linear_issue: {
          type: "string",
          description: "Source Linear issue",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["learning_type", "title", "description"],
    },
  },
  // gm-search
  {
    name: "gm-search",
    description: "gm-search (search) - Search institutional memory by query",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        match_count: {
          type: "number",
          description: "Number of results (default: 5)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by type",
        },
      },
      required: ["query"],
    },
  },
  // gm-log
  {
    name: "gm-log",
    description: "gm-log (log) - List recent learnings chronologically",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of entries (default: 10)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern", "anti_pattern"],
          description: "Filter by type",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        since: {
          type: "number",
          description: "Days to look back",
        },
      },
    },
  },
  // gm-pc (prepare_context)
  {
    name: "gm-pc",
    description: "gm-pc (prepare_context) - Generate portable memory payload for sub-agents",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What the team is about to do",
        },
        format: {
          type: "string",
          enum: ["full", "compact", "gate"],
          description: "Output format: full, compact, gate",
        },
        max_tokens: {
          type: "number",
          description: "Token budget for payload",
        },
        agent_role: {
          type: "string",
          description: "Sub-agent role (reserved for Phase 3)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
      required: ["plan", "format"],
    },
  },
  // gm-absorb (absorb_observations) — v2 Phase 2
  {
    name: "gm-absorb",
    description: "gm-absorb (absorb_observations) - Capture sub-agent observations",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Linear issue or task identifier" },
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Who observed" },
              text: { type: "string", description: "What was observed" },
              severity: { type: "string", enum: ["info", "warning", "scar_candidate"] },
              context: { type: "string", description: "File/function/area" },
            },
            required: ["source", "text", "severity"],
          },
          description: "Observations array",
        },
      },
      required: ["observations"],
    },
  },
  // gm-threads (list_threads) — 
  {
    name: "gm-threads",
    description: "gm-threads (list_threads) - List open threads",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["open", "resolved"], description: "Filter by status (default: open)" },
        include_resolved: { type: "boolean", description: "Include resolved threads" },
        project: { type: "string", description: "Project namespace for organizing memories" },
      },
    },
  },
  // gm-resolve (resolve_thread) — 
  {
    name: "gm-resolve",
    description: "gm-resolve (resolve_thread) - Resolve a thread",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string", description: 'Thread ID (e.g., "t-a1b2c3d4")' },
        text_match: { type: "string", description: "Fuzzy text match" },
        resolution_note: { type: "string", description: "Brief resolution note" },
      },
    },
  },
  // gm-thread-new (create_thread)
  {
    name: "gm-thread-new",
    description: "gm-thread-new (create_thread) - Create an open thread with semantic dedup",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Thread description" },
        linear_issue: { type: "string", description: "Associated Linear issue" },
      },
      required: ["text"],
    },
  },
  // gm-promote (promote_suggestion) — Phase 5
  {
    name: "gm-promote",
    description: "gm-promote (promote_suggestion) - Promote a suggested thread",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: { type: "string", description: "Suggestion ID" },
        project: { type: "string", description: "Project namespace for organizing memories" },
      },
      required: ["suggestion_id"],
    },
  },
  // gm-dismiss (dismiss_suggestion) — Phase 5
  {
    name: "gm-dismiss",
    description: "gm-dismiss (dismiss_suggestion) - Dismiss a suggested thread",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestion_id: { type: "string", description: "Suggestion ID" },
      },
      required: ["suggestion_id"],
    },
  },
  // gm-cleanup (cleanup_threads) — Phase 6
  {
    name: "gm-cleanup",
    description: "gm-cleanup (cleanup_threads) - Triage threads by health",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string" },
        auto_archive: { type: "boolean", description: "Auto-archive dormant threads" },
      },
    },
  },
  // gm-health (health) — Effect Tracker health report
  {
    name: "gm-health",
    description: "gm-health (health) - Show write health for fire-and-forget operations",
    inputSchema: {
      type: "object" as const,
      properties: {
        failure_limit: { type: "number", description: "Max recent failures (default: 10)" },
      },
    },
  },
  // ============================================================================
  // ANALYTICS TOOLS
  // ============================================================================
  {
    name: "analyze",
    description: "Session analytics and insights engine. Returns formatted markdown by default. Use format=json for raw data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections", "blindspots"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., cli, desktop, autonomous)",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Output format: text (default, compact markdown) or json (raw data)",
        },
      },
    },
  },
  // gitmem-analyze alias
  {
    name: "gitmem-analyze",
    description: "gitmem-analyze (analyze) - Session analytics. Returns formatted markdown by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections", "blindspots"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., cli, desktop, autonomous)",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Output format: text (default) or json (raw data)",
        },
      },
    },
  },
  // gm-analyze ultra-short alias
  {
    name: "gm-analyze",
    description: "gm-analyze (analyze) - Session analytics. Returns formatted markdown by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections", "blindspots"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., cli, desktop, autonomous)",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Output format: text (default) or json (raw data)",
        },
      },
    },
  },
  {
    name: "gitmem-help",
    description: "gitmem-help - Show available commands with ASCII art header",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ============================================================================
  // CACHE MANAGEMENT TOOLS
  // ============================================================================
  {
    name: "gitmem-cache-status",
    description: "gitmem-cache-status - Show local search cache status (scar count, age, staleness)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "gitmem-cache-health",
    description: "gitmem-cache-health - Compare local cache against remote Supabase (detect out-of-sync)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "gitmem-cache-flush",
    description: "gitmem-cache-flush - Force reload cache from Supabase (use when out of sync)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "gm-cache-s",
    description: "gm-cache-s (cache_status) - Show local search cache status (scar count, age, staleness)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "gm-cache-h",
    description: "gm-cache-h (cache_health) - Compare local cache against remote Supabase (detect out-of-sync)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },
  {
    name: "gm-cache-f",
    description: "gm-cache-f (cache_flush) - Force reload cache from Supabase",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
      },
    },
  },

  // --- Archive Learning Tool ---

  {
    name: "archive_learning",
    description: "Archives a learning (scar/win/pattern) by setting is_active=false and recording archived_at timestamp. Archived learnings are excluded from recall and search results but preserved for audit trail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "UUID of the learning to archive",
        },
        reason: {
          type: "string",
          description: "Optional reason for archiving (e.g., 'superseded by PROJ-123', 'no longer relevant')",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gitmem-al",
    description: "gitmem-al (archive_learning) - Archive a scar/win/pattern (sets is_active=false)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "UUID of the learning to archive",
        },
        reason: {
          type: "string",
          description: "Optional reason for archiving",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gm-archive",
    description: "gm-archive (archive_learning) - Archive a scar/win/pattern",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "UUID of the learning to archive",
        },
        reason: {
          type: "string",
          description: "Optional reason for archiving",
        },
      },
      required: ["id"],
    },
  },

  // --- Knowledge Graph Traversal (Phase 3) ---

  {
    name: "graph_traverse",
    description: "Traverse the knowledge graph over institutional memory triples. Answers: 'show me everything connected to this issue', 'what did this agent produce', 'trace this decision back', 'which issues produced the most learnings'. Four lenses: connected_to, produced_by, provenance, stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["connected_to", "produced_by", "provenance", "stats"],
          description: "Traversal mode: connected_to (all connections to a node), produced_by (what an agent/persona produced), provenance (trace origin chain), stats (aggregate counts)",
        },
        node: {
          type: "string",
          description: "Starting node. Examples: 'PROJ-123', 'cli', 'Scar: Done ≠ Deployed'. Required for all lenses except stats.",
        },
        predicate: {
          type: "string",
          enum: ["created_in", "influenced_by", "supersedes", "demonstrates"],
          description: "Filter by predicate (optional)",
        },
        depth: {
          type: "number",
          description: "Max chain depth for provenance lens (default: 3)",
        },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        limit: {
          type: "number",
          description: "Max triples to return (default: 50)",
        },
      },
      required: ["lens"],
    },
  },
  {
    name: "gitmem-graph",
    description: "gitmem-graph (graph_traverse) - Traverse knowledge graph over institutional memory triples",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["connected_to", "produced_by", "provenance", "stats"],
          description: "Traversal mode",
        },
        node: {
          type: "string",
          description: "Starting node (e.g., 'PROJ-123', 'cli')",
        },
        predicate: {
          type: "string",
          enum: ["created_in", "influenced_by", "supersedes", "demonstrates"],
          description: "Filter by predicate",
        },
        depth: { type: "number", description: "Max depth for provenance (default: 3)" },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        limit: { type: "number", description: "Max triples (default: 50)" },
      },
      required: ["lens"],
    },
  },
  {
    name: "gm-graph",
    description: "gm-graph (graph_traverse) - Traverse knowledge graph",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["connected_to", "produced_by", "provenance", "stats"],
          description: "Traversal mode",
        },
        node: { type: "string", description: "Starting node" },
        predicate: {
          type: "string",
          enum: ["created_in", "influenced_by", "supersedes", "demonstrates"],
          description: "Filter by predicate",
        },
        depth: { type: "number", description: "Max depth for provenance" },
        project: {
          type: "string",

          description: "Project namespace (e.g., 'my-project'). Scopes sessions and searches.",
        },
        limit: { type: "number", description: "Max triples" },
      },
      required: ["lens"],
    },
  },
];

/**
 * Alias tool names — filtered out by default to reduce context window cost.
 * Set GITMEM_FULL_ALIASES=1 to advertise all aliases.
 * Aliases still route correctly in server.ts even when not advertised.
 */
export const ALIAS_TOOL_NAMES = new Set([
  // gitmem-* aliases
  "gitmem-r", "gitmem-cs", "gitmem-ss", "gitmem-sr", "gitmem-sc",
  "gitmem-cl", "gitmem-cd", "gitmem-rs", "gitmem-rsb",
  "gitmem-st", "gitmem-gt", "gitmem-stx",
  "gitmem-search", "gitmem-log", "gitmem-analyze",
  "gitmem-pc", "gitmem-ao",
  "gitmem-lt", "gitmem-rt", "gitmem-ct", "gitmem-ps", "gitmem-ds",
  "gitmem-cleanup", "gitmem-health", "gitmem-al", "gitmem-graph",
  // gm-* aliases
  "gm-open", "gm-confirm", "gm-refresh", "gm-close",
  "gm-scar", "gm-search", "gm-log", "gm-analyze",
  "gm-pc", "gm-absorb",
  "gm-threads", "gm-resolve", "gm-thread-new", "gm-promote", "gm-dismiss",
  "gm-cleanup", "gm-health", "gm-archive", "gm-graph",
  "gm-stx",
  // gm-cache-* aliases (canonical names are gitmem-cache-*, tier-gated separately)
  "gm-cache-s", "gm-cache-h", "gm-cache-f",
]);

/**
 * Tier-gated tool names
 *
 * Cache tools: pro/dev only (require Supabase)
 * Batch/transcript tools: dev only (internal operations)
 */
export const CACHE_TOOL_NAMES = new Set([
  "gitmem-cache-status", "gm-cache-s",
  "gitmem-cache-health", "gm-cache-h",
  "gitmem-cache-flush", "gm-cache-f",
]);

export const BATCH_TOOL_NAMES = new Set([
  "record_scar_usage_batch", "gitmem-rsb",
]);

export const TRANSCRIPT_TOOL_NAMES = new Set([
  "save_transcript", "gitmem-st",
  "get_transcript", "gitmem-gt",
  "search_transcripts", "gitmem-stx", "gm-stx",
]);

export const ANALYZE_TOOL_NAMES = new Set([
  "analyze", "gitmem-analyze", "gm-analyze",
]);

export const GRAPH_TOOL_NAMES = new Set([
  "graph_traverse", "gitmem-graph", "gm-graph",
]);

export const ARCHIVE_TOOL_NAMES = new Set([
  "archive_learning", "gitmem-al", "gm-archive",
]);

/**
 * Get tools registered for the current tier.
 * Free: core tools only (7 canonical + aliases)
 * Pro: + cache management tools
 * Dev: + batch operations + transcripts
 */
export function getRegisteredTools() {
  const showAliases = hasFullAliases();
  return TOOLS.filter(tool => {
    // Filter aliases unless GITMEM_FULL_ALIASES=1
    if (!showAliases && ALIAS_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    if (BATCH_TOOL_NAMES.has(tool.name)) {
      return hasBatchOperations();
    }
    if (TRANSCRIPT_TOOL_NAMES.has(tool.name)) {
      return hasTranscripts();
    }
    if (CACHE_TOOL_NAMES.has(tool.name)) {
      return hasCacheManagement();
    }
    if (ANALYZE_TOOL_NAMES.has(tool.name)) {
      return hasSupabase();
    }
    if (GRAPH_TOOL_NAMES.has(tool.name)) {
      return hasSupabase();
    }
    // archive_learning works on both free (local JSON) and pro (Supabase) tiers
    // Only gate the aliases
    if (ARCHIVE_TOOL_NAMES.has(tool.name) && tool.name !== "archive_learning") {
      return hasSupabase();
    }
    return true;
  });
}
