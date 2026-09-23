/**
 * GIT-120: merge gitmem's hooks into a settings file without touching anyone
 * else's.
 *
 * install-hooks used to replace `settings.hooks` wholesale and uninstall-hooks
 * deleted the key, so every hook the user or another tool had configured was
 * lost. These helpers work per event and per command: only commands gitmem
 * wrote are replaced or removed, and the file is backed up before any write.
 *
 * Two shapes are supported:
 *   Claude Code  hooks[event] = [{ matcher?, hooks: [{ type, command, ... }] }]
 *   Cursor       hooks[event] = [{ command, ... }]
 */

import { copyFileSync, existsSync } from "fs";

/**
 * A command gitmem installed: the per-repo copy (.gitmem/hooks/), the older
 * node_modules path, or the legacy plugin. A bare "gitmem" substring is not
 * enough — a user's own script can live in a directory called gitmem.
 */
export function isGitmemCommand(command) {
  if (typeof command !== "string") return false;
  return /(^|[\s"'=/])\.gitmem\/hooks\/[\w.-]+\.sh\b/.test(command)
    || /gitmem-mcp\/hooks\/scripts\/[\w.-]+\.sh\b/.test(command)
    || /\bgitmem-hooks\b/.test(command);
}

const isGroup = (entry) => entry && typeof entry === "object" && Array.isArray(entry.hooks);

/** Commands in one event's entries, as [gitmem, other] counts. */
function countEntries(entries) {
  let gitmem = 0;
  let other = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const commands = isGroup(entry) ? entry.hooks : [entry];
    for (const h of commands) {
      if (isGitmemCommand(h?.command)) gitmem++; else other++;
    }
  }
  return { gitmem, other };
}

/**
 * One event's entries with gitmem's commands taken out. A Claude group keeps
 * its other commands; a group left empty is dropped.
 */
function withoutGitmem(entries) {
  const kept = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isGroup(entry)) {
      const others = entry.hooks.filter((h) => !isGitmemCommand(h?.command));
      if (others.length === entry.hooks.length) kept.push(entry);
      else if (others.length > 0) kept.push({ ...entry, hooks: others });
    } else if (!isGitmemCommand(entry?.command)) {
      kept.push(entry);
    }
  }
  return kept;
}

/** The hooks object must be a plain object of arrays, or absent. */
export function hooksShapeError(hooks) {
  if (hooks === undefined) return null;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "hooks is not an object";
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) return `hooks.${event} is not an array`;
  }
  return null;
}

/** True when any command in the hooks is one gitmem installed. */
export function hasGitmemHooks(hooks) {
  return Object.values(hooks || {}).some((entries) => countEntries(entries).gitmem > 0);
}

/**
 * Merge gitmem's hooks in: per event, drop the gitmem commands already there,
 * keep everything else, append gitmem's current entries.
 * Returns the new hooks and one change line per event touched.
 */
export function mergeGitmemHooks(existing, gitmemHooks) {
  const hooks = { ...(existing || {}) };
  const changes = [];
  for (const [event, entries] of Object.entries(gitmemHooks)) {
    const before = countEntries(hooks[event]);
    const added = countEntries(entries).gitmem;
    hooks[event] = [...withoutGitmem(hooks[event]), ...entries];
    changes.push(`${event}: ${before.gitmem ? `replaced ${before.gitmem} gitmem hook(s) with ${added}` : `added ${added} gitmem hook(s)`}${before.other ? `, kept ${before.other} other` : ""}`);
  }
  // Events this installer does not manage are left exactly as they are. That
  // includes gitmem's own UserPromptSubmit hook, which `gitmem init` installs
  // and install-hooks does not.
  for (const [event, entries] of Object.entries(hooks)) {
    if (event in gitmemHooks) continue;
    const c = countEntries(entries);
    if (c.gitmem + c.other) changes.push(`${event}: kept ${c.gitmem + c.other} (untouched)`);
  }
  return { hooks, changes };
}

/**
 * Take gitmem's commands out of every event. Events left empty are dropped;
 * hooks is undefined when nothing remains.
 */
export function removeGitmemHooks(existing) {
  const hooks = {};
  const changes = [];
  let removed = 0;
  let kept = 0;
  for (const [event, entries] of Object.entries(existing || {})) {
    const c = countEntries(entries);
    removed += c.gitmem;
    kept += c.other;
    const rest = withoutGitmem(entries);
    if (rest.length) hooks[event] = rest;
    if (c.gitmem) changes.push(`${event}: removed ${c.gitmem} gitmem hook(s)${c.other ? `, kept ${c.other} other` : ""}`);
    else if (c.other) changes.push(`${event}: kept ${c.other} other (untouched)`);
  }
  return { hooks: Object.keys(hooks).length ? hooks : undefined, removed, kept, changes };
}

/** Copy a file aside before it is rewritten; returns the backup path or null. */
export function backupFile(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.gitmem-backup-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}
