#!/bin/bash
# GitMem Hooks Plugin — PreToolUse Hook (Credential Guard)
#
# CONSTITUTIONAL ENFORCEMENT: Hard-blocks any tool call that would expose
# credentials, API keys, tokens, or secrets in conversation output.
#
# Intercepts:
#   - Bash: env/printenv/export dumps, echo $SECRET, cat/read of credential files
#   - Read: Direct reads of known credential files (mcp-config.json, .env, etc.)
#
# This is a RED LINE — no override, no exception. Credential exposure is
# permanent and irreversible once it enters conversation history.
#
# Input: JSON via stdin with tool_name and tool_input
# Output: JSON with decision:block OR empty (exit 0 = allow)

set -e

HOOK_INPUT=$(cat -)

# ============================================================================
# Parse tool info
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
# Credential file patterns (basenames and paths)
# ============================================================================

# Files that are PRIMARILY credential stores — never read in full
CREDENTIAL_FILES_PATTERN='(mcp-config\.json|\.env($|\.)|\.credentials\.json|credentials\.json|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.pem$|\.key$)'

# ============================================================================
# BASH TOOL GUARD
# ============================================================================

if [ "$TOOL_NAME" = "Bash" ]; then
    COMMAND=$(parse_json "$HOOK_INPUT" ".tool_input.command")

    # Guard 1: env/printenv dumps that would expose secret values
    # Blocks: env | grep KEY, printenv TOKEN, export -p | grep SECRET
    # Allows: env | grep -c KEY (count only), [ -n "$VAR" ] checks
    if echo "$COMMAND" | grep -qEi '(^|\|)\s*(env|printenv|export\s+-p)\s*(\||$)' && \
       ! echo "$COMMAND" | grep -qE 'grep\s+-(c|l)\s'; then
        # Check if the piped grep targets secret-looking patterns
        if echo "$COMMAND" | grep -qEi '(key|secret|token|password|credential|auth|pat[^h]|api_|twitter|supabase|linear|notion|openrouter|perplexity|anthropic|github)'; then
            cat <<'HOOKJSON'
{
  "decision": "block",
  "reason": "RED LINE — CREDENTIAL EXPOSURE BLOCKED: This command would print secret values from environment variables into the conversation. Use count-only checks instead:\n\n  env | grep -c VARNAME        # returns count, not value\n  [ -n \"$VARNAME\" ] && echo set  # existence check only\n\nThis rule is constitutional. There is no override."
}
HOOKJSON
            exit 0
        fi
    fi

    # Guard 2: Direct echo/printf of secret-looking env vars
    if echo "$COMMAND" | grep -qEi '(echo|printf)\s+.*\$\{?(TWITTER|API_KEY|API_SECRET|ACCESS_TOKEN|ACCESS_SECRET|GITHUB_PAT|LINEAR_API|SUPABASE_SERVICE|NOTION_TOKEN|OPENROUTER|PERPLEXITY|ANTHROPIC)'; then
        cat <<'HOOKJSON'
{
  "decision": "block",
  "reason": "RED LINE — CREDENTIAL EXPOSURE BLOCKED: This command would print a secret environment variable value. Use existence checks instead:\n\n  [ -n \"$VARNAME\" ] && echo \"set\" || echo \"unset\"\n\nThis rule is constitutional. There is no override."
}
HOOKJSON
        exit 0
    fi

    # Guard 3: cat/head/tail/less of credential files via Bash
    if echo "$COMMAND" | grep -qEi "(cat|head|tail|less|more|bat)\s+" && \
       echo "$COMMAND" | grep -qEi "$CREDENTIAL_FILES_PATTERN"; then
        cat <<'HOOKJSON'
{
  "decision": "block",
  "reason": "RED LINE — CREDENTIAL EXPOSURE BLOCKED: This command would dump a credential file into the conversation. Use targeted, value-safe searches instead:\n\n  grep -c '\"server_name\"' config.json  # check structure, not secrets\n\nThis rule is constitutional. There is no override."
}
HOOKJSON
        exit 0
    fi
fi

# ============================================================================
# READ TOOL GUARD
# ============================================================================

if [ "$TOOL_NAME" = "Read" ]; then
    FILE_PATH=$(parse_json "$HOOK_INPUT" ".tool_input.file_path")
    BASENAME=$(basename "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

    # Block reading known credential files
    if echo "$BASENAME" | grep -qEi "$CREDENTIAL_FILES_PATTERN"; then
        cat <<HOOKJSON
{
  "decision": "block",
  "reason": "RED LINE — CREDENTIAL EXPOSURE BLOCKED: Reading '${BASENAME}' would dump secrets (API keys, tokens) into the conversation. This file is a credential store.\n\nSafe alternatives:\n  grep -c '\"server_name\"' ${FILE_PATH}   # check if a key exists\n  grep '\"twitter\"' ${FILE_PATH}            # check specific non-secret structure\n\nThis rule is constitutional. There is no override."
}
HOOKJSON
        exit 0
    fi

    # Block reading files in sensitive directories
    if echo "$FILE_PATH" | grep -qEi '(/\.ssh/|/\.gnupg/|/secrets?/)'; then
        cat <<HOOKJSON
{
  "decision": "block",
  "reason": "RED LINE — CREDENTIAL EXPOSURE BLOCKED: Reading files from '${FILE_PATH}' would expose sensitive cryptographic material or secrets. This rule is constitutional. There is no override."
}
HOOKJSON
        exit 0
    fi
fi

# ============================================================================
# No credential risk detected — allow
# ============================================================================

exit 0
