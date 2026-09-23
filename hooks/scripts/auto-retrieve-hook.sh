#!/bin/bash
# GitMem Hooks Plugin — UserPromptSubmit Hook (Auto-Retrieve)
#
# Automatically searches institutional memory and injects relevant scars
# into the agent's context before it starts working.
#
# Pipeline:
#   1. Read user prompt from stdin (hook input JSON)
#   2. Classify task type via keyword matching (<50ms)
#   3. If retrieval needed, call quick-retrieve.js (Node module)
#   4. Inject results as additionalContext
#
# Task Types (priority order):
#   trivial        → none   (confirmations, slash cmds, short prompts)
#   architecture   → full   (design, decisions, trade-offs)
#   research       → full   (synthesis, comparison, analysis)
#   content        → full   (writing, documentation)
#   implementation → scars  (building, fixing, issue work)
#   default        → scars  (conservative default)
#
# Design: fail open — if anything breaks, exit 0 (never block the user).
#
# Disable: GITMEM_AUTO_RETRIEVE=false

set -e

# Check if disabled
if [ "$GITMEM_AUTO_RETRIEVE" = "false" ] || [ "$GITMEM_AUTO_RETRIEVE" = "0" ]; then
    exit 0
fi

# Read hook input from stdin
HOOK_INPUT=$(cat -)

# ============================================================================
# Extract prompt from hook input
# ============================================================================

# GIT-116: a missing tool is a visible, non-blocking hook error (exit 1 with a
# reason on stderr; exit 2 would block the prompt), never a silent "nothing
# relevant". Retrieval needs node, which the MCP server needs anyway — but the
# hook runs with the launcher's PATH, where an nvm/volta node may be absent.
gitmem_unavailable() {
    echo "gitmem auto-retrieve is not running: $1" >&2
    exit 1
}

if ! command -v node &>/dev/null; then
    gitmem_unavailable "node is not on the hook's PATH (PATH=$PATH)"
fi

# Extract the prompt (node is required; checked above)
PROMPT=""
if command -v node &>/dev/null; then
    PROMPT=$(echo "$HOOK_INPUT" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try {
                const j=JSON.parse(d);
                process.stdout.write(j.prompt||'');
            } catch(e) { }
        });
    " 2>/dev/null) || true
fi

# Empty or missing prompt → nothing to do
if [ -z "$PROMPT" ]; then
    exit 0
fi

PROMPT_LOWER=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]')
PROMPT_LEN=${#PROMPT}

# ============================================================================
# Task Classification (keyword matching, <50ms)
# ============================================================================

RETRIEVAL_LEVEL=""

# Priority 0: Knowledge-retrieval queries — route through gitmem, don't inject scars
# These are queries where the user wants to ACCESS institutional memory, not just
# have scars passively injected. Output a routing instruction instead of scars.
IS_KNOWLEDGE_QUERY=false

# Explicit recall/remember commands
if echo "$PROMPT_LOWER" | grep -qE '\b(recall|remember)\b.*(doc|process|tree|structure|how|what|where|our)'; then
    IS_KNOWLEDGE_QUERY=true
# Process/documentation queries ("what's our process for X", "how do we usually Y")
elif echo "$PROMPT_LOWER" | grep -qE "(what('s| is) our (process|approach|pattern|method)|how do we (usually|typically|normally)|remind me (how|what|about)|what('s| is) the (process|protocol|procedure) for)"; then
    IS_KNOWLEDGE_QUERY=true
# Documentation discovery ("show me the docs", "where are the scars")
elif echo "$PROMPT_LOWER" | grep -qE '\b(show me|find|where (is|are|do)).*(doc(s|umentation)?|process(es)?|pattern(s)?|decision(s)?|scar(s)?|learning(s)?)\b'; then
    IS_KNOWLEDGE_QUERY=true
# Institutional knowledge queries ("what did we decide about", "what scars exist")
elif echo "$PROMPT_LOWER" | grep -qE '\b(what did we (decide|learn|document)|what scars|what learnings|past decisions about|institutional (memory|knowledge))\b'; then
    IS_KNOWLEDGE_QUERY=true
# Direct "recall" as a verb/command at start of prompt
elif echo "$PROMPT_LOWER" | grep -qE '^\s*recall\b'; then
    IS_KNOWLEDGE_QUERY=true
fi

if [ "$IS_KNOWLEDGE_QUERY" = "true" ]; then
    cat <<HOOKJSON
{
  "additionalContext": "KNOWLEDGE RETRIEVAL DETECTED. Route through GitMem FIRST:\n\n1. gitmem search (query relevant to the question) OR gitmem recall (if action-oriented)\n2. gitmem log (if browsing recent learnings)\n3. ONLY THEN fall back to filesystem reads if gitmem doesn't have the answer\n\nDo NOT start with Read/Glob/Grep on local files. Institutional memory exists precisely so we don't re-explore the filesystem every time."
}
HOOKJSON
    exit 0
fi

# Priority 1: Trivial — skip retrieval entirely
if echo "$PROMPT_LOWER" | grep -qE '^(yes|no|ok|k|y|n|sure|thanks|thank you|continue|go ahead|proceed|correct|right|exactly|got it|sounds good|lgtm|looks good|done|nope|yep|yup|agreed)$'; then
    exit 0
elif echo "$PROMPT_LOWER" | grep -qE '^/'; then
    exit 0
elif echo "$PROMPT_LOWER" | grep -qE '^(closing|done for now|wrapping up|wrap up|that.s it|that.s all|gitmem)'; then
    exit 0
elif echo "$PROMPT_LOWER" | grep -qE '\b(fix\s+typo|typo\b|formatting\b|indent(ation)?\b|whitespace\b|lint(ing)?\b)'; then
    exit 0
elif [ "$PROMPT_LEN" -lt 12 ]; then
    exit 0
fi

# Priority 2: Architecture → full retrieval
if echo "$PROMPT_LOWER" | grep -qE '\b(architect(ure)?|design\s+(the\s+)?\w+|decide\s+(between|on|whether|how|if)|should\s+we|trade-?offs?\b|rfc\b|adr\b|system\s+design)\b'; then
    RETRIEVAL_LEVEL="full"

# Priority 3: Research → full retrieval
elif echo "$PROMPT_LOWER" | grep -qE '\b(research\b|synthesize|synthesis\b|compare\s+(and|the|our)|contrast\b|analyze\s+(the\s+)?(options|approaches|alternatives)|evaluate\s+(frameworks|tools|approaches))\b'; then
    RETRIEVAL_LEVEL="full"

# Priority 4: Content creation → full retrieval
elif echo "$PROMPT_LOWER" | grep -qE '\b(write\s+(a|an|the|about)|article\b|blog\s*(post)?|document\s+(the|how|what)|explain\s+(how|what|the)|guide\s+(to|for)|tutorial\b)\b'; then
    RETRIEVAL_LEVEL="full"

# Priority 5: Implementation → scars only
elif echo "$PROMPT_LOWER" | grep -qE '\b(implement|build\b|fix\s+(the\s+)?bug|refactor|migrate\b|pickup\b|pick\s*up|create\s+(a|the)|add\s+(a|the))\b'; then
    RETRIEVAL_LEVEL="scars"

# Default: scars (conservative — better to surface something than nothing)
else
    RETRIEVAL_LEVEL="scars"
fi

# ============================================================================
# Invoke quick-retrieve (Node module)
# ============================================================================


# Locate quick-retrieve.js relative to plugin root
# Hook scripts are at: ${CLAUDE_PLUGIN_ROOT}/scripts/
# Built JS is at:      ${CLAUDE_PLUGIN_ROOT}/../dist/hooks/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUICK_RETRIEVE="${SCRIPT_DIR}/../../dist/hooks/quick-retrieve.js"

# Fallback: try relative to CLAUDE_PLUGIN_ROOT
if [ ! -f "$QUICK_RETRIEVE" ]; then
    QUICK_RETRIEVE="${CLAUDE_PLUGIN_ROOT}/../dist/hooks/quick-retrieve.js"
fi

# Hooks copied into <repo>/.gitmem/hooks (init, install-hooks) have no dist/
# beside them, so look where the package itself is installed. GIT-116: this
# searched for a package called "gitmem"; it is "gitmem-mcp". Most installs run
# it through npx, so npx's cache is searched too (newest first).
if [ ! -f "$QUICK_RETRIEVE" ]; then
    REL="gitmem-mcp/dist/hooks/quick-retrieve.js"
    BIN="$(command -v gitmem-mcp 2>/dev/null || true)"
    for CANDIDATE in \
        ${BIN:+"$(dirname "$BIN")/../lib/node_modules/$REL"} \
        $(ls -1t "$HOME"/.npm/_npx/*/node_modules/$REL 2>/dev/null) \
        "$(npm root -g 2>/dev/null)/$REL"; do
        if [ -f "$CANDIDATE" ]; then
            QUICK_RETRIEVE="$CANDIDATE"
            break
        fi
    done
fi

if [ ! -f "$QUICK_RETRIEVE" ]; then
    gitmem_unavailable "quick-retrieve.js not found next to the hook, in npx's cache, or in the global node_modules"
fi

# Call quick-retrieve with prompt and level. It bounds its own run (2.5 s,
# inside the 3 s hook budget): GIT-116 dropped the `timeout` wrapper, which
# macOS does not ship.
RESULT=$(node "$QUICK_RETRIEVE" "$PROMPT" "$RETRIEVAL_LEVEL" 2>/dev/null) || true

# Empty result → nothing relevant found
if [ -z "$RESULT" ]; then
    exit 0
fi

# ============================================================================
# Inject as additionalContext
# ============================================================================

# Escape the result for JSON embedding
ESCAPED_RESULT=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$RESULT" 2>/dev/null) || exit 0

cat <<HOOKJSON
{
  "additionalContext": ${ESCAPED_RESULT}
}
HOOKJSON

exit 0
