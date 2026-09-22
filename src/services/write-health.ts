/**
 * Write-path health check.
 *
 * Verifies that (a) the resolved storage tier matches the presence of Supabase
 * credentials and (b) the tables the WRITE path resolves to actually exist on
 * the configured backend. Surfaces two silent-failure classes loudly at
 * startup instead of on the first failed write:
 *
 *   1. free_with_credentials — Supabase creds are present but the tier resolved
 *      to FREE (e.g. an invalid/expired/placeholder GITMEM_API_KEY). Writes go
 *      to local .gitmem/ files instead of Supabase, while reads (recall,
 *      cache-health) can still reach Supabase and mask the problem.
 *   2. missing_tables — pro/dev tier, but the prefixed tables don't exist (e.g.
 *      a GITMEM_TABLE_PREFIX mismatch, or the schema was never applied).
 *      create_learning / create_decision 404 (PGRST205) on the first write.
 *
 * Fire-and-forget: never throws (whole body is guarded), never blocks startup.
 * Logs a loud warning to stderr when misconfigured, a one-line confirmation
 * otherwise.
 *
 * GIT-102: the probe had no timeout. A store that accepts the connection and
 * never answers left it pending forever — no warning, no confirmation, and
 * nothing anywhere saying durability had not been checked. The server now runs
 * it through checkWritePathWithTimeout(): raced against 10 s, with a
 * "timed_out" verdict that says so, and the last verdict kept for `health`.
 */

import { getTier, hasSupabase, getTablePrefix, getTableName } from "./tier.js";
import { isConfigured, directQuery } from "./supabase-client.js";

/** Error messages that indicate a resolved table is absent on the backend. */
const SCHEMA_MISS = /PGRST205|schema cache|does not exist|Could not find the table/i;

export type WritePathMode =
  | "local"                 // free tier, no Supabase creds — local writes are intentional
  | "free_with_credentials" // creds present but tier free — writes silently local (bug)
  | "missing_tables"        // pro/dev but resolved tables absent (bug)
  | "supabase"              // healthy: pro/dev with tables present
  | "skipped"               // unexpected internal error — stayed silent, did not block startup
  | "timed_out"             // GIT-102: no answer within the budget — durability UNVERIFIED
  | "unreachable";          // GIT-102: probes errored (network/auth) — durability UNVERIFIED

export interface WritePathResult {
  ok: boolean;
  mode: WritePathMode;
  missing?: string[];
  /** unreachable: the probe error, as the store reported it. */
  error?: string;
}

/** The most recent write-path verdict, for `health` (GIT-102). */
export interface WritePathVerdict extends WritePathResult {
  /** One line a person can act on. */
  summary: string;
  checked_at: string;
  duration_ms: number;
  /** A check that finished after its timeout had already been reported. */
  late?: boolean;
}

export const WRITE_PATH_TIMEOUT_MS = 10_000;

let lastVerdict: WritePathVerdict | null = null;

/** The last write-path verdict, or null when no check has finished or timed out yet. */
export function getLastWritePathVerdict(): WritePathVerdict | null {
  return lastVerdict;
}

/** For tests. */
export function resetWritePathVerdict(): void {
  lastVerdict = null;
}

/** The `health` line for a verdict (GIT-102). */
export function formatWritePathLine(v: WritePathVerdict | null): string {
  if (!v) return "Write path: not checked yet (the startup check has not finished or timed out)";
  return `Write path: ${v.summary} (${v.ok ? "ok" : "NOT OK"}, checked ${v.checked_at}, ${v.duration_ms} ms` +
    `${v.late ? ", finished after its timeout" : ""})`;
}

function summarize(r: WritePathResult, timeoutMs: number): string {
  switch (r.mode) {
    case "supabase": return "Supabase — learnings/decisions tables present, writes are durable";
    case "local": return "local files (free tier, no Supabase configured) — intended";
    case "free_with_credentials": return "Supabase is configured but the tier resolved to FREE — writes are going to local files, NOT Supabase";
    case "missing_tables": return `tables missing on the Supabase backend (${(r.missing || []).join(", ")}) — create_learning / create_decision will fail`;
    case "skipped": return "check skipped after an internal error — durability UNVERIFIED";
    case "timed_out": return `timed out after ${Math.round(timeoutMs / 1000)} s, durability UNVERIFIED`;
    case "unreachable": return `store unreachable (${r.error ?? "probe failed"}), durability UNVERIFIED`;
  }
}

/**
 * Run checkWritePath() against a deadline and record the verdict.
 *
 * Resolves by the deadline at the latest. If the check finishes afterwards,
 * its real verdict replaces "timed_out" (marked late) — the store answered
 * slowly, and the latest word on it is the one health should show.
 */
export async function checkWritePathWithTimeout(
  timeoutMs: number = WRITE_PATH_TIMEOUT_MS,
  check: () => Promise<WritePathResult> = checkWritePath
): Promise<WritePathVerdict> {
  const started = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const record = (r: WritePathResult, late = false): WritePathVerdict => {
    lastVerdict = {
      ...r,
      summary: summarize(r, timeoutMs),
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      ...(late && { late: true }),
    };
    return lastVerdict;
  };

  const checked = check().then((r) => {
    if (timedOut) {
      const v = record(r, true);
      console.error(`[gitmem] Write-path check finished late (${v.duration_ms} ms): ${v.summary}`);
      return v;
    }
    return record(r);
  });

  const deadline = new Promise<WritePathVerdict>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      const v = record({ ok: false, mode: "timed_out" });
      console.error(
        `\n\u26a0\ufe0f  [gitmem] WRITE PATH: ${v.summary}.\n` +
        "   The Supabase store did not answer the write-path probe. Writes may or may not be landing;\n" +
        "   check connectivity to SUPABASE_URL. `health` shows the latest verdict.\n"
      );
      resolve(v);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([checked, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkWritePath(): Promise<WritePathResult> {
  try {
    // No Supabase credentials → legitimate free tier; local writes are intended.
    if (!isConfigured()) {
      return { ok: true, mode: "local" };
    }

    // Credentials present but tier resolved to free. With SUPABASE_URL set, the
    // only path to free tier is a missing/invalid license — so create_learning /
    // create_decision are writing to local files instead of Supabase.
    if (!hasSupabase()) {
      console.error(
        "\n\u26a0\ufe0f  [gitmem] WRITE PATH: Supabase is configured but the tier resolved to FREE.\n" +
        "   create_learning / create_decision are writing to local .gitmem/ files, NOT Supabase.\n" +
        "   Likely cause: a missing or invalid GITMEM_API_KEY \u2014 it must be a real gitmem_pro_... key,\n" +
        "   present in the SAME environment as this server. Check the startup 'Tier:' line and the\n" +
        "   device limit (3). Reads (recall, cache-health) can still reach Supabase, masking this.\n"
      );
      return { ok: false, mode: "free_with_credentials" };
    }

    // Pro/dev: probe the tables the write path actually resolves to. learnings
    // and decisions hard-fail on a prefix/schema mismatch (threads fall back to
    // local), so probing those two is sufficient and avoids column assumptions.
    const prefix = getTablePrefix();
    const prefixSource = process.env.GITMEM_TABLE_PREFIX ? "GITMEM_TABLE_PREFIX" : "default";
    const missing: string[] = [];
    const probeErrors: string[] = [];

    for (const base of ["learnings", "decisions"]) {
      const table = getTableName(base);
      try {
        await directQuery(table, { select: "id", limit: 1 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (SCHEMA_MISS.test(msg)) missing.push(table);
        // GIT-102: a network/auth error used to be ignored here, so a store
        // that refused every connection was reported as "Write-path OK".
        else probeErrors.push(`${table}: ${msg}`);
      }
    }

    if (missing.length > 0) {
      console.error(
        "\n\u26a0\ufe0f  [gitmem] WRITE PATH: these resolved tables do not exist on the Supabase backend:\n" +
        `      ${missing.join(", ")}\n` +
        `   Resolved table prefix: "${prefix}" (from ${prefixSource}).\n` +
        "   create_learning / create_decision WILL FAIL until this is fixed:\n" +
        "     - Pointing at an existing schema (e.g. orchestra_)? Set GITMEM_TABLE_PREFIX to match.\n" +
        "     - Fresh project? Run `npx gitmem-mcp setup` (or set DATABASE_URL and re-activate) to create tables.\n"
      );
      return { ok: false, mode: "missing_tables", missing };
    }

    if (probeErrors.length > 0) {
      const error = probeErrors.join("; ").slice(0, 300);
      console.error(
        "\n\u26a0\ufe0f  [gitmem] WRITE PATH: the Supabase store could not be probed — durability UNVERIFIED.\n" +
        `      ${error}\n`
      );
      return { ok: false, mode: "unreachable", error };
    }

    console.error(
      `[gitmem] Write-path OK (tier ${getTier()}, prefix "${prefix}", learnings/decisions present).`
    );
    return { ok: true, mode: "supabase" };
  } catch (err) {
    // The health check must never break startup. On any unexpected error, stay
    // silent (don't false-alarm) rather than throw from a floated promise.
    console.error(
      `[gitmem] Write-path check skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: true, mode: "skipped" };
  }
}
