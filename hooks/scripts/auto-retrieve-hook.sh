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

# Use node if available, fallback to basic extraction
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

# Require node for retrieval
if ! command -v node &>/dev/null; then
    exit 0
fi

# Locate quick-retrieve.js relative to plugin root
# Hook scripts are at: ${CLAUDE_PLUGIN_ROOT}/scripts/
# Built JS is at:      ${CLAUDE_PLUGIN_ROOT}/../dist/hooks/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUICK_RETRIEVE="${SCRIPT_DIR}/../../dist/hooks/quick-retrieve.js"

# Fallback: try relative to CLAUDE_PLUGIN_ROOT
if [ ! -f "$QUICK_RETRIEVE" ]; then
    QUICK_RETRIEVE="${CLAUDE_PLUGIN_ROOT}/../dist/hooks/quick-retrieve.js"
fi

# If still not found, try the gitmem package location
if [ ! -f "$QUICK_RETRIEVE" ]; then
    # Check common install locations
    for CANDIDATE in \
        "/workspace/gitmem/dist/hooks/quick-retrieve.js" \
        "$(npm root -g 2>/dev/null)/gitmem/dist/hooks/quick-retrieve.js" \
        "$(dirname "$(which gitmem 2>/dev/null)")/../lib/node_modules/gitmem/dist/hooks/quick-retrieve.js"; do
        if [ -f "$CANDIDATE" ]; then
            QUICK_RETRIEVE="$CANDIDATE"
            break
        fi
    done
fi

if [ ! -f "$QUICK_RETRIEVE" ]; then
    # Can't find quick-retrieve module — fail open
    exit 0
fi

# Call quick-retrieve with prompt and level
# Timeout: 2.5s (leave 500ms buffer within 3s hook timeout)
RESULT=$(timeout 2.5 node "$QUICK_RETRIEVE" "$PROMPT" "$RETRIEVAL_LEVEL" 2>/dev/null) || true

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
