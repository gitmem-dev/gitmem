/**
 * GIT-143: which session a recalled scar belongs to.
 *
 * One gitmem server process can serve several chats at once. The Claude
 * desktop app starts one server for all of its chats, and a Code-tab session
 * can end up on it too. The process has a single "current session" (the last
 * one session_start set), so every chat's recall() lands in that session's
 * list. confirm_scars then demanded all of them from whichever chat called it:
 * a gitmem chat was blocked on Weekend Warrior scars, and could clear another
 * chat's gate by answering for it.
 *
 * The full fix is a session model with more than one open session per process
 * (GIT-103). Until then each surfaced scar and each confirmation carries the id
 * of the session it was recorded under, and a caller that names its session is
 * held only to its own scars.
 *
 * Pure helpers only. No I/O, so they are safe to use from anywhere.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_REGEX = /^[0-9a-f]{8}$/i;

export function isSessionIdShape(id: string): boolean {
  return UUID_REGEX.test(id) || SHORT_ID_REGEX.test(id);
}

/** Same session: equal ignoring case, or one is the other's 8-char short id. */
export function sameSessionId(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (SHORT_ID_REGEX.test(x) && y.startsWith(x)) || (SHORT_ID_REGEX.test(y) && x.startsWith(y));
}

export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The session a recorded entry belongs to. Entries written before GIT-143
 * carry no stamp; they belong to the session whose list holds them.
 */
export function ownerOf(entry: { session_id?: string }, holderSessionId: string): string {
  return entry.session_id || holderSessionId;
}

export type CallerSessionId =
  | { ok: true; id?: string }
  | { ok: false; error: string };

/**
 * The session id a caller passed, from `session_id` or its alias
 * `gitmem_session_id` (the Claude remote-devices bridge strips a parameter
 * named `session_id`, GIT-122). Both given and different is an error, as is a
 * value that is not a session id. A short id that matches the current session
 * is expanded to its full id, so stamps compare cleanly.
 */
export function resolveCallerSessionId(
  params: { session_id?: unknown; gitmem_session_id?: unknown },
  currentSessionId?: string,
): CallerSessionId {
  const given: string[] = [];
  for (const [name, value] of [["session_id", params.session_id], ["gitmem_session_id", params.gitmem_session_id]] as const) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !isSessionIdShape(value)) {
      return { ok: false, error: `${name} must be a UUID or 8-char hex short id.` };
    }
    given.push(value);
  }
  if (given.length === 0) return { ok: true };
  if (given.length === 2 && !sameSessionId(given[0], given[1])) {
    return {
      ok: false,
      error: `session_id ${given[0]} and gitmem_session_id ${given[1]} name different sessions. Pass one of them, or the same id in both.`,
    };
  }
  const id = given.find((g) => UUID_REGEX.test(g)) ?? given[0];
  if (currentSessionId && sameSessionId(id, currentSessionId)) return { ok: true, id: currentSessionId };
  return { ok: true, id };
}
