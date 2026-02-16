# Threads

Threads are persistent work items that carry across sessions. They track what's unresolved, what's blocked, and what needs follow-up — surviving session boundaries so nothing gets lost.

## Why Threads Exist

Sessions end, but work doesn't. Before threads, open items lived in `open_threads` as plain strings inside session records. They had no IDs, no lifecycle, no way to mark something as done. You'd see the same stale item surfaced session after session with no way to clear it.

Threads give open items identity (`t-XXXXXXXX`), lifecycle status, vitality scoring, and a resolution trail.

## Thread Lifecycle

Threads progress through a 5-stage state machine based on vitality scoring and age:

```
create_thread / session_close payload
        |
        v
  [ EMERGING ]  ── first 24 hours, high visibility
        |
        v (age > 24h)
  [ ACTIVE ]  ── vitality > 0.5, actively referenced
        |
        v (vitality decays)
  [ COOLING ]  ── 0.2 <= vitality <= 0.5, fading from use
        |
        v (vitality < 0.2)
  [ DORMANT ]  ── vitality < 0.2, no recent touches
        |
        v (dormant 30+ days)
  [ ARCHIVED ]  ── auto-archived, hidden from session_start

Any state ──(explicit resolve_thread)──> [ RESOLVED ]
```

### Creation

Threads are created in three ways:

1. **Explicitly** via `create_thread` — mid-session when you identify a new open item
2. **Implicitly** via `session_close` — when the closing payload includes `open_threads`
3. **Promoted** from a suggestion via `promote_suggestion` — when a recurring topic is confirmed

New threads undergo **semantic deduplication** (Phase 3) before creation. If a thread with similar meaning already exists (cosine similarity > 0.85), the existing thread is returned instead.

### Carry-Forward

On `session_start`, threads are loaded from Supabase (source of truth) with fallback to session aggregation. The display now shows vitality info:

```
Open threads (3):
  t-abc12345: Fix auth timeout [ACTIVE 0.82] (operational, 2d ago)
  t-def67890: Improve test coverage [COOLING 0.35] (backlog, 12d ago)
  t-ghi11111: New thread just created [EMERGING 0.95] (backlog, today)
```

### Resolution

Threads are resolved via `resolve_thread`:
- **By ID** (preferred): `resolve_thread({ thread_id: "t-a1b2c3d4" })`
- **By text match** (fallback): `resolve_thread({ text_match: "package name" })`

Resolution records a timestamp, the resolving session, and an optional note. Knowledge graph triples are written to track the resolution relationship.

## Vitality Scoring

Every thread has a vitality score (0.0 to 1.0) computed from two components:

```
vitality = 0.55 * recency + 0.45 * frequency
```

### Recency

Exponential decay based on thread class half-life:

```
recency = e^(-ln(2) * days_since_touch / half_life)
```

| Thread Class | Half-Life | Use Case |
|-------------|-----------|----------|
| operational | 3 days | Deploys, fixes, incidents, blockers |
| backlog | 21 days | Research, long-running improvements |

Thread class is auto-detected from keywords in the thread text. Keywords like "deploy", "fix", "debug", "hotfix", "urgent", "broken", "incident", "blocker" classify a thread as operational.

### Frequency

Log-scaled touch count normalized against thread age:

```
frequency = min(log(touch_count + 1) / log(days_alive + 1), 1.0)
```

### Status Thresholds

| Vitality Score | Status |
|---------------|--------|
| > 0.5 | active |
| 0.2 - 0.5 | cooling |
| < 0.2 | dormant |

Threads touched during a session have their `touch_count` incremented and `last_touched_at` refreshed, which revives decayed vitality.

## Lifecycle State Machine

The lifecycle wraps vitality scoring with age-based and dormancy logic:

| Transition | Condition |
|-----------|-----------|
| any &rarr; emerging | Thread age < 24 hours |
| emerging &rarr; active | Thread age >= 24 hours, vitality > 0.5 |
| active &rarr; cooling | Vitality drops to [0.2, 0.5] |
| cooling &rarr; active | Touch refreshes vitality above 0.5 |
| cooling &rarr; dormant | Vitality drops below 0.2 |
| dormant &rarr; active | Touch refreshes vitality above 0.5 |
| dormant &rarr; archived | Dormant for 30+ consecutive days |
| any &rarr; resolved | Explicit `resolve_thread` call |

**Terminal states:** Archived and resolved threads do not transition. To reopen an archived topic, create a new thread.

**Dormancy tracking:** When a thread enters dormant status, a `dormant_since` timestamp is stored in the Supabase metadata column. This is cleared if the thread revives.

**Auto-archival:** At every `session_start`, a fire-and-forget call archives threads that have been dormant for 30+ days.

## Semantic Deduplication

When `create_thread` is called, the new thread text is compared against all open threads using embedding cosine similarity before creation.

| Threshold | Value | Meaning |
|-----------|-------|---------|
| `DEDUP_SIMILARITY_THRESHOLD` | 0.85 | Above this = duplicate |

**Dedup methods** (in priority order):
1. **Embedding-based** — cosine similarity of text embeddings (preferred, when Supabase available)
2. **Text normalization fallback** — exact match after lowercasing, stripping punctuation, collapsing whitespace

When a duplicate is detected:
- The existing thread is returned instead of creating a new one
- The existing thread is touched in Supabase to keep it vital
- Response includes `deduplicated: true` with match details

## Knowledge Graph Integration

Thread creation and resolution generate knowledge graph triples linking threads to sessions and issues.

### Predicates

| Predicate | Subject | Object | When |
|-----------|---------|--------|------|
| `created_thread` | Session | Thread | Thread created |
| `resolves_thread` | Session | Thread | Thread resolved |
| `relates_to_thread` | Thread | Issue | Thread linked to Linear issue |

Triples are written fire-and-forget via `writeTriplesForThreadCreation()` and `writeTriplesForThreadResolution()`. They use `HALF_LIFE_PROCESS = 9999` (never decay).

### Graph Traversal

The `graph_traverse` tool provides 4 query lenses:
- **connected_to(node)** — find all relationships for a thread, issue, or session
- **produced_by(agent)** — find all contributions by an agent or persona
- **provenance(node, depth)** — trace origin chain up to N hops
- **stats()** — predicate distribution, top subjects/objects/issues

## Implicit Thread Detection

At `session_close`, session embeddings are compared to detect recurring topics that should become threads.

### Detection Algorithm

1. Compare current session embedding against the last 20 sessions (30-day window)
2. Find sessions with cosine similarity >= 0.70
3. If 3+ sessions cluster (current + 2 historical):
   - Check if an open thread already covers the topic (similarity >= 0.80) &rarr; skip
   - Check if a pending suggestion already matches (similarity >= 0.80) &rarr; add evidence
   - Otherwise, create a new suggestion

### Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `SESSION_SIMILARITY_THRESHOLD` | 0.70 | Session-to-session clustering |
| `THREAD_MATCH_THRESHOLD` | 0.80 | Existing thread covers topic |
| `SUGGESTION_MATCH_THRESHOLD` | 0.80 | Matches existing suggestion |
| `MIN_EVIDENCE_SESSIONS` | 3 | Minimum sessions to trigger |

### Suggestion Lifecycle

Suggestions are stored in `.gitmem/suggested-threads.json` and surfaced at `session_start`:

```
Suggested threads (2) — recurring topics not yet tracked:
  ts-a1b2c3d4: Recurring auth timeout pattern (3 sessions)
  ts-e5f6g7h8: Build performance regression (4 sessions)
  Use promote_suggestion or dismiss_suggestion to manage.
```

| Status | Meaning |
|--------|---------|
| pending | New suggestion, awaiting user action |
| promoted | Converted to a real thread via `promote_suggestion` |
| dismissed | Suppressed via `dismiss_suggestion` (3x = permanent) |

## ThreadObject Schema

```typescript
interface ThreadObject {
  id: string;            // "t-" + 8 hex chars (e.g., "t-a1b2c3d4")
  text: string;          // Description of the open item
  status: ThreadStatus;  // "open" | "resolved"
  created_at: string;    // ISO timestamp
  resolved_at?: string;  // ISO timestamp (set on resolution)
  source_session?: string;       // Session UUID that created this thread
  resolved_by_session?: string;  // Session UUID that resolved it
  resolution_note?: string;      // Brief explanation of resolution
}
```

**Supabase-native statuses** (`emerging|active|cooling|dormant|archived|resolved`) are display enrichments. The local `ThreadStatus` stays `"open"|"resolved"` for backward compatibility, with `mapStatusFromSupabase()` flattening all non-resolved to `"open"`.

## MCP Tools

### `create_thread`

Create a new open thread. Runs semantic dedup check and writes knowledge graph triples.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | yes | Thread description |
| `linear_issue` | `string` | no | Associated Linear issue (e.g., PROJ-123) |

Returns: `{ thread, deduplicated?, dedup_details?, performance }`

### `resolve_thread`

Mark a thread as resolved. Provide either `thread_id` or `text_match`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `thread_id` | `string` | -- | Exact thread ID (e.g., `"t-a1b2c3d4"`) |
| `text_match` | `string` | -- | Case-insensitive substring match |
| `resolution_note` | `string` | -- | Brief resolution explanation |

Returns: `{ success, resolved_thread, performance }`

### `list_threads`

List threads with optional filtering.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | `"open" \| "resolved"` | `"open"` | Filter by status |
| `include_resolved` | `boolean` | `false` | Include recently resolved threads |
| `project` | `string` | -- | Project scope |

Returns: `{ threads, total_open, total_resolved, performance }`

### `cleanup_threads`

Batch triage tool for thread health review. Groups threads by lifecycle status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project` | `string` | -- | Project scope |
| `auto_archive` | `boolean` | `false` | Auto-archive threads dormant 30+ days |

Returns: `{ summary, groups: { emerging, active, cooling, dormant }, archived_count, archived_ids, performance }`

### `promote_suggestion`

Convert a suggested thread into a real open thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `suggestion_id` | `string` | yes | Suggestion ID (e.g., `"ts-a1b2c3d4"`) |
| `project` | `string` | -- | Project scope |

Returns: `{ thread, suggestion, performance }`

### `dismiss_suggestion`

Dismiss a suggested thread. Suggestions dismissed 3+ times are permanently suppressed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `suggestion_id` | `string` | yes | Suggestion ID |

Returns: `{ suggestion, performance }`

### `graph_traverse`

Traverse the knowledge graph connecting threads, sessions, issues, and learnings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lens` | `string` | yes | Query type: `connected_to`, `produced_by`, `provenance`, `stats` |
| `node` | `string` | -- | Node to query (e.g., thread ID, issue ID) |
| `predicate` | `string` | -- | Filter by predicate type |
| `depth` | `number` | -- | Max traversal depth (provenance lens) |

## Storage

### Local: `.gitmem/threads.json`

The runtime cache. An array of `ThreadObject` values, updated on every `create_thread`, `resolve_thread`, and `session_start` (after aggregation merge).

### Local: `.gitmem/suggested-threads.json`

Pending thread suggestions from implicit detection. Array of `ThreadSuggestion` objects with embeddings and evidence session lists.

### Remote: `threads` table (Supabase)

Source of truth. Full table with columns for vitality scoring, lifecycle status, embeddings, metadata (including `dormant_since`), and knowledge graph relationships.

### Remote: `sessions.open_threads`

Legacy JSONB column on the sessions table. Written during `session_close`. Used as fallback when the `threads` table is unavailable.

## Format Normalization

Threads have passed through several format generations. The `normalizeThreads()` function handles all of them:

| Format | Example | Handling |
|--------|---------|----------|
| Plain string | `"Fix the bug"` | Migrated to ThreadObject with generated ID |
| Full ThreadObject | `{ id, text, status }` | Passed through as-is |
| JSON string (text) | `'{"id":"t-abc","text":"...","status":"open"}'` | Parsed, used directly |
| JSON string (note) | `'{"id":"t-abc","note":"...","status":"open"}'` | Parsed, `note` mapped to `text` |
| Legacy format | `'{"item":"...","context":"..."}'` | `item` field extracted as text |

## PROJECT STATE Convention

Threads starting with `PROJECT STATE:` are treated specially:
- Skipped during aggregation (not shown in thread lists)
- Extracted separately by `session_start` for rapid project context

Format: `PROJECT STATE: Project Name: PROJ-1done PROJ-2~note PROJ-3->next`

## Implementation

| File | Purpose |
|------|---------|
| `src/services/thread-manager.ts` | Core lifecycle: ID generation, normalization, aggregation, resolution, file I/O |
| `src/services/thread-vitality.ts` | Vitality scoring, lifecycle state machine, thread class detection |
| `src/services/thread-supabase.ts` | Supabase CRUD, vitality recomputation, dormant tracking, archival |
| `src/services/thread-dedup.ts` | Semantic deduplication via embedding cosine similarity |
| `src/services/thread-suggestions.ts` | Implicit thread detection, suggestion management |
| `src/services/triple-writer.ts` | Knowledge graph triple extraction for threads |
| `src/tools/create-thread.ts` | `create_thread` MCP tool (with dedup + triples) |
| `src/tools/resolve-thread.ts` | `resolve_thread` MCP tool (with triples) |
| `src/tools/list-threads.ts` | `list_threads` MCP tool |
| `src/tools/cleanup-threads.ts` | `cleanup_threads` MCP tool (batch triage) |
| `src/tools/promote-suggestion.ts` | `promote_suggestion` MCP tool |
| `src/tools/dismiss-suggestion.ts` | `dismiss_suggestion` MCP tool |
| `src/tools/graph-traverse.ts` | `graph_traverse` MCP tool (4 lenses) |
| `src/schemas/thread.ts` | Zod validation schemas |
| `src/types/index.ts` | TypeScript interfaces |
| `tests/unit/services/thread-vitality.test.ts` | Vitality scoring tests (17) |
| `tests/unit/services/thread-lifecycle.test.ts` | Lifecycle state machine tests (15) |
| `tests/unit/services/thread-manager.test.ts` | Thread manager tests (28) |
| `tests/unit/services/thread-supabase.test.ts` | Supabase integration tests (24) |
| `tests/unit/services/thread-dedup.test.ts` | Deduplication tests (13) |
| `tests/unit/services/thread-suggestions.test.ts` | Suggestion detection tests (13) |
| `tests/unit/services/thread-triples.test.ts` | Triple extraction tests (10) |
