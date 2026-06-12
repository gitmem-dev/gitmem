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
  | "skipped";              // unexpected internal error — stayed silent, did not block startup

export interface WritePathResult {
  ok: boolean;
  mode: WritePathMode;
  missing?: string[];
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

    for (const base of ["learnings", "decisions"]) {
      const table = getTableName(base);
      try {
        await directQuery(table, { select: "id", limit: 1 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (SCHEMA_MISS.test(msg)) missing.push(table);
        // Transient network/auth errors are out of scope for this check.
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
