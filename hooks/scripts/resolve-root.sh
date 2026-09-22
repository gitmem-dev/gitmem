#!/bin/bash
# ============================================================================
# gitmem-hooks — resolve the .gitmem root the way the MCP server does (GIT-99)
#
# Sourced, not executed:  . "$(dirname "$0")/resolve-root.sh"
#
# The hooks used to read ".gitmem/..." relative to their cwd. Since GIT-91 the
# server resolves its root independently of cwd, so a hook running in a repo
# read a different store from the one the server writes: it saw no session, or
# someone else's, and pointed the agent at a closing-payload.json the server
# would never read.
#
# Precedence mirrors src/services/gitmem-dir.ts:
#   1. $GITMEM_DIR               — names the .gitmem directory itself
#   2. $GITMEM_HOME/.gitmem      — relocates the home the fallback uses
#   3. $HOME/.gitmem
#
# Sets (all absolute):
#   GITMEM_ROOT               the resolved .gitmem directory
#   GITMEM_ACTIVE_SESSIONS    $GITMEM_ROOT/active-sessions.json
#   GITMEM_PAYLOAD_PATH       $GITMEM_ROOT/closing-payload.json
# Provides:
#   gitmem_live_session_ids   registry session ids, newest first, skipping
#                             entries on this host whose pid is dead
#   gitmem_json_escape        escape a string for a JSON string literal
# ============================================================================

if [ -n "${GITMEM_DIR:-}" ]; then
    _gitmem_root="$GITMEM_DIR"
elif [ -n "${GITMEM_HOME:-}" ]; then
    _gitmem_root="$GITMEM_HOME/.gitmem"
else
    _gitmem_root="$HOME/.gitmem"
fi
# Absolute, without requiring the directory to exist yet.
case "$_gitmem_root" in
    /*) ;;
    *) _gitmem_root="$PWD/$_gitmem_root" ;;
esac
GITMEM_ROOT="${_gitmem_root%/}"
unset _gitmem_root
GITMEM_ACTIVE_SESSIONS="$GITMEM_ROOT/active-sessions.json"
GITMEM_PAYLOAD_PATH="$GITMEM_ROOT/closing-payload.json"

# A registry entry whose server died is not a session anyone can be in. Only
# entries on THIS host can be checked; entries without a pid, or from another
# host, are kept. `ps -p` rather than `kill -0`: kill fails with EPERM for a
# live process of another user, which is still alive.
gitmem_live_session_ids() {
    [ -f "$GITMEM_ACTIVE_SESSIONS" ] || return 0
    local host rows
    host=$(hostname 2>/dev/null || echo "")
    if command -v jq &>/dev/null; then
        rows=$(jq -r '(.sessions // []) | sort_by(.started_at // "") | reverse | .[]
            | [(.session_id // ""), ((.pid // "") | tostring), (.hostname // "")] | join("|")' \
            "$GITMEM_ACTIVE_SESSIONS" 2>/dev/null) || return 0
    elif command -v node &>/dev/null; then
        rows=$(GITMEM_REG="$GITMEM_ACTIVE_SESSIONS" node -e '
            try {
              const r = JSON.parse(require("fs").readFileSync(process.env.GITMEM_REG, "utf8"));
              const s = (r.sessions || []).slice().sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
              process.stdout.write(s.map((e) => [e.session_id || "", e.pid ?? "", e.hostname || ""].join("|")).join("\n"));
            } catch (e) {}' 2>/dev/null) || return 0
    else
        return 0
    fi
    local sid pid h
    # "|" rather than a tab: read collapses runs of whitespace separators, so an
    # empty pid would shift the hostname into its place.
    while IFS='|' read -r sid pid h; do
        [ -n "$sid" ] || continue
        if [ -n "$pid" ] && [ "$h" = "$host" ] && ! ps -p "$pid" >/dev/null 2>&1; then
            continue
        fi
        echo "$sid"
    done <<< "$rows"
}

gitmem_json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
