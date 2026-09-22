/**
 * WriteResult — the one contract every write tool answers with (GIT-101).
 *
 * create_thread established it (GIT-63/GIT-67, R3/R4): say where the record
 * landed and whether it survives this machine, and only call it a success
 * when it reached the store of truth for this tier. Other write tools grew
 * their own shapes — resolve_thread returned success: true whether or not the
 * durable store accepted the write — so a caller could not tell a saved
 * record from a lost one without reading prose.
 *
 *   durable    the record is in Supabase (pro/dev). Never true on free.
 *   stored_in  "supabase" | "local" (free: the local store IS the truth) |
 *              "local_only" (pro: kept on this machine only, the durable
 *              write failed) | null (stored nowhere).
 *   success    durable || !hasSupabase() — and false whenever nothing was
 *              stored at all.
 */

import { hasSupabase } from "./tier.js";
import type { WriteResult, StoredIn } from "../types/index.js";

export type { WriteResult, StoredIn };

/**
 * The outcome of a write.
 *
 * @param durable        the durable store (Supabase) accepted the write
 * @param storedLocally  a local copy exists (threads.json, the free-tier
 *                       store, session state). Default: true on free, where
 *                       reaching this call means the local write succeeded;
 *                       false on pro, where a failed durable write keeps
 *                       nothing unless the tool says it did.
 */
export function writeResult(durable: boolean, storedLocally: boolean = !hasSupabase()): WriteResult {
  if (durable && hasSupabase()) return { success: true, durable: true, stored_in: "supabase" };
  if (!hasSupabase()) {
    return storedLocally
      ? { success: true, durable: false, stored_in: "local" }
      : notStored();
  }
  return { success: false, durable: false, stored_in: storedLocally ? "local_only" : null };
}

/** Nothing was stored anywhere. */
export function notStored(): WriteResult {
  return { success: false, durable: false, stored_in: null };
}
