# Threads

Threads are persistent work items that carry across sessions. They track what's unresolved, what's blocked, and what needs follow-up — surviving session boundaries so nothing gets lost.

## Why Threads Exist

Sessions end, but work doesn't. Before threads, open items lived in `open_threads` as plain strings inside session records. They had no IDs, no lifecycle, no way to mark something as done. You'd see the same stale item surfaced session after session with no way to clear it.

Threads give open items identity (`t-XXXXXXXX`), status (`open` / `resolved`), and a resolution trail.

## Thread Lifecycle

```
create_thread / session_close payload
        |
        v
   [ OPEN ]  ── persisted to .gitmem/threads.json
        |         + Supabase orchestra_sessions.open_threads
        |
   (carried forward by session_start across sessions)
        |
        v
  resolve_thread (by ID or text match)
        |
        v
  [ RESOLVED ]  ── resolution_note + timestamp recorded
```

### Creation

Threads are created in two ways:

1. **Explicitly** via `create_thread` — mid-session when you identify a new open item
2. **Implicitly** via `session_close` — when the closing payload includes `open_threads`

### Carry-Forward

On `session_start`, threads are aggregated from the last 5 closed sessions (within 14 days). The aggregation:
- Normalizes mixed formats (plain strings, JSON objects, ThreadObjects)
- Deduplicates by text content (case-insensitive)
- Skips `PROJECT STATE:` threads (handled separately)
- Merges with the local `.gitmem/threads.json` file

### Resolution

Threads are resolved via `resolve_thread`:
- **By ID** (preferred): `resolve_thread({ thread_id: "t-a1b2c3d4" })`
- **By text match** (fallback): `resolve_thread({ text_match: "package name" })`

Resolution records a timestamp, the resolving session, and an optional note.

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

## MCP Tools

### `list_threads`

List threads with optional filtering.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | `"open" \| "resolved"` | `"open"` | Filter by status |
| `include_resolved` | `boolean` | `false` | Include recently resolved threads |
| `project` | `string` | — | Project scope |

Returns: `{ threads, total_open, total_resolved, performance }`

### `create_thread`

Create a new open thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | yes | Thread description |

Returns: `{ thread, performance }`

### `resolve_thread`

Mark a thread as resolved. Provide either `thread_id` or `text_match`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `thread_id` | `string` | — | Exact thread ID (e.g., `"t-a1b2c3d4"`) |
| `text_match` | `string` | — | Case-insensitive substring match |
| `resolution_note` | `string` | — | Brief resolution explanation |

Returns: `{ success, resolved_thread, performance }`

## Storage

Threads are persisted in two places:

### Local: `.gitmem/threads.json`

The canonical runtime state. An array of `ThreadObject` values, updated on every `create_thread`, `resolve_thread`, and `session_start` (after aggregation).

```json
[
  {
    "id": "t-05a7ecb6",
    "text": "Phase 2 GitMem public npm release still pending",
    "status": "open",
    "created_at": "2026-02-09T18:12:01.097Z",
    "source_session": "c2d841be-fff2-4ac9-ae1e-4d604e2e4d69"
  }
]
```

### Remote: `orchestra_sessions.open_threads`

Supabase JSONB column on the sessions table. Written during `session_close`. This is how threads survive across machines and containers — `session_start` reads the last 5 closed sessions and aggregates their `open_threads`.

## Format Normalization

Threads have passed through several format generations. The `normalizeThreads()` function handles all of them:

| Format | Example | Handling |
|--------|---------|----------|
| Plain string | `"Fix the bug"` | Migrated to ThreadObject with generated ID |
| Full ThreadObject | `{ id, text, status }` | Passed through as-is |
| JSON string (text) | `'{"id":"t-abc","text":"...","status":"open"}'` | Parsed, used directly |
| JSON string (note) | `'{"id":"t-abc","note":"...","status":"open"}'` | Parsed, `note` mapped to `text` |
| Legacy format | `'{"item":"...","context":"..."}'` | `item` field extracted as text |

The `{id, status, note}` format appears when agents write threads with `note` instead of `text` in their closing payloads. Without normalization, these get re-wrapped as new threads with the JSON string as their text, creating duplicates.

## PROJECT STATE Convention

Threads starting with `PROJECT STATE:` are treated specially:
- Skipped during aggregation (not shown in thread lists)
- Extracted separately by `session_start` for rapid project context

Format: `PROJECT STATE: Project Name: OD-523done OD-524~note OD-525->next`

See `docs/operations/session-closing.md` in the Orchestra repo for details.

## Known Issues

### Deduplication by ID

`aggregateThreads()` currently deduplicates by text content only. Two threads with the same ID but different text (e.g., one from `note` field, one original) can both appear. A fix to also deduplicate by thread ID is pending.

## Implementation

| File | Purpose |
|------|---------|
| `src/services/thread-manager.ts` | Core lifecycle: ID generation, normalization, aggregation, resolution, file I/O |
| `src/tools/list-threads.ts` | `list_threads` MCP tool |
| `src/tools/create-thread.ts` | `create_thread` MCP tool |
| `src/tools/resolve-thread.ts` | `resolve_thread` MCP tool |
| `src/schemas/thread.ts` | Zod validation schemas |
| `src/types/index.ts` | TypeScript interfaces (`ThreadObject`, `ThreadStatus`) |
| `tests/unit/services/thread-manager.test.ts` | Unit tests (27 tests) |
