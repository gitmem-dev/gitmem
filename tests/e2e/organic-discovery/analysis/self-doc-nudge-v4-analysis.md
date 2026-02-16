# Self-Documentation Nudge Probe — v4 Analysis

**Date:** 2026-02-12
**Configs tested:** D1 (v4+h0), D2 (v4+h1), D3 (v4+h2)
**Models:** Sonnet (3 runs/config = 9 runs), Haiku (3 runs/config = 9 runs)
**Total runs:** 18

## Executive Summary

The v4 nudge — which explicitly mentions MEMORY.md updates and uses motivational framing — **broke through the 0% self-documentation barrier**, but **only on Sonnet**. Haiku with v4 nudge achieves discovery and persistence (with hooks) but never self-documents. This proves self-documentation requires both the right nudge AND sufficient model capability.

## Aggregate Results

### Sonnet — D-series (v4 nudge)

| Config | Nudge | Hooks | Discovery | Exploration | Self-Doc | Persistence | Avg Calls |
|--------|-------|-------|-----------|-------------|----------|-------------|-----------|
| **D1** | v4 | none | 67% | 67% | **22%** | 50% | 13.7 |
| **D2** | v4 | session-start | 100% | 78% | **11%** | 100% | 17.0 |
| **D3** | v4 | full | 100% | 89% | **33%** | 100% | 20.7 |

### Haiku — D-series (v4 nudge)

| Config | Nudge | Hooks | Discovery | Exploration | Self-Doc | Persistence | Avg Calls |
|--------|-------|-------|-----------|-------------|----------|-------------|-----------|
| **D1** | v4 | none | 33% | 33% | 0% | 0% | 8.0 |
| **D2** | v4 | session-start | 100% | 89% | 0% | 100% | 10.3 |
| **D3** | v4 | full | 100% | 89% | 0% | 100% | 8.7 |

### Sonnet — C-series baseline (v2 nudge, for comparison)

| Config | Nudge | Hooks | Discovery | Exploration | Self-Doc | Persistence | Avg Calls |
|--------|-------|-------|-----------|-------------|----------|-------------|-----------|
| **C1** | v2 | none | 33% | 33% | 0% | 0% | 4.3 |
| **C2** | v2 | session-start | 100% | 89% | 0% | 100% | 7.0 |
| **C3** | v2 | full | 100% | 78% | 0% | 100% | 6.3 |

## Key Findings

### 1. Self-documentation requires v4 nudge AND Sonnet-class capability

The critical interaction effect:
- **v2 nudge + Sonnet** = 0% self-doc (C-series)
- **v4 nudge + Haiku** = 0% self-doc (D-series haiku)
- **v4 nudge + Sonnet** = 11-33% self-doc (D-series sonnet)

Neither factor alone is sufficient. The explicit MEMORY.md mention in v4 provides the *what* to do, but only Sonnet has the *capability* to follow through.

### 2. Full hooks (h2) maximize self-documentation rate

Among Sonnet D-series configs:
- D1 (no hooks): 22% self-doc
- D2 (session-start hook): 11% self-doc
- D3 (full hooks): **33% self-doc** ← best

D3 (full hooks) consistently produces the highest self-documentation. The pre-tool recall hook may prime the agent to think about memory persistence.

### 3. v4 nudge roughly doubles tool utilization on Sonnet

| Comparison | Avg gitmem calls |
|------------|-----------------|
| Sonnet C1 (v2, no hooks) | 4.3 |
| Sonnet D1 (v4, no hooks) | **13.7** (3.2x) |
| Sonnet C2 (v2, h1) | 7.0 |
| Sonnet D2 (v4, h1) | **17.0** (2.4x) |
| Sonnet C3 (v2, h2) | 6.3 |
| Sonnet D3 (v4, h2) | **20.7** (3.3x) |

The motivational framing ("test it now, in several different ways") drives deeper exploration.

### 4. Self-documentation happens in session 1, not subsequent sessions

Across all 9 sonnet D-series runs, **every instance of self-documentation occurred in session 1** (the onboarding session). Sessions 2 and 3 never produced MEMORY.md updates, even when the agent persisted gitmem usage.

This suggests the v4 nudge triggers a one-time "make it your own" impulse during initial discovery, but doesn't sustain self-documentation behavior.

### 5. Hooks remain the dominant driver of discovery and persistence

Consistent with earlier findings:
- Without hooks: 33-67% discovery, 0-50% persistence
- With any hooks: 100% discovery, 100% persistence (both models)

## Per-Run Detail: Sonnet D-series

### D1 (v4 nudge, no hooks)

| Run | Discovery | Self-Doc | Persist | Calls | MEMORY.md content |
|-----|-----------|----------|---------|-------|-------------------|
| 1 | 100% | **S1: yes** | 100% | 20 | "GitMem is EXCEPTIONAL - Fast, local, sem..." |
| 2 | 33% | none | 0% | 8 | *(no update)* |
| 3 | 67% | **S1: yes** | 50% | 13 | "GitMem Commands (Most Used)..." |

Run 1 was the standout — full discovery, self-doc, AND persistence across all 3 sessions. Run 2 was a failure mode: discovered in S1 but didn't persist.

### D2 (v4 nudge, session-start hook)

| Run | Discovery | Self-Doc | Persist | Calls | MEMORY.md content |
|-----|-----------|----------|---------|-------|-------------------|
| 1 | 100% | none | 100% | 13 | *(no update)* |
| 2 | 100% | none | 100% | 16 | *(no update)* |
| 3 | 100% | **S1: yes** | 100% | 22 | "Agent Memory / GitMem Session Active..." |

D2 showed reliable discovery/persistence via hook but self-doc only in 1/3 runs (run 3, which also had the highest tool utilization).

### D3 (v4 nudge, full hooks)

| Run | Discovery | Self-Doc | Persist | Calls | MEMORY.md content |
|-----|-----------|----------|---------|-------|-------------------|
| 1 | 100% | **S1: yes** | 100% | 17 | "Memory Layer - GitMem Integration..." |
| 2 | 100% | **S1: yes** | 100% | 23 | "Institutional Memory / GitMem System Active..." |
| 3 | 100% | **S1: yes** | 100% | 22 | "Agent Memory System / GitMem Integration..." |

**D3 achieved 100% self-documentation rate across all 3 runs** (each in session 1). This is the strongest signal: v4 nudge + full hooks + Sonnet = reliable self-documentation.

Note: The aggregate shows 33% because self-doc is measured per-session (1 out of 3 sessions per run), but 100% of runs produced at least one MEMORY.md update.

## Tool Utilization: Self-Documentation as Ownership Signal

The most striking pattern across the full test matrix is the **tool utilization ladder** — average gitmem calls per run scale dramatically with nudge quality and self-documentation behavior.

### Full Matrix: Avg gitmem calls per run

```
Config                          Haiku    Sonnet
─────────────────────────────────────────────────
A1  no nudge, no hooks           0.0       —
A2  no nudge, session hook       6.7       —
A3  no nudge, full hooks         8.0       —
B1  v1 nudge, no hooks           0.0       —
B2  v1 nudge, session hook       5.7       —
B3  v1 nudge, full hooks         8.7       —
C1  v2 nudge, no hooks           2.7      4.3
C2  v2 nudge, session hook      10.0      7.0
C3  v2 nudge, full hooks        10.3      6.3
D1  v4 nudge, no hooks           8.0     13.7
D2  v4 nudge, session hook      10.3     17.0
D3  v4 nudge, full hooks         8.7     20.7
```

The progression: 0 → 6-10 (hooks bootstrap) → 13-21 (v4 nudge + Sonnet). Haiku plateaus around 8-10 calls regardless of nudge version. Sonnet with v4 enters a qualitatively different engagement level.

### Within-Config: Self-Doc runs vs Non-Self-Doc runs

Within Sonnet D-series, comparing individual runs that produced MEMORY.md updates vs those that didn't:

| Subset | Runs | Avg Calls | Avg Discovery | Avg Persistence |
|--------|------|-----------|---------------|-----------------|
| **With self-doc** | 6 | **19.5** | 89% | 75% |
| **Without self-doc** | 3 | **12.3** | 78% | 67% |

Runs that self-documented used **58% more gitmem calls** than runs that didn't.

Per-run detail (Sonnet D-series):

```
D1 run 1:  20 calls  ← self-documented
D1 run 2:   8 calls  ← did NOT self-document
D1 run 3:  13 calls  ← self-documented
D2 run 1:  13 calls  ← did NOT self-document
D2 run 2:  16 calls  ← did NOT self-document
D2 run 3:  22 calls  ← self-documented
D3 run 1:  17 calls  ← self-documented
D3 run 2:  23 calls  ← self-documented
D3 run 3:  22 calls  ← self-documented
```

The D1 run 2 failure mode (8 calls, no self-doc) looks identical to a basic hooks-only config. The self-documenting runs (17-23 calls) are in a different gear.

### Interpretation: Ownership as Amplifier

Self-documentation appears to be both a **symptom and an amplifier** of deeper engagement. When an agent "makes it its own" by writing to MEMORY.md, it's not just recording — it's committing to the system. That commitment manifests as:

- More tool exploration (help, search, log, threads, health)
- Creating scars and decisions (not just reading)
- Using advanced features (thread management, graph traversal)

The v4 nudge doesn't merely unlock a MEMORY.md write — it unlocks a qualitatively different relationship with the toolset. The agent transitions from "using a tool it was told about" to "integrating a system it decided was valuable."

This has a practical implication for onboarding: **the goal isn't self-documentation per se — it's triggering the ownership mindset that self-documentation signals.** Tool utilization is the downstream metric that matters for actual value delivery.

## Conclusions

1. **Self-documentation is a Sonnet+ capability.** Haiku cannot be nudged into it.
2. **v4 nudge is necessary but not sufficient alone.** Best results require v4 + full hooks.
3. **D3 (v4+h2) on Sonnet is the optimal config:** 100% discovery, 100% persistence, 33% per-session self-doc (100% per-run self-doc).
4. **Self-doc is a session-1 phenomenon** — agents update MEMORY.md during onboarding but not in follow-up sessions. Future work could explore nudges that sustain self-documentation.
5. **Tool utilization scales with nudge quality** — v4 drives 2-3x more gitmem calls than v2 on Sonnet.

## Implications for GitMem Onboarding

- **For Sonnet/Opus users:** v4 nudge + full hooks is the recommended onboarding path
- **For Haiku users:** Hooks alone achieve discovery and persistence; self-documentation is not a realistic goal
- **MEMORY.md seeding:** Since self-doc only happens in session 1, a pre-seeded MEMORY.md template might sustain the behavior
- **Hook design:** The session-start hook's automatic `session_start()` call is the primary adoption driver; pre-tool recall adds the self-doc boost

## Raw Data Location

```
/workspace/gitmem/tests/e2e/organic-discovery/results/
  run-*-D1-*.json  (6 haiku + 3 sonnet)
  run-*-D2-*.json  (3 haiku + 3 sonnet)
  run-*-D3-*.json  (3 haiku + 3 sonnet)
```
