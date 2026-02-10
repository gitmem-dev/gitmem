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
        "/workspace/gitmem/dist/index.js" \
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

    # Always instruct agent to call ToolSearch + session_start via MCP.
    # The MCP server creates sessions with its own PID, enabling multi-session
    # isolation (Phase 1, GIT-19). CLI binary invocation was removed because
    # the CLI PID dies immediately, defeating PID-based session identity.
    cat <<'HOOK_MSG'
SESSION START — ACTIVE

All MCP tools are deferred. You MUST load them first via ToolSearch.

Step 1 — Load tools:
  ToolSearch(query: "+gitmem session", max_results: 5)

Step 2 — Start session:
  mcp__gitmem__session_start(project: "orchestra_dev")

IMPORTANT:
- Do NOT skip Step 1. Without it, session_start will not exist as a callable tool.
- Do NOT say "tools aren't available" — ToolSearch makes them available.
- Do NOT respond to the user until both steps complete.
- Execute Step 1 and Step 2 as your FIRST two tool calls of the session.
HOOK_MSG
else
    echo "[$(date)] Gitmem NOT detected (checked: project .mcp.json, mcp-config, ~/.claude.json, disk)" >> "$PLUGIN_LOG"
    echo "GITMEM PLUGIN: GitMem MCP server not detected. Session lifecycle hooks are inactive. To enable, ensure gitmem is configured via --mcp-config, project .mcp.json, or set GITMEM_ENABLED=true."
fi

echo "[$(date)] Hook completed, exit 0" >> "$PLUGIN_LOG"

exit 0
