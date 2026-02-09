#!/usr/bin/env node
/**
 * Backfill knowledge triples for all existing learnings and decisions.
 *
 * Uses the same rule-based extraction from triple-writer.ts.
 * Skips learnings/decisions that already have triples (by source_id).
 *
 * Usage: node scripts/backfill-triples.mjs [--dry-run]
 */

import { extractLearningTriples, extractDecisionTriples } from "../dist/services/triple-writer.js";
import { randomUUID } from "crypto";
import https from "https";
import fs from "fs";

// --- Config ---
const mpcConfigPaths = [
  process.env.MCP_CONFIG_PATH,
  "/home/claude/mcp-config.json",
  "/home/node/mcp-config.json",
];

let SUPABASE_URL = process.env.SUPABASE_URL || "";
let SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Try mcp-config if env vars not set
if (!SUPABASE_URL || !SUPABASE_KEY) {
  for (const p of mpcConfigPaths) {
    if (!p) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const gm = cfg.mcpServers?.gitmem || cfg.mcpServers?.["gitmem-mcp"];
      const env = gm?.env || {};
      SUPABASE_URL = env.SUPABASE_URL || SUPABASE_URL;
      SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;
      if (SUPABASE_URL && SUPABASE_KEY) break;
    } catch {}
  }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");

// --- HTTP helpers ---

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Accept-Profile": "public",
      "Content-Profile": "public",
    };
    if (method === "GET") {
      headers.Prefer = "count=exact";
    }
    if (method === "POST") {
      headers.Prefer = "return=representation,resolution=merge-duplicates";
    }
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), range: res.headers["content-range"] });
        } catch {
          resolve({ status: res.statusCode, data, range: res.headers["content-range"] });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchAll(table, select, filters = "") {
  const results = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const path = `/rest/v1/${table}?select=${encodeURIComponent(select)}${filters}&limit=${limit}&offset=${offset}`;
    const res = await request("GET", path);
    if (!Array.isArray(res.data)) {
      console.error(`Error fetching ${table}:`, res.data);
      break;
    }
    results.push(...res.data);
    if (res.data.length < limit) break;
    offset += limit;
  }
  return results;
}

// --- Main ---

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== BACKFILL ===");

  // 1. Fetch existing triple source_ids to skip
  console.log("Fetching existing triples...");
  const existingTriples = await fetchAll("knowledge_triples", "source_id");
  const existingSourceIds = new Set(existingTriples.map((t) => t.source_id));
  console.log(`  ${existingTriples.length} existing triples, ${existingSourceIds.size} unique source_ids`);

  // 2. Fetch all learnings
  console.log("Fetching learnings...");
  const learnings = await fetchAll(
    "orchestra_learnings",
    "id,title,description,learning_type,scar_type,persona_name,source_linear_issue,domain,project",
    "&is_active=eq.true"
  );
  console.log(`  ${learnings.length} active learnings`);

  // 3. Fetch all decisions
  console.log("Fetching decisions...");
  const decisions = await fetchAll(
    "orchestra_decisions",
    "id,title,decision,rationale,personas_involved,linear_issue,session_id,project"
  );
  console.log(`  ${decisions.length} decisions`);

  // 4. Extract triples
  let candidates = [];
  let skippedLearnings = 0;
  let skippedDecisions = 0;

  for (const l of learnings) {
    if (existingSourceIds.has(l.id)) {
      skippedLearnings++;
      continue;
    }
    const triples = extractLearningTriples({
      id: l.id,
      learning_type: l.learning_type || "scar",
      title: l.title || "",
      description: l.description || "",
      scar_type: l.scar_type,
      source_linear_issue: l.source_linear_issue,
      persona_name: l.persona_name || "Unknown",
      domain: l.domain || [],
      project: l.project || "orchestra_dev",
    });
    candidates.push(...triples);
  }

  for (const d of decisions) {
    if (existingSourceIds.has(d.id)) {
      skippedDecisions++;
      continue;
    }
    const triples = extractDecisionTriples({
      id: d.id,
      title: d.title || "",
      decision: d.decision || "",
      rationale: d.rationale || "",
      personas_involved: d.personas_involved || [],
      linear_issue: d.linear_issue,
      session_id: d.session_id,
      project: d.project || "orchestra_dev",
      agent: d.agent || "Unknown",
    });
    candidates.push(...triples);
  }

  console.log(`\nExtraction results:`);
  console.log(`  Learnings: ${learnings.length - skippedLearnings} processed, ${skippedLearnings} skipped (already have triples)`);
  console.log(`  Decisions: ${decisions.length - skippedDecisions} processed, ${skippedDecisions} skipped (already have triples)`);
  console.log(`  Total new triples: ${candidates.length}`);

  // 5. Show predicate breakdown
  const predicateCounts = {};
  for (const c of candidates) {
    predicateCounts[c.predicate] = (predicateCounts[c.predicate] || 0) + 1;
  }
  console.log(`\nPredicate breakdown:`);
  for (const [pred, count] of Object.entries(predicateCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pred}: ${count}`);
  }

  if (DRY_RUN) {
    console.log(`\nSample triples (first 10):`);
    for (const c of candidates.slice(0, 10)) {
      console.log(`  ${c.subject}  --[${c.predicate}]-->  ${c.object}`);
    }
    console.log(`\nRun without --dry-run to write ${candidates.length} triples.`);
    return;
  }

  // 6. Write triples in batches
  console.log(`\nWriting ${candidates.length} triples...`);
  let written = 0;
  let errors = 0;
  const batchSize = 20;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize).map((c) => ({
      id: randomUUID(),
      subject: c.subject,
      predicate: c.predicate,
      object: c.object,
      event_time: new Date().toISOString(),
      decay_weight: 1.0,
      half_life_days: c.half_life_days,
      decay_floor: 0.1,
      source_type: c.source_type,
      source_id: c.source_id,
      source_linear_issue: c.source_linear_issue || null,
      domain: c.domain || [],
      project: c.project,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: "backfill",
    }));

    const res = await request("POST", "/rest/v1/knowledge_triples", batch);
    if (res.status >= 200 && res.status < 300) {
      written += batch.length;
    } else {
      console.error(`  Batch error (${i}-${i + batch.length}):`, res.status, JSON.stringify(res.data).slice(0, 200));
      errors += batch.length;
    }

    // Progress
    if ((i + batchSize) % 100 === 0 || i + batchSize >= candidates.length) {
      console.log(`  Progress: ${Math.min(i + batchSize, candidates.length)}/${candidates.length} (${written} written, ${errors} errors)`);
    }
  }

  console.log(`\nDone: ${written} written, ${errors} errors, ${existingTriples.length + written} total triples.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
