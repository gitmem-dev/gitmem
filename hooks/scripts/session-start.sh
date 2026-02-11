#!/bin/bash
# GitMem Hooks Plugin — SessionStart Hook
# Detects gitmem MCP server and instructs Claude to call session_start
#
# Input: JSON via stdin (hook event data)
# Output: Plain text instruction (visible in system-reminder)

set -e

# Debug logging — verify hook actually fires
PLUGIN_LOG="/tmp/gitmem-hooks-plugin-debug.log"
echo "[$(date)] PLUGIN SessionStart hook invoked" >> "$PLUGIN_LOG"

# Read hook input from stdin
HOOK_INPUT=$(cat -)
echo "[$(date)] Input: $HOOK_INPUT" >> "$PLUGIN_LOG"

# ============================================================================
# Detect gitmem MCP server
# ============================================================================
#
# Detection cascade — any match = detected. Errs on the side of "yes, try it"
# because a false positive (agent tries session_start, gets tool-not-found) is
# recoverable, but a false negative silently disables the entire lifecycle.
#
# Checks (in order):
#   1. GITMEM_ENABLED env var (explicit override)
#   2. Project .mcp.json files (project-scoped setups)
#   3. --mcp-config file (Docker setups via common paths or MCP_CONFIG_PATH)
#   4. User-level ~/.claude.json mcpServers
#   5. Gitmem server binary on disk (works regardless of config method)

GITMEM_DETECTED=false
DETECT_SOURCE=""

# Helper: check a JSON file for gitmem/gitmem-mcp in mcpServers
check_config_for_gitmem() {
    local FILE="$1"
    [ -f "$FILE" ] || return 1
    if command -v jq &>/dev/null; then
        jq -e '.mcpServers.gitmem // .mcpServers["gitmem-mcp"]' "$FILE" &>/dev/null && return 0
    elif command -v node &>/dev/null; then
        local RESULT
        RESULT=$(node -e "
            const fs = require('fs');
            try {
                const cfg = JSON.parse(fs.readFileSync('$FILE', 'utf8'));
                const s = cfg.mcpServers || {};
                process.stdout.write((s.gitmem || s['gitmem-mcp']) ? 'true' : 'false');
            } catch(e) { process.stdout.write('false'); }
        " 2>/dev/null)
        [ "$RESULT" = "true" ] && return 0
    fi
    return 1
}

# --- 1. Explicit environment variable ---
if [ "${GITMEM_ENABLED}" = "true" ] || [ "${GITMEM_ENABLED}" = "1" ]; then
    GITMEM_DETECTED=true
    DETECT_SOURCE="GITMEM_ENABLED env var"
fi

# --- 2. Project-level .mcp.json ---
if [ "$GITMEM_DETECTED" = "false" ]; then
    for MCP_FILE in ".mcp.json" ".claude/mcp.json"; do
        if check_config_for_gitmem "$MCP_FILE"; then
            GITMEM_DETECTED=true
            DETECT_SOURCE="project $MCP_FILE"
            break
        fi
    done
fi

# --- 3. --mcp-config file (Docker / CLI flag) ---
if [ "$GITMEM_DETECTED" = "false" ]; then
    for CONFIG_FILE in \
        "${MCP_CONFIG_PATH:-}" \
        "/home/claude/mcp-config.json" \
        "/home/node/mcp-config.json" \
        "$HOME/mcp-config.json"; do
        if [ -n "$CONFIG_FILE" ] && check_config_for_gitmem "$CONFIG_FILE"; then
            GITMEM_DETECTED=true
            DETECT_SOURCE="mcp-config $CONFIG_FILE"
            break
        fi
    done
fi

# --- 4. User-level ~/.claude.json ---
if [ "$GITMEM_DETECTED" = "false" ]; then
    if check_config_for_gitmem "$HOME/.claude.json"; then
        GITMEM_DETECTED=true
        DETECT_SOURCE="user ~/.claude.json"
    fi
fi

# --- 5. Gitmem server binary exists on disk ---
if [ "$GITMEM_DETECTED" = "false" ]; then
    for SERVER_PATH in \
        "${GITMEM_SERVER_PATH:-}" \
        "$(which gitmem-mcp 2>/dev/null || echo '')" \
        "$(which gitmem 2>/dev/null || echo '')"; do
        if [ -n "$SERVER_PATH" ] && [ -f "$SERVER_PATH" ]; then
            GITMEM_DETECTED=true
            DETECT_SOURCE="binary $SERVER_PATH"
            break
        fi
    done
fi

# ============================================================================
# Create session state directory
# ============================================================================

SESSION_ID="${CLAUDE_SESSION_ID:-$$}"
STATE_DIR="/tmp/gitmem-hooks-${SESSION_ID}"
mkdir -p "$STATE_DIR"
date +%s > "$STATE_DIR/start_time"
echo "0" > "$STATE_DIR/tool_call_count"
echo "0" > "$STATE_DIR/last_nag_time"

# ============================================================================
# Output hook response
# ============================================================================

if [ "$GITMEM_DETECTED" = "true" ]; then
    echo "[$(date)] Gitmem DETECTED via ${DETECT_SOURCE} — instructing agent to call session_start via MCP" >> "$PLUGIN_LOG"

    # Instruct agent to call session_start via MCP.
    # The MCP server creates sessions with its own PID, enabling multi-session
    # isolation (Phase 1, GIT-19). CLI binary invocation was removed because
    # the CLI PID dies immediately, defeating PID-based session identity.
    #
    # NOTE: ToolSearch (tengu_mcp_tool_search) was removed. MCP tools load
    # eagerly now — no deferral step needed. Just call session_start directly.
    cat <<'HOOK_MSG'
SESSION START — ACTIVE

Call mcp__gitmem__session_start(project: "orchestra_dev") as your FIRST tool call.

IMPORTANT:
- Do NOT respond to the user until session_start completes.
- Do NOT diagnose tool availability — gitmem tools are loaded via --mcp-config.
- If session_start fails, report the error directly instead of investigating.

## GitMem Protocol (active for this session)

**Before any task:** Call `recall` with a brief description of what you're about to do. Review surfaced scars before proceeding.

**When mistakes happen:** Suggest creating a scar with `create_learning`. Include counter_arguments.

**When things go well:** Capture wins with `create_learning` (type: "win").

**At session end** ("closing", "done for now", "wrapping up"):

Run the standard closing ceremony:

1. YOU (the agent) ANSWER these 7 reflection questions based on the session. Display your answers to the human:
   - what_broke: What broke that you didn't expect?
   - what_took_longer: What took longer than it should have?
   - do_differently: What would you do differently next time?
   - what_worked: What pattern or approach worked well?
   - wrong_assumption: What assumption was wrong?
   - scars_applied: Which scars or institutional knowledge did you apply?
   - institutional_memory: What from this session should be captured?

2. ASK the human: "Any corrections or additions to my answers?"
   WAIT for their response before proceeding.

3. WRITE structured payload to .gitmem/closing-payload.json (incorporating human corrections):
   {
     "closing_reflection": { "what_broke": "...", "what_took_longer": "...", "do_differently": "...", "what_worked": "...", "wrong_assumption": "...", "scars_applied": "...", "institutional_memory": "..." },
     "task_completion": { "started_at": "ISO", "completed_at": "ISO", "questions_displayed_at": "ISO", "reflection_completed_at": "ISO", "human_asked_at": "ISO", "human_response_at": "ISO", "human_response": "" },
     "human_corrections": ""
   }

4. CALL session_close with session_id and close_type: "standard"

For short exploratory sessions (< 30 min, no real work), use close_type: "quick" — no questions needed.
HOOK_MSG
else
    echo "[$(date)] Gitmem NOT detected (checked: project .mcp.json, mcp-config, ~/.claude.json, disk)" >> "$PLUGIN_LOG"
    echo "GITMEM PLUGIN: GitMem MCP server not detected. Session lifecycle hooks are inactive. To enable, ensure gitmem is configured via --mcp-config, project .mcp.json, or set GITMEM_ENABLED=true."
fi

echo "[$(date)] Hook completed, exit 0" >> "$PLUGIN_LOG"

exit 0
