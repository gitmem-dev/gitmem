# Positioning Memo v2 — Memory Is the Wedge, Governance Is the Moat

**Status:** Draft v1 · 2026-08-02 · Author: Brain (strategist), at the founder's direction
**Supersedes in part:** the implicit positioning of the Jan-2026 seed deck and `GitMem_vs_Mem0_Positioning.docx` (Jan 23, 2026) — both remain correct about the market; this memo revises what the *product* is.
**Provenance:** grounded in seven months of production use at the Weekend Warrior lab (the reference deployment), the Agent Working Protocol v1.0→v1.2 (authored 2026-08-02, `weekend-warrior-dashboard/docs/architecture/awp-core.md`), and two independent external reviews of that protocol received the same day. n=1 caveats are stated where they apply — this memo practices the honest-labeling it recommends.

---

## 1. The one-sentence revision

Today GitMem sells **memory** ("we compete with forgetting"). It should sell **memory that enforces** ("we compete with *repeating*"). Mem0 remembers preferences; GitMem remembers — and *governs*.

## 2. Why: the 65% problem

GitMem's founding philosophy document (Jan 3, 2026) already contained the confession: *"write-only is not enough... enforcement happens through triggers."* Seven months of production use sharpened it into a measurable claim: **a recalled scar is a suggestion, and suggestions get ignored.** An external reviewer of the Agent Working Protocol reported (their telemetry, unverified in our record — labeled per our own R-16): instructional rules failed in ~65% of their transcripts. Our own scar ledger agrees directionally: every scar in it is a rule that was surfaced-and-ignorable until someone built a gate.

This is not a criticism of GitMem — it is GitMem's **roadmap**. The value curve of institutional memory is an enforcement ladder:

```
I  instructional  — the scar is recalled; the agent is asked        (today's product)
M  mechanical     — a gate detects violation and blocks/flags        (the upgrade)
S  structural     — the violation has no code path                   (the moat)
```

Retrieval quality (Mem0's benchmark game — latency, token reduction) optimizes tier I. Nobody on the competitive slide climbs the ladder. The company that turns remembered failures into *enforced* protections owns a different category than the one that recalls them fastest.

## 3. The feature map (from AWP, production-derived)

Every item below was extracted from a rule exercised in production at the reference deployment, then hardened by two external reviews. Effort tiers are rough.

| Feature | AWP source | What it is | Effort |
|---|---|---|---|
| **Scar→Gate compiler** | R-03/R-07 + tier ladder | One command promotes a Hardened scar into an enforced hook / CI check / pre-commit gate. GitMem already ships hooks — this is the flagship motion, and no competitor does it. | M |
| **Scar lifecycle** | R-22 | Active → Hardened (fired productively ≥N) → Retired. Retirement is a governed act with evidence, not housekeeping — an agent may never retire a scar that constrains it. Builds on existing decay (process/incident/context). | S–M |
| **Supersession primitive** | R-05 | `superseded_by` as a first-class field; search/recall refuses to serve a superseded entry without its head. Kills the stale-pointer failure class. | S |
| **Capability declaration** | R-17 | Sessions open with machine-readable model/context/tooling declaration; handoffs become capability-aware; near-limit agents stop at clean commits. | S |
| **Compliance artifacts** | INV-4 / R-23 | "The agent followed the rules" is only claimable with an artifact the claimant did not author (cold-start diff, planted-defect run, audit report). This is the enterprise AI-governance checkbox, generated automatically. | M |
| **Self-audit cadence** | R-20 | Every N sessions, a cold agent audits the memory/rules corpus for self-violations; findings become scars. Recurring, schedulable, demo-able. | M |
| **Cold-start harness** | R-13/R-14 | Dispatch a fresh agent against a handoff; diff its first actions vs. intent; divergences are handoff defects. Tests the memory's *sufficiency*, not just its recall. | M |
| **Attention/compute ledger** | R-15/R-19 | Per-session log of human words, escalations, token/wall-clock per decision class. Measure first; price only after a baseline (no fake unit costs). Feeds the "30-60-90: Attention + Trust" project directly. | S |

*(Effort: S = small/one sprint-equivalent · M = medium/multi-sprint.)*

## 4. Marketplace upgrade: memory packs → protocol packs

The pitch's marketplace flywheel gets stronger when a pack is not a pile of scars but a **protocol pack**: scars + their compiled gates + adoption observables ("you have this when…"). Buyers install enforcement, not reading material. **AWP itself is SKU #1** — the single-file distribution edition exists today, with a lineage table, a 13-row scar table, and two external reviews as its independent compliance artifacts. The npm/PyPI analogy in the Jan positioning doc becomes exact: packages ship *executable* protection, not documentation.

## 5. GTM: the book is the content engine, the lab is the proof

The pitch promises content-led growth. The content now exists as a governed pipeline: **The Liberation Blueprint** (book outline v1.0, 15 chapters, one drafted) is precisely the "practitioners, not theorists" narrative the deck promises — and the Weekend Warrior lab is the flagship case study with auditable numbers: seventeen ratifications on ~two hundred founder words in one night; five pre-contamination catches in a single research batch; a full protocol version (v1.0→v1.2) evolved in one day under two independent reviews; every claim citable to an immutable record. "Built in production, not theory" stops being a slide and becomes a bibliography.

Separately: the two protocol reviewers evidently operate agent fleets with their own telemetry. They are not reviewers; they are **design partners** and plausibly the first protocol-pack customers. Worth pursuing by name.

## 6. Pricing logic: the adoption ladder is the freemium ladder

AWP §V (non-goals) is the guard: full governance is **pure tax** on casual work, and the product must never impose it by default. The graduated shape:

- **Free:** memory (recall/learn/close) — the wedge, zero-config, `npx init`, unchanged.
- **Pro ($19):** the enforcement ladder — scar lifecycle, scar→gate compiler, supersession, capability declarations, self-audit cadence. (This gives Pro the identity it currently lacks: today Pro is "more memory"; tomorrow Pro is "memory that acts.")
- **Marketplace:** protocol packs at 15%, AWP as the reference SKU.

AWP §IV's adoption observables are literally the onboarding checklist: each step has a "you have this when…" test, which converts activation from a metric into a product feature.

## 7. Honest labeling (the section an associate will try to puncture first)

- **n = 1.** The protocol is proven at one shop, one founder, one domain, one season. The pitch claim is "proven wedge + production-derived governance hypothesis," not "proven governance." The Maturity Declaration discipline applies to this memo and to the deck.
- **The 65% figure is external and unverified here.** Use it as a reviewer's observation with our directional agreement, never as our benchmark. (Building our own instructional-vs-mechanical compliance telemetry is itself a small, high-value feature — R-19's ledger yields it.)
- **Scope-creep is the real product risk.** If governance leaks into the free tier's first-run experience, the wedge dies. The §V non-goals boundary ships *in the product*, not just in this memo.
- **Linear/record hygiene:** the GitMem Linear workspace's newest activity predates this memo by ~5 months while the repo shipped continuously — the project currently violates its own record-primacy thesis. First workstream of the next session.

## 8. Recommended next actions (for the GitMem-side session to convert into issues)

1. Reconcile Linear to reality: audit the 11 GitMem projects against the repo's actual state; close/merge the dead, restate the live.
2. Adopt AWP internally for GitMem development itself (dogfooding the governance tier before selling it) — version-pinned per R-21.
3. Ship the two S-tier features first (supersession primitive, capability declaration) — smallest surface, largest credibility.
4. Prototype the scar→gate compiler against GitMem's existing hooks as the Pro-tier flagship.
5. Revise the deck's category line: from "we compete with forgetting" to "we compete with repeating," with the enforcement ladder as the category-creation slide.
6. Contact the two protocol reviewers as design partners.

---

*This memo is uncommitted at authorship; it enters the record via the GitMem repo's own conventions. If a claim here contradicts a scar earned later, the scar wins — write the amendment.*
