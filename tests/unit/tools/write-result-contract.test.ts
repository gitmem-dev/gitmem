/**
 * GIT-101: every write tool answers with WriteResult, and none of them calls a
 * write the durable store never saw a success.
 *
 * One parameterized test: Pro tier, Supabase configured, and every request to
 * it fails at the network. Each tool runs its real write path and must report
 * success: false, durable: false — and a stored_in that names what actually
 * survived (local_only when a local copy was kept, null when nothing was).
 *
 * resolve_thread used to return success: true here unconditionally.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const saved = vi.hoisted(() => {
  const keys = ["GITMEM_TIER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITMEM_DIR", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GITMEM_EMBEDDING_PROVIDER"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "gitmem-git101-"));
  Object.assign(process.env, {
    GITMEM_TIER: "pro",
    SUPABASE_URL: "https://stubbed-venue.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "stub-key",
    GITMEM_DIR: dir,
  });
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GITMEM_EMBEDDING_PROVIDER;
  return { before, dir };
});

import { resetTier, hasSupabase } from "../../../src/services/tier.js";
import { setCurrentSession, clearCurrentSession } from "../../../src/services/session-state.js";
import { saveThreadsFile } from "../../../src/services/thread-manager.js";
import { saveSuggestions } from "../../../src/services/thread-suggestions.js";
import { createLearning } from "../../../src/tools/create-learning.js";
import { createDecision } from "../../../src/tools/create-decision.js";
import { createThread } from "../../../src/tools/create-thread.js";
import { resolveThread } from "../../../src/tools/resolve-thread.js";
import { archiveLearning } from "../../../src/tools/archive-learning.js";
import { recordScarUsage } from "../../../src/tools/record-scar-usage.js";
import { recordScarUsageBatch } from "../../../src/tools/record-scar-usage-batch.js";
import { sessionClose } from "../../../src/tools/session-close.js";
import { promoteSuggestion } from "../../../src/tools/promote-suggestion.js";
import { saveTranscript } from "../../../src/tools/save-transcript.js";

const SID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";
const SCAR = "11111111-2222-4333-8444-555555555555";
const now = () => new Date().toISOString();
let supabaseCalls = 0;

type Case = {
  tool: string;
  run: () => Promise<{ success: boolean; durable: boolean; stored_in: unknown; display?: string }>;
  /** What a failed durable write leaves behind. */
  storedIn: "local_only" | null;
  setup?: () => void;
};

const CASES: Case[] = [
  { tool: "create_learning", storedIn: null,
    run: () => createLearning({ learning_type: "win", title: "t", description: "d" } as never) },
  { tool: "create_decision", storedIn: null,
    run: () => createDecision({ title: "t", decision: "d", rationale: "r" }) },
  { tool: "create_thread", storedIn: "local_only",
    run: () => createThread({ text: "GIT-101 contract thread", allow_duplicate: true }) },
  { tool: "resolve_thread", storedIn: "local_only",
    setup: () => saveThreadsFile([{ id: "t-git10101", text: "resolve me", status: "open", created_at: now() } as never]),
    run: () => resolveThread({ thread_id: "t-git10101" }) },
  { tool: "archive_learning", storedIn: null,
    run: () => archiveLearning({ id: SCAR }) },
  { tool: "record_scar_usage", storedIn: null,
    run: () => recordScarUsage({ scar_id: SCAR, surfaced_at: now(), reference_type: "explicit", reference_context: "c" }) },
  { tool: "record_scar_usage_batch", storedIn: null,
    run: () => recordScarUsageBatch({ scars: [{ scar_identifier: SCAR, surfaced_at: now(), reference_type: "explicit", reference_context: "c" }] } as never) },
  { tool: "session_close", storedIn: null,
    run: () => sessionClose({ session_id: SID, close_type: "standard", human_corrections: "none",
      closing_reflection: { what_broke: "x", what_took_longer: "x", do_differently: "x", what_worked: "x",
        wrong_assumption: "x", scars_applied: [], institutional_memory_items: "x", collaborative_dynamic: "x", rapport_notes: "x" } } as never) },
  { tool: "promote_suggestion", storedIn: "local_only",
    setup: () => saveSuggestions([{ id: "ts-git10101", text: "promote me", embedding: null, evidence_sessions: ["a", "b", "c"],
      similarity_score: 0.9, status: "pending", created_at: now() } as never]),
    run: () => promoteSuggestion({ suggestion_id: "ts-git10101" }) },
  { tool: "save_transcript", storedIn: null,
    run: () => saveTranscript({ session_id: SID, transcript: "hello" }) },
];

beforeAll(() => {
  resetTier();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("stubbed-venue.supabase.co")) supabaseCalls++;
    throw new TypeError("fetch failed (GIT-101 stub: store unreachable)");
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  clearCurrentSession();
  for (const [k, v] of Object.entries(saved.before)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetTier();
  fs.rmSync(saved.dir, { recursive: true, force: true });
});

beforeEach(() => {
  supabaseCalls = 0;
  setCurrentSession({ sessionId: SID, agent: "cli", project: "default", startedAt: new Date() });
});

describe("WriteResult contract with Supabase failing (GIT-101)", () => {
  it("runs on the pro tier", () => {
    expect(hasSupabase()).toBe(true);
  });

  it.each(CASES)("$tool: success false, durable false, stored_in $storedIn", async ({ run, setup, storedIn }) => {
    setup?.();
    const result = await run();

    expect(supabaseCalls).toBeGreaterThan(0); // the durable store was actually tried
    expect(result.success).toBe(false);
    expect(result.durable).toBe(false);
    expect(result.stored_in).toBe(storedIn);
    // Over MCP a client sees only `display` when a tool sets one (server.ts),
    // so the display must carry the same verdict as the fields.
    const display = (result as { display?: string }).display;
    if (display !== undefined) expect(display).toMatch(/fail|not stored|not durable|locally only/i);
  });

  it("resolve_thread says so in its display, not just its fields", async () => {
    saveThreadsFile([{ id: "t-git10102", text: "resolve me too", status: "open", created_at: now() } as never]);
    const result = await resolveThread({ thread_id: "t-git10102" });
    expect(result.display).toContain("RESOLVED LOCALLY ONLY — not durable");
  });
});
