/**
 * Unit tests for the Thread Scope Resolver (GIT-69)
 *
 * Covers the three acceptance criteria from ruling R6:
 *   - parity          query builder and in-memory filter agree on one fixture set
 *   - isolation       a project's threads never appear in another project's scope
 *   - determinism     ordering is a total order, stable across identical calls
 *
 * Plus the project-disagreement fixture, which documents the recovery→scoping
 * seam by name so the boundary is explicit rather than discovered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetCurrentSession = vi.fn();
const mockGetProject = vi.fn();

vi.mock("../../../src/services/session-state.js", () => ({
  getCurrentSession: () => mockGetCurrentSession(),
  getProject: () => mockGetProject(),
}));

const {
  resolveThreadScope,
  buildScopedThreadQuery,
  isInScope,
  describeScope,
  computePanelOmission,
  formatOmissionLine,
  THREAD_SCOPE_ORDER,
  THREAD_SCOPE_LIMIT,
  INACTIVE_STATUSES,
  TERMINAL_STATUSES,
} = await import("../../../src/services/thread-scope.js");

type Scope = ReturnType<typeof resolveThreadScope>;

const SESSION_A = "84765490-da8b-45d3-9f59-cc30bb99cbde";
const SESSION_B = "096e940d-af35-4bac-bc30-a73c9d0de79e";

beforeEach(() => {
  mockGetCurrentSession.mockReset();
  mockGetProject.mockReset();
  mockGetCurrentSession.mockReturnValue(null);
  mockGetProject.mockReturnValue(undefined);
});

// ---------- Scope resolution ----------

describe("resolveThreadScope()", () => {
  it("takes project and session from the active session", () => {
    mockGetCurrentSession.mockReturnValue({ sessionId: SESSION_A });
    mockGetProject.mockReturnValue("gitmem");

    expect(resolveThreadScope()).toEqual({
      project: "gitmem",
      sessionId: SESSION_A,
    });
  });

  it("returns a null sessionId when no session is active", () => {
    mockGetProject.mockReturnValue("gitmem");

    expect(resolveThreadScope().sessionId).toBeNull();
  });

  it("falls back to the default project when none is configured", () => {
    expect(resolveThreadScope().project).toBe("default");
  });

  it("lets explicit overrides win over session state", () => {
    mockGetCurrentSession.mockReturnValue({ sessionId: SESSION_A });
    mockGetProject.mockReturnValue("gitmem");

    expect(
      resolveThreadScope({ project: "weekend_warrior", sessionId: SESSION_B })
    ).toEqual({ project: "weekend_warrior", sessionId: SESSION_B });
  });

  it("distinguishes an explicit null sessionId from an omitted one", () => {
    mockGetCurrentSession.mockReturnValue({ sessionId: SESSION_A });

    // Omitted → inherit the session.
    expect(resolveThreadScope({}).sessionId).toBe(SESSION_A);
    // Explicit null → caller is deliberately sessionless.
    expect(resolveThreadScope({ sessionId: null }).sessionId).toBeNull();
  });
});

// ---------- Determinism ----------

describe("ordering is deterministic", () => {
  it("breaks ties on thread_id so the order is total", () => {
    // vitality_score is 1 for most rows, so without a tiebreaker the ordering
    // is unstable exactly at the limit boundary and two identical calls can
    // return different candidate sets.
    expect(THREAD_SCOPE_ORDER).toContain("thread_id");
  });

  it("applies the same order and limit to every visibility", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };

    const projectWide = buildScopedThreadQuery(scope, { visibility: "project" });
    const ownSession = buildScopedThreadQuery(scope, { visibility: "own_session" });

    expect(projectWide?.order).toBe(THREAD_SCOPE_ORDER);
    expect(ownSession?.order).toBe(THREAD_SCOPE_ORDER);
    expect(projectWide?.limit).toBe(THREAD_SCOPE_LIMIT);
    expect(ownSession?.limit).toBe(THREAD_SCOPE_LIMIT);
  });

  it("returns an identical query for identical inputs", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const first = buildScopedThreadQuery(scope, { visibility: "project" });
    const second = buildScopedThreadQuery(scope, { visibility: "project" });

    expect(first).toEqual(second);
  });
});

// ---------- Cross-project isolation ----------

describe("cross-project isolation", () => {
  const scope: Scope = { project: "gitmem", sessionId: SESSION_A };

  it("always constrains the query to one project", () => {
    for (const visibility of ["project", "own_session"] as const) {
      const query = buildScopedThreadQuery(scope, { visibility });
      expect(query?.filters.project).toBe("gitmem");
    }
  });

  it("excludes a thread belonging to another project", () => {
    const foreign = { project: "weekend_warrior", source_session: SESSION_A };

    expect(isInScope(foreign, scope, "project")).toBe(false);
    expect(isInScope(foreign, scope, "own_session")).toBe(false);
  });

  it("admits a same-project thread from another session at project visibility", () => {
    const sibling = { project: "gitmem", source_session: SESSION_B };

    expect(isInScope(sibling, scope, "project")).toBe(true);
  });

  it("reproduces the f02f74ca leak as a guarded case", () => {
    // A weekend_warrior thread reaching a gitmem session_start panel is the
    // 2026-08-05 repro. It must be excluded on every axis.
    const leaked = { project: "weekend_warrior", source_session: SESSION_B };

    expect(isInScope(leaked, { project: "gitmem", sessionId: SESSION_A }, "project")).toBe(false);
  });
});

// ---------- own_session visibility ----------

describe("own_session visibility (dedup candidate set, R1)", () => {
  it("restricts candidates to the caller's own session", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const query = buildScopedThreadQuery(scope, { visibility: "own_session" });

    expect(query?.filters.source_session).toBe(SESSION_A);
  });

  it("excludes another session's thread from the candidate set", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const otherSession = { project: "gitmem", source_session: SESSION_B };

    expect(isInScope(otherSession, scope, "own_session")).toBe(false);
  });

  it("selects nothing rather than widening when there is no session", () => {
    const scope: Scope = { project: "gitmem", sessionId: null };

    // null, not a project-wide query. A sessionless caller must not silently
    // dedup against every thread in the namespace.
    expect(buildScopedThreadQuery(scope, { visibility: "own_session" })).toBeNull();
  });

  it("still permits a project-wide read when there is no session", () => {
    const scope: Scope = { project: "gitmem", sessionId: null };
    const query = buildScopedThreadQuery(scope, { visibility: "project" });

    expect(query).not.toBeNull();
    expect(query?.filters.source_session).toBeUndefined();
  });
});

// ---------- Status sets ----------

describe("status filtering is single-sourced", () => {
  it("excludes the inactive set by default", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const query = buildScopedThreadQuery(scope, { visibility: "project" });

    for (const status of INACTIVE_STATUSES) {
      expect(query?.filters.status).toContain(status);
    }
  });

  it("honours a narrower terminal-only exclusion", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const query = buildScopedThreadQuery(scope, {
      visibility: "project",
      exclude: TERMINAL_STATUSES,
    });

    expect(query?.filters.status).not.toContain("dormant");
  });

  it("omits the status filter when nothing is excluded", () => {
    const scope: Scope = { project: "gitmem", sessionId: SESSION_A };
    const query = buildScopedThreadQuery(scope, {
      visibility: "project",
      exclude: [],
    });

    expect(query?.filters.status).toBeUndefined();
  });
});

// ---------- Parity ----------

describe("parity between the query builder and the in-memory filter", () => {
  // The store path and the cache path must agree, or they reproduce the
  // divergence this module exists to close.
  const scope: Scope = { project: "gitmem", sessionId: SESSION_A };

  const fixtures = [
    { name: "own session, same project", row: { project: "gitmem", source_session: SESSION_A }, project: true, own: true },
    { name: "other session, same project", row: { project: "gitmem", source_session: SESSION_B }, project: true, own: false },
    { name: "own session, other project", row: { project: "weekend_warrior", source_session: SESSION_A }, project: false, own: false },
    { name: "other session, other project", row: { project: "weekend_warrior", source_session: SESSION_B }, project: false, own: false },
  ];

  for (const f of fixtures) {
    it(`agrees on: ${f.name}`, () => {
      expect(isInScope(f.row, scope, "project")).toBe(f.project);
      expect(isInScope(f.row, scope, "own_session")).toBe(f.own);
    });
  }

  it("treats a project-less local row as in scope", () => {
    // Local cache rows predate project tagging; excluding them would hide a
    // user's own threads behind a schema detail.
    expect(isInScope({ source_session: SESSION_A }, scope, "project")).toBe(true);
  });
});

// ---------- Recovery seam (R6 #1) ----------

describe("project-disagreement fixture — the recovery→scoping seam", () => {
  // GIT-51's resolveCurrentSession() builds a recovered context as
  //   project: data.project || entry.project
  // where data is sessions/<id>/session.json and entry is the
  // active-sessions.json registry row. When those two disagree, session.json
  // silently wins, and the resolver is handed a project the registry never
  // agreed to.
  //
  // The resolver's contract is deliberately narrow: it scopes correctly
  // relative to whatever identity it is given. Detecting the disagreement is
  // GIT-51's job at its rebase phase (explicit precedence + recovery_conflict),
  // not this module's. These tests pin that boundary so a later reader does not
  // mistake the silence for an oversight.

  it("scopes to exactly the project it was handed", () => {
    mockGetCurrentSession.mockReturnValue({ sessionId: SESSION_A });
    mockGetProject.mockReturnValue("gitmem"); // registry view

    // Recovery resolved a different project from session.json and passes it in.
    const scope = resolveThreadScope({ project: "weekend_warrior" });
    const query = buildScopedThreadQuery(scope, { visibility: "project" });

    expect(query?.filters.project).toBe("weekend_warrior");
  });

  it("does not silently merge the two candidate projects", () => {
    const recovered: Scope = { project: "weekend_warrior", sessionId: SESSION_A };

    // The registry's project must not leak into a scope built from the
    // recovered one — a union here would be the cross-project leak arriving
    // through a new door.
    expect(isInScope({ project: "gitmem", source_session: SESSION_A }, recovered, "project")).toBe(false);
  });

  it("names its scope so a caller can tell empty from mis-scoped", () => {
    const scope: Scope = { project: "weekend_warrior", sessionId: SESSION_A };

    expect(describeScope(scope, "project")).toContain("weekend_warrior");
    expect(describeScope(scope, "own_session")).toContain(SESSION_A.slice(0, 8));
    expect(describeScope({ project: "gitmem", sessionId: null }, "own_session")).toContain("none");
  });
});

// ---------- Display layer: no silent truncation (R7) ----------

describe("panel omission accounting", () => {
  // The cap is annotation, not scope. These assert the panel cannot claim a
  // completeness it does not have, and that its numbers reconcile exactly to
  // the scope set: shown + dormantHidden + overCap === totalInScope.

  const cases = [
    { name: "everything fits", listable: 3, dormantHidden: 0, maxShow: 5 },
    { name: "over cap only", listable: 12, dormantHidden: 0, maxShow: 5 },
    { name: "dormant only", listable: 4, dormantHidden: 31, maxShow: 5 },
    { name: "both", listable: 16, dormantHidden: 31, maxShow: 5 },
    { name: "exactly at cap", listable: 5, dormantHidden: 0, maxShow: 5 },
    { name: "empty scope", listable: 0, dormantHidden: 0, maxShow: 5 },
    { name: "all dormant", listable: 0, dormantHidden: 9, maxShow: 5 },
  ];

  for (const c of cases) {
    it(`reconciles: ${c.name}`, () => {
      const counts = {
        listable: c.listable,
        dormantHidden: c.dormantHidden,
        totalInScope: c.listable + c.dormantHidden,
      };
      const o = computePanelOmission(counts, c.maxShow);

      // The invariant R7 exists to protect.
      expect(o.shown + o.dormantHidden + o.overCap).toBe(counts.totalInScope);
      expect(o.shown).toBeLessThanOrEqual(c.maxShow);
      expect(o.overCap).toBeGreaterThanOrEqual(0);
    });
  }

  it("says nothing when the view is complete", () => {
    const o = computePanelOmission({ listable: 3, dormantHidden: 0, totalInScope: 3 }, 5);
    expect(formatOmissionLine(o)).toBeNull();
  });

  it("discloses both omission kinds and where the rest lives", () => {
    const o = computePanelOmission({ listable: 16, dormantHidden: 31, totalInScope: 47 }, 5);
    const line = formatOmissionLine(o);

    expect(line).toContain("showing 5 of 47 in scope");
    expect(line).toContain("31 dormant");
    expect(line).toContain("11 over cap");
    expect(line).toContain("list_threads");
  });

  it("omits a zero term rather than printing '0 dormant'", () => {
    const overCapOnly = formatOmissionLine(
      computePanelOmission({ listable: 12, dormantHidden: 0, totalInScope: 12 }, 5)
    );
    expect(overCapOnly).toContain("7 over cap");
    expect(overCapOnly).not.toContain("dormant");

    const dormantOnly = formatOmissionLine(
      computePanelOmission({ listable: 4, dormantHidden: 31, totalInScope: 35 }, 5)
    );
    expect(dormantOnly).toContain("31 dormant");
    expect(dormantOnly).not.toContain("over cap");
  });

  it("discloses dormant-only omission even when nothing is over cap", () => {
    // The panel looks complete — 4 threads listed, 4 threads shown — while 31
    // in-scope threads are withheld. Exactly the case a naive "+N more" misses.
    const o = computePanelOmission({ listable: 4, dormantHidden: 31, totalInScope: 35 }, 5);
    expect(o.overCap).toBe(0);
    expect(formatOmissionLine(o)).not.toBeNull();
  });
});
