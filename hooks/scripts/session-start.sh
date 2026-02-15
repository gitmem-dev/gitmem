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
# MCP Server Readiness Gate
# ============================================================================
#
# Problem: MCP servers start asynchronously when Claude Code launches.
# If the user types fast, their first message is processed before gitmem's
# MCP server finishes connecting. This hook acts as a gate — by waiting here,
# we force Claude Code to delay processing the first user message until
# the gitmem server is likely ready.
#
# Strategy: Poll for the gitmem node process, then wait a buffer for
# MCP handshake completion. Total budget: ~8s (within 10s hook timeout).

if [ "$GITMEM_DETECTED" = "true" ]; then
    GATE_START=$(date +%s%N 2>/dev/null || date +%s)
    MAX_WAIT_SECS=7
    POLL_INTERVAL=0.3
    HANDSHAKE_BUFFER=0.5
    SERVER_FOUND=false

    echo "[$(date)] MCP readiness gate: waiting up to ${MAX_WAIT_SECS}s for gitmem server process..." >> "$PLUGIN_LOG"

    # Build list of patterns to match the gitmem server process
    # Covers: direct node invocation, npx, and symlinked binaries
    GITMEM_PATTERNS=(
        "gitmem/dist/index.js"
        "gitmem-mcp"
    )

    # Poll every 0.3s. Max iterations = MAX_WAIT_SECS / 0.3 ≈ 23
    MAX_POLLS=$(( MAX_WAIT_SECS * 10 / 3 ))
    POLL=0
    while [ "$POLL" -lt "$MAX_POLLS" ]; do
        for PATTERN in "${GITMEM_PATTERNS[@]}"; do
            if pgrep -f "$PATTERN" > /dev/null 2>&1; then
                SERVER_FOUND=true
                WAIT_SECS=$(( POLL * 3 / 10 ))
                echo "[$(date)] MCP readiness gate: gitmem process found (pattern: $PATTERN) after ~${WAIT_SECS}.$(( POLL * 3 % 10 ))s" >> "$PLUGIN_LOG"
                # Buffer for MCP protocol handshake to complete
                sleep "$HANDSHAKE_BUFFER"
                break 2
            fi
        done
        sleep "$POLL_INTERVAL"
        POLL=$((POLL + 1))
    done

    if [ "$SERVER_FOUND" = "false" ]; then
        echo "[$(date)] MCP readiness gate: gitmem process NOT found after ${MAX_WAIT_SECS}s — proceeding anyway (config detected, server may use different process name)" >> "$PLUGIN_LOG"
    fi

    GATE_END=$(date +%s%N 2>/dev/null || date +%s)
    echo "[$(date)] MCP readiness gate completed" >> "$PLUGIN_LOG"
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
    #
    # Read project from .gitmem/config.json if available.
    # Fallback: let session_start default (reads config.json server-side too).
    GITMEM_PROJECT=""
    if [ -f ".gitmem/config.json" ] && command -v jq &>/dev/null; then
        GITMEM_PROJECT=$(jq -r '.project // empty' .gitmem/config.json 2>/dev/null || true)
    fi

    if [ -n "$GITMEM_PROJECT" ]; then
        echo "[$(date)] Project from config: ${GITMEM_PROJECT}" >> "$PLUGIN_LOG"
        cat <<HOOK_MSG
SESSION START — ACTIVE

Call mcp__gitmem__session_start(project: "${GITMEM_PROJECT}") as your FIRST tool call.
HOOK_MSG
    else
        cat <<'HOOK_MSG'
SESSION START — ACTIVE

Call mcp__gitmem__session_start() as your FIRST tool call.
HOOK_MSG
    fi

    cat <<'HOOK_MSG2'

IMPORTANT:
- Do NOT respond to the user until session_start completes.
- Do NOT diagnose tool availability — gitmem tools are loaded via --mcp-config.
- If session_start fails, report the error directly instead of investigating.

You have persistent memory. session_start just loaded context from your last
session — open threads, recent decisions, what was learned. This compounds
every session. Use recall before tasks to see what past sessions discovered.
The more you use it, the better it gets.
HOOK_MSG2
else
    echo "[$(date)] Gitmem NOT detected (checked: project .mcp.json, mcp-config, ~/.claude.json, disk)" >> "$PLUGIN_LOG"
    echo "GITMEM PLUGIN: GitMem MCP server not detected. Session lifecycle hooks are inactive. To enable, ensure gitmem is configured via --mcp-config, project .mcp.json, or set GITMEM_ENABLED=true."
fi

echo "[$(date)] Hook completed, exit 0" >> "$PLUGIN_LOG"

exit 0
