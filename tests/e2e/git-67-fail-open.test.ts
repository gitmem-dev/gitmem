/**
 * GIT-67 / GIT-63 — fail-open write repro (E2E, through the MCP protocol)
 *
 * These run against the LOCAL build over stdio, not against the published
 * package. That distinction is load-bearing: the sprint's own MCP tooling
 * serves gitmem-mcp 1.6.6 from npm, so verifying the fix through it would
 * green-light unfixed code.
 *
 * Two conditions, both from community feedback f9fa0461:
 *
 *   1. No active session. Every write tool must refuse with no ID. An ID that
 *      corresponds to no stored row is worse than an error, because the caller
 *      records it and moves on.
 *
 *   2. Healthy session, dead durable store. This is the condition the original
 *      report most likely hit — it needs no restart, and session loss and store
 *      failure are indistinguishable from outside. The response must be
 *      unmistakably non-success (R4: local_only, durable:false), never a bare
 *      success string with a minted ID.
 *
 * Written to fail against the pre-fix build. A repro that passes before the
 * fix is not a repro.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  callTool,
  getToolResultText,
  createOutageEnv,
  type McpTestClient,
} from "./mcp-client.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** A minted thread id: "t-" + 8 hex. The thing that must not appear. */
const THREAD_ID_PATTERN = /\bt-[0-9a-f]{8}\b/;

/**
 * Thread text for these tests must contain NONE of the words the assertions
 * look for.
 *
 * The tools echo submitted text back in their response, so an assertion keyed
 * on a word the submission can contain matches the input rather than the
 * behaviour. An earlier draft used "…the durable store unreachable" as the
 * thread text and its own "admits non-durability" check passed on that echo,
 * while the defect was live and a bare ID was being minted.
 *
 * That is render-from-submission corrupting the test written to catch
 * render-from-submission. Neutral, distinctive, sentinel-free strings only —
 * and distinct enough from each other not to trip semantic dedup.
 */
const SAFE_TEXT = {
  noSessionId: "Harness case alpha — quiet river marmalade",
  noSessionLegible: "Harness case bravo — copper lantern zither",
  dualMessage: "Harness case charlie — velvet compass gherkin",
  deadSotId: "Harness case delta — brass otter samovar",
  deadSotNaming: "Harness case echo — plum trellis oscilloscope",
  dedupSeed: "Harness case foxtrot — juniper anvil quasar",
  dedupLonger:
    "Harness case foxtrot — juniper anvil quasar, extended with additional wording so the two submissions differ in length while still colliding",
  freeNoSession: "Harness case golf — tin sparrow obelisk",
  freeNoSessionNaming: "Harness case hotel — moss lantern pendulum",
} as const;

const TEST_DIR = join(tmpdir(), `gitmem-git67-${process.pid}`);

function freshDir(name: string): string {
  const dir = join(TEST_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("GIT-67: no active session", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    // A pristine HOME/GITMEM_DIR means there is no session file to recover
    // from, so "no active session" is unambiguous regardless of what the
    // recovery path does.
    const dir = freshDir("no-session");
    mcp = await createMcpClient({
      ...createOutageEnv(),
      GITMEM_DIR: dir,
      HOME: dir,
    });
  });

  afterAll(async () => {
    await mcp?.cleanup();
  });

  it("create_thread does not mint a thread ID when there is no session", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.noSessionId,
    });
    const text = getToolResultText(result);

    // The core assertion. An ID in this output is a promise of durability the
    // tool cannot keep.
    expect(text).not.toMatch(THREAD_ID_PATTERN);
  });

  it("create_thread says plainly that nothing was stored", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.noSessionLegible,
    });
    const text = getToolResultText(result).toLowerCase();

    // Note: on the pre-fix build this passes on the enforcement banner alone,
    // while an ID is minted alongside it. It is kept because the refusal must
    // remain legible after the fix, but it is NOT the assertion that catches
    // the defect — the ID and dual-message tests are. A test that can be
    // satisfied by a banner is not evidence the write refused.
    expect(text).toMatch(/no active session|not stored|stored: ?false|no_active_session/);
  });

  it("never emits a success payload and a failure banner in one response", async () => {
    // The reported symptom: "Thread created ... ID: t-xxxxxxxx" carrying
    // "--- gitmem enforcement --- No active session." in the same string.
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.dualMessage,
    });
    const text = getToolResultText(result);

    const claimsSuccess = /thread created/i.test(text);
    const admitsFailure = /no active session/i.test(text);

    expect(claimsSuccess && admitsFailure).toBe(false);
  });
});

describe("GIT-67 / R4: healthy session, unreachable durable store", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    const dir = freshDir("dead-sot");
    mcp = await createMcpClient({
      ...createOutageEnv(),
      GITMEM_DIR: dir,
      HOME: dir,
    });

    // A genuinely healthy session. Only the store is dead.
    await callTool(mcp.client, "session_start", {
      agent_identity: "cli",
      project: "gitmem",
    });
  });

  afterAll(async () => {
    await mcp?.cleanup();
  });

  it("does not surface a thread ID without a durability caveat", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.deadSotId,
    });
    const text = getToolResultText(result);

    // Deliberately shape-independent. An earlier version of this assertion
    // keyed on "Thread created" and passed while the defect was live, because
    // the response had taken the dedup shape ("Dedup: matched existing thread
    // … ID: t-xxxxxxxx") instead. The invariant is not about a phrase — it is
    // that no ID reaches the caller without a statement about durability.
    const presentsId = THREAD_ID_PATTERN.test(text);
    const admitsNonDurability = /durable|local[_ ]only|not stored|failed|unavailable/i.test(text);

    expect(presentsId && !admitsNonDurability).toBe(false);
  });

  it("names the store and its non-durability (R3 + R4)", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.deadSotNaming,
    });
    const text = getToolResultText(result).toLowerCase();

    expect(text).toMatch(/durable|local[_ ]only|not stored/);
  });
});

describe("GIT-63 / R2: dedup refuses rather than discarding", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    const dir = freshDir("dedup");
    mcp = await createMcpClient({
      ...createOutageEnv(),
      GITMEM_DIR: dir,
      HOME: dir,
    });
    await callTool(mcp.client, "session_start", {
      agent_identity: "cli",
      project: "gitmem",
    });
    // Seed the thread the next call will collide with.
    await callTool(mcp.client, "create_thread", { text: SAFE_TEXT.dedupSeed });
  });

  afterAll(async () => {
    await mcp?.cleanup();
  });

  it("states that the submitted text was NOT stored", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.dedupSeed,
    });
    const text = getToolResultText(result).toLowerCase();

    // The old behaviour read as "created and merged" while the row kept its
    // previous text and only updated_at moved.
    expect(text).toMatch(/not stored|duplicate_candidate/);
    expect(text).not.toMatch(/thread created/i);
  });

  it("shows both lengths so a discard is arithmetically visible", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.dedupLonger,
    });
    const text = getToolResultText(result);

    // Two char counts must appear — the stored row's and the submission's.
    const lengths = text.match(/\b\d+ chars\b/g) ?? [];
    expect(lengths.length).toBeGreaterThanOrEqual(2);
  });

  it("offers an explicit way through rather than a dead end", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.dedupSeed,
    });
    const text = getToolResultText(result);

    expect(text).toMatch(/allow_duplicate/);
    expect(text).toMatch(/resolve_thread/);
  });

  it("allow_duplicate: true actually creates a distinct thread", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.dedupSeed,
      allow_duplicate: true,
    });
    const text = getToolResultText(result);

    expect(text).not.toMatch(/not stored/i);
    expect(text).toMatch(THREAD_ID_PATTERN);
  });
});

describe("R5: free tier writes without a session, and says so", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    const dir = freshDir("free-no-session");
    mcp = await createMcpClient({
      GITMEM_TIER: "free",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      GITMEM_DIR: dir,
      HOME: dir,
    });
  });

  afterAll(async () => {
    await mcp?.cleanup();
  });

  it("stores the thread — the local file IS the SOT here", async () => {
    // Refusing this would fail-close every sessionless free user. R5 makes the
    // guard tier-relative precisely to avoid that.
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.freeNoSession,
    });
    const text = getToolResultText(result);

    expect(text).toMatch(THREAD_ID_PATTERN);
    expect(text).not.toMatch(/not stored/i);
  });

  it("names the store and the absent session rather than implying ownership", async () => {
    const result = await callTool(mcp.client, "create_thread", {
      text: SAFE_TEXT.freeNoSessionNaming,
    });
    const text = getToolResultText(result).toLowerCase();

    expect(text).toContain("local file");
    expect(text).toContain("session: none");
  });
});
