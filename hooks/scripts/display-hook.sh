#!/bin/bash
# GitMem Hooks Plugin — PostToolUse Display Hook
#
# PURPOSE: Deterministic MCP tool output display.
# Routes formatted display directly to the terminal (bypassing the LLM)
# and replaces the LLM's view with machine-readable data only.
#
# Architecture:
#   Channel 1 (stdout, exit 0) → User sees in terminal, LLM does NOT
#   Channel 2 (updatedMCPToolOutput) → LLM sees, user does NOT directly
#
# The gitmem MCP server returns responses with an optional separator:
#   [formatted display]
#   ═══ GITMEM_DATA ═══
#   {"machine": "data"}
#
# This hook splits on that separator. If no separator exists, the entire
# response is treated as display-only.
#
# Input: JSON via stdin with tool_name, tool_input, tool_response
# Output: JSON with hookSpecificOutput.updatedMCPToolOutput (or exit 0)

set -e

# Read hook input from stdin
HOOK_INPUT=$(cat -)

# Extract tool name
TOOL_NAME=""
if command -v jq &>/dev/null; then
    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
else
    TOOL_NAME=$(echo "$HOOK_INPUT" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try { process.stdout.write(JSON.parse(d).tool_name||''); }
            catch(e) { process.stdout.write(''); }
        });
    " 2>/dev/null)
fi

# Only process gitmem MCP tools
case "$TOOL_NAME" in
    mcp__gitmem__*) ;;
    *) exit 0 ;;
esac

# Extract tool response — try both field names Claude Code might use
TOOL_RESPONSE=""
if command -v jq &>/dev/null; then
    TOOL_RESPONSE=$(echo "$HOOK_INPUT" | jq -r '(.tool_response // .tool_output // empty)' 2>/dev/null)
else
    TOOL_RESPONSE=$(echo "$HOOK_INPUT" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try {
                const j=JSON.parse(d);
                process.stdout.write(String(j.tool_response||j.tool_output||''));
            } catch(e) { process.stdout.write(''); }
        });
    " 2>/dev/null)
fi

# No response to process
if [ -z "$TOOL_RESPONSE" ] || [ "$TOOL_RESPONSE" = "null" ]; then
    exit 0
fi

# ============================================================================
# Split response into DISPLAY and MACHINE DATA
# ============================================================================

SEPARATOR="═══ GITMEM_DATA ═══"

# Check if separator exists in response
if echo "$TOOL_RESPONSE" | grep -qF "$SEPARATOR"; then
    # Split: display = everything before separator, data = everything after
    DISPLAY_PART=$(echo "$TOOL_RESPONSE" | awk -v sep="$SEPARATOR" '{if ($0 == sep) exit; print}')
    MACHINE_PART=$(echo "$TOOL_RESPONSE" | awk -v sep="$SEPARATOR" 'found{print} $0==sep{found=1}')
else
    # No separator — entire response is display-only
    DISPLAY_PART="$TOOL_RESPONSE"
    MACHINE_PART=""
fi

# ============================================================================
# Strip DISPLAY PROTOCOL suffix from display portion
# ============================================================================

# Remove the separator line and everything after it (DISPLAY PROTOCOL instructions)
DISPLAY_CLEAN=$(echo "$DISPLAY_PART" | awk '/^───────────────────────────────────────────────────$/{exit} {print}')

# If stripping removed everything (shouldn't happen), fall back to full display
if [ -z "$DISPLAY_CLEAN" ]; then
    DISPLAY_CLEAN="$DISPLAY_PART"
fi

# ============================================================================
# Channel 1: Print display to stdout (user sees, LLM does not)
# ============================================================================

echo "$DISPLAY_CLEAN"

# ============================================================================
# Channel 2: Return updatedMCPToolOutput (LLM sees, user does not directly)
# ============================================================================

# Build the LLM-facing replacement
SHORT_NAME=$(echo "$TOOL_NAME" | sed 's/^mcp__gitmem__//')

if [ -n "$MACHINE_PART" ]; then
    # Has machine data — give LLM the structured data
    LLM_TEXT="gitmem ${SHORT_NAME} · output displayed to user\n${MACHINE_PART}"
else
    # Display-only — give LLM a brief summary
    # Include the display text so LLM can still reference the content
    LLM_TEXT="gitmem ${SHORT_NAME} · output displayed to user\n${DISPLAY_CLEAN}"
fi

# Escape for JSON embedding (handle newlines, quotes, backslashes)
if command -v jq &>/dev/null; then
    LLM_JSON=$(printf '%s' "$LLM_TEXT" | jq -Rs '.')
else
    LLM_JSON=$(printf '%s' "$LLM_TEXT" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));
    " 2>/dev/null)
fi

# Return the hook response with updatedMCPToolOutput
cat <<HOOKJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedMCPToolOutput": ${LLM_JSON}
  }
}
HOOKJSON
