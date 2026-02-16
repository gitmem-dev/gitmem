#!/bin/bash
# GitMem Hooks Plugin — PostToolUse Hook (Audit Trail)
# Logs LOOKED events (after recall/search) and ACTION events (after consequential actions).
#
# Event types:
#   LOOKED — Agent checked institutional memory (recall, search)
#   ACTION — Agent took a consequential action (git push, Linear Done, SQL migration)
#
# Audit trail: append-only JSONL at /tmp/gitmem-hooks-{SESSION_ID}/audit.jsonl
# Non-consequential actions pass through silently.
#
# Input: JSON via stdin with tool_name, tool_input, tool_output
# Output: empty (exit 0) — PostToolUse hooks never block

set -e

# Read hook input from stdin
HOOK_INPUT=$(cat -)

# ============================================================================
# Graceful degradation: skip if no active gitmem session
# ============================================================================

# Check active sessions registry
ACTIVE_SESSIONS=".gitmem/active-sessions.json"
if [ ! -f "$ACTIVE_SESSIONS" ]; then
    exit 0
fi

# ============================================================================
# JSON parsing helper (jq preferred, node fallback)
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
# Classify event: LOOKED or ACTION
# ============================================================================

EVENT_TYPE=""
DETAIL=""

case "$TOOL_NAME" in
    mcp__gitmem__recall|mcp__gitmem__gitmem-r)
        EVENT_TYPE="LOOKED"
        PLAN=$(parse_json "$HOOK_INPUT" ".tool_input.plan")
        DETAIL="plan: ${PLAN:-<no plan>}"
        ;;
    mcp__gitmem__search|mcp__gitmem__gm-scar)
        EVENT_TYPE="LOOKED"
        QUERY=$(parse_json "$HOOK_INPUT" ".tool_input.query")
        DETAIL="query: ${QUERY:-<no query>}"
        ;;
    Bash)
        COMMAND=$(parse_json "$HOOK_INPUT" ".tool_input.command")
        if echo "$COMMAND" | grep -qE '(git\s+push|git\s+tag|npm\s+publish|npx\s+supabase\s+db\s+push|deploy|supabase\s+functions\s+deploy)'; then
            EVENT_TYPE="ACTION"
            DETAIL="command: $COMMAND"
        fi
        ;;
    Write|Edit)
        FILE_PATH=$(parse_json "$HOOK_INPUT" ".tool_input.file_path")
        if echo "$FILE_PATH" | grep -qE '\.(sql|env)$'; then
            EVENT_TYPE="ACTION"
            DETAIL="file: $FILE_PATH"
        fi
        ;;
esac

# Not a tracked event → pass through silently
if [ -z "$EVENT_TYPE" ]; then
    exit 0
fi

# ============================================================================
# Append to audit trail (JSONL)
# ============================================================================

SESSION_ID="${CLAUDE_SESSION_ID:-$$}"
STATE_DIR="/tmp/gitmem-hooks-${SESSION_ID}"
mkdir -p "$STATE_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Escape detail for JSON (replace quotes and backslashes)
DETAIL_ESCAPED=$(echo "$DETAIL" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')

echo "{\"timestamp\":\"${TIMESTAMP}\",\"type\":\"${EVENT_TYPE}\",\"tool\":\"${TOOL_NAME}\",\"detail\":\"${DETAIL_ESCAPED}\"}" >> "$STATE_DIR/audit.jsonl"

exit 0
