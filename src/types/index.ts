/**
 * GitMem MCP Server Types
 */

// Tier type (re-exported from tier.ts for convenience)
export type { GitMemTier } from "../services/tier.js";

// Data source types for cache instrumentation (OD-489)
export type DataSource = "local_cache" | "supabase" | "memory";
export type CacheStatus = "hit" | "miss" | "expired" | "bypassed" | "not_applicable";

// Per-component performance breakdown (OD-489 - test harness requirements)
export interface ComponentPerformance {
  latency_ms: number;
  source: DataSource;
  cache_status: CacheStatus;
  network_call: boolean;
}

// Detailed performance breakdown for test harness validation
export interface PerformanceBreakdown {
  // Read operations
  last_session?: ComponentPerformance;
  scar_search?: ComponentPerformance;
  decisions?: ComponentPerformance;
  wins?: ComponentPerformance;
  session_create?: ComponentPerformance;
  // Write operations
  embedding?: ComponentPerformance;
  upsert?: ComponentPerformance;
  storage_write?: ComponentPerformance;
}

// Performance data included in all tool results (OD-429, extended OD-489)
export interface PerformanceData {
  // Legacy fields (maintained for backward compatibility)
  latency_ms: number;
  target_ms: number;
  meets_target: boolean;
  result_count: number;
  memories_surfaced?: string[];
  similarity_scores?: number[];

  // OD-489: Detailed instrumentation for test harness
  total_latency_ms?: number;           // Alias for latency_ms (test harness format)
  network_calls_made?: number;          // PRIMARY METRIC - count of network round-trips
  fully_local?: boolean;                // true only if network_calls_made === 0
  breakdown?: PerformanceBreakdown;     // Per-component details

  // Cache fields (OD-473)
  cache_hit?: boolean;
  cache_age_ms?: number;

  // Search mode (OD-489)
  search_mode?: "local" | "remote";
}

// Agent identities
export type AgentIdentity =
  | "CLI"
  | "DAC"
  | "CODA-1"
  | "Brain_Local"
  | "Brain_Cloud"
  | "Unknown";

export type Project = "orchestra_dev" | "weekend_warrior";

// Thread lifecycle types (OD-thread-lifecycle)
export type ThreadStatus = "open" | "resolved";

export interface ThreadObject {
  /** Unique identifier: "t-" + 8 hex chars (e.g., "t-a1b2c3d4") */
  id: string;
  /** Thread text description */
  text: string;
  /** Current status */
  status: ThreadStatus;
  /** ISO timestamp when thread was first created */
  created_at: string;
  /** ISO timestamp when thread was resolved */
  resolved_at?: string;
  /** Session ID that created this thread */
  source_session?: string;
  /** Session ID that resolved this thread */
  resolved_by_session?: string;
  /** Brief resolution note */
  resolution_note?: string;
}

// Detected environment from agent detection
export interface DetectedEnvironment {
  entrypoint: string | null;
  docker: boolean;
  hostname: string;
  agent: AgentIdentity;
}

// Session start parameters and result
export interface SessionStartParams {
  agent_identity?: AgentIdentity;
  linear_issue?: string;
  issue_title?: string;
  issue_description?: string;
  issue_labels?: string[];
  project?: Project;
  /** OD-558: Force overwrite of existing active session */
  force?: boolean;
}

export interface LastSession {
  id: string;
  title: string;
  date: string;
  key_decisions: string[];
  open_threads: (string | ThreadObject)[];
}

export interface RelevantScar {
  id: string;
  title: string;
  learning_type?: string;
  severity: string;
  description: string;
  counter_arguments: string[];
  similarity: number;
  // OD-508: LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
}

export interface RecentDecision {
  id: string;
  title: string;
  decision: string;
  date: string;
}

export interface RecentWin {
  id: string;
  title: string;
  description: string;
  date: string;
  source_issue?: string;
}

export interface SessionStartResult {
  session_id: string;
  agent: AgentIdentity;
  detected_environment?: DetectedEnvironment;
  last_session?: LastSession | null;
  /** OD-534: PROJECT STATE thread extracted from last session (if present) */
  project_state?: string;
  /** Aggregated open threads across last 5 sessions (deduplicated, migrated to objects) */
  open_threads?: ThreadObject[];
  /** Threads resolved since last session (informational) */
  recently_resolved?: ThreadObject[];
  relevant_scars?: RelevantScar[];
  recent_decisions?: RecentDecision[];
  recent_wins?: RecentWin[];
  performance?: PerformanceData;
  /** OD-558: Whether this session was resumed from an existing active session */
  resumed?: boolean;
  /** Whether this result is from a mid-session refresh (no new session created) */
  refreshed?: boolean;
  /** OD-558: Message explaining session state */
  message?: string;
  /** Asciinema recording path for session replay (from GITMEM_RECORDING_PATH env var) */
  recording_path?: string;
  /** Pre-formatted display string for consistent CLI output */
  display?: string;
}

// Session close parameters and result
export type CloseType = "standard" | "quick" | "autonomous" | "retroactive";

export interface ClosingReflection {
  what_broke: string;
  what_took_longer: string;
  do_differently: string;
  what_worked: string;
  wrong_assumption: string;
  scars_applied: string[];
  /** Q7: What from this session should be captured as institutional memory? */
  institutional_memory_items?: string;
}

/**
 * Task completion proof for standard close (OD-491)
 *
 * Enforces that each step in the closing protocol was actually completed.
 * Timestamps must be in logical order and human_response requires minimum gap.
 */
export interface TaskCompletion {
  /** ISO timestamp when 7 reflection questions were displayed to human (Task 1) */
  questions_displayed_at: string;
  /** ISO timestamp when agent finished answering all questions (Task 2) */
  reflection_completed_at: string;
  /** ISO timestamp when agent asked human for corrections (Task 3) */
  human_asked_at: string;
  /** Human's response - "none", "no corrections", or actual corrections (Task 4) */
  human_response: string;
  /** ISO timestamp when human responded (Task 4) - must be >= 3 seconds after human_asked_at */
  human_response_at: string;
}

export interface SessionDecision {
  title: string;
  decision: string;
  rationale: string;
  alternatives_considered?: string[];
}

export interface SessionCloseParams {
  session_id: string;
  close_type: CloseType;
  /** Task completion proof - REQUIRED for standard close (OD-491) */
  task_completion?: TaskCompletion;
  closing_reflection?: ClosingReflection;
  human_corrections?: string;
  decisions?: SessionDecision[];
  open_threads?: (string | ThreadObject)[];
  /** Optional PROJECT STATE that auto-prepends to open_threads[0] (OD-534) */
  project_state?: string;
  learnings_created?: string[];
  linear_issue?: string;
  ceremony_duration_ms?: number; // End-to-end ceremony duration from agent perspective
  scars_to_record?: ScarUsageEntry[]; // Optional: scars to record as part of close
  /** OD-538: Capture full conversation transcript to Supabase storage (defaults to true for CLI/DAC) */
  capture_transcript?: boolean;
  /** OD-538: Explicit transcript file path (overrides automatic detection) */
  transcript_path?: string;
}

export interface CloseCompliance {
  close_type: CloseType;
  agent: AgentIdentity;
  checklist_displayed: boolean;
  questions_answered_by_agent: boolean;
  human_asked_for_corrections: boolean;
  learnings_stored: number;
  scars_applied: number;
  ceremony_duration_ms?: number; // Optional: end-to-end ceremony duration
  retroactive?: boolean; // Optional: marks sessions created post-mortem
}

export interface SessionCloseResult {
  success: boolean;
  session_id: string;
  close_compliance: CloseCompliance;
  validation_errors?: string[];
  performance: PerformanceData;
  /** Pre-formatted display string for consistent CLI output */
  display?: string;
}

// Learning types
export type LearningType = "scar" | "win" | "pattern" | "anti_pattern";
export type ScarSeverity = "critical" | "high" | "medium" | "low";

export interface CreateLearningParams {
  learning_type: LearningType;
  title: string;
  description: string;
  severity?: ScarSeverity;
  scar_type?: string;
  counter_arguments?: string[];
  problem_context?: string;
  solution_approach?: string;
  applies_when?: string[];
  domain?: string[];
  keywords?: string[];
  source_linear_issue?: string;
  project?: Project;
  // OD-508: LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
}

export interface CreateLearningResult {
  success: boolean;
  learning_id: string;
  embedding_generated: boolean;
  performance: PerformanceData;
}

// Decision types
export interface CreateDecisionParams {
  title: string;
  decision: string;
  rationale: string;
  alternatives_considered?: string[];
  personas_involved?: string[];
  docs_affected?: string[];
  linear_issue?: string;
  session_id?: string;
  project?: Project;
}

export interface CreateDecisionResult {
  success: boolean;
  decision_id: string;
  performance: PerformanceData;
}

// OD-552: Surfaced scar tracking (persisted from session_start and recall)
export interface SurfacedScar {
  scar_id: string;
  scar_title: string;
  scar_severity: string;
  surfaced_at: string; // ISO timestamp
  source: "session_start" | "recall";
}

// Scar usage tracking
export type ReferenceType = "explicit" | "implicit" | "acknowledged" | "refuted" | "none";

export interface RecordScarUsageParams {
  scar_id: string;
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string; // OD-552: Session tracking for non-issue contexts
  agent?: string; // OD-552: Agent identity for analytics
  surfaced_at: string;
  acknowledged_at?: string;
  reference_type: ReferenceType;
  reference_context: string;
  execution_successful?: boolean;
}

export interface RecordScarUsageResult {
  success: boolean;
  usage_id: string;
  performance: PerformanceData;
}

// Batch scar usage tracking
export interface ScarUsageEntry {
  scar_identifier: string; // Can be UUID or title/description
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string; // OD-552: Session tracking for non-issue contexts
  agent?: string; // OD-552: Agent identity for analytics
  surfaced_at: string;
  acknowledged_at?: string;
  reference_type: ReferenceType;
  reference_context: string;
  execution_successful?: boolean;
}

export interface RecordScarUsageBatchParams {
  scars: ScarUsageEntry[];
  project?: Project;
}

export interface RecordScarUsageBatchResult {
  success: boolean;
  usage_ids: string[];
  resolved_count: number;
  failed_count: number;
  failed_identifiers?: string[];
  performance: PerformanceData;
}

// Supabase client types
export interface SupabaseListOptions {
  table: string;
  columns?: string;  // Comma-separated column names to select (default: *)
  filters?: Record<string, unknown>;
  limit?: number;
  orderBy?: {
    column: string;
    ascending?: boolean;
  };
}

export interface SupabaseSearchOptions {
  query: string;
  tables?: string[];
  match_count?: number;
  project?: Project;
}

// Transcript types (OD-467)
export interface SaveTranscriptParams {
  session_id: string;
  transcript: string;
  format?: "json" | "markdown";
  project?: Project;
}

export interface SaveTranscriptResult {
  success: boolean;
  transcript_path?: string;
  size_bytes?: number;
  size_kb?: number;
  estimated_tokens?: number;
  error?: string;
  performance: PerformanceData;
}

export interface GetTranscriptParams {
  session_id: string;
}

export interface GetTranscriptResult {
  success: boolean;
  transcript?: string;
  transcript_path?: string;
  size_bytes?: number;
  error?: string;
  performance: PerformanceData;
}

// --- GitMem v2 Phase 2: Multi-Agent Observations ---

export type ObservationSeverity = "info" | "warning" | "scar_candidate";

export interface Observation {
  source: string;
  text: string;
  severity: ObservationSeverity;
  context?: string;
  absorbed_at?: string;
}

export interface SessionChild {
  type: "sub_agent" | "teammate";
  role: string;
  task_description: string;
  scars_inherited: string[];
  observations_returned: Observation[];
  started_at: string;
  ended_at?: string;
}

export interface AbsorbObservationsParams {
  task_id?: string;
  observations: Observation[];
}

export interface AbsorbObservationsResult {
  absorbed: number;
  scar_candidates: number;
  suggestions: string[];
  performance: PerformanceData;
}

// --- Thread Lifecycle Tool Types (OD-thread-lifecycle) ---

export interface ListThreadsParams {
  /** Filter by status (default: "open") */
  status?: ThreadStatus;
  /** Include recently resolved threads (default: false) */
  include_resolved?: boolean;
  project?: Project;
}

export interface ListThreadsResult {
  threads: ThreadObject[];
  total_open: number;
  total_resolved: number;
  performance: PerformanceData;
}

export interface ResolveThreadParams {
  /** Thread ID for exact resolution (e.g., "t-a1b2c3d4") */
  thread_id?: string;
  /** Fuzzy text match against thread descriptions */
  text_match?: string;
  /** Brief note explaining resolution */
  resolution_note?: string;
}

export interface ResolveThreadResult {
  success: boolean;
  resolved_thread?: ThreadObject;
  error?: string;
  performance: PerformanceData;
}

// --- GIT-19: Multi-Session Concurrency ---

/** A single entry in the active-sessions registry */
export interface ActiveSessionEntry {
  session_id: string;
  agent: AgentIdentity;
  started_at: string; // ISO-8601
  hostname: string; // os.hostname()
  pid: number; // process.pid
  project: Project;
}

/** The shape of .gitmem/active-sessions.json on disk */
export interface ActiveSessionsRegistry {
  sessions: ActiveSessionEntry[];
}
