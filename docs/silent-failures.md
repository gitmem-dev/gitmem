# Silent Failures in GitMem: Problem Analysis and Proposed Defense

## The Problem

GitMem has a systemic class of bugs where operations appear to succeed but
silently produce no effect. These aren't crashes or errors — they're the
*absence* of signal, which is itself invisible.

Across 30+ institutional scars, a taxonomy of four failure modes has emerged:

### 1. "200 OK, Zero Rows Written"

Supabase PostgREST returns HTTP 200 with an empty array `[]` when writes are
silently blocked by RLS policies, NOT NULL constraints, triggers, or schema
mismatches. The API says "OK" but nothing was persisted.

**Incidents:**
- `directUpsert` appeared to succeed, records never appeared in DB
- Variant metrics: 10+ days of missing A/B test data. `fire-and-forget` with
  `.catch(() => {})` swallowed Supabase 400 errors from a NOT NULL constraint.
  The entire experiment ran blind.
- Linear API: 3 of 7 parallel state transitions returned success but didn't
  actually change state

### 2. "Cache Served Stale, Looked Fresh"

The cache layer returns correct-looking results from outdated code or data:

- MCP server after `npm run build`: Node.js doesn't hot-reload. Old modules stay
  in memory. Tools return results from local cache while the server runs outdated
  code. You think you verified a fix but tested the old code.
- Plugin cache is version-gated: Editing source without bumping version means
  `claude plugin update` says "already at latest." Tests pass (they test source),
  but runtime uses cached old version. **Critical severity** — went undetected
  through 344 tests.
- `fully_local: true` metric lies: `buildPerformanceData` defaults to
  `fully_local: true` when no breakdown is passed. Hours wasted thinking
  Supabase wasn't being reached when it was.

### 3. "Resumed With Zero Context, Didn't Know It"

- `session_start` resume path: When it detects an existing
  `active-session.json`, it returns early with `{ session_id, resumed: true }` —
  skipping ALL institutional context. The agent proceeds blind and doesn't know
  it's missing context because the response looks like a successful start.
- MEMORY.md stale reads: Agent acts on initial content, ignores mid-conversation
  corrections via system-reminder.

### 4. "Verification Says Fail, But It Actually Worked"

- Verification reported "scars not acknowledged" but CODA-1 had output
  the section correctly. Buffer truncation (FIFO `shift()`) discarded early
  output. Infrastructure bug looked identical to LLM failure.
- `claude mcp list`: Reported "No MCP servers configured" right after
  successfully using MCP twice. Diagnostic tool gave wrong answer.

### The Common Shape

All four categories share one trait: **the absence of signal is itself
invisible.** The system doesn't crash, doesn't error, doesn't warn. It returns
a plausible-looking result that happens to be wrong. And the diagnostics we
reach for often have the same class of bug.

---

## Current Defenses

### What We've Built

| Defense | Status | Coverage |
|---------|--------|----------|
| `directUpsert` empty array guard | Deployed | Upsert only, not patch |
| `create-learning.ts` write verification | Deployed | One tool |
| Permissive detection cascade (5 sources) | Deployed | Plugin detection only |
| `session_refresh` for zero-context recovery | Deployed | Manual invocation only |

### What We Haven't Built

| Gap | Exposure |
|-----|----------|
| 19 fire-and-forget `.catch(() => {})` paths | Writes silently vanish |
| No observability for swallowed errors | `console.error` → `/dev/null` in MCP |
| No stale cache detection at runtime | Manual check only |
| No write verification outside `directUpsert` | `directPatch` unguarded |
| No smoke test after session start | Zero-context state looks normal |
| No aggregate failure detection | Can't tell if a write path is dead |

### The 19 Unguarded Fire-and-Forget Paths

```
metrics.ts:333         recordMetrics().catch(() => {})
cache.ts:225,249,273   setResult() for scars, decisions, wins
cache.ts:309,330       setResult() for sessions, scar_usage
triple-writer.ts       4 knowledge graph write paths
record-scar-usage.ts   scar tracking
list-threads.ts        background thread sync
cleanup-threads.ts     thread archival
session-close.ts:961   relevance data update
session-close.ts:984   thread detection
absorb-observations.ts observation persistence
```

Every one of these is a place where a write can fail and nobody will ever know.

---

## Research: Meta-Patterns

We investigated two architectural approaches:

### Option A: Durable Write Pipeline (Heavy)

WAL + transactional outbox + dead letter queue + circuit breaker + bulkhead.
Every write becomes a durable transaction logged before execution, processed by
a background worker, with failed writes captured in a DLQ for retry or manual
intervention.

**Pros:** Guarantees eventual delivery. Full audit trail.
**Cons:** Massive complexity for a single-process MCP server. Requires local
SQLite or equivalent. Transforms fire-and-forget into fire-and-wait, adding
latency to every non-critical write path. Over-engineered for our case — these
are metrics and cache warming, not payment transactions.

### Option B: Effect Tracker (Light) — RECOMMENDED

A lightweight in-process accounting system that wraps async side effects with
registration-before-execution, completion/failure tracking, and on-demand
auditing. Think "OpenTelemetry spans without the collector."

**Pros:** Minimal overhead. No new infrastructure. Addresses 4 of 7 gaps with
one abstraction. The fire-and-forget paths stay fire-and-forget for latency,
but failures become visible.
**Cons:** No guaranteed delivery. No automatic retry. No persistence across
process restarts (unless we add a file-backed buffer).

---

## Proposed Solution: Effect Tracker

### Core Concept

Every async side effect gets wrapped in a tracker that records:
1. **Registration** (before execution): what we intend to do
2. **Completion** (after execution): success with result, or failure with error
3. **Audit** (on demand): aggregate counts queryable via MCP tool

The fire-and-forget paths keep their `.catch()` but the catch *records* instead
of swallowing:

```typescript
// BEFORE: silent failure
writeTriplesForLearning(data).catch(() => {});

// AFTER: tracked failure
tracker.track('triple_write', 'learning', () =>
  writeTriplesForLearning(data)
);
```

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Server                      │
│                                                  │
│  ┌───────────┐    ┌──────────────────────────┐  │
│  │ MCP Tools │───>│     Effect Tracker        │  │
│  └───────────┘    │                           │  │
│                   │  register() → execute()   │  │
│                   │       │           │        │  │
│                   │       ▼           ▼        │  │
│                   │  ┌────────┐ ┌─────────┐   │  │
│                   │  │Pending │ │ Results │   │  │
│                   │  │  Map   │ │  Ring   │   │  │
│                   │  └────────┘ │ Buffer  │   │  │
│                   │             └─────────┘   │  │
│                   │       ▲                    │  │
│                   │       │                    │  │
│                   │  ┌─────────────────┐      │  │
│                   │  │  Audit Query    │      │  │
│                   │  │  (MCP tool)     │      │  │
│                   │  └─────────────────┘      │  │
│                   └──────────────────────────┘  │
│                                                  │
│  Optional: JSONL file buffer for crash recovery  │
└─────────────────────────────────────────────────┘
```

### What It Solves

| Gap | How Effect Tracker Addresses It |
|-----|--------------------------------|
| 19 fire-and-forget paths | Wrap each with `tracker.track()` — failures recorded, not swallowed |
| No observability | Expose `gitmem-health` MCP tool that queries tracker for aggregate stats |
| No aggregate failure detection | Tracker counts failures per write path — "triple_write: 12/15 failed in last hour" |
| Diagnostic tools lying | Health tool reports *actual* write outcomes, not proxy status |
| No write verification outside upsert | Tracker can verify non-empty result for any wrapped operation |

### What It Doesn't Solve (Different Mechanisms Needed)

| Gap | Why Not | Better Approach |
|-----|---------|-----------------|
| Cache staleness | Runtime problem, not write problem | Build hash + version into MCP server startup, expose via health tool |
| Plugin version divergence | Build-time problem | Pre-commit hook or CI check comparing source hash vs cached hash |
| Session zero-context | Bootstrap problem | Sanity check in session_start: "project has N learnings but loaded 0 scars" |

### Key Design Decisions

1. **In-memory ring buffer, not persistent log.** These are non-critical writes
   (metrics, cache warming, knowledge graph triples). If the process crashes, we
   lose the tracker state — that's acceptable. The point is visibility during
   the session, not guaranteed delivery.

2. **Track by write path, not individual write.** We want to know "triple_write
   is failing" not "this specific triple failed." Aggregate stats > individual
   records for our use case.

3. **Expose via MCP tool, not stderr.** MCP server stderr goes to `/dev/null`
   in most deployments. The tracker should be queryable via a `gitmem-health`
   tool that agents and humans can call. This also means session_close can
   include a health summary automatically.

4. **Non-blocking wrapper.** The tracker must not add latency to the happy path.
   Registration is synchronous (Map.set), completion recording is synchronous
   (update Map entry). The wrapped operation runs exactly as before.

5. **Optional JSONL file buffer for failures.** For crash-recovery scenarios or
   post-mortem analysis, failures can optionally be appended to a local JSONL
   file. This is the only I/O the tracker introduces.

### Rough API Surface

```typescript
interface EffectTracker {
  // Wrap an async operation for tracking
  track<T>(
    path: string,       // e.g., 'triple_write', 'cache_set', 'metrics'
    target: string,     // e.g., 'learning', 'scar_search', 'session'
    fn: () => Promise<T>
  ): Promise<T | undefined>;  // returns undefined on failure (fire-and-forget)

  // Query aggregate stats
  getStats(): {
    byPath: Record<string, {
      attempted: number;
      succeeded: number;
      failed: number;
      lastFailure?: { error: string; timestamp: Date };
      avgDurationMs: number;
    }>;
    overall: {
      attempted: number;
      succeeded: number;
      failed: number;
      oldestPending?: Date;
    };
  };

  // Get recent failures (ring buffer)
  getRecentFailures(limit?: number): Array<{
    path: string;
    target: string;
    error: string;
    timestamp: Date;
  }>;
}
```

### Session Close Integration

The health summary should be automatically included in session close data:

```
📊 Write Health (this session)
  triple_write:    47/50 succeeded (3 failed — Supabase timeout)
  cache_set:       128/128 succeeded
  metrics:         15/15 succeeded
  scar_usage:      3/3 succeeded
  thread_sync:     0/1 succeeded (RLS policy blocked)
```

If any path has a failure rate > 20%, the session close reflection should
surface it as a potential scar candidate.

### Migration Path

1. **Create `EffectTracker` class** (~100 lines)
2. **Create singleton instance** in MCP server initialization
3. **Replace 19 `.catch(() => {})` calls** with `tracker.track()` — mechanical
   transformation, one file at a time
4. **Add `gitmem-health` MCP tool** that calls `tracker.getStats()`
5. **Wire into session_close** to include health summary in closing payload

Steps 1-3 can be done in a single PR. Steps 4-5 are follow-ups.

---

## Decision Record

**Decision:** Use the Effect Tracker pattern (Option B) over the Durable Write
Pipeline (Option A).

**Rationale:** Our fire-and-forget writes are non-critical (metrics, cache,
knowledge graph). We don't need guaranteed delivery — we need *visibility* into
what's failing. The Effect Tracker gives us that with ~100 lines of code and
zero new infrastructure. The Durable Write Pipeline would require SQLite, a
background processor, retry logic, and idempotency keys — massive complexity
for writes we're intentionally treating as best-effort.

**What we're explicitly NOT doing:**
- No automatic retry of failed writes (these are best-effort by design)
- No persistent WAL or outbox table (in-memory is sufficient)
- No circuit breaker (we don't want to stop attempting writes; we want to
  know when they fail)

**Counter-arguments:**
- "What about the 10-day blind A/B test?" — The effect tracker would have
  surfaced that failure in the first session's health report, not 10 days later.
  Visibility alone prevents the worst outcomes.
- "What if you need guaranteed delivery later?" — The effect tracker is a
  stepping stone. The `track()` wrapper is the same interface a durable pipeline
  would use. We can upgrade the implementation without changing call sites.
