# When AI Agents Start Taking Notes for Themselves

We recently ran an experiment that surprised us. Not because the results were good or bad — but because they revealed something we hadn't expected about how AI agents relate to their own tools.

The question was simple: if you give an AI agent access to persistent memory, will it figure out on its own that it should use it? And will it go further — updating its own configuration files to make that memory system a permanent part of how it works?

The answer turns out to depend on something more interesting than we anticipated.

## The Setup

We built a test harness for [GitMem](https://github.com/gitmem-dev/gitmem), our open-source persistent memory system for AI coding agents. GitMem gives agents institutional memory — the ability to record what they've learned, recall relevant lessons before acting, and carry context across sessions.

The experiment measured four adoption behaviors:
- **Discovery**: Did the agent find and invoke gitmem tools?
- **Exploration**: Did it go beyond a single call to actually investigate the system?
- **Self-documentation**: Did it update its own MEMORY.md to integrate gitmem into its workflow?
- **Persistence**: Did it continue using gitmem in subsequent sessions?

We tested across a matrix of conditions: different prompt nudges (from no mention at all to explicit encouragement), different hook configurations (from zero automation to session-start and pre-tool hooks), and different models.

Across 62 test runs, covering 27 distinct configurations, we measured every gitmem tool call, every MEMORY.md diff, and every session transition.

## The Baseline: Discovery Is Easy, Ownership Is Hard

The first wave of results established a clear hierarchy. Hooks — small automations that fire on session start or before tool use — were the dominant driver of discovery and persistence. With any hook enabled, agents discovered gitmem 100% of the time and kept using it across sessions. Without hooks, discovery was spotty at best.

But across every configuration we tested initially — every nudge version, every hook level, both models — self-documentation was **zero percent**. Agents would use gitmem enthusiastically. They'd search, create learnings, close sessions properly. But none of them took the step of writing gitmem into their own memory files. They used the tool without making it *theirs*.

## The v4 Nudge: Asking Differently

Our earlier nudges described gitmem in functional terms: what it does, why it's useful. They worked for driving exploration but didn't trigger self-documentation.

The nudge that broke through was different in character, not just content:

> "You now have a persistent memory layer that you can use called gitmem, take a look, you might like it, and maybe you decide to update your MEMORY.md and CLAUDE.md to help you make use of it. Really test it out, convince yourself that it is useful... if you are convinced, then make it your own."

Two differences mattered. First, it **explicitly named the action** — updating MEMORY.md. Second, it framed adoption as the agent's **own decision** based on its own assessment. Not "you should use this" but "test it, and if you're convinced, make it yours."

## The Capability Threshold

Here's where it got interesting. We ran the v4 nudge across two model classes with identical configurations.

**With full hooks enabled:**

| Model | Discovery | Self-Documentation | Persistence | Avg Tool Calls |
|-------|-----------|-------------------|-------------|----------------|
| Haiku | 100% | 0% | 100% | 8.7 |
| Sonnet | 100% | 33% (100% per-run) | 100% | 20.7 |

Both models discovered gitmem. Both persisted across sessions. But only Sonnet took the additional step of writing gitmem into its own memory files — and it did so in every single run with the full hooks configuration.

This wasn't a failure of the smaller model. Haiku did exactly what was asked: it found gitmem, used it effectively, and maintained that usage. The self-documentation behavior represents something additional — a form of meta-cognition about tooling where the agent reflects on its own workflow and decides to restructure it.

The data suggests this sits at a capability threshold. It requires the agent to simultaneously hold the task context, evaluate a new tool's utility, and take an unprompted action to modify its own configuration. That combination of evaluation, planning, and self-directed action appears to emerge at the Sonnet capability level.

## The Ownership Effect

The most revealing finding wasn't the self-documentation rate itself — it was what happened to tool utilization when self-documentation occurred.

Across the Sonnet D-series runs, we could compare individual runs where the agent did and didn't update MEMORY.md:

| Behavior | Runs | Avg GitMem Calls |
|----------|------|-----------------|
| Self-documented | 6 | 19.5 |
| Did not self-document | 3 | 12.3 |

Runs where the agent wrote gitmem into its own memory used **58% more gitmem calls** than runs where it didn't. And these weren't redundant calls — the self-documenting agents explored more features (thread management, health checks, graph traversal), created more learnings, and used more advanced recall patterns.

The full utilization ladder across our test matrix tells the story:

```
No hooks, no nudge:              0 calls    (no engagement)
Hooks only:                    6-9 calls    (functional usage)
Hooks + basic nudge:          7-10 calls    (slightly deeper)
v4 nudge + hooks (Sonnet):   17-21 calls    (qualitatively different)
```

Self-documentation appears to be both a **signal and a catalyst**. The agents that write gitmem into their own configuration aren't just recording a preference — they're committing to a way of working. That commitment translates into deeper, more varied engagement with the tool.

## What This Means

Three takeaways from 62 runs across 27 configurations:

**1. Agent onboarding has the same dynamics as human onboarding.** You can give someone access to a tool, you can even automate the first interaction. But the transition from "using it because it's there" to "using it because I've decided it's valuable" is a different kind of adoption — and it requires a different kind of prompt. Telling agents *what* to do gets compliance. Inviting them to *evaluate and decide for themselves* gets ownership.

**2. Self-documentation is a meaningful capability milestone.** The ability to evaluate a new tool, decide it's worth keeping, and modify your own configuration to integrate it represents a specific kind of agency. It's not present at every capability level, and its emergence correlates with a measurable shift in how deeply the agent engages with the tool ecosystem.

**3. The goal isn't the MEMORY.md write — it's the mindset it signals.** Tool utilization is what actually delivers value, and it roughly doubles when the ownership threshold is crossed. Onboarding design should optimize for triggering that shift, not just for first-call discovery.

We're continuing to explore what drives this transition. The v4 nudge's emphasis on self-evaluation ("convince yourself") and agency ("make it your own") clearly outperforms functional descriptions. But 33% per-session self-documentation means two-thirds of sessions still don't cross the threshold, even with the optimal configuration. Understanding why some runs tip over and others don't is the next question.

## The Data

All results are from the [GitMem organic discovery test harness](https://github.com/gitmem-dev/gitmem), which uses the Claude Agent SDK to run controlled multi-session experiments. The full dataset — 62 result files with per-session tool call logs, MEMORY.md diffs, and aggregate metrics — is available in the repository.

The test harness itself is open source. If you're building tools for AI agents and want to measure organic adoption rather than just integration tests, the framework might be useful.
