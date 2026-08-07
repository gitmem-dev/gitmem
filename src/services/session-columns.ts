/**
 * The persisted column set for the sessions table (GIT-74/R17).
 *
 * WHY THIS EXISTS
 *
 * session_close builds its upsert payload by spreading the *existing* session
 * record and layering the close on top:
 *
 *   sessionData = { ...existingWithoutEmbedding, close_compliance }
 *
 * When the session is not found in Supabase it falls back to the LOCAL file
 * record, whose shape is not the row's shape — it carries rendering fields like
 * `display`. Postgres rejects the whole upsert on the first unknown key
 * (PGRST204), so one local-only field fails the entire close. A fresh Pro
 * install provisioned from schema/setup.sql could not close its first session.
 *
 * The fix filters to known columns rather than deleting `display` by name,
 * because the defect is the shape-drift CLASS, not that one instance. Any
 * future local-only field is now inert instead of fatal.
 *
 * SOURCE OF TRUTH — read this before editing.
 *
 * This list is the UNION of two things, and it has to be, because they differ:
 *
 *   1. `schema/setup.sql` — what a fresh install creates. The canonical
 *      definition, and the source of truth for anything provisioned today.
 *   2. The live production table, which carries ELEVEN columns setup.sql does
 *      not define (children, claude_code_session_id, compacted*, insights,
 *      metrics, task_observations, blocked_by, handover_linear_slug,
 *      pre_compaction_summary) and lacks `updated_at`, which setup.sql has.
 *
 * Filtering to setup.sql ALONE would have silently dropped real production data
 * on every close — the same disease this filter cures, pointed the other way.
 * So the union is deliberate, and the drift between the two is itself a known
 * defect: schema/setup.sql is stale and a fresh install does not reproduce
 * production. That is tracked separately; do not "clean up" this list by
 * trimming it to setup.sql until those two agree.
 *
 * When adding a column: add it to schema/setup.sql AND here, in the same
 * change. A column missing here is silently dropped on write.
 */
export const SESSION_COLUMNS: ReadonlySet<string> = new Set([
  // --- defined in schema/setup.sql ---
  "id",
  "session_title",
  "session_date",
  "agent",
  "project",
  "linear_issue",
  "recording_path",
  "transcript_path",
  "decisions",
  "open_threads",
  "closing_reflection",
  "close_compliance",
  "rapport_summary",
  "embedding",
  "created_at",
  "updated_at",

  // --- present in production, absent from setup.sql (see note above) ---
  "blocked_by",
  "children",
  "claude_code_session_id",
  "compacted",
  "compacted_at",
  "compacted_summary",
  "handover_linear_slug",
  "insights",
  "metrics",
  "pre_compaction_summary",
  "task_observations",
]);

/**
 * Drop keys the sessions table does not have, so a local-only field cannot
 * fail an otherwise valid close.
 *
 * Returns a new object; the input is not mutated. Undefined values are kept —
 * an explicit undefined is a caller's business, and only *unknown keys* are the
 * hazard being removed here.
 */
export function filterToSessionColumns(
  data: Record<string, unknown>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SESSION_COLUMNS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
