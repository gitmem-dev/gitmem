import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkEnforcement } from "../../../src/services/enforcement.js";
import {
  setCurrentSession,
  clearCurrentSession,
  addSurfacedScars,
  addConfirmations,
  setRecallCalled,
} from "../../../src/services/session-state.js";

describe("enforcement", () => {
  afterEach(() => {
    clearCurrentSession();
  });

  describe("exempt tools", () => {
    it("returns no warning for session_start", () => {
      const result = checkEnforcement("session_start");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for gitmem-ss alias", () => {
      const result = checkEnforcement("gitmem-ss");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for search without session", () => {
      const result = checkEnforcement("search");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for gitmem-help", () => {
      const result = checkEnforcement("gitmem-help");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for health", () => {
      const result = checkEnforcement("health");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for list_threads", () => {
      const result = checkEnforcement("list_threads");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for log", () => {
      const result = checkEnforcement("gitmem-log");
      expect(result.warning).toBeNull();
    });

    it("returns no warning for cache tools", () => {
      expect(checkEnforcement("gitmem-cache-status").warning).toBeNull();
      expect(checkEnforcement("gitmem-cache-health").warning).toBeNull();
      expect(checkEnforcement("gitmem-cache-flush").warning).toBeNull();
    });
  });

  describe("no session warnings", () => {
    it("warns when recall called without session", () => {
      const result = checkEnforcement("recall");
      expect(result.warning).toContain("No active session");
      expect(result.warning).toContain("session_start()");
    });

    it("warns for gitmem-r alias without session", () => {
      const result = checkEnforcement("gitmem-r");
      expect(result.warning).toContain("No active session");
    });

    it("warns when create_learning called without session", () => {
      const result = checkEnforcement("create_learning");
      expect(result.warning).toContain("No active session");
    });

    it("warns when session_close called without session", () => {
      const result = checkEnforcement("session_close");
      expect(result.warning).toContain("No active session");
    });

    it("warns for confirm_scars without session", () => {
      const result = checkEnforcement("confirm_scars");
      expect(result.warning).toContain("No active session");
    });
  });

  describe("no recall warnings", () => {
    beforeEach(() => {
      setCurrentSession({
        sessionId: "test-session-1",
        agent: "cli",
        project: "test",
        startedAt: new Date(),
      });
    });

    it("warns when create_learning called without recall", () => {
      const result = checkEnforcement("create_learning");
      expect(result.warning).toContain("No recall()");
      expect(result.warning).toContain("institutional memory");
    });

    it("warns for gitmem-cl alias without recall", () => {
      const result = checkEnforcement("gitmem-cl");
      expect(result.warning).toContain("No recall()");
    });

    it("warns when create_decision called without recall", () => {
      const result = checkEnforcement("create_decision");
      expect(result.warning).toContain("No recall()");
    });

    it("warns when create_thread called without recall", () => {
      const result = checkEnforcement("create_thread");
      expect(result.warning).toContain("No recall()");
    });

    it("warns when session_close called without recall", () => {
      const result = checkEnforcement("session_close");
      expect(result.warning).toContain("No recall()");
    });

    it("does not warn for recall itself", () => {
      const result = checkEnforcement("recall");
      expect(result.warning).toBeNull();
    });

    it("does not warn for confirm_scars", () => {
      const result = checkEnforcement("confirm_scars");
      expect(result.warning).toBeNull();
    });

    it("does not warn for non-consequential session-required tools", () => {
      // record_scar_usage is session-required but not consequential
      const result = checkEnforcement("record_scar_usage");
      expect(result.warning).toBeNull();
    });
  });

  describe("unconfirmed scars warnings", () => {
    beforeEach(() => {
      setCurrentSession({
        sessionId: "test-session-2",
        agent: "cli",
        project: "test",
        startedAt: new Date(),
      });

      setRecallCalled();

      // Simulate recall surfacing scars
      addSurfacedScars([
        {
          scar_id: "scar-1",
          title: "Test scar 1",
          source: "recall",
          surfaced_at: new Date().toISOString(),
        },
        {
          scar_id: "scar-2",
          title: "Test scar 2",
          source: "recall",
          surfaced_at: new Date().toISOString(),
        },
      ]);
    });

    it("warns when consequential action called with unconfirmed scars", () => {
      const result = checkEnforcement("create_learning");
      expect(result.warning).toContain("2 recalled scar(s) await confirmation");
      expect(result.warning).toContain("confirm_scars()");
    });

    it("warns for session_close with unconfirmed scars", () => {
      const result = checkEnforcement("session_close");
      expect(result.warning).toContain("await confirmation");
    });

    it("clears warning after all scars confirmed", () => {
      addConfirmations([
        { scar_id: "scar-1", decision: "APPLYING", evidence: "Applied the lesson in my implementation approach for this task" },
        { scar_id: "scar-2", decision: "N_A", evidence: "This scar relates to database migrations which is not what we are doing here" },
      ]);

      const result = checkEnforcement("create_learning");
      // Should now show "no recall" warning (not "unconfirmed") since scars are confirmed
      // Actually wait — scars WERE recalled, so no warning at all
      expect(result.warning).toBeNull();
    });

    it("still warns with partial confirmation", () => {
      addConfirmations([
        { scar_id: "scar-1", decision: "APPLYING", evidence: "Applied the lesson in my implementation approach for this task" },
      ]);

      const result = checkEnforcement("create_learning");
      expect(result.warning).toContain("1 recalled scar(s) await confirmation");
    });

    it("does not warn for session_start scars (no confirmation needed)", () => {
      clearCurrentSession();
      setCurrentSession({
        sessionId: "test-session-3",
        agent: "cli",
        project: "test",
        startedAt: new Date(),
      });

      // Session_start scars have source "session_start", not "recall"
      addSurfacedScars([
        {
          scar_id: "scar-3",
          title: "Auto-surfaced scar",
          source: "session_start",
          surfaced_at: new Date().toISOString(),
        },
      ]);

      // Has a session_start scar but no recall scars — should warn about no recall
      const result = checkEnforcement("create_learning");
      expect(result.warning).toContain("No recall()");
      // Should NOT say "await confirmation"
      expect(result.warning).not.toContain("await confirmation");
    });
  });

  describe("clean pass (no warnings)", () => {
    beforeEach(() => {
      setCurrentSession({
        sessionId: "test-session-clean",
        agent: "cli",
        project: "test",
        startedAt: new Date(),
      });

      setRecallCalled();

      addSurfacedScars([
        {
          scar_id: "scar-a",
          title: "Confirmed scar",
          source: "recall",
          surfaced_at: new Date().toISOString(),
        },
      ]);

      addConfirmations([
        { scar_id: "scar-a", decision: "APPLYING", evidence: "Verified the enforcement layer handles this case correctly in the implementation" },
      ]);
    });

    it("returns null warning for create_learning after full compliance", () => {
      const result = checkEnforcement("create_learning");
      expect(result.warning).toBeNull();
    });

    it("returns null warning for create_decision after full compliance", () => {
      const result = checkEnforcement("create_decision");
      expect(result.warning).toBeNull();
    });

    it("returns null warning for session_close after full compliance", () => {
      const result = checkEnforcement("session_close");
      expect(result.warning).toBeNull();
    });
  });

  describe("unknown tools", () => {
    it("returns no warning for completely unknown tools", () => {
      // Unknown tools are handled by the tier guard in server.ts, not enforcement
      const result = checkEnforcement("nonexistent_tool");
      expect(result.warning).toBeNull();
    });
  });
});
