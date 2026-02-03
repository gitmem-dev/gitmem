/**
 * GitMem MCP Server
 *
 * Registers all tools and handles MCP protocol communication.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { sessionStart } from "./tools/session-start.js";
import { sessionClose } from "./tools/session-close.js";
import { createLearning } from "./tools/create-learning.js";
import { createDecision } from "./tools/create-decision.js";
import { recordScarUsage } from "./tools/record-scar-usage.js";
import { recordScarUsageBatch } from "./tools/record-scar-usage-batch.js";
import { recall } from "./tools/recall.js";
import { saveTranscript } from "./tools/save-transcript.js";
import { getTranscript } from "./tools/get-transcript.js";
import { search } from "./tools/search.js";
import { log } from "./tools/log.js";
import { analyze } from "./tools/analyze.js";
import type { AnalyzeParams } from "./tools/analyze.js";
import {
  getCacheStatus,
  checkCacheHealth,
  flushCache,
  startBackgroundInit,
} from "./services/startup.js";
import {
  getTier,
  hasSupabase,
  hasCacheManagement,
  hasBatchOperations,
  hasTranscripts,
} from "./services/tier.js";
import type { Project } from "./types/index.js";

import type {
  SessionStartParams,
  SessionCloseParams,
  CreateLearningParams,
  CreateDecisionParams,
  RecordScarUsageParams,
  RecordScarUsageBatchParams,
  SaveTranscriptParams,
  GetTranscriptParams,
} from "./types/index.js";
import type { RecallParams } from "./tools/recall.js";
import type { SearchParams } from "./tools/search.js";
import type { LogParams } from "./tools/log.js";

/**
 * Tool definitions for MCP
 */
const TOOLS = [
  {
    name: "recall",
    description: "Check institutional memory for relevant scars before taking action. Returns matching scars and their lessons. OD-525: Integrates variant assignment when issue_id provided.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: {
          type: "string",
          description: "What you're about to do (e.g., 'implement auth layer', 'deploy to production')",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        match_count: {
          type: "number",
          description: "Number of scars to return (default: 3)",
        },
        issue_id: {
          type: "string",
          description: "Linear issue identifier for variant assignment (e.g., 'OD-525'). When provided, scars with variants will be randomly assigned and formatted accordingly.",
        },
      },
      required: ["plan"],
    },
  },
  {
    name: "session_start",
    description: "Initialize session, detect agent, load institutional context (last session, relevant scars, recent decisions)",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., OD-XXX)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists (OD-558)",
        },
      },
    },
  },
  {
    name: "session_close",
    description: "Persist session with compliance validation. Standard close requires task_completion proof and 6 closing questions answered (OD-491).",
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
        task_completion: {
          type: "object",
          properties: {
            questions_displayed_at: {
              type: "string",
              description: "ISO timestamp when 7 reflection questions were displayed to human (Task 1)",
            },
            reflection_completed_at: {
              type: "string",
              description: "ISO timestamp when agent finished answering all questions (Task 2)",
            },
            human_asked_at: {
              type: "string",
              description: "ISO timestamp when agent asked human for corrections (Task 3)",
            },
            human_response: {
              type: "string",
              description: "Human's response - 'none', 'no corrections', or actual corrections (Task 4)",
            },
            human_response_at: {
              type: "string",
              description: "ISO timestamp when human responded (Task 4) - must be >= 3 seconds after human_asked_at",
            },
          },
          required: ["questions_displayed_at", "reflection_completed_at", "human_asked_at", "human_response", "human_response_at"],
          description: "Task completion proof - REQUIRED for standard close (OD-491). Timestamps must be in order with 3s minimum gap for human response.",
        },
        closing_reflection: {
          type: "object",
          properties: {
            what_broke: { type: "string" },
            what_took_longer: { type: "string" },
            do_differently: { type: "string" },
            what_worked: { type: "string" },
            wrong_assumption: { type: "string" },
            scars_applied: {
              type: "array",
              items: { type: "string" },
            },
          },
          description: "Answers to 6 closing questions (required for standard close)",
        },
        human_corrections: {
          type: "string",
          description: "Human corrections/additions (required for standard close, even if empty)",
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              decision: { type: "string" },
              rationale: { type: "string" },
              alternatives_considered: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          description: "Decisions made during session",
        },
        open_threads: {
          type: "array",
          items: { type: "string" },
          description: "Open threads to carry forward",
        },
        learnings_created: {
          type: "array",
          items: { type: "string" },
          description: "IDs of learnings created before close",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
        scars_to_record: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_identifier: {
                type: "string",
                description: "UUID or title/description of scar",
              },
              issue_id: {
                type: "string",
                description: "Linear issue UUID",
              },
              issue_identifier: {
                type: "string",
                description: "Linear issue identifier (e.g., OD-XXX)",
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
                description: "Agent identity (CLI, DAC, CODA-1, etc.)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Scars to record as part of close (batch operation)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "create_learning",
    description: "Create scar, win, or pattern entry in institutional memory",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
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
          description: "UUID of the scar from orchestra_learnings",
        },
        issue_id: {
          type: "string",
          description: "Linear issue UUID",
        },
        issue_identifier: {
          type: "string",
          description: "Linear issue identifier (e.g., OD-XXX)",
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
          description: "Agent identity (CLI, DAC, CODA-1, etc.)",
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
                description: "Linear issue identifier (e.g., OD-XXX)",
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
                description: "Agent identity (CLI, DAC, CODA-1, etc.)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Array of scar usage entries to record",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope for scar resolution",
        },
      },
      required: ["scars"],
    },
  },
  {
    name: "save_transcript",
    description: "Save full session transcript to storage for training data and post-mortems (OD-467)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
      },
      required: ["session_id", "transcript"],
    },
  },
  {
    name: "get_transcript",
    description: "Retrieve a session transcript from storage (OD-467)",
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

  // ============================================================================
  // SEARCH & LOG TOOLS (OD-560, OD-561)
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
    name: "gitmem-ss",
    description: "gitmem-ss (session_start) - Initialize session with institutional context",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., OD-XXX)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists (OD-558)",
        },
      },
    },
  },
  {
    name: "gitmem-sc",
    description: "gitmem-sc (session_close) - Close session with compliance validation. Standard close requires task_completion proof (OD-491).",
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
        task_completion: {
          type: "object",
          properties: {
            questions_displayed_at: {
              type: "string",
              description: "ISO timestamp when 7 reflection questions were displayed to human (Task 1)",
            },
            reflection_completed_at: {
              type: "string",
              description: "ISO timestamp when agent finished answering all questions (Task 2)",
            },
            human_asked_at: {
              type: "string",
              description: "ISO timestamp when agent asked human for corrections (Task 3)",
            },
            human_response: {
              type: "string",
              description: "Human's response - 'none', 'no corrections', or actual corrections (Task 4)",
            },
            human_response_at: {
              type: "string",
              description: "ISO timestamp when human responded (Task 4) - must be >= 3 seconds after human_asked_at",
            },
          },
          required: ["questions_displayed_at", "reflection_completed_at", "human_asked_at", "human_response", "human_response_at"],
          description: "Task completion proof - REQUIRED for standard close (OD-491)",
        },
        closing_reflection: {
          type: "object",
          properties: {
            what_broke: { type: "string" },
            what_took_longer: { type: "string" },
            do_differently: { type: "string" },
            what_worked: { type: "string" },
            wrong_assumption: { type: "string" },
            scars_applied: {
              type: "array",
              items: { type: "string" },
            },
          },
          description: "Answers to 6 closing questions (required for standard close)",
        },
        human_corrections: {
          type: "string",
          description: "Human corrections/additions (required for standard close, even if empty)",
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              decision: { type: "string" },
              rationale: { type: "string" },
              alternatives_considered: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          description: "Decisions made during session",
        },
        open_threads: {
          type: "array",
          items: { type: "string" },
          description: "Open threads to carry forward",
        },
        learnings_created: {
          type: "array",
          items: { type: "string" },
          description: "IDs of learnings created before close",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
        scars_to_record: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_id: { type: "string" },
              reference_type: { type: "string" },
              reference_context: { type: "string" },
              session_id: { type: "string" },
              agent: { type: "string" },
            },
          },
          description: "Scars to record (batch recorded in parallel)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "gitmem-cl",
    description: "gitmem-cl (create_learning) - Create scar/win/pattern in institutional memory",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
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
          description: "UUID of the scar from orchestra_learnings",
        },
        issue_id: {
          type: "string",
          description: "Linear issue UUID",
        },
        issue_identifier: {
          type: "string",
          description: "Linear issue identifier (e.g., OD-XXX)",
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
          description: "Agent identity (CLI, DAC, CODA-1, etc.)",
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
                description: "Linear issue identifier (e.g., OD-XXX)",
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
                description: "Agent identity (CLI, DAC, CODA-1, etc.)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Array of scar usage entries to record",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
  // gitmem-search (OD-560)
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
          description: "Filter by type",
        },
      },
      required: ["query"],
    },
  },
  // gitmem-log (OD-561)
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
  // ============================================================================
  // GM-* SHORT, MEMORABLE ALIASES (user-facing ergonomics)
  // ============================================================================
  {
    name: "gm-open",
    description: "gm-open (session_start) - Open a GitMem session and load institutional context",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_identity: {
          type: "string",
          enum: ["CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud"],
          description: "Override agent identity (auto-detects if not provided)",
        },
        linear_issue: {
          type: "string",
          description: "Current Linear issue identifier (e.g., OD-XXX)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
        force: {
          type: "boolean",
          description: "Force create new session even if one already exists (OD-558)",
        },
      },
    },
  },
  {
    name: "gm-close",
    description: "gm-close (session_close) - Close a GitMem session with compliance validation",
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
        task_completion: {
          type: "object",
          properties: {
            questions_displayed_at: {
              type: "string",
              description: "ISO timestamp when 7 reflection questions were displayed to human (Task 1)",
            },
            reflection_completed_at: {
              type: "string",
              description: "ISO timestamp when agent finished answering all questions (Task 2)",
            },
            human_asked_at: {
              type: "string",
              description: "ISO timestamp when agent asked human for corrections (Task 3)",
            },
            human_response: {
              type: "string",
              description: "Human's response - 'none', 'no corrections', or actual corrections (Task 4)",
            },
            human_response_at: {
              type: "string",
              description: "ISO timestamp when human responded (Task 4) - must be >= 3 seconds after human_asked_at",
            },
          },
          required: ["questions_displayed_at", "reflection_completed_at", "human_asked_at", "human_response", "human_response_at"],
          description: "Task completion proof - REQUIRED for standard close (OD-491). Timestamps must be in order with 3s minimum gap for human response.",
        },
        closing_reflection: {
          type: "object",
          properties: {
            what_broke: { type: "string" },
            what_took_longer: { type: "string" },
            do_differently: { type: "string" },
            what_worked: { type: "string" },
            wrong_assumption: { type: "string" },
            scars_applied: {
              type: "array",
              items: { type: "string" },
            },
          },
          description: "Answers to 6 closing questions (required for standard close)",
        },
        human_corrections: {
          type: "string",
          description: "Human corrections/additions (required for standard close, even if empty)",
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              decision: { type: "string" },
              rationale: { type: "string" },
              alternatives_considered: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          description: "Decisions made during session",
        },
        open_threads: {
          type: "array",
          items: { type: "string" },
          description: "Open threads to carry forward",
        },
        learnings_created: {
          type: "array",
          items: { type: "string" },
          description: "IDs of learnings created before close",
        },
        linear_issue: {
          type: "string",
          description: "Associated Linear issue",
        },
        ceremony_duration_ms: {
          type: "number",
          description: "End-to-end ceremony duration from agent perspective (in milliseconds)",
        },
        scars_to_record: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scar_identifier: {
                type: "string",
                description: "UUID or title/description of scar",
              },
              issue_id: {
                type: "string",
                description: "Linear issue UUID",
              },
              issue_identifier: {
                type: "string",
                description: "Linear issue identifier (e.g., OD-XXX)",
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
                description: "Agent identity (CLI, DAC, CODA-1, etc.)",
              },
            },
            required: ["scar_identifier", "surfaced_at", "reference_type", "reference_context"],
          },
          description: "Scars to record as part of close (batch operation)",
        },
      },
      required: ["session_id", "close_type"],
    },
  },
  {
    name: "gm-scar",
    description: "gm-scar (create_learning) - Create a scar/win/pattern in institutional memory",
    inputSchema: {
      type: "object" as const,
      properties: {
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
      },
      required: ["learning_type", "title", "description"],
    },
  },
  // gm-search (OD-560)
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
          description: "Filter by type",
        },
      },
      required: ["query"],
    },
  },
  // gm-log (OD-561)
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
        learning_type: {
          type: "string",
          enum: ["scar", "win", "pattern"],
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
  // ============================================================================
  // ANALYTICS TOOLS (OD-567)
  // ============================================================================
  {
    name: "analyze",
    description: "Session analytics and insights engine. Provides structured analysis of session history, closing reflections, and agent patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., CLI, DAC, CODA-1)",
        },
      },
    },
  },
  // gitmem-analyze alias (OD-567)
  {
    name: "gitmem-analyze",
    description: "gitmem-analyze (analyze) - Session analytics and insights engine",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., CLI, DAC, CODA-1)",
        },
      },
    },
  },
  // gm-analyze ultra-short alias (OD-567)
  {
    name: "gm-analyze",
    description: "gm-analyze (analyze) - Session analytics and insights engine",
    inputSchema: {
      type: "object" as const,
      properties: {
        lens: {
          type: "string",
          enum: ["summary", "reflections"],
          description: "Analysis lens to apply (default: summary)",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope",
        },
        agent: {
          type: "string",
          description: "Filter by agent identity (e.g., CLI, DAC, CODA-1)",
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
  // CACHE MANAGEMENT TOOLS (OD-473)
  // ============================================================================
  {
    name: "gitmem-cache-status",
    description: "gitmem-cache-status - Show local search cache status (scar count, age, staleness)",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
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
          enum: ["orchestra_dev", "weekend_warrior"],
          description: "Project scope (default: orchestra_dev)",
        },
      },
    },
  },
];

/**
 * Tier-gated tool names
 *
 * Cache tools: pro/dev only (require Supabase)
 * Batch/transcript tools: dev only (internal operations)
 */
const CACHE_TOOL_NAMES = new Set([
  "gitmem-cache-status", "gm-cache-s",
  "gitmem-cache-health", "gm-cache-h",
  "gitmem-cache-flush", "gm-cache-f",
]);

const BATCH_TOOL_NAMES = new Set([
  "record_scar_usage_batch", "gitmem-rsb",
]);

const TRANSCRIPT_TOOL_NAMES = new Set([
  "save_transcript", "gitmem-st",
  "get_transcript", "gitmem-gt",
]);

const ANALYZE_TOOL_NAMES = new Set([
  "analyze", "gitmem-analyze", "gm-analyze",
]);

/**
 * Get tools registered for the current tier.
 * Free: core tools only (7 canonical + aliases)
 * Pro: + cache management tools
 * Dev: + batch operations + transcripts
 */
function getRegisteredTools() {
  return TOOLS.filter(tool => {
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
    return true;
  });
}

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: "gitmem-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register list tools handler (tier-gated)
  const registeredTools = getRegisteredTools();
  const registeredToolNames = new Set(registeredTools.map(t => t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registeredTools,
  }));

  // Register call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    // Guard: reject calls to tools not available in current tier
    if (!registeredToolNames.has(name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Unknown tool: ${name}. Available tools depend on your GitMem tier (current: ${getTier()}).` }),
          },
        ],
        isError: true,
      };
    }

    try {
      let result: unknown;

      switch (name) {
        case "recall":
        case "gitmem-r":
          result = await recall(toolArgs as unknown as RecallParams);
          break;
        case "session_start":
        case "gitmem-ss":
        case "gm-open":
          result = await sessionStart(toolArgs as unknown as SessionStartParams);
          break;
        case "session_close":
        case "gitmem-sc":
        case "gm-close":
          result = await sessionClose(toolArgs as unknown as SessionCloseParams);
          break;
        case "create_learning":
        case "gitmem-cl":
        case "gm-scar":
          result = await createLearning(toolArgs as unknown as CreateLearningParams);
          break;
        case "create_decision":
        case "gitmem-cd":
          result = await createDecision(toolArgs as unknown as CreateDecisionParams);
          break;
        case "record_scar_usage":
        case "gitmem-rs":
          result = await recordScarUsage(toolArgs as unknown as RecordScarUsageParams);
          break;
        case "record_scar_usage_batch":
        case "gitmem-rsb":
          result = await recordScarUsageBatch(toolArgs as unknown as RecordScarUsageBatchParams);
          break;
        case "save_transcript":
        case "gitmem-st":
          result = await saveTranscript(toolArgs as unknown as SaveTranscriptParams);
          break;
        case "get_transcript":
        case "gitmem-gt":
          result = await getTranscript(toolArgs as unknown as GetTranscriptParams);
          break;
        case "search":
        case "gitmem-search":
        case "gm-search":
          result = await search(toolArgs as unknown as SearchParams);
          break;
        case "log":
        case "gitmem-log":
        case "gm-log":
          result = await log(toolArgs as unknown as LogParams);
          break;
        case "analyze":
        case "gitmem-analyze":
        case "gm-analyze":
          result = await analyze(toolArgs as unknown as AnalyzeParams);
          break;
        case "gitmem-help": {
          const tier = getTier();
          const commands = [
            { alias: "gitmem-r", full: "recall", description: "Check scars before taking action" },
            { alias: "gitmem-ss", full: "session_start", description: "Initialize session with context" },
            { alias: "gitmem-sc", full: "session_close", description: "Close session with compliance validation" },
            { alias: "gitmem-cl", full: "create_learning", description: "Create scar/win/pattern entry" },
            { alias: "gitmem-cd", full: "create_decision", description: "Log architectural/operational decision" },
            { alias: "gitmem-rs", full: "record_scar_usage", description: "Track scar application" },
            { alias: "gitmem-search", full: "search", description: "Search institutional memory (exploration)" },
            { alias: "gitmem-log", full: "log", description: "List recent learnings chronologically" },
            { alias: "gitmem-analyze", full: "analyze", description: "Session analytics and insights" },
          ];
          if (hasBatchOperations()) {
            commands.push({ alias: "gitmem-rsb", full: "record_scar_usage_batch", description: "Track multiple scars (batch)" });
          }
          if (hasTranscripts()) {
            commands.push(
              { alias: "gitmem-st", full: "save_transcript", description: "Save session transcript to storage" },
              { alias: "gitmem-gt", full: "get_transcript", description: "Retrieve session transcript" },
            );
          }
          if (hasCacheManagement()) {
            commands.push(
              { alias: "gitmem-cache-status", full: "cache_status", description: "Show cache status" },
              { alias: "gitmem-cache-health", full: "cache_health", description: "Compare local vs remote" },
              { alias: "gitmem-cache-flush", full: "cache_flush", description: "Force reload from Supabase" },
            );
          }

          result = {
            header: `
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║    ██████  ██ ████████ ███    ███ ███████ ███    ███      ║
║   ██       ██    ██    ████  ████ ██      ████  ████      ║
║   ██   ███ ██    ██    ██ ████ ██ █████   ██ ████ ██      ║
║   ██    ██ ██    ██    ██  ██  ██ ██      ██  ██  ██      ║
║    ██████  ██    ██    ██      ██ ███████ ██      ██      ║
║                                                           ║
║         Institutional Memory & Learning System            ║
║              Never repeat the same mistake                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`,
            version: "0.1.0",
            tier,
            tools_registered: registeredTools.length,
            storage: hasSupabase() ? "supabase" : "local (.gitmem/)",
            commands,
          };
          break;
        }

        // Cache management tools (OD-473)
        case "gitmem-cache-status":
        case "gm-cache-s":
          result = getCacheStatus((toolArgs.project as Project) || "orchestra_dev");
          break;

        case "gitmem-cache-health":
        case "gm-cache-h":
          result = await checkCacheHealth((toolArgs.project as Project) || "orchestra_dev");
          break;

        case "gitmem-cache-flush":
        case "gm-cache-f":
          result = await flushCache((toolArgs.project as Project) || "orchestra_dev");
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Run the server with stdio transport
 *
 * OD-473: Initializes local vector search in background for fast startup.
 * OD-489: Uses direct Supabase queries to get embeddings for local cache.
 *
 * Server starts immediately; cache loads in background.
 * First few queries may use Supabase fallback until cache is ready.
 */
export async function runServer(): Promise<void> {
  const tier = getTier();

  // Start server immediately (don't block on cache loading)
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const toolCount = getRegisteredTools().length;
  const storage = hasSupabase() ? "supabase" : "local";
  console.error(`[gitmem] Tier: ${tier} | Storage: ${storage} | Tools: ${toolCount}`);

  if (hasSupabase()) {
    // Pro/Dev: Initialize local vector search in background (non-blocking)
    // This loads scars with embeddings directly from Supabase REST API
    console.error("[gitmem] Starting background cache initialization...");
    startBackgroundInit("orchestra_dev");

    // Also init weekend_warrior if needed (non-blocking)
    startBackgroundInit("weekend_warrior");

    console.error("[gitmem] Server ready | Cache loading in background");
  } else {
    // Free tier: no Supabase cache to load
    console.error("[gitmem] Server ready | Using local storage (.gitmem/)");
  }
}
