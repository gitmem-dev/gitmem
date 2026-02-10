#!/bin/bash
# GitMem Hooks Plugin — Stop Hook (Session Close Check)
# Ensures session_close is called before the session ends.
#
# Logic:
# 1. Check if session is meaningful (registry has entries, or >5 tool calls, or >5 min)
# 2. If session was closed properly (registry empty) → allow stop
# 3. If meaningful but not closed → block with reminder
# 4. Infinite loop guard: if stop_hook_active flag set → always allow
# 5. Trivial sessions skip enforcement
#
# Input: JSON via stdin (hook event data)
# Output: JSON with decision: "block" and message if enforcement triggered

set -e

# Read hook input from stdin
HOOK_INPUT=$(cat -)

# ============================================================================
# Infinite loop guard
# ============================================================================

SESSION_ID="${CLAUDE_SESSION_ID:-$$}"
STATE_DIR="/tmp/gitmem-hooks-${SESSION_ID}"

if [ -f "$STATE_DIR/stop_hook_active" ]; then
    # Already fired once and blocked — don't block again
    exit 0
fi

# ============================================================================
# Check if session is meaningful
# ============================================================================

IS_MEANINGFUL=false

ACTIVE_SESSIONS=".gitmem/active-sessions.json"
SESSION_STARTED=false
if [ -f "$ACTIVE_SESSIONS" ]; then
    # Check if registry has active session entries (Phase 1 multi-session, GIT-19)
    if command -v jq &>/dev/null; then
        [ "$(jq '.sessions | length' "$ACTIVE_SESSIONS" 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null && SESSION_STARTED=true
    elif command -v node &>/dev/null; then
        [ "$(node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync('$ACTIVE_SESSIONS','utf8'));process.stdout.write(String((r.sessions||[]).length))}catch(e){process.stdout.write('0')}" 2>/dev/null)" -gt 0 ] 2>/dev/null && SESSION_STARTED=true
    fi
fi

# Without state dir, we have no tracking data — can't determine meaningfulness.
# This happens when the SessionStart hook didn't fire (plugin hooks issue).
# Don't block with bogus defaults — skip enforcement gracefully.
if [ ! -d "$STATE_DIR" ]; then
    if [ "$SESSION_STARTED" = "true" ]; then
        # Session exists but no tracking — create state dir NOW so future
        # Stop attempts can track from this point forward.
        mkdir -p "$STATE_DIR"
        date +%s > "$STATE_DIR/start_time"
        echo "0" > "$STATE_DIR/tool_call_count"
    fi
    # First time seeing this — not meaningful yet
    exit 0
fi

# Criterion 1: >5 tool calls
TOOL_COUNT=0
if [ -f "$STATE_DIR/tool_call_count" ]; then
    TOOL_COUNT=$(cat "$STATE_DIR/tool_call_count" 2>/dev/null || echo "0")
fi
if [ "$TOOL_COUNT" -gt 5 ]; then
    IS_MEANINGFUL=true
fi

# Criterion 2: >5 minutes duration
NOW=$(date +%s)
if [ -f "$STATE_DIR/start_time" ]; then
    START_TIME=$(cat "$STATE_DIR/start_time" 2>/dev/null || echo "$NOW")
    DURATION=$((NOW - START_TIME))
    if [ "$DURATION" -gt 300 ]; then
        IS_MEANINGFUL=true
    fi
fi

# ============================================================================
# Trivial session → skip enforcement
# ============================================================================

if [ "$IS_MEANINGFUL" != "true" ]; then
    exit 0
fi

# ============================================================================
# Check if session was closed properly
# ============================================================================

if [ "$SESSION_STARTED" = "true" ]; then
    # Registry still has entries → session not closed
    # Set guard flag to prevent infinite blocking
    mkdir -p "$STATE_DIR"
    touch "$STATE_DIR/stop_hook_active"

    cat <<'HOOKJSON'
{
  "decision": "block",
  "reason": "GITMEM SESSION STILL OPEN — Run the standard closing ceremony:\n\n1. YOU (the agent) ANSWER these 7 reflection questions based on the session. Display your answers to the human:\n   - what_broke: What broke that you didn't expect?\n   - what_took_longer: What took longer than it should have?\n   - do_differently: What would you do differently next time?\n   - what_worked: What pattern or approach worked well?\n   - wrong_assumption: What assumption was wrong?\n   - scars_applied: Which scars or institutional knowledge did you apply?\n   - institutional_memory: What from this session should be captured?\n\n2. ASK the human: 'Any corrections or additions to my answers?' WAIT for their response.\n\n3. WRITE structured payload to .gitmem/closing-payload.json with closing_reflection (7 fields above, incorporating human corrections), task_completion (timestamps), and human_corrections.\n\n4. CALL session_close with session_id and close_type: 'standard'.\n\nFor trivial sessions (< 30min, exploratory only), use close_type: 'quick' instead — no questions needed."
}
HOOKJSON
    exit 0
fi

# Session was closed properly (registry empty) or never started
# Clean up state dir
if [ -d "$STATE_DIR" ]; then
    rm -rf "$STATE_DIR"
fi

exit 0
