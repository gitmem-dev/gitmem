# Doc-Debt Tracking

Decisions move faster than documentation. A team makes an architectural choice, captures it via `create_decision`, ships the code — and the affected docs go stale. Nobody notices until someone reads the wrong doc months later.

Doc-debt tracking closes this gap by connecting decisions to the documents they affect, then surfacing the drift.

## The Problem

Five scars in Orchestra's institutional memory document this pattern:

- Decisions get captured in PMEM (institutional memory) but affected docs never update
- Code changes outpace documentation
- Agents read stale docs and make wrong assumptions
- The gap compounds: each un-updated doc makes the next session's context less reliable

This isn't a discipline problem — it's a structural one. There's no mechanism connecting "we decided X" to "these docs now need updating."

## Three-Layer Solution

### Layer 1: `docs_affected` on `create_decision` (SHIPPED)

Every decision now declares which docs it impacts.

```
create_decision({
  title: "Session close expanded to 7 questions",
  decision: "Added Q7 for institutional memory capture",
  rationale: "5 questions missed important learnings",
  docs_affected: [
    "docs/systems/enforcement/roadmap.md",
    "docs/operations/session-closing.md"
  ]
})
```

**What shipped:**
- `docs_affected` field: Zod schema, TypeScript types, MCP tool schema (both `create_decision` and `gitmem-cd` alias)
- Handler passes through to Supabase (`orchestra_decisions.docs_affected text[]`)
- Knowledge graph triple: `(Decision: <title>, affects_doc, Doc: <path>)` via `affects_doc` predicate
- Migration `20260213_add_docs_affected_field.sql` applied and live
- `_lite` view includes `docs_affected`

**Pattern:** Same as `alternatives_considered` and `personas_involved` — optional string array, defaults to `[]` in Supabase.

### Layer 2: Session Close Doc-Debt Surfacing (PENDING)

During `session_close`, query recent decisions that have `docs_affected` entries and check whether those docs have been modified since the decision date.

**Concept:**
```
At session close:
  1. Query orchestra_decisions where docs_affected is not empty
     and decision_date > (now - 14 days)
  2. For each affected doc, check git log for modifications after decision_date
  3. If doc is unmodified since the decision, flag it:
     "Decision 'X' affects docs/foo.md but it hasn't been updated since"
  4. Surface as a warning in close compliance output
```

This gives agents a nudge at the natural reflection point — session close — when they're already reviewing what happened.

### Layer 3: Session Start Doc-Debt Accumulation (PENDING)

On `session_start`, display accumulated doc-debt alongside open threads and scars.

**Concept:**
```
At session start:
  1. Same query as Layer 2 — decisions with stale docs_affected
  2. Group by affected doc path
  3. Display: "3 decisions affect docs/enforcement/roadmap.md
              but it hasn't been updated in 12 days"
  4. Include in session_start result alongside scars and threads
```

This makes doc-debt visible before work begins, creating pressure to address it.

## How It Works End-to-End

```
Agent makes decision
    |
    v
create_decision({ ..., docs_affected: ["docs/foo.md"] })
    |
    v
Stored in orchestra_decisions.docs_affected
    + Triple: (Decision, affects_doc, Doc: docs/foo.md)
    |
    v
Next session_close (Layer 2):
    "Warning: docs/foo.md affected by decision 'X' but not updated"
    |
    v
Next session_start (Layer 3):
    "Doc-debt: 2 decisions affect docs/foo.md (unchanged 5 days)"
    |
    v
Agent or human updates docs/foo.md
    |
    v
Debt cleared (git log shows modification after decision_date)
```

## Current Status

| Layer | Status | Description |
|-------|--------|-------------|
| 1 | Shipped | `docs_affected` field on `create_decision` |
| 2 | Open thread `t-e5f6a7b8` | Session close doc-debt surfacing |
| 3 | Open thread `t-c9d0e1f2` | Session start doc-debt accumulation |

## Related

- [Threads](threads.md) — the open thread tracking system
- `src/tools/create-decision.ts` — handler implementation
- `src/services/triple-writer.ts` — `affects_doc` predicate for knowledge graph
- `orchestra/supabase/migrations/20260213_add_docs_affected_field.sql` — schema migration
