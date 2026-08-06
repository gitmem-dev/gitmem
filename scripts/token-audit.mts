/**
 * Token-efficiency audit harness (GIT-74 item 1 / GIT-50 measurement spec)
 *
 * Measures the token cost of what gitmem injects into agent context, per
 * surface, against the REAL corpus. Run before compaction for the baseline and
 * again after for the delta — the acceptance criterion is a before/after table
 * that is measured, not estimated, so this must be repeatable rather than
 * hand-transcribed.
 *
 * Method notes, stated because they qualify every number below:
 *
 * - Tokenizer is o200k_base (GPT-4o BPE) via gpt-tokenizer, installed OUTSIDE
 *   the repo so no dependency is added to package.json days before a version
 *   bump. It is not Claude's tokenizer, so absolute counts carry a modest
 *   error; ratios and deltas — which is what the audit decides on — are sound.
 *   Set TOKENIZER_PATH to override.
 * - Surfaces are measured on the DISPLAY string, because that is what reaches
 *   the model. Structured fields that never render are not injection cost.
 * - Reads only. No tool that creates a thread, learning, decision or session is
 *   called against the live store. Write-path response shapes are measured from
 *   the outage-env harness instead, where nothing durable is produced.
 * - Credentials are read from the MCP config programmatically and passed to the
 *   child process. They are never printed. (Four exposure sites are already on
 *   the record; this adds none.)
 *
 * Usage:  npx tsx scripts/token-audit.mts [--json]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SERVER = join(REPO, "dist", "index.js");

const TOKENIZER_PATH =
  process.env.TOKENIZER_PATH ??
  "/private/tmp/claude-501/-Users-chriscrawford-nTEG-Labs-gitmem/484fb581-da80-40bd-a803-ed0f1afba43f/scratchpad/tok/node_modules/gpt-tokenizer/cjs/encoding/o200k_base.js";

const require = createRequire(import.meta.url);
const { encode } = require(TOKENIZER_PATH) as { encode: (s: string) => number[] };

function tokens(s: string): number {
  return encode(s).length;
}

// --- Credentials, read but never printed -----------------------------------

/**
 * Pull the gitmem MCP server's env from the Claude config. Returns only what
 * the server needs; values are passed straight to the child and never logged.
 */
function liveEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8"));
  let found: Record<string, string> | null = null;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const servers = obj.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
    if (servers?.gitmem?.env && !found) found = servers.gitmem.env;
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(cfg);

  if (!found) throw new Error("gitmem MCP env not found in ~/.claude.json");

  const env = found as Record<string, string>;
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITMEM_TABLE_PREFIX"];
  for (const k of required) {
    if (!env[k]) throw new Error(`missing ${k} in gitmem MCP env — cannot measure against the real corpus`);
  }
  return env;
}

// --- MCP plumbing ----------------------------------------------------------

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, ...env, NO_COLOR: "1", NODE_ENV: "test" } as Record<string, string>,
  });
  const client = new Client({ name: "gitmem-token-audit", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: async () => { try { await client.close(); } catch {} } };
}

function displayOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// --- Measurement -----------------------------------------------------------

interface Row {
  surface: string;
  mode: "live-read" | "outage";
  chars: number;
  tokens: number;
  note: string;
}

const rows: Row[] = [];

/**
 * DUMP=1 prints each measured string verbatim.
 *
 * Not a debug convenience — a measurement you cannot read is a number you
 * cannot defend. The first run of this script reported identical token counts
 * for match_count 8 and 3, and only dumping the text showed why.
 */
const DUMP = process.env.DUMP === "1";

function record(surface: string, mode: Row["mode"], text: string, note: string): void {
  rows.push({ surface, mode, chars: text.length, tokens: tokens(text), note });
  if (DUMP) {
    console.log(`\n===== ${surface} [${mode}] ${tokens(text)}t / ${text.length}c =====`);
    console.log(text);
    console.log(`===== end ${surface} =====`);
  }
}

async function main(): Promise<void> {
  const env = liveEnv();

  // ---- Live, read-only surfaces against the real corpus ----
  //
  // Deliberately uses the REAL gitmem dir rather than a temp one. An isolated
  // dir discards the warm scar cache, and a cold load returns learnings with no
  // embeddings — which degrades recall from semantic matching to weak keyword
  // matching and produces a measurement of the degraded path. Only read-only
  // tools are called here; nothing registers a session or writes a record.
  const live = await connect(env);

  const call = async (name: string, args: Record<string, unknown>) =>
    displayOf(await live.client.callTool({ name, arguments: args }));

  try {
    // The scar cache loads in the background after the server reports ready.
    // Measuring before it finishes measures the cold-start fallback path, not
    // the rendering — the first run of this script did exactly that and
    // produced a "133 token recall" that was actually an RPC error string.
    // Gate on the cache reporting initialized, and say so if it never does.
    const warmed = await (async () => {
      for (let i = 0; i < 30; i++) {
        const status = await call("gitmem-cache-status", { project: "gitmem" });
        if (/initialized["\s:]*true|scar_count["\s:]*[1-9]/i.test(status)) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();

    if (!warmed) {
      console.error(
        "\n⚠️  Scar cache never reported initialized. Recall numbers below are the " +
        "cold-start fallback path, NOT the rendering under measurement. Do not " +
        "publish them as a baseline.\n",
      );
    }

    // Recall cost is driven by how many scars clear the similarity threshold,
    // not by match_count. Two queries of deliberately different yield bracket
    // the real range — a single query would report one point and imply it was
    // the cost.
    const HIGH_YIELD_PLAN =
      "Implement GIT-67 + GIT-63 jointly in gitmem-mcp: render write-tool responses from the " +
      "stored row rather than from the submitted payload, across create_thread/create_learning/" +
      "create_decision; fail loud with no_active_session instead of fabricating a success " +
      "response and a synthetic ID when there is no active session; scope the dedup candidate " +
      "set to the caller's session lineage so a cross-session semantic match hard-refuses.";

    const LOW_YIELD_PLAN =
      "implement the thread scope resolver and wire the four thread surfaces to it";

    record(
      "recall — high yield (8 scars)",
      "live-read",
      await call("recall", { plan: HIGH_YIELD_PLAN, project: "gitmem", match_count: 8 }),
      "PRIMARY INJECTION SURFACE — mixed full-body and stub rendering",
    );

    record(
      "recall — low yield (1 stub)",
      "live-read",
      await call("recall", { plan: LOW_YIELD_PLAN, project: "gitmem", match_count: 8 }),
      "same match_count; only 1 scar clears threshold, so match_count does not bind",
    );

    record(
      "search (topic query)",
      "live-read",
      await call("search", { query: "fail-open write success without a stored row", project: "gitmem" }),
      "",
    );

    record("list_threads", "live-read", await call("list_threads", { project: "gitmem" }), "");

    record("log (recent learnings)", "live-read", await call("log", {}), "");

    record("cache-health", "live-read", await call("gitmem-cache-health", { project: "gitmem" }), "post-GIT-69 three-valued status");

    record("health (write-path)", "live-read", await call("health", {}), "");
  } finally {
    await live.close();
  }

  // ---- Write-path response shapes, measured where nothing durable lands ----
  const outageHome = mkdtempSync(join(tmpdir(), "gitmem-audit-outage-"));
  const outage = await connect({
    GITMEM_TIER: "pro",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "audit-not-a-real-key",
    GITMEM_TABLE_PREFIX: "orchestra_",
    GITMEM_DIR: outageHome,
    HOME: outageHome,
  });

  try {
    const oCall = async (name: string, args: Record<string, unknown>) =>
      displayOf(await outage.client.callTool({ name, arguments: args }));

    record(
      "create_thread — refusal (no session)",
      "outage",
      await oCall("create_thread", { text: "Audit probe alpha — cinnabar wren lattice" }),
      "GIT-67 no_active_session refusal",
    );

    await oCall("session_start", { agent_identity: "cli", project: "gitmem" });

    record(
      "session_start panel (empty corpus)",
      "outage",
      await oCall("session_refresh", {}),
      "LOWER BOUND only — no threads/decisions to render; live panel is larger",
    );

    const created = await oCall("create_thread", { text: "Audit probe bravo — quartz heron dulcimer" });
    record("create_thread — local_only (R4 fail-honest)", "outage", created, "");

    record(
      "create_thread — dedup refusal (R2)",
      "outage",
      await oCall("create_thread", { text: "Audit probe bravo — quartz heron dulcimer" }),
      "quotes the stored row + both lengths",
    );
  } finally {
    await outage.close();
  }

  // ---- Report ----
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ tokenizer: "o200k_base", measured_at_utc: null, rows }, null, 2));
    return;
  }

  const w = Math.max(...rows.map((r) => r.surface.length), 8);
  console.log(`\nTokenizer: o200k_base (GPT-4o BPE). Display strings only.\n`);
  console.log(`${"surface".padEnd(w)}  ${"mode".padEnd(10)}  ${"tokens".padStart(7)}  ${"chars".padStart(7)}  note`);
  console.log("-".repeat(w + 40));
  for (const r of rows) {
    console.log(
      `${r.surface.padEnd(w)}  ${r.mode.padEnd(10)}  ${String(r.tokens).padStart(7)}  ${String(r.chars).padStart(7)}  ${r.note}`,
    );
  }
  const liveTotal = rows.filter((r) => r.mode === "live-read").reduce((a, r) => a + r.tokens, 0);
  console.log("-".repeat(w + 40));
  console.log(`${"live-read subtotal".padEnd(w)}  ${"".padEnd(10)}  ${String(liveTotal).padStart(7)}`);
  console.log("");
}

main().catch((err) => {
  console.error("audit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
