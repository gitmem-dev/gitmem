#!/usr/bin/env node
/**
 * Blank-Supabase venue driver (GIT-97 / GIT-98).
 *
 * Runs the BUILT server (dist/index.js) over stdio, Pro tier, against a Supabase
 * project that has schema/setup.sql and nothing else — no edge functions — which
 * is what every customer project looks like. Each run gets an isolated HOME and
 * GITMEM_DIR. Every fetch the server makes is logged by blank-supabase-netlog.mjs.
 *
 * Embeddings come from a local fake Ollama endpoint (deterministic bag-of-words
 * hashing into 1536 dims), so no embedding API key is needed and all measured
 * network traffic is venue traffic.
 *
 * Usage (build first: npm run build):
 *   VENUE_ENV=/path/outside/repo/.env node tests/e2e/blank-supabase.mjs flow   --label main --out <dir>
 *   VENUE_ENV=/path/outside/repo/.env node tests/e2e/blank-supabase.mjs egress --label pr31 --out <dir> [--rows 250] [--usage 5]
 *
 *   flow   session_start -> list_threads -> recall -> confirm_scars -> create_thread
 *          -> list_threads -> session_close -> health, with a local threads.json that
 *          deliberately differs from the remote thread table.
 *   egress bytes received from the venue on a cold start, a warm start, and around
 *          two session_starts (GIT-98 disk cache). --usage N seeds N scars with
 *          >=3 usage rows so refresh_scar_behavioral_scores() has work to do.
 *
 * VENUE_ENV is a KEY=VALUE file OUTSIDE the repo defining SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY and VENUE_REF. Credentials are never committed.
 * The driver WIPES the gitmem tables of that project before seeding. It refuses
 * to run unless SUPABASE_URL is exactly https://<VENUE_REF>.supabase.co and the
 * ref is not on the deny list below.
 *
 * Exit status: 0 = every 4xx/5xx from /rest/v1/ or /functions/v1/ is on
 * EXPECTED_FAILURES; 1 = at least one unexpected failure; 2 = usage/config error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DENY_REFS = new Set(["cjptxyezuxdiinufgrrm"]); // production GitMem — never touch

/**
 * Known venue failures. Any other 4xx/5xx from /rest/v1/ or /functions/v1/
 * fails the run. Each entry names the ticket that removes it — delete the entry
 * when that ticket merges, so this list only shrinks. An entry allows a failure;
 * it does not require one (e.g. the GIT-73 race is intermittent).
 */
const EXPECTED_FAILURES = [
  { ticket: "GIT-73", what: "metrics/session_start FK race", method: "POST", path: /^\/rest\/v1\/gitmem_query_metrics$/, status: 409 },
  { ticket: "GIT-105", what: "knowledge-triple thread id into a uuid column", method: "POST", path: /^\/rest\/v1\/knowledge_triples$/, status: 400 },
  { ticket: "GIT-106", what: "scar_enforcement_variants.active does not exist", method: "GET", path: /^\/rest\/v1\/scar_enforcement_variants$/, status: 400 },
  { ticket: "GIT-84", what: "unprefixed scar_usage table (remove once GIT-84 merges)", method: null, path: /^\/rest\/v1\/scar_usage$/, status: 404 },
  { ticket: "GIT-97", what: "ww-mcp edge function absent on customer projects (remove once PR #30 merges)", method: "POST", path: /^\/functions\/v1\/ww-mcp$/, status: 404 },
];
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SERVER = join(REPO, "dist/index.js");
const NETLOG_PRELOAD = join(HERE, "blank-supabase-netlog.mjs");
const DIM = 1536;
const PROJECT = "blank-venue";

// ---------------------------------------------------------------- args / env
const mode = process.argv[2];
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const label = arg("label", "run");
const outDir = resolve(arg("out", join(tmpdir(), `blank-supabase-${label}`)));
const seedRows = Number(arg("rows", "250"));
/** Configuration problems end the run with a plain message, never a stack trace. */
function configError(message) {
  console.error(`[driver] ${message}`);
  process.exit(2);
}
if (!["flow", "egress"].includes(mode)) {
  configError("usage: blank-supabase.mjs flow|egress --label <l> --out <dir> [--rows N] [--usage N]");
}

const venueEnvPath = process.env.VENUE_ENV;
if (!venueEnvPath) {
  configError("VENUE_ENV is not set. Point it at a KEY=VALUE file outside the repo with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and VENUE_REF.");
}
if (!existsSync(venueEnvPath)) configError(`VENUE_ENV file not found: ${venueEnvPath}`);
let venue;
try {
  venue = Object.fromEntries(
    readFileSync(venueEnvPath, "utf8")
      .split("\n").filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
  );
} catch (err) {
  configError(`Cannot read VENUE_ENV file ${venueEnvPath}: ${err.message}`);
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VENUE_REF } = venue;
const missingKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VENUE_REF"].filter((k) => !venue[k]);
if (missingKeys.length) configError(`VENUE_ENV file ${venueEnvPath} is missing: ${missingKeys.join(", ")}`);
if (DENY_REFS.has(VENUE_REF) || SUPABASE_URL !== `https://${VENUE_REF}.supabase.co`) {
  configError(`Refusing to run against ${SUPABASE_URL} (ref ${VENUE_REF}). Only a disposable venue whose URL is https://<VENUE_REF>.supabase.co is allowed; production is denied.`);
}
if (!existsSync(SERVER)) configError(`Build first (npm run build): ${SERVER} is missing`);
mkdirSync(outDir, { recursive: true });
const VENUE_HOST = new URL(SUPABASE_URL).host;
console.log(`[driver] target venue: ${SUPABASE_URL} (ref ${VENUE_REF}) mode=${mode} label=${label}`);

// ---------------------------------------------------------------- venue REST (driver-side seeding)
const rest = async (method, path, body, extraHeaders = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
};
const WIPE_ORDER = [
  "gitmem_scar_usage", "gitmem_decisions", "gitmem_threads", "knowledge_triples",
  "gitmem_query_metrics", "scar_enforcement_variants", "gitmem_learnings", "gitmem_sessions",
];
async function wipeVenue() {
  for (const t of WIPE_ORDER) await rest("DELETE", `${t}?id=not.is.null`);
}
async function count(table, filter = "") {
  const res = await rest("HEAD", `${table}?select=id${filter}`, undefined, { Prefer: "count=exact", Range: "0-0" });
  return Number((res.headers.get("content-range") || "*/-1").split("/")[1]);
}

// ---------------------------------------------------------------- fake embeddings (Ollama /api/embed shape)
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function embed(text) {
  const v = new Array(DIM).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || ["empty"];
  for (const w of words) for (let k = 0; k < 3; k++) {
    const h = fnv(`${k}:${w}`);
    v[h % DIM] += (h & 1) ? 1 : -1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}
async function startFakeOllama() {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const { input } = JSON.parse(body || "{}");
      const inputs = Array.isArray(input) ? input : [input];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "fake", embeddings: inputs.map(embed) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), calls: () => calls };
}

// ---------------------------------------------------------------- server process
function isolatedHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `gitmem-venue-${tag}-`));
  const gitmemDir = join(home, ".gitmem");
  mkdirSync(gitmemDir, { recursive: true });
  return { home, gitmemDir };
}
const STRIP = /^(OPENAI_API_KEY|OPENROUTER_API_KEY|GITMEM_|SUPABASE_|OLLAMA_|NODE_OPTIONS$|CLAUDE_CODE_ENTRYPOINT$)/;
async function startServer({ home, gitmemDir, ollamaUrl, netlog, stderrSink }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));
  Object.assign(env, {
    HOME: home,
    GITMEM_DIR: gitmemDir,
    GITMEM_TIER: "pro",
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GITMEM_EMBEDDING_PROVIDER: "ollama",
    OLLAMA_URL: ollamaUrl,
    GITMEM_OLLAMA_MODEL: "fake",
    GITMEM_EMBEDDING_DIM: String(DIM),
    GITMEM_DEFAULT_PROJECT: PROJECT,
    GITMEM_NETLOG: netlog,
    NODE_OPTIONS: `--import=${pathToFileURL(NETLOG_PRELOAD).href}`,
    NO_COLOR: "1",
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, cwd: home, stderr: "pipe" });
  transport.stderr?.on("data", (d) => stderrSink.push(d.toString()));
  const client = new Client({ name: "gitmem-blank-venue-driver", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      return (r.content || []).map((c) => c.text || "").join("\n");
    },
    close: async () => { try { await client.close(); } catch {} try { await transport.close(); } catch {} },
  };
}
const readNet = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function waitQuiet(file, { minMs = 4000, quietMs = 4000, maxMs = 90_000 } = {}) {
  const t0 = Date.now();
  let last = -1, lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    const n = readNet(file).length;
    if (n !== last) { last = n; lastChange = Date.now(); }
    if (Date.now() - t0 >= minMs && Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
const venueReqs = (reqs) => reqs.filter((r) => r.host === VENUE_HOST);
const sumBytes = (reqs) => venueReqs(reqs).reduce((a, r) => a + (r.bytes || 0), 0);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Every venue request from every server process in this run, for the failure check.
const allVenueRequests = [];
const expectedFor = (r) => EXPECTED_FAILURES.find((e) =>
  e.status === r.status && e.path.test(r.path) && (e.method === null || e.method === r.method));
function checkFailures(reqs) {
  const failures = reqs.filter((r) => r.status >= 400 && /^\/(rest|functions)\/v1\//.test(r.path));
  const unexpected = failures.filter((r) => !expectedFor(r))
    .map((r) => `${r.method} ${r.path}${r.query} -> ${r.status}`);
  const expectedSeen = {};
  for (const r of failures) {
    const e = expectedFor(r);
    if (e) expectedSeen[`${e.ticket} ${r.method} ${r.path} ${r.status}`] = (expectedSeen[`${e.ticket} ${r.method} ${r.path} ${r.status}`] || 0) + 1;
  }
  return { unexpected, expected_seen: expectedSeen };
}

// ---------------------------------------------------------------- FLOW (runs 1 & 2)
async function flow() {
  await wipeVenue();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  // A prior closed session, so there is a "last session" to load.
  const priorSession = "11111111-1111-4111-8111-111111111111";
  await rest("POST", "gitmem_sessions", [{
    id: priorSession, session_title: "Seeded prior session", agent: "cli", project: PROJECT,
    decisions: [], open_threads: [], closing_reflection: { what_worked: "seeded" },
    created_at: iso(3600_000), updated_at: iso(3600_000),
  }]);

  // Learnings with embeddings, so recall has something to find.
  const scars = [
    ["Supabase migrations must be dry-run before push", "Run db push --dry-run and read the plan before applying any migration to a shared database."],
    ["Edge functions are not shipped to customer projects", "Anything under /functions/v1 exists only where someone deployed it; customer Supabase projects have none."],
    ["Service role keys never go in logs", "Redact service role keys from stdout, stderr and CI logs; write them to a mode-600 env file."],
    ["Verify deployment after merge", "Done is not deployed is not verified working: pull on the target, restart, and check it is running."],
    ["Thread counts must agree across surfaces", "session_start and list_threads must read threads from the same source of truth."],
  ];
  await rest("POST", "gitmem_learnings", scars.map(([title, description], i) => ({
    learning_type: "scar", title, description, severity: i < 2 ? "high" : "medium",
    counter_arguments: ["You might think it is fine to skip — but it is not."], project: PROJECT,
    embedding: JSON.stringify(embed(`${title} ${description}`)), is_active: true,
  })));

  // Remote threads (source of truth) — 3 open.
  const remoteThreads = ["Remote thread A: rotate venue credentials", "Remote thread B: document blank-venue setup", "Remote thread C: follow up on per-row delta sync"];
  await rest("POST", "gitmem_threads", remoteThreads.map((text, i) => ({
    thread_id: `t-remote0${i + 1}`, text, status: "active", project: PROJECT,
    source_session: priorSession, last_touched_at: iso(600_000 * (i + 1)),
  })));

  // Local threads.json that DIFFERS from the remote table: 2 local-only threads, none of the remote ones.
  const { home, gitmemDir } = isolatedHome(`${label}-flow`);
  const localThreads = [
    { id: "t-local001", text: "Stale local file: renew the TLS certificate on the staging box", status: "open", created_at: iso(86400_000) },
    { id: "t-local002", text: "Stale local file: benchmark ivfflat recall at ten thousand rows", status: "open", created_at: iso(86400_000) },
  ];
  writeFileSync(join(gitmemDir, "threads.json"), JSON.stringify(localThreads, null, 2));

  const seeded = {
    remote_threads_open: await count("gitmem_threads", "&status=eq.active"),
    local_threads_json: localThreads.length,
    learnings: await count("gitmem_learnings"),
    sessions: await count("gitmem_sessions"),
  };
  console.log("[driver] seeded:", seeded);

  const ollama = await startFakeOllama();
  const netlog = join(outDir, `netlog-${label}-flow.jsonl`);
  writeFileSync(netlog, "");
  const stderr = [];
  const transcript = [];
  const srv = await startServer({ home, gitmemDir, ollamaUrl: ollama.url, netlog, stderrSink: stderr });
  const step = async (name, args) => {
    const t0 = Date.now();
    let text, error;
    try { text = await srv.call(name, args); } catch (e) { error = String(e); text = ""; }
    transcript.push({ step: name, args, ms: Date.now() - t0, error, text });
    console.log(`[driver] ${name}: ${error ? "ERROR " + error : "ok"} (${Date.now() - t0}ms)`);
    return text;
  };

  await waitQuiet(netlog, { minMs: 3000, quietMs: 3000 });
  const ss = await step("session_start", { project: PROJECT, agent_identity: "cli", force: true });
  const sessionId = (ss.match(UUID) || []).find((u) => u !== priorSession);
  const ssThreadCount = Number((ss.match(/Threads \((\d+)\)/) || [])[1] ?? 0);
  // Same-moment comparison: list_threads immediately after session_start, before anything writes a thread.
  const lt0 = await step("list_threads", { project: PROJECT });
  const lt0Open = Number((lt0.match(/(\d+) open/) || [])[1] ?? -1);

  const rc = await step("recall", { plan: "Supabase migrations must be dry-run before push; verify deployment after merge, pull on the target, restart", project: PROJECT, match_count: 3 });
  // recall prints short ids ("id:448fede2"); resolve them to full UUIDs from the venue.
  const allIds = await rest("GET", "gitmem_learnings?select=id", undefined, { Prefer: "" }).then((r) => r.json());
  const shortIds = [...new Set([...rc.matchAll(/id:([0-9a-f]{8})\b/g)].map((m) => m[1]))];
  const scarIds = shortIds.map((s) => allIds.find((r) => r.id.startsWith(s))?.id).filter(Boolean);

  const cs = await step("confirm_scars", {
    confirmations: scarIds.map((id, i) => ({
      scar_id: id,
      decision: i === 0 ? "APPLYING" : "N_A",
      evidence: i === 0
        ? "Ran the dry-run first and read the migration plan before applying it to the blank venue project."
        : "This scar concerns a different failure mode than the blank-venue verification being run here.",
      relevance: i === 0 ? "high" : "low",
    })),
  });

  const ct = await step("create_thread", { text: `Driver-created thread (${label}) ${new Date(now).toISOString()}` });
  const lt = await step("list_threads", { project: PROJECT });
  const ltOpen = Number((lt.match(/(\d+) open/) || [])[1] ?? -1);

  const sc = await step("session_close", {
    session_id: sessionId, close_type: "standard", human_corrections: "none",
    closing_reflection: {
      what_broke: "nothing (driver)", what_took_longer: "n/a", do_differently: "n/a", what_worked: "driver",
      wrong_assumption: "n/a", scars_applied: [], institutional_memory_items: "n/a",
      collaborative_dynamic: "n/a", rapport_notes: "n/a",
    },
  });
  await waitQuiet(netlog, { minMs: 2000, quietMs: 3000 });
  const health = await step("health", { failure_limit: 20 });
  await waitQuiet(netlog, { minMs: 1000, quietMs: 2000 });
  await srv.close();
  ollama.close();

  const reqs = readNet(netlog);
  const vr = venueReqs(reqs);
  allVenueRequests.push(...vr);
  const errText = stderr.join("");
  const failed = [...health.matchAll(/\((\d+) failed\)/g)].reduce((a, m) => a + Number(m[1]), 0);
  const summary = {
    label, mode, venue: SUPABASE_URL, seeded, session_id: sessionId,
    session_start_thread_count: ssThreadCount,
    list_threads_open_right_after_session_start: lt0Open,
    list_threads_open_after_create_thread: ltOpen,
    thread_counts_match: ssThreadCount === lt0Open,
    session_start_matches_local_file: ssThreadCount === seeded.local_threads_json,
    recall_scar_ids: scarIds.length,
    remote_threads_after: await count("gitmem_threads"),
    remote_sessions_after: await count("gitmem_sessions"),
    remote_scar_usage_after: await count("gitmem_scar_usage"),
    health_failed_total: failed,
    health_text: health,
    functions_v1_requests: vr.filter((r) => r.path.startsWith("/functions/v1/")).map((r) => `${r.method} ${r.path} -> ${r.status}`),
    rest_requests: vr.length,
    non_2xx_venue: vr.filter((r) => r.status < 200 || r.status >= 300).map((r) => `${r.method} ${r.path}${r.query} -> ${r.status}`),
    stderr_has_mcp_404: /MCP HTTP error: 404/.test(errText),
    stderr_has_failed_last_session: /\[session_start\] Failed to load last session/.test(errText),
    stderr_error_lines: errText.split("\n").filter((l) => /error|fail|warn/i.test(l)).slice(0, 60),
    embed_calls: ollama.calls(),
    tool_errors: transcript.filter((s) => s.error || /^\{"error"/.test(s.text)).map((s) => `${s.step}: ${s.error || s.text.slice(0, 200)}`),
  };
  writeFileSync(join(outDir, `stderr-${label}-flow.log`), errText);
  writeFileSync(join(outDir, `transcript-${label}-flow.json`), JSON.stringify(transcript, null, 2));
  writeFileSync(join(outDir, `summary-${label}-flow.json`), JSON.stringify(summary, null, 2));
  return summary;
}

// ---------------------------------------------------------------- EGRESS (run 3)
async function egress() {
  await wipeVenue();
  const rows = [];
  for (let i = 0; i < seedRows; i++) {
    const title = `Egress learning ${i}: ${["deploy", "migration", "cache", "thread", "session"][i % 5]} behaviour ${i}`;
    rows.push({
      learning_type: ["scar", "pattern", "win"][i % 3], title,
      description: `Seeded learning ${i} for the GIT-98 egress measurement. `.repeat(3),
      severity: "medium", project: PROJECT, is_active: true,
      embedding: JSON.stringify(embed(title)),
    });
  }
  for (let i = 0; i < rows.length; i += 50) await rest("POST", "gitmem_learnings", rows.slice(i, i + 50));
  console.log(`[driver] seeded learnings: ${await count("gitmem_learnings")}`);
  // --usage N: give N learnings >=3 recent gitmem_scar_usage rows each, the threshold at which
  // refresh_scar_behavioral_scores() rewrites them (and bumps updated_at). A real Pro store with
  // usage history looks like this; a store where usage never lands looks like --usage 0.
  const usageScars = Number(arg("usage", "0"));
  if (usageScars > 0) {
    const ids = await rest("GET", `gitmem_learnings?select=id&learning_type=eq.scar&limit=${usageScars}`, undefined, { Prefer: "" }).then((r) => r.json());
    const surfaced = new Date(Date.now() - 86400_000).toISOString();
    await rest("POST", "gitmem_scar_usage", ids.flatMap(({ id }) => [0, 1, 2].map((k) => ({
      scar_id: id, agent: "cli", reference_type: k === 0 ? "none" : "acknowledged", surfaced_at: surfaced,
    }))));
    console.log(`[driver] seeded gitmem_scar_usage: ${await count("gitmem_scar_usage")} rows over ${ids.length} scars`);
  }

  const { home, gitmemDir } = isolatedHome(`${label}-egress`); // shared across all starts: the disk cache must persist
  const ollama = await startFakeOllama();
  const starts = [];
  const run = async (name, { sessionStart = false } = {}) => {
    const netlog = join(outDir, `netlog-${label}-${name}.jsonl`);
    writeFileSync(netlog, "");
    const stderr = [];
    const srv = await startServer({ home, gitmemDir, ollamaUrl: ollama.url, netlog, stderrSink: stderr });
    await waitQuiet(netlog);
    const startupBytes = sumBytes(readNet(netlog));
    const startupReqs = venueReqs(readNet(netlog)).length;
    if (sessionStart) {
      await srv.call("session_start", { project: PROJECT, agent_identity: "cli", force: true });
      await waitQuiet(netlog, { minMs: 2000 });
    }
    await srv.close();
    const reqs = venueReqs(readNet(netlog));
    allVenueRequests.push(...reqs);
    const errText = stderr.join("");
    writeFileSync(join(outDir, `stderr-${label}-${name}.log`), errText);
    const s = {
      start: name,
      startup_bytes: startupBytes,
      startup_requests: startupReqs,
      total_bytes: sumBytes(reqs),
      total_requests: reqs.length,
      largest: [...reqs].sort((a, b) => b.bytes - a.bytes).slice(0, 4).map((r) => `${r.method} ${r.path}${r.query.slice(0, 80)} ${r.status} ${r.bytes}B${r.encoding ? " (" + r.encoding + ")" : ""}`),
      cache_log: errText.split("\n").filter((l) => /Vector cache|Loaded \d+ learnings|bulk download|Loading ALL/.test(l)),
    };
    starts.push(s);
    console.log(`[driver] ${name}: startup ${startupBytes} B / ${startupReqs} req; total ${s.total_bytes} B / ${s.total_requests} req`);
    return s;
  };
  // Which learnings did a session_start rewrite? (refresh_scar_behavioral_scores bumps updated_at)
  const maxUpdated = () => rest("GET", "gitmem_learnings?select=updated_at&order=updated_at.desc&limit=1", undefined, { Prefer: "" })
    .then((r) => r.json()).then((rows) => rows[0]?.updated_at ?? null);
  const changedSince = (ts) => rest("GET", `gitmem_learnings?select=id,title,decay_multiplier,updated_at&updated_at=gt.${encodeURIComponent(ts)}&order=updated_at.desc`, undefined, { Prefer: "" })
    .then((r) => r.json());
  const rounds = [];
  await run("start1-cold");
  await run("start2-warm");
  for (const round of [1, 2]) {
    const before = await maxUpdated();
    await run(`start${round * 2 + 1}-with-session_start-${round}`, { sessionStart: true });
    const changed = await changedSince(before);
    rounds.push({
      round,
      max_updated_at_before: before,
      max_updated_at_after: await maxUpdated(),
      rows_rewritten: changed.map((r) => ({ id: r.id.slice(0, 8), title: r.title.slice(0, 40), decay_multiplier: r.decay_multiplier })),
    });
    await run(`start${round * 2 + 2}-after-session_start-${round}`);
  }
  ollama.close();
  const summary = { label, mode, venue: SUPABASE_URL, seeded_learnings: seedRows, rounds, starts };
  writeFileSync(join(outDir, `summary-${label}-egress.json`), JSON.stringify(summary, null, 2));
  return summary;
}

const result = mode === "flow" ? await flow() : await egress();
const failureCheck = checkFailures(allVenueRequests);
writeFileSync(join(outDir, `failure-check-${label}-${mode}.json`), JSON.stringify(failureCheck, null, 2));
console.log(JSON.stringify({ ...result, health_text: undefined, stderr_error_lines: undefined, failure_check: failureCheck }, null, 2));
if (failureCheck.unexpected.length > 0) {
  console.error(`[driver] FAIL: ${failureCheck.unexpected.length} unexpected venue failure(s) — not on EXPECTED_FAILURES:`);
  for (const u of failureCheck.unexpected) console.error(`  ${u}`);
  process.exit(1);
}
console.error(`[driver] PASS: no unexpected venue failures (${Object.keys(failureCheck.expected_seen).length} known kinds seen)`);
process.exit(0);
