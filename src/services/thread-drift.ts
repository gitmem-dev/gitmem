/**
 * Thread Drift Detection (GIT-69 item 2)
 *
 * cache-health reported `status: healthy` on scar parity alone while two
 * threads were demonstrably divergent between stores (feedback ad5ca35a).
 * "Healthy" asserted from one covered store is the same shape as a write
 * reporting success from an unread row: a claim of a completeness that was
 * never checked.
 *
 * This module supplies the thread half. It is a pure diff — no I/O — so the
 * comparison can be tested against fixtures without a database.
 *
 * ## Why there are three buckets and not two
 *
 * The two stores are not partitioned the same way. Remote `threads` rows carry
 * a `project`; the local `threads.json` cache does not — `ThreadObject` has no
 * project field, so one flat file holds every project's threads.
 *
 * A naive two-bucket diff (in-local / in-remote) for project A would therefore
 * report every local project-B thread as drift. That is false drift, and a
 * drift detector that cries wolf is worse than none: it trains its reader to
 * ignore it, which is how ad5ca35a's real divergence stayed invisible next to
 * a healthy banner.
 *
 * So local-only IDs are reported in their own bucket, explicitly unattributable
 * rather than folded into drift. The honest statement is "these exist locally
 * and I cannot tell whose they are", not "these are missing remotely".
 *
 * The durable fix is to give the local cache a project field so attribution is
 * possible; until then this module reports what is actually knowable.
 */

// --- Types ---

/** Minimal shape needed from either store. */
export interface DriftThread {
  id: string;
  status?: string;
}

export interface ThreadDrift {
  /** Present in both stores, states agree. */
  in_sync_count: number;
  /** Present in both stores, states disagree. Unambiguous drift. */
  divergent: DriftDivergence[];
  /** In the remote scope, absent locally. Unambiguous drift. */
  only_remote: string[];
  /**
   * Present locally, not in this project's remote scope. NOT counted as drift:
   * the local cache is not project-partitioned, so these may legitimately
   * belong to another project.
   */
  unattributable_local: string[];
  /** Divergent + only_remote. The count that can be asserted. */
  drift_count: number;
  /** True when nothing attributable diverges. */
  in_sync: boolean;
}

export interface DriftDivergence {
  id: string;
  local_status?: string;
  remote_status?: string;
}

// --- Core ---

/**
 * Diff local cache threads against the remote scope's threads.
 *
 * `remote` must already be scoped (project, status) by the caller via the
 * thread-scope resolver — this function does not decide what is in scope, only
 * whether the two views of that scope agree.
 */
export function diffThreads(
  local: readonly DriftThread[],
  remote: readonly DriftThread[]
): ThreadDrift {
  const remoteById = new Map<string, DriftThread>();
  for (const t of remote) {
    if (t.id) remoteById.set(t.id, t);
  }

  const localById = new Map<string, DriftThread>();
  for (const t of local) {
    if (t.id) localById.set(t.id, t);
  }

  const divergent: DriftDivergence[] = [];
  const unattributable_local: string[] = [];
  let in_sync_count = 0;

  for (const [id, localThread] of localById) {
    const remoteThread = remoteById.get(id);

    if (!remoteThread) {
      unattributable_local.push(id);
      continue;
    }

    // Both stores hold it — do they agree?
    if (
      localThread.status !== undefined &&
      remoteThread.status !== undefined &&
      localThread.status !== remoteThread.status
    ) {
      divergent.push({
        id,
        local_status: localThread.status,
        remote_status: remoteThread.status,
      });
    } else {
      in_sync_count++;
    }
  }

  const only_remote: string[] = [];
  for (const id of remoteById.keys()) {
    if (!localById.has(id)) only_remote.push(id);
  }

  // Deterministic output — a drift report that reorders between identical
  // runs cannot be diffed by a human or a test.
  divergent.sort((a, b) => a.id.localeCompare(b.id));
  only_remote.sort();
  unattributable_local.sort();

  const drift_count = divergent.length + only_remote.length;

  return {
    in_sync_count,
    divergent,
    only_remote,
    unattributable_local,
    drift_count,
    in_sync: drift_count === 0,
  };
}

/**
 * One-line summary for cache-health's details field.
 *
 * Always states the unattributable count when non-zero, even though it is not
 * drift — an omitted number reads as zero, and the reader cannot otherwise
 * tell "no local extras" from "local extras I declined to classify".
 */
export function describeThreadDrift(drift: ThreadDrift): string {
  if (drift.in_sync && drift.unattributable_local.length === 0) {
    return `threads in sync (${drift.in_sync_count})`;
  }

  const parts: string[] = [];
  if (drift.divergent.length > 0) {
    parts.push(`${drift.divergent.length} divergent`);
  }
  if (drift.only_remote.length > 0) {
    parts.push(`${drift.only_remote.length} missing locally`);
  }
  if (drift.unattributable_local.length > 0) {
    parts.push(
      `${drift.unattributable_local.length} local-only (project unattributable — local cache is not project-partitioned)`
    );
  }

  return `threads: ${parts.join(", ")} of ${drift.in_sync_count + drift.drift_count} compared`;
}
