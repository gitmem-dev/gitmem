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
#   gitmem_own_session_ids    the live sessions of the client running this hook
#                             (GIT-128), newest first
#   gitmem_hook_client_pid    that client's pid
#   gitmem_pid_alive          whether a pid is running (no `ps` needed)
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

# Is this pid a running process? `kill -0` (a builtin) answers for our own
# processes. When it fails the process is either gone or another user's (EPERM):
# /proc tells them apart on Linux, `ps` (always present on macOS) elsewhere.
# GIT-116: this used to match kill's English error text, which a non-English
# locale changes.
gitmem_pid_alive() {
    kill -0 "$1" 2>/dev/null && return 0
    if [ -d /proc/self ]; then
        [ -d "/proc/$1" ] && return 0 || return 1
    fi
    if command -v ps >/dev/null 2>&1; then
        ps -p "$1" >/dev/null 2>&1 && return 0 || return 1
    fi
    local out
    out=$(LC_ALL=C kill -0 "$1" 2>&1)
    case "$out" in *ermitted*) return 0 ;; esac
    return 1
}

# Live registry rows as "session_id|client_pid", newest first. A registry
# entry whose server died is not a session anyone can be in. Only entries on
# THIS host can be checked; entries without a pid, or from another host, are
# kept.
_gitmem_live_rows() {
    [ -f "$GITMEM_ACTIVE_SESSIONS" ] || return 0
    local host rows
    # bash's own HOSTNAME is gethostname(), what the server's os.hostname() is.
    host="${HOSTNAME:-$(hostname 2>/dev/null || echo "")}"
    if command -v jq &>/dev/null; then
        rows=$(jq -r '(.sessions // []) | sort_by(.started_at // "") | reverse | .[]
            | [(.session_id // ""), ((.pid // "") | tostring), (.hostname // ""), ((.client_pid // "") | tostring)] | join("|")' \
            "$GITMEM_ACTIVE_SESSIONS" 2>/dev/null) || return 0
    elif command -v node &>/dev/null; then
        rows=$(GITMEM_REG="$GITMEM_ACTIVE_SESSIONS" node -e '
            try {
              const r = JSON.parse(require("fs").readFileSync(process.env.GITMEM_REG, "utf8"));
              const s = (r.sessions || []).slice().sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
              process.stdout.write(s.map((e) => [e.session_id || "", e.pid ?? "", e.hostname || "", e.client_pid ?? ""].join("|")).join("\n"));
            } catch (e) {}' 2>/dev/null) || return 0
    else
        return 0
    fi
    local sid pid h cpid
    # "|" rather than a tab: read collapses runs of whitespace separators, so an
    # empty pid would shift the hostname into its place.
    while IFS='|' read -r sid pid h cpid; do
        [ -n "$sid" ] || continue
        if [ -n "$pid" ] && [ "$h" = "$host" ] && ! gitmem_pid_alive "$pid"; then
            continue
        fi
        echo "$sid|$cpid"
    done <<< "$rows"
}

gitmem_live_session_ids() {
    _gitmem_live_rows | cut -d'|' -f1
}

# GIT-128: the client this hook runs for — its nearest ancestor that is not a
# shell. Claude Code (or any client) runs hooks through a shell; the server's
# registry entry records the same client as client_pid. GITMEM_CLIENT_PID
# overrides detection, as it does for the server.
gitmem_hook_client_pid() {
    if [ -n "${GITMEM_CLIENT_PID:-}" ]; then
        echo "$GITMEM_CLIENT_PID"
        return 0
    fi
    local pid="$PPID" line stat ppid cmd name depth=0
    while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 12 ]; do
        if [ -r "/proc/$pid/stat" ]; then
            # Linux, ps not required: ppid is the 2nd field after the "(comm)".
            stat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 0
            stat="${stat##*) }"
            read -r _ ppid _ <<< "$stat"
            cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
        elif command -v ps >/dev/null 2>&1; then
            line=$(ps -o ppid=,command= -p "$pid" 2>/dev/null) || return 0
            [ -n "$line" ] || return 0
            read -r ppid cmd <<< "$line"
        else
            return 0
        fi
        name="${cmd%% *}"
        name="${name##*/}"
        name="${name#-}"
        case "$name" in
            sh|bash|zsh|dash|ksh|fish|env) ;;
            *) echo "$pid"; return 0 ;;
        esac
        pid="$ppid"
        depth=$((depth + 1))
    done
}

# GIT-128: the live sessions this hook's client owns. The newest live session
# used to stand in for "mine", so a second client's session — or its
# confirmations — decided this client's gate. Entries written by servers older
# than GIT-128 carry no client_pid; they are used only when no entry names this
# client, which keeps single-client setups working across the upgrade.
gitmem_own_session_ids() {
    local me rows sid cpid owned="" legacy=""
    me=$(gitmem_hook_client_pid)
    rows=$(_gitmem_live_rows)
    while IFS='|' read -r sid cpid; do
        [ -n "$sid" ] || continue
        if [ -z "$cpid" ]; then
            legacy="$legacy$sid"$'\n'
        elif [ -n "$me" ] && [ "$cpid" = "$me" ]; then
            owned="$owned$sid"$'\n'
        fi
    done <<< "$rows"
    if [ -n "$owned" ]; then
        printf '%s' "$owned"
    else
        printf '%s' "$legacy"
    fi
}

gitmem_json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
