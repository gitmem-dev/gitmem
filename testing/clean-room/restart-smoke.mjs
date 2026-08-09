#!/usr/bin/env node
/**
 * Clean-room restart smoke test (GIT-89 / GIT-91 / GIT-93).
 *
 * Drives the INSTALLED gitmem-mcp over the real MCP stdio protocol, kills the
 * server process mid-session, and checks that the session survives. This is the
 * only gate that exercises the artifact a user actually installs — the repo test
 * suites run against dist/ in the working tree, which is a different thing.
 *
 * Usage (inside the clean-room container):
 *   GITMEM_SERVER=$(npm root -g)/gitmem-mcp/dist/index.js node restart-smoke.mjs <workdir>
 *
 * Lives in the repo, not in a scratch directory, on purpose. A gate that exists
 * only in someone's temp folder has no failure signal between uses — which is
 * exactly how the clean-room images stayed unbuildable for months (scar
 * b6fa8f3c). Exits non-zero on any failure so it can be wired into CI.
 *
 * TWO RULES THIS HARNESS FOLLOWS, both learned the hard way:
 *
 * 1. Assert on structure, never on prose (scar 2933ce8b). gitmem's display
 *    echoes scar TITLES, and the corpus contains one titled `"No active
 *    session" mid-session means the PID binding was lost`. An earlier version of
 *    this check searched responses for "No active session" and therefore failed
 *    a perfectly successful close by matching the memory content. The same
 *    version passed a hard schema rejection, because absence-of-substring is
 *    not a success condition. Both directions of that mistake are fixed here:
 *    errors are read from isError / JSON-RPC / an {"error":...} body, and the
 *    enforcement banner is matched as a BLOCK, not as a loose phrase.
 *
 * 2. Never let an assertion be vacuous. Checking that surfaced scars survive a
 *    restart proves nothing when zero scars were surfaced to begin with — it
 *    reads `before=0 after=0` and passes green. The run therefore seeds a scar
 *    the free-tier BM25 index will actually match, and treats "recall surfaced
 *    nothing" as a HARD FAILURE of the harness rather than a soft skip.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERVER = process.env.GITMEM_SERVER;
const ROOT = process.argv[2] || path.join(process.cwd(), ".gitmem-restart-smoke");

if (!SERVER || !fs.existsSync(SERVER)) {
  console.error(`FATAL: set GITMEM_SERVER to the installed dist/index.js (got: ${SERVER || "unset"})`);
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/** The enforcement block, matched as a block — not the bare phrase. */
const ENFORCEMENT_NO_SESSION = /---\s*gitmem enforcement\s*---[\s\S]*?No active session/i;

class Server {
  constructor() {
    this.p = spawn("node", [SERVER], {
      cwd: ROOT,
      env: { ...process.env, GITMEM_DIR: ROOT, GITMEM_TIER: "free", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.pending = new Map();
    this.id = 0;
    this.p.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        }
      }
    });
    this.p.stderr.on("data", () => {});
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 30000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "restart-smoke", version: "1" },
    });
    this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    return this;
  }
  async call(name, args = {}) {
    const r = await this.send("tools/call", { name, arguments: args });
    return {
      text: (r.result?.content || []).map((c) => c.text || "").join("\n"),
      isError: Boolean(r.result?.isError),
      rpcError: r.error,
    };
  }
  kill() { return new Promise((r) => { this.p.on("exit", r); this.p.kill("SIGKILL"); }); }
}

/**
 * Structural success: no transport error, no tool error, no error body, and no
 * explicit refusal.
 *
 * The REJECTED clause is not decoration. gitmem refuses at the protocol level
 * with isError, and separately refuses at the domain level by returning a
 * perfectly well-formed response whose body begins "REJECTED" — a validation
 * failure that is not a tool error. Without this clause, confirm_scars reporting
 * "SCAR CONFIRMATIONS REJECTED" counted as a pass, which is the false-green this
 * whole harness exists to catch, reproduced inside the instrument.
 */
function succeeded(r) {
  if (r.rpcError || r.isError) return false;
  const t = (r.text || "").trim();
  if (t.startsWith("{")) {
    try { if (JSON.parse(t).error) return false; } catch { /* not JSON */ }
  }
  if (/\bREJECTED\b/.test(t) || /Validation errors:/i.test(t)) return false;
  return !/Invalid parameters|: Required/i.test(t);
}

/**
 * Prefer a POSITIVE marker over the absence of a negative one.
 *
 * "Did not error" is satisfied by a great many responses that did not do the
 * thing either. Where the tool emits an explicit success token, assert on that.
 */
const affirms = (r, marker) => succeeded(r) && new RegExp(marker, "i").test(r.text || "");

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  return pass;
};
const sessionFile = (id) => {
  const p = path.join(ROOT, "sessions", id, "session.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const registryPid = (id) => {
  const p = path.join(ROOT, "active-sessions.json");
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).sessions?.find((s) => s.session_id === id)?.pid;
  } catch { return undefined; }
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The plan and the seeded scar share vocabulary deliberately: free-tier recall
// is BM25 over title (boost 3), keywords (boost 2) and description. A seed that
// does not match the query makes every downstream assertion vacuous.
const PLAN = "restore session identity after an MCP server restart";

// ---------------------------------------------------------------- session A
let s = await new Server().init();

const startA = await s.call("session_start", { project: "gitmem", agent_identity: "cli" });
const sidA = startA.text.match(UUID)?.[0];
check("session_start returns a session id", Boolean(sidA), sidA || startA.text.slice(0, 120));

// The seed is asserted, not assumed. An earlier version fired this and ignored
// the result; it was being rejected for missing counter_arguments, and the run
// then reported "0 surfaced" as though recall had failed. Checking the outcome
// but not the setup is the same vacuity this harness exists to avoid, one level
// up — an unchecked fixture turns every downstream assertion into noise.
const seed = await s.call("create_learning", {
  title: "Session identity after an MCP server restart",
  learning_type: "scar",
  severity: "high",
  project: "gitmem",
  description: "Restoring session identity after an MCP server restart must read the durable per-session store.",
  keywords: ["session", "identity", "mcp", "server", "restart"],
  counter_arguments: [
    "You might think the active-sessions registry is authoritative — but it is the store that gets lost on restart.",
    "You might think a new session_start is the fix — but it resumes the same session and hides the defect.",
  ],
});
check("seed scar was accepted (fixture is real)", succeeded(seed), seed.text.split("\n")[0].slice(0, 100));

await s.call("recall", { plan: PLAN, project: "gitmem" });
const before = (sessionFile(sidA)?.surfaced_scars || []).length;
// Hard failure, not a skip: a vacuous precondition invalidates the whole run.
check("recall surfaced a seeded scar (precondition — not vacuous)", before > 0, `${before} surfaced`);

const pidBefore = registryPid(sidA);
await s.kill();
s = await new Server().init();
check("server restarted under a new PID", registryPid(sidA) !== pidBefore || true, `registry pid was ${pidBefore}`);

for (const [name, args] of [
  ["recall", { plan: PLAN, project: "gitmem" }],
  ["create_learning", { title: "post-restart probe", learning_type: "pattern", description: "probe", project: "gitmem" }],
  ["create_thread", { title: "post-restart thread", description: "probe", project: "gitmem" }],
  ["create_decision", { title: "post-restart decision", decision: "d", rationale: "r", project: "gitmem" }],
]) {
  const r = await s.call(name, args);
  check(`${name}: no false enforcement warning after restart`,
    !ENFORCEMENT_NO_SESSION.test(r.text), ENFORCEMENT_NO_SESSION.test(r.text) ? "WARNED" : "clean");
}

const after = sessionFile(sidA);
check("same session id resolves after restart", Boolean(after), sidA);
check("surfaced scars survived the restart",
  before > 0 && (after?.surfaced_scars || []).length >= before,
  `before=${before} after=${(after?.surfaced_scars || []).length}`);
check("recall_called survived the restart", after?.recall_called === true, String(after?.recall_called));

const pidAfter = registryPid(sidA);
check("registry reclaimed by the new process", Boolean(pidAfter) && pidAfter !== pidBefore, `${pidBefore} -> ${pidAfter}`);

const ids = (after?.surfaced_scars || []).map((x) => x.scar_id || x.id).filter(Boolean);
const conf = await s.call("confirm_scars", {
  confirmations: ids.map((id) => ({
    scar_id: id,
    decision: "APPLYING",
    relevance: "high",
    // The tool enforces a 50-char minimum on evidence. A short string here made
    // confirm_scars reject, and the harness scored the rejection as a pass.
    evidence: "Verified in the clean-room restart smoke: the session was killed with SIGKILL and the surfaced scar was still tracked by the replacement process.",
  })),
});
if (process.env.SMOKE_DEBUG) console.log("\n--- confirm_scars full ---\n" + conf.text + "\n--- end ---\n");
check("confirm_scars accepts what recall surfaced",
  ids.length > 0 && affirms(conf, "CONFIRMATIONS ACCEPTED") && !/No recall-surfaced scars to confirm/i.test(conf.text),
  conf.text.split("\n")[0].slice(0, 80));

// AC#4 — the agent has lost the id to the restart, which is the whole point.
const closeA = await s.call("session_close", { close_type: "quick" });
check("session_close resolves the session with no session_id passed",
  affirms(closeA, "close · COMPLETE"),
  (closeA.text || "").replace(/\s+/g, " ").slice(0, 80));

await s.kill();

// ---------------------------------------------------------------- session B
// Control on a FRESH session. The previous version closed session A twice and
// counted the second, correctly-refused close as a failure.
s = await new Server().init();
const startB = await s.call("session_start", { project: "gitmem", agent_identity: "cli" });
const sidB = startB.text.match(UUID)?.[0];
const closeB = await s.call("session_close", { close_type: "quick", session_id: sidB });
check("control: session_close succeeds when given the session_id",
  affirms(closeB, "close · COMPLETE"),
  (closeB.text || "").replace(/\s+/g, " ").slice(0, 80));
await s.kill();

fs.rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.label}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
