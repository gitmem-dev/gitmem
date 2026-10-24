#!/bin/bash
# GitMem Hooks Plugin — PreToolUse Hook (Recall Check + Confirmation Gate)
#
# Two enforcement mechanisms with different trigger scopes:
#
# 1. CONFIRMATION GATE (hard block, consequential actions only):
#    If recall() surfaced a scar this client's session has not confirmed → BLOCK.
#    Uses JSON "decision: block" pattern (same as session-close-check.sh).
#    Only blocks on recall-source scars; session_start scars don't require confirmation.
#    Consequential = git push, npm publish, deploy, .sql, .env files.
#
# 2. RECALL NAG (soft reminder, ALL Bash/Write/Edit actions):
#    If recall hasn't been called AND agent has made 10+ tool calls → nudge.
#    Never blocks — just injects additionalContext.
#    Cooldown: no more than once per 90 seconds.
#    NOTE: hooks.json matchers already limit this to Bash/Write/Edit.
#
# UX audit finding: 12 sessions >30min with zero recalls because the nag was
# gated behind the consequential filter — agents writing .ts files, running
# tests, etc. were never nudged. Now the nag fires for all code changes.
#
# Input: JSON via stdin with tool_name and tool_input
# Output: JSON with decision:block OR additionalContext OR empty (exit 0)

set -e

# Read hook input from stdin
HOOK_INPUT=$(cat -)

# ============================================================================
# Resolve active session from registry
# ============================================================================

# GIT-99: resolve .gitmem the way the server does, not from cwd.
. "$(dirname "${BASH_SOURCE[0]}")/resolve-root.sh"
if [ ! -f "$GITMEM_ACTIVE_SESSIONS" ]; then
    exit 0
fi

# GIT-128: the sessions of the client running this hook, not the newest live
# session on the machine — that could be another agent's, and its
# confirmations then opened this agent's gate. Entries whose server pid is
# dead are skipped (GIT-99). A client serving several projects can own more
# than one; the gate holds if any of them has an unconfirmed scar.
SESSION_FILES=""
while IFS= read -r SID; do
    [ -n "$SID" ] || continue
    F="$GITMEM_ROOT/sessions/${SID}/session.json"
    [ -f "$F" ] && SESSION_FILES="$SESSION_FILES$F"$'\n'
done <<< "$(gitmem_own_session_ids)"

if [ -z "$SESSION_FILES" ]; then
    exit 0
fi

# ============================================================================
# Extract tool info using jq (node fallback)
# ============================================================================

parse_json() {
    local INPUT="$1"
    local FIELD="$2"
    if command -v jq &>/dev/null; then
        echo "$INPUT" | jq -r "$FIELD // empty" 2>/dev/null
    else
        echo "$INPUT" | node -e "
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                try {
                    const j=JSON.parse(d);
                    const path='$FIELD'.replace(/^\./,'').split('.');
                    let v=j;
                    for(const p of path) v=v?.[p];
                    process.stdout.write(String(v||''));
                } catch(e) { process.stdout.write(''); }
            });
        " 2>/dev/null
    fi
}

TOOL_NAME=$(parse_json "$HOOK_INPUT" ".tool_name")

# ============================================================================
# Read session state (shared by both gate and nag)
# ============================================================================

# GIT-128: per scar, not per count. The gate used to open once the session
# held any confirmation at all, so a scar surfaced by a later recall — or one
# confirmed only by another agent — never held it shut. Now it holds while any
# recall-surfaced scar of this client's sessions has no confirmation.
#
# Prints "<recall scar count>\t<unconfirmed titles, comma separated>".
read_gate_state() {
    if command -v jq &>/dev/null; then
        local total=0 titles="" f n t
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            n=$(jq '[.surfaced_scars // [] | .[] | select(.source == "recall")] | length' "$f" 2>/dev/null || echo 0)
            t=$(jq -r '((.confirmations // []) | map(.scar_id)) as $c
                | [.surfaced_scars // [] | .[] | select(.source == "recall")
                   | select((.scar_id as $id | $c | index($id)) | not) | .scar_title] | join(", ")' "$f" 2>/dev/null || echo "")
            total=$((total + n))
            [ -n "$t" ] && titles="${titles:+$titles, }$t"
        done <<< "$SESSION_FILES"
        printf '%s\t%s' "$total" "$titles"
    else
        GITMEM_FILES="$SESSION_FILES" node -e '
            const fs = require("fs");
            let total = 0; const titles = [];
            for (const f of process.env.GITMEM_FILES.split("\n").filter(Boolean)) {
              try {
                const s = JSON.parse(fs.readFileSync(f, "utf8"));
                const recall = (s.surfaced_scars || []).filter((x) => x.source === "recall");
                const confirmed = new Set((s.confirmations || []).map((c) => c.scar_id));
                total += recall.length;
                for (const x of recall) if (!confirmed.has(x.scar_id)) titles.push(x.scar_title);
              } catch (e) {}
            }
            process.stdout.write(total + "\t" + titles.join(", "));' 2>/dev/null || printf '0\t'
    fi
}

GATE_STATE=$(read_gate_state)
RECALL_SCAR_COUNT="${GATE_STATE%%$'\t'*}"
UNCONFIRMED_TITLES="${GATE_STATE#*$'\t'}"
[ -n "$RECALL_SCAR_COUNT" ] || RECALL_SCAR_COUNT=0

# ============================================================================
# Session state tracking (for nag logic — runs for ALL matched tool calls)
# ============================================================================

SESSION_ID="${CLAUDE_SESSION_ID:-$$}"
STATE_DIR="/tmp/gitmem-hooks-${SESSION_ID}"
mkdir -p "$STATE_DIR"

# Increment tool call count (counts all Bash/Write/Edit, not just consequential)
TOOL_COUNT=0
if [ -f "$STATE_DIR/tool_call_count" ]; then
    TOOL_COUNT=$(cat "$STATE_DIR/tool_call_count")
fi
TOOL_COUNT=$((TOOL_COUNT + 1))
echo "$TOOL_COUNT" > "$STATE_DIR/tool_call_count"

# ============================================================================
# Filter layer: Is this a consequential action? (used for gate only)
# ============================================================================

IS_CONSEQUENTIAL=false

case "$TOOL_NAME" in
    Bash)
        # Extract the command being run
        COMMAND=$(parse_json "$HOOK_INPUT" ".tool_input.command")
        # Check for consequential bash commands
        if echo "$COMMAND" | grep -qE '(git\s+push|git\s+tag|npm\s+publish|npx\s+supabase\s+db\s+push|deploy|supabase\s+functions\s+deploy)'; then
            IS_CONSEQUENTIAL=true
        fi
        ;;
    Write|Edit)
        # Check for sensitive file types
        FILE_PATH=$(parse_json "$HOOK_INPUT" ".tool_input.file_path")
        if echo "$FILE_PATH" | grep -qE '\.(sql|env)$'; then
            IS_CONSEQUENTIAL=true
        fi
        ;;
esac

# ============================================================================
# CONFIRMATION GATE (hard block — consequential actions only)
# ============================================================================
# Block if recall() surfaced scars but confirm_scars() hasn't been called.
# Only blocks on recall-source scars; session_start scars don't require confirmation.

if [ "$IS_CONSEQUENTIAL" = "true" ] && [ -n "$UNCONFIRMED_TITLES" ]; then
    SCAR_TITLES=$(gitmem_json_escape "$UNCONFIRMED_TITLES")
    cat <<HOOKJSON
{
  "decision": "block",
  "reason": "SCAR CONFIRMATION REQUIRED: recall() surfaced scar(s) in this session that have not been confirmed. Call confirm_scars() (or gm-confirm) with APPLYING/N_A/REFUTED for each scar before proceeding.\n\nUnconfirmed scars: ${SCAR_TITLES}\n\nEach scar must be addressed with:\n- APPLYING: past-tense evidence of compliance\n- N_A: explain why the scar doesn't apply\n- REFUTED: acknowledge risk of overriding"
}
HOOKJSON
    exit 0
fi

# ============================================================================
# RECALL NAG (soft reminder — ALL Bash/Write/Edit, not just consequential)
# ============================================================================
# UX audit: 12 sessions >30min with zero recalls because nag was gated behind
# consequential filter. Now fires for any code change after 10+ tool calls.
# Cooldown: 90s between nags. Never blocks — additionalContext only.

NOW=$(date +%s)
LAST_NAG=0
if [ -f "$STATE_DIR/last_nag_time" ]; then
    LAST_NAG=$(cat "$STATE_DIR/last_nag_time")
fi

ELAPSED_SINCE_NAG=$((NOW - LAST_NAG))
if [ "$ELAPSED_SINCE_NAG" -lt 90 ]; then
    exit 0
fi

SHOULD_NAG=false

if [ "$RECALL_SCAR_COUNT" -eq 0 ] 2>/dev/null; then
    # No recall scars found — recall hasn't been called this session
    # Threshold: 10 tool calls to avoid nagging during initial exploration
    if [ "$TOOL_COUNT" -gt 10 ]; then
        SHOULD_NAG=true
    fi
fi

# ============================================================================
# Output nag or pass through
# ============================================================================

if [ "$SHOULD_NAG" = "true" ]; then
    echo "$NOW" > "$STATE_DIR/last_nag_time"
    cat <<'HOOKJSON'
{
  "additionalContext": "GITMEM RECALL REMINDER: You've been working for a while without checking institutional memory. Consider calling `recall` (or `gitmem-r`) with your current plan — it surfaces relevant lessons from past sessions that may save time or prevent mistakes. Example: recall({ plan: \"what I'm about to do\" })"
}
HOOKJSON
fi

exit 0
