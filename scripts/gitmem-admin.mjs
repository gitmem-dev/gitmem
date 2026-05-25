#!/usr/bin/env node

/**
 * GitMem Admin — License Key Management (internal, not published)
 *
 * Usage:
 *   node scripts/gitmem-admin.mjs create --email user@co.com [--tier pro] [--max-devices 3] [--expires YYYY-MM-DD]
 *   node scripts/gitmem-admin.mjs list
 *   node scripts/gitmem-admin.mjs revoke <key-prefix>
 *   node scripts/gitmem-admin.mjs devices <key-prefix>
 *   node scripts/gitmem-admin.mjs clear-devices <key-prefix>
 *
 * Requires SUPABASE_ACCESS_TOKEN (from `npx supabase login`).
 * Operates on the gitmem infrastructure Supabase project (cjptxyezuxdiinufgrrm).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const INFRA_PROJECT_REF = "cjptxyezuxdiinufgrrm";
const API_BASE = `https://api.supabase.com/v1/projects/${INFRA_PROJECT_REF}/database/query`;

function getAccessToken() {
  const envToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (envToken) return envToken;

  try {
    const tokenPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".supabase",
      "access-token"
    );
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {
    // No stored token
  }

  console.error("Error: SUPABASE_ACCESS_TOKEN required.");
  console.error("  Set via environment variable or run: npx supabase login");
  process.exit(1);
}

async function runQuery(token, sql) {
  const response = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Database error (HTTP ${response.status}): ${text.slice(0, 300)}`);
    process.exit(1);
  }

  return await response.json();
}

function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { flags, positional };
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

// ─── Subcommands ─────────────────────────────────────────────

async function cmdCreate(token, args) {
  const { flags } = parseArgs(args);

  const email = flags.email;
  if (!email) {
    console.error("Error: --email is required.");
    console.error("  Usage: node scripts/gitmem-admin.mjs create --email user@co.com [--tier pro] [--max-devices 3] [--expires YYYY-MM-DD]");
    process.exit(1);
  }

  const tier = flags.tier || "pro";
  if (tier !== "pro" && tier !== "dev") {
    console.error("Error: --tier must be 'pro' or 'dev'.");
    process.exit(1);
  }

  const maxDevices = parseInt(flags["max-devices"] || "3", 10);
  if (isNaN(maxDevices) || maxDevices < 1) {
    console.error("Error: --max-devices must be a positive integer.");
    process.exit(1);
  }

  const expires = flags.expires || null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    console.error("Error: --expires must be YYYY-MM-DD format.");
    process.exit(1);
  }

  const key = `gitmem_${tier}_` + crypto.randomBytes(16).toString("hex");

  const expiresClause = expires ? `'${escapeSql(expires)}'` : "NULL";

  const sql = `
    INSERT INTO gitmem_licenses (api_key, tier, owner_email, max_activations, expires_at, is_active)
    VALUES ('${escapeSql(key)}', '${tier}', '${escapeSql(email)}', ${maxDevices}, ${expiresClause}, true)
    RETURNING id, api_key, tier, owner_email, max_activations, expires_at, created_at;
  `;

  const rows = await runQuery(token, sql);

  if (rows.length > 0) {
    const row = rows[0];
    console.log("");
    console.log("License created:");
    console.log(`  Key:         ${key}`);
    console.log(`  Tier:        ${row.tier}`);
    console.log(`  Email:       ${row.owner_email}`);
    console.log(`  Max Devices: ${row.max_activations}`);
    console.log(`  Expires:     ${row.expires_at || "never"}`);
    console.log(`  Created:     ${row.created_at}`);
    console.log("");
    console.log("Share this key with the user:");
    console.log(`  ${key}`);
  }
}

async function cmdList(token) {
  const sql = `
    SELECT
      l.id,
      substring(l.api_key, 1, 20) as key_prefix,
      l.tier,
      l.owner_email,
      l.max_activations,
      l.is_active,
      l.expires_at,
      l.created_at,
      COUNT(a.id) as active_devices
    FROM gitmem_licenses l
    LEFT JOIN gitmem_license_activations a ON a.license_id = l.id
    GROUP BY l.id, l.api_key, l.tier, l.owner_email, l.max_activations, l.is_active, l.expires_at, l.created_at
    ORDER BY l.created_at DESC;
  `;

  const rows = await runQuery(token, sql);

  if (rows.length === 0) {
    console.log("No licenses found.");
    return;
  }

  console.log("");
  console.log(`${"Key Prefix".padEnd(22)} ${"Tier".padEnd(5)} ${"Email".padEnd(30)} ${"Devices".padEnd(9)} ${"Active".padEnd(7)} ${"Expires".padEnd(12)} Created`);
  console.log("─".repeat(120));

  for (const row of rows) {
    const prefix = String(row.key_prefix || "").padEnd(22);
    const tier = String(row.tier || "").padEnd(5);
    const email = String(row.owner_email || "").padEnd(30);
    const devices = `${row.active_devices}/${row.max_activations}`.padEnd(9);
    const active = (row.is_active ? "yes" : "NO").padEnd(7);
    const expires = (row.expires_at ? String(row.expires_at).slice(0, 10) : "never").padEnd(12);
    const created = String(row.created_at || "").slice(0, 10);
    console.log(`${prefix} ${tier} ${email} ${devices} ${active} ${expires} ${created}`);
  }

  console.log("");
  console.log(`${rows.length} license(s)`);
}

async function cmdRevoke(token, args) {
  const prefix = args[0];
  if (!prefix) {
    console.error("Error: key prefix required.");
    console.error("  Usage: node scripts/gitmem-admin.mjs revoke <key-prefix>");
    process.exit(1);
  }

  const sql = `
    UPDATE gitmem_licenses
    SET is_active = false
    WHERE api_key LIKE '${escapeSql(prefix)}%'
    RETURNING id, substring(api_key, 1, 20) as key_prefix, owner_email;
  `;

  const rows = await runQuery(token, sql);

  if (rows.length === 0) {
    console.error(`No license found matching prefix: ${prefix}`);
    process.exit(1);
  }

  for (const row of rows) {
    console.log(`Revoked: ${row.key_prefix}... (${row.owner_email})`);
  }
}

async function cmdDevices(token, args) {
  const prefix = args[0];
  if (!prefix) {
    console.error("Error: key prefix required.");
    console.error("  Usage: node scripts/gitmem-admin.mjs devices <key-prefix>");
    process.exit(1);
  }

  const sql = `
    SELECT
      a.install_id,
      a.activated_at,
      a.last_seen_at
    FROM gitmem_license_activations a
    JOIN gitmem_licenses l ON l.id = a.license_id
    WHERE l.api_key LIKE '${escapeSql(prefix)}%'
    ORDER BY a.last_seen_at DESC;
  `;

  const rows = await runQuery(token, sql);

  if (rows.length === 0) {
    console.log(`No device activations for prefix: ${prefix}`);
    return;
  }

  console.log("");
  console.log(`${"Install ID".padEnd(38)} ${"Activated".padEnd(22)} Last Seen`);
  console.log("─".repeat(90));

  for (const row of rows) {
    const installId = String(row.install_id || "").padEnd(38);
    const activated = String(row.activated_at || "").slice(0, 19).padEnd(22);
    const lastSeen = String(row.last_seen_at || "").slice(0, 19);
    console.log(`${installId} ${activated} ${lastSeen}`);
  }

  console.log("");
  console.log(`${rows.length} device(s)`);
}

async function cmdClearDevices(token, args) {
  const prefix = args[0];
  if (!prefix) {
    console.error("Error: key prefix required.");
    console.error("  Usage: node scripts/gitmem-admin.mjs clear-devices <key-prefix>");
    process.exit(1);
  }

  const sql = `
    DELETE FROM gitmem_license_activations
    WHERE license_id IN (
      SELECT id FROM gitmem_licenses WHERE api_key LIKE '${escapeSql(prefix)}%'
    )
    RETURNING id;
  `;

  const rows = await runQuery(token, sql);
  console.log(`Cleared ${rows.length} device activation(s) for prefix: ${prefix}`);
}

// ─── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0];
const subArgs = args.slice(1);

if (!subcommand || subcommand === "help" || subcommand === "--help") {
  console.log(`
GitMem Admin — License Key Management (internal)

Usage:
  node scripts/gitmem-admin.mjs create --email user@co.com [--tier pro] [--max-devices 3] [--expires YYYY-MM-DD]
  node scripts/gitmem-admin.mjs list
  node scripts/gitmem-admin.mjs revoke <key-prefix>
  node scripts/gitmem-admin.mjs devices <key-prefix>
  node scripts/gitmem-admin.mjs clear-devices <key-prefix>

Requires SUPABASE_ACCESS_TOKEN (from \`npx supabase login\`).
Operates on infra project: ${INFRA_PROJECT_REF}
`);
  process.exit(0);
}

const token = getAccessToken();

switch (subcommand) {
  case "create":
    await cmdCreate(token, subArgs);
    break;
  case "list":
    await cmdList(token);
    break;
  case "revoke":
    await cmdRevoke(token, subArgs);
    break;
  case "devices":
    await cmdDevices(token, subArgs);
    break;
  case "clear-devices":
    await cmdClearDevices(token, subArgs);
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("  Run: node scripts/gitmem-admin.mjs help");
    process.exit(1);
}
