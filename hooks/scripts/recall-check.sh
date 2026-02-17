#!/bin/bash
# GitMem Hooks Plugin — PreToolUse Hook (Recall Check + Confirmation Gate)
#
# Two enforcement mechanisms with different trigger scopes:
#
# 1. CONFIRMATION GATE (hard block, consequential actions only):
#    If recall() surfaced scars but confirm_scars() hasn't been called → BLOCK.
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

ACTIVE_SESSIONS=".gitmem/active-sessions.json"
if [ ! -f "$ACTIVE_SESSIONS" ]; then
    exit 0
fi

# Get first session ID from registry to find per-session data file
SESSION_FILE=""
if command -v jq &>/dev/null; then
    SID=$(jq -r '.sessions[0].session_id // empty' "$ACTIVE_SESSIONS" 2>/dev/null)
    [ -n "$SID" ] && SESSION_FILE=".gitmem/sessions/${SID}/session.json"
elif command -v node &>/dev/null; then
    SID=$(node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync('$ACTIVE_SESSIONS','utf8'));const s=(r.sessions||[])[0];process.stdout.write(s?.session_id||'')}catch(e){}" 2>/dev/null)
    [ -n "$SID" ] && SESSION_FILE=".gitmem/sessions/${SID}/session.json"
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
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

# Read a numeric field from per-session file safely
read_session_count() {
    local JQ_FILTER="$1"
    local NODE_SCRIPT="$2"
    if command -v jq &>/dev/null; then
        jq "$JQ_FILTER" "$SESSION_FILE" 2>/dev/null || echo "0"
    else
        node -e "$NODE_SCRIPT" 2>/dev/null || echo "0"
    fi
}

TOOL_NAME=$(parse_json "$HOOK_INPUT" ".tool_name")

# ============================================================================
# Read session state (shared by both gate and nag)
# ============================================================================

RECALL_SCAR_COUNT=$(read_session_count \
    '[.surfaced_scars // [] | .[] | select(.source == "recall")] | length' \
    "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('$SESSION_FILE','utf8'));const c=(s.surfaced_scars||[]).filter(x=>x.source==='recall');process.stdout.write(String(c.length))}catch(e){process.stdout.write('0')}")

CONFIRMATION_COUNT=$(read_session_count \
    '[.confirmations // [] | .[]] | length' \
    "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('$SESSION_FILE','utf8'));process.stdout.write(String((s.confirmations||[]).length))}catch(e){process.stdout.write('0')}")

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

if [ "$IS_CONSEQUENTIAL" = "true" ] && [ "$RECALL_SCAR_COUNT" -gt 0 ] 2>/dev/null && [ "$CONFIRMATION_COUNT" -eq 0 ] 2>/dev/null; then
    # Get scar titles for the error message
    if command -v jq &>/dev/null; then
        SCAR_TITLES=$(jq -r '[.surfaced_scars // [] | .[] | select(.source == "recall") | .scar_title] | join(", ")' "$SESSION_FILE" 2>/dev/null || echo "(unknown)")
    else
        SCAR_TITLES=$(node -e "
            const fs=require('fs');
            try{const s=JSON.parse(fs.readFileSync('$SESSION_FILE','utf8'));
            const t=(s.surfaced_scars||[]).filter(x=>x.source==='recall').map(x=>x.scar_title);
            process.stdout.write(t.join(', '))}catch(e){process.stdout.write('(unknown)')}" 2>/dev/null || echo "(unknown)")
    fi

    cat <<HOOKJSON
{
  "decision": "block",
  "reason": "SCAR CONFIRMATION REQUIRED: recall() surfaced ${RECALL_SCAR_COUNT} scar(s) that have not been confirmed. Call confirm_scars() (or gm-confirm) with APPLYING/N_A/REFUTED for each scar before proceeding.\n\nUnconfirmed scars: ${SCAR_TITLES}\n\nEach scar must be addressed with:\n- APPLYING: past-tense evidence of compliance\n- N_A: explain why the scar doesn't apply\n- REFUTED: acknowledge risk of overriding"
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
