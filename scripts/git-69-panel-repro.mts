/**
 * GIT-69 consumer verification — the 2026-08-05 cross-project leak repro.
 *
 * The original defect (desktop session 096e940d): session_start(project=gitmem)
 * displayed a weekend_warrior thread (t-4120fdad) in its panel while
 * list_threads(project=gitmem) correctly excluded it. Two code paths, two
 * answers, and the panel was the one that leaked.
 *
 * This runs BOTH surfaces against the LOCAL BUILD over stdio — not through the
 * session's own MCP tooling, which serves published 1.6.6 and would green-light
 * unfixed code. It then resolves every surfaced thread's true project by
 * reading orchestra_threads directly, because the acceptance criterion says
 * "confirmed against orchestra_threads directly" and a tool confirming itself
 * is not confirmation.
 *
 * READ-ONLY against orchestra_threads, per the acceptance-venue ruling
 * (GIT-70 comment 10b75c26): production is evidence, never fixture. Nothing
 * here writes a thread. session_start does insert its own session row in
 * orchestra_sessions — an ordinary operational write, not a seeded fixture —
 * and that is disclosed rather than hidden.
 *
 * Credentials are read from the MCP config and never printed.
 *
 *   npx tsx scripts/git-69-panel-repro.mts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SERVER = join(REPO, "dist", "index.js");

const TARGET_PROJECT = "gitmem";
const FOREIGN_PROJECT = "weekend_warrior";

function liveEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8"));
  let found: Record<string, string> | null = null;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const servers = obj.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
    if (servers?.gitmem?.env && !found) found = servers.gitmem.env;
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(cfg);
  if (!found) throw new Error("gitmem MCP env not found in ~/.claude.json");
  const env = found as Record<string, string>;
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[k]) throw new Error(`missing ${k}`);
  }
  return env;
}

const env = liveEnv();
const BASE = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
const TABLE = `${env.GITMEM_TABLE_PREFIX || "orchestra_"}threads`;
const authHeaders = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};

/** Every thread id mentioned in a surface's output. */
function threadIds(text: string): Set<string> {
  return new Set(text.match(/\bt-[0-9a-f]{8}\b/g) ?? []);
}

/**
 * The panel renders truncated thread TEXT and no ids — verified by dumping the
 * raw tool result, which carries `content` only and no structuredContent. So
 * the panel's entries are matched back to rows by text prefix rather than by
 * id. Stated explicitly because an id-regex over this surface silently returns
 * zero matches and would read as "no leak" when it means "not measured".
 */
function panelThreadPrefixes(text: string): string[] {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => /^Threads \(\d+\)/.test(l.trim()));
  if (header === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith("  ") || !line.trim()) break;
    out.push(line.trim().replace(/\.\.\.$/, "").trim());
  }
  return out;
}

/** The count the panel claims, independent of how many lines it prints. */
function panelClaimedCount(text: string): number | null {
  const m = text.match(/^Threads \((\d+)\)/m);
  return m ? Number(m[1]) : null;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
      GITMEM_HOME: join(tmpdir(), `git69-repro-${Date.now()}`),
    } as Record<string, string>,
  });
  const client = new Client({ name: "git-69-repro", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log(`GIT-69 panel repro — local build, project=${TARGET_PROJECT}\n`);

  const started = await client.callTool({
    name: "session_start",
    arguments: { project: TARGET_PROJECT, agent_identity: "cli" },
  });
  const panelText = textOf(started);
  const prefixes = panelThreadPrefixes(panelText);
  const claimed = panelClaimedCount(panelText);

  const listed = await client.callTool({
    name: "list_threads",
    arguments: { project: TARGET_PROJECT, status: "open" },
  });
  const listText = textOf(listed);
  const listIds = threadIds(listText);

  await client.close().catch(() => {});

  console.log(`session_start panel : claims ${claimed}, prints ${prefixes.length} entries`);
  console.log(`list_threads        : ${listIds.size} thread ids\n`);

  const failures: string[] = [];
  if (claimed !== null && claimed !== prefixes.length) {
    failures.push(`panel claims ${claimed} threads but prints ${prefixes.length}`);
  }

  // --- Resolve every panel entry against the table, ACROSS ALL PROJECTS ---
  // Scoping this read to gitmem would assume the answer: a leaked thread would
  // simply not be found and would look like a clean panel.
  // No status filter: thread rows carry lifecycle values like "emerging", not
  // a literal "open", so filtering on status=open silently returns the wrong
  // set and every panel entry reads as unmatched. Unresolved is the criterion
  // that matters here, and resolved threads simply will not appear in a panel.
  const res = await fetch(
    `${BASE}/${TABLE}?resolved_at=is.null&select=thread_id,project,text,status&limit=1000`,
    { headers: authHeaders },
  );
  if (!res.ok) throw new Error(`read threads: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { thread_id: string; project: string; text: string; status: string }[];

  console.log("panel contents, project resolved from orchestra_threads (all projects):");
  const matchedIds = new Set<string>();
  for (const prefix of prefixes) {
    const hits = rows.filter((r) => (r.text ?? "").startsWith(prefix));
    if (hits.length === 0) {
      failures.push(`panel entry matched no open thread row: "${prefix.slice(0, 50)}"`);
      console.log(`  ??    (no row matched)  "${prefix.slice(0, 46)}"`);
      continue;
    }
    for (const h of hits) matchedIds.add(h.thread_id);
    const projects = [...new Set(hits.map((h) => h.project))];
    const leaked = projects.filter((p) => p !== TARGET_PROJECT);
    const flag = leaked.length ? "LEAK" : "ok  ";
    console.log(`  ${flag}  ${hits.map((h) => h.thread_id).join(",")}  project=${projects.join(",")}  "${prefix.slice(0, 40)}"`);
    if (leaked.length) {
      failures.push(`panel leaked thread from project(s) ${leaked.join(",")}: "${prefix.slice(0, 50)}"`);
    }
    if (projects.includes(FOREIGN_PROJECT)) {
      failures.push(`panel contains a ${FOREIGN_PROJECT} thread: "${prefix.slice(0, 50)}"`);
    }
  }

  // Criterion 2: the two surfaces agree — the original defect was disagreement.
  const onlyPanel = [...matchedIds].filter((id) => !listIds.has(id));
  const onlyList = [...listIds].filter((id) => !matchedIds.has(id));
  console.log(`\nparity: panel-only=${onlyPanel.length} list-only=${onlyList.length}`);
  if (onlyPanel.length) failures.push(`in panel but not list_threads: ${onlyPanel.join(", ")}`);
  if (onlyList.length) failures.push(`in list_threads but not panel: ${onlyList.join(", ")}`);

  // --- Instrument self-test -----------------------------------------------
  // A repro that cannot fail is not a repro. Two earlier versions of this
  // script reported FAILED for instrument reasons (the panel renders no ids;
  // thread rows carry status "emerging", not "open"), which is the same class
  // in reverse — so the detector is now exercised against a thread that really
  // does belong to another project, and must flag it.
  const foreignRow = rows.find((r) => r.project && r.project !== TARGET_PROJECT);
  if (!foreignRow) {
    console.log("\nself-test SKIPPED — no foreign-project thread exists to detect with");
    failures.push("instrument unvalidated: no foreign-project row available");
  } else {
    const syntheticPrefix = (foreignRow.text ?? "").slice(0, 45);
    const hits = rows.filter((r) => (r.text ?? "").startsWith(syntheticPrefix));
    const detected = hits.some((h) => h.project !== TARGET_PROJECT);
    console.log(
      `\nself-test: feeding the detector a real ${foreignRow.project} thread ` +
        `(${foreignRow.thread_id}) → ${detected ? "LEAK detected, instrument binds" : "NOT DETECTED"}`,
    );
    if (!detected) failures.push("instrument does not detect a known foreign-project thread");
  }

  console.log("");
  if (failures.length) {
    console.log("REPRO FAILED — the defect is still present:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS — panel contains no ${FOREIGN_PROJECT} threads and agrees with list_threads,`);
    console.log("       both confirmed against orchestra_threads directly.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
