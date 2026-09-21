/**
 * Store capability probe — which optional columns and tables does THIS store have?
 *
 * Customers provision their store from schema/setup.sql and often upgrade the
 * package without re-running it. nTEG's own store carries extra columns and
 * tables setup.sql does not define. The tier cannot tell the two apart (nTEG
 * validates as "pro" like any customer), so writes of anything outside the
 * baseline schema ask the store instead.
 *
 * Rule this enforces: never write a column or table the store lacks. A single
 * unknown key fails a whole PostgREST write — which is how a session close was
 * lost on every customer store that recorded observations or found a Claude
 * Code transcript.
 *
 * The probe is a read-only one-row SELECT of just the named columns. Answers
 * are cached for the life of the process. A probe that fails for any reason
 * other than "column/table does not exist" is not cached and is treated as
 * "absent" for that call — skipping an optional field is safe; sending one the
 * store may not have is not.
 */

import { directQuery } from "./supabase-client.js";

const known = new Map<string, boolean>(); // "table.column" -> present?

/** PostgREST / Postgres errors meaning "that column or table does not exist". */
function isMissingObjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(42703|42P01|PGRST204|PGRST205)\b|does not exist|Could not find the/.test(message);
}

async function probe(table: string, columns: string[]): Promise<"present" | "missing" | "unknown"> {
  try {
    await directQuery(table, { select: columns.join(","), limit: 1 });
    return "present";
  } catch (error) {
    return isMissingObjectError(error) ? "missing" : "unknown";
  }
}

/**
 * Return the subset of `candidates` that exist as columns of `table` in this store.
 */
export async function supportedColumns(table: string, candidates: string[]): Promise<Set<string>> {
  const unique = [...new Set(candidates)];
  const unresolved = unique.filter((c) => !known.has(`${table}.${c}`));

  if (unresolved.length > 0) {
    const all = await probe(table, unresolved);
    if (all === "present") {
      for (const c of unresolved) known.set(`${table}.${c}`, true);
    } else if (all === "missing") {
      // At least one is absent — find out which, one column at a time.
      for (const c of unresolved) {
        const one = unresolved.length === 1 ? all : await probe(table, [c]);
        if (one !== "unknown") known.set(`${table}.${c}`, one === "present");
      }
    }
    // "unknown": leave uncached; treated as absent below.
  }

  return new Set(unique.filter((c) => known.get(`${table}.${c}`) === true));
}

/** Whether `table` exists in this store. */
export async function storeHasTable(table: string): Promise<boolean> {
  return (await supportedColumns(table, ["id"])).has("id");
}

/** Forget cached answers (tests; or after a schema change within one process). */
export function resetStoreColumnCache(): void {
  known.clear();
}
