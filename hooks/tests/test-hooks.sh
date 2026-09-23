#!/bin/bash
# ============================================================================
# gitmem-hooks — Integration Tests
# Tests all four hook scripts against real scenarios
#
# Uses multi-session registry format:
#   - active-sessions.json with {"sessions": [...]} array
#   - Per-session data at .gitmem/sessions/{session_id}/session.json
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${GREEN}PASS${NC}: $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${RED}FAIL${NC}: $1"
    echo -e "        Expected: $2"
    echo -e "        Got:      $3"
}

# ============================================================================
# Setup: create a temp workspace that simulates the project directory
# ============================================================================

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cd "$TMPDIR"

# GIT-99: the hooks resolve .gitmem like the server does (GITMEM_DIR, then
# GITMEM_HOME/.gitmem, then ~/.gitmem), no longer from cwd. These tests used to
# rely on cwd = $TMPDIR finding $TMPDIR/.gitmem; point the hooks there
# explicitly instead — and, unpointed, they would read the developer's ~/.gitmem.
export GITMEM_DIR="$TMPDIR/.gitmem"
unset GITMEM_HOME

# ============================================================================
# Helpers: multi-session registry format
# ============================================================================

# Create multi-session registry (replaces old active-session.json singular)
create_session_registry() {
    local sid="${1:-test-session}"
    mkdir -p "$TMPDIR/.gitmem"
    echo "{\"sessions\":[{\"session_id\":\"$sid\"}]}" > "$TMPDIR/.gitmem/active-sessions.json"
}

# Remove session registry and per-session data
remove_session_registry() {
    rm -f "$TMPDIR/.gitmem/active-sessions.json"
    rm -rf "$TMPDIR/.gitmem/sessions"
}

# Create per-session data file (needed by recall-check.sh for scar/confirmation checks)
create_session_data() {
    local sid="${1:-test-session}"
    local surfaced_scars="${2:-[]}"
    local confirmations="${3:-[]}"
    mkdir -p "$TMPDIR/.gitmem/sessions/$sid"
    echo "{\"surfaced_scars\":$surfaced_scars,\"confirmations\":$confirmations}" > "$TMPDIR/.gitmem/sessions/$sid/session.json"
}

# Helper: check if gitmem binary exists on disk (affects detection tests)
gitmem_binary_on_disk() {
    for p in "/workspace/gitmem/dist/index.js"; do
        [ -f "$p" ] && return 0
    done
    command -v gitmem &>/dev/null && return 0
    return 1
}

# Helper: set up state dir with known values
setup_state() {
    local tool_count="${1:-0}"
    local start_offset="${2:-0}"  # seconds ago

    rm -rf /tmp/gitmem-hooks-*
    export CLAUDE_SESSION_ID="test-$$"
    local STATE_DIR="/tmp/gitmem-hooks-test-$$"
    mkdir -p "$STATE_DIR"
    echo "$tool_count" > "$STATE_DIR/tool_call_count"
    echo $(($(date +%s) - start_offset)) > "$STATE_DIR/start_time"
    rm -f "$STATE_DIR/stop_hook_active"
}

# ============================================================================
# TEST GROUP 1: session-start.sh
# ============================================================================

echo ""
echo -e "${YELLOW}=== SessionStart Hook ===${NC}"

# Test 1.1: Gitmem detected in .mcp.json
echo '{"mcpServers":{"gitmem":{"command":"node","args":["/path/to/gitmem"]}}}' > "$TMPDIR/.mcp.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "SESSION START"; then
    pass "Gitmem detected → outputs session start instruction"
else
    fail "Gitmem detected → outputs session start instruction" \
         "Contains 'SESSION START'" \
         "$OUTPUT"
fi

# Test 1.2: Output is plain text, not JSON
if echo "$OUTPUT" | grep -q "additionalContext"; then
    fail "Output is plain text, not JSON" \
         "No JSON additionalContext" \
         "Found 'additionalContext' in output"
else
    pass "Output is plain text, not JSON"
fi

# Test 1.2b (GIT-115): the project hint comes from the repo's .gitmem/config.json,
# with or without jq (node fallback).
# A repo of its own: the suite's GITMEM_DIR ($TMPDIR/.gitmem) is the store.
mkdir -p "$TMPDIR/repo-git115/.gitmem"
cp "$TMPDIR/.mcp.json" "$TMPDIR/repo-git115/.mcp.json"
echo '{"project":"acme-hooks"}' > "$TMPDIR/repo-git115/.gitmem/config.json"
OUTPUT=$(cd "$TMPDIR/repo-git115" && echo '{}' | bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null)
if echo "$OUTPUT" | grep -q 'session_start(project: "acme-hooks")'; then
    pass "Project hint read from the repo's .gitmem/config.json"
else
    fail "Project hint read from the repo's .gitmem/config.json" \
         'Contains session_start(project: "acme-hooks")' \
         "$OUTPUT"
fi
rm -rf "$TMPDIR/repo-git115"

# Test 1.3: Gitmem NOT in .mcp.json (may still detect via disk fallback)
rm "$TMPDIR/.mcp.json"
echo '{"mcpServers":{"other-tool":{}}}' > "$TMPDIR/.mcp.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null)

if gitmem_binary_on_disk; then
    # Gitmem binary exists on disk — detection cascade finds it even without .mcp.json
    if echo "$OUTPUT" | grep -q "SESSION START"; then
        pass "Gitmem not in .mcp.json but found on disk → still detected (correct cascade)"
    else
        fail "Gitmem not in .mcp.json but found on disk → still detected" \
             "Contains 'SESSION START' (disk fallback)" \
             "$OUTPUT"
    fi
else
    if echo "$OUTPUT" | grep -q "not detected"; then
        pass "Gitmem not in .mcp.json, no binary → outputs 'not detected' message"
    else
        fail "Gitmem not in .mcp.json, no binary → outputs 'not detected'" \
             "Contains 'not detected'" \
             "$OUTPUT"
    fi
fi

# Test 1.4: No .mcp.json at all (may still detect via disk fallback)
rm "$TMPDIR/.mcp.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null)

if gitmem_binary_on_disk; then
    if echo "$OUTPUT" | grep -q "SESSION START"; then
        pass "No .mcp.json but gitmem on disk → still detected (correct cascade)"
    else
        fail "No .mcp.json but gitmem on disk → still detected" \
             "Contains 'SESSION START' (disk fallback)" \
             "$OUTPUT"
    fi
else
    if echo "$OUTPUT" | grep -q "not detected"; then
        pass "No .mcp.json file, no binary → outputs 'not detected' message"
    else
        fail "No .mcp.json file, no binary → outputs 'not detected'" \
             "Contains 'not detected'" \
             "$OUTPUT"
    fi
fi

# Test 1.5: gitmem-mcp alternate name detected
echo '{"mcpServers":{"gitmem-mcp":{"command":"node"}}}' > "$TMPDIR/.mcp.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "SESSION START"; then
    pass "gitmem-mcp alternate name → detected"
else
    fail "gitmem-mcp alternate name → detected" \
         "Contains 'SESSION START'" \
         "$OUTPUT"
fi

# Test 1.6: Creates state directory
if [ -d "/tmp/gitmem-hooks-$$" ] || ls /tmp/gitmem-hooks-* &>/dev/null; then
    pass "Creates /tmp/gitmem-hooks-{session} state directory"
else
    fail "Creates /tmp/gitmem-hooks-{session} state directory" \
         "Directory exists" \
         "Not found"
fi

# Clean up state dirs created by tests
rm -rf /tmp/gitmem-hooks-*

# ============================================================================
# TEST GROUP 2: session-close-check.sh (Stop hook)
# ============================================================================

echo ""
echo -e "${YELLOW}=== Stop Hook (Session Close Check) ===${NC}"

# Test 2.1: No session, no work → allows stop
setup_state 0 0
remove_session_registry
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "No session, no work → allows stop (exit 0, no block)"
else
    fail "No session, no work → allows stop" \
         "exit 0, no block output" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.2: THE BUG FIX — session_start called, <5 calls, <5 min → allows stop
setup_state 2 60  # 2 tool calls, 60 seconds ago
create_session_registry "test-session"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "session_start + <5 calls + <5 min → allows stop (BUG FIX)"
else
    fail "session_start + <5 calls + <5 min → allows stop (BUG FIX)" \
         "exit 0, no block" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.3: session_start called, >5 tool calls → blocks
setup_state 10 60  # 10 tool calls, 60 seconds ago
create_session_registry "test-session"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "block"; then
    pass "session_start + >5 calls → blocks (requires session_close)"
else
    fail "session_start + >5 calls → blocks" \
         "Output contains 'block'" \
         "$OUTPUT"
fi

# Test 2.4: session_start called, >5 min → blocks
setup_state 2 600  # 2 tool calls, 600 seconds (10 min) ago
create_session_registry "test-session"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "block"; then
    pass "session_start + >5 min → blocks (requires session_close)"
else
    fail "session_start + >5 min → blocks" \
         "Output contains 'block'" \
         "$OUTPUT"
fi

# Test 2.5: Session properly closed (registry empty) → allows stop
setup_state 10 600  # meaningful work
remove_session_registry
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "Session closed (registry removed) → allows stop"
else
    fail "Session closed → allows stop" \
         "exit 0, no block" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.6: Infinite loop guard — second stop attempt passes through
setup_state 10 60
create_session_registry "test-session"
# First stop — should block
echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null > /dev/null
# Second stop — should pass through (guard active)
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "Infinite loop guard → second stop always passes"
else
    fail "Infinite loop guard → second stop passes" \
         "exit 0, no block on second attempt" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.7: No state dir at all, no session → allows stop
rm -rf /tmp/gitmem-hooks-*
remove_session_registry
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "No state dir, no session → allows stop"
else
    fail "No state dir → allows stop" \
         "exit 0, no block" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.8: >5 calls but NO session_start → should NOT block
# (meaningful by tool count but no session to close)
setup_state 10 60
remove_session_registry
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass ">5 calls but no session_start → allows stop (nothing to close)"
else
    fail ">5 calls but no session_start → allows stop" \
         "exit 0, no block" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.9: THE REAL BUG — No state dir + active session registry → allows stop
# (Plugin SessionStart hook didn't fire, user called session_start manually,
#  but no tracking data exists. Must NOT block with bogus duration calculation.)
rm -rf /tmp/gitmem-hooks-*
create_session_registry "test-session"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && ! echo "$OUTPUT" | grep -q "block"; then
    pass "No state dir + active session → allows stop (no tracking data)"
else
    fail "No state dir + active session → allows stop" \
         "exit 0, no block (graceful degradation)" \
         "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.10: No state dir + active session → creates state dir for next time
rm -rf /tmp/gitmem-hooks-*
create_session_registry "test-session"
echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null > /dev/null
if [ -d "/tmp/gitmem-hooks-test-$$" ] && [ -f "/tmp/gitmem-hooks-test-$$/start_time" ]; then
    pass "No state dir + session → creates state dir for future tracking"
else
    fail "No state dir + session → creates state dir" \
         "State dir exists with start_time" \
         "Dir or file missing"
fi

# ============================================================================
# TEST GROUP 3: recall-check.sh (PreToolUse hook)
# ============================================================================

echo ""
echo -e "${YELLOW}=== PreToolUse Hook (Recall Check) ===${NC}"

# Test 3.1: No active session → passes silently
remove_session_registry
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ -z "$OUTPUT" ]; then
    pass "No active session → passes silently"
else
    fail "No active session → passes silently" \
         "exit 0, empty output" \
         "exit=$EXIT_CODE, output='$OUTPUT'"
fi

# Test 3.2: Non-consequential Bash with few tool calls → passes silently
setup_state 3 60  # Only 3 calls — below the 10-call nag threshold
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ -z "$OUTPUT" ]; then
    pass "Non-consequential Bash (ls) + few calls → passes silently"
else
    fail "Non-consequential Bash + few calls → passes silently" \
         "exit 0, empty output" \
         "exit=$EXIT_CODE, output='$OUTPUT'"
fi

# Test 3.3: Non-consequential Bash with many tool calls + no recall → nags
# (Key fix: nag now fires for ALL Bash/Write/Edit, not just consequential)
setup_state 12 0
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "RECALL REMINDER"; then
    pass "Non-consequential Bash + no recall + >10 calls → nags (UX audit fix)"
else
    fail "Non-consequential Bash + >10 calls → nags" \
         "Contains 'RECALL REMINDER'" \
         "$OUTPUT"
fi

# Test 3.4: Write to .ts file + many calls + no recall → nags
# (Previously only .sql/.env files triggered nag; now all Write actions count)
setup_state 15 0
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
OUTPUT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/component.ts"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "RECALL REMINDER"; then
    pass "Write .ts file + no recall + >10 calls → nags (UX audit fix)"
else
    fail "Write .ts file + >10 calls → nags" \
         "Contains 'RECALL REMINDER'" \
         "$OUTPUT"
fi

# Test 3.5: Confirmation gate still only blocks on consequential actions
setup_state 0 0
create_session_registry "test-session"
SCARS='[{"scar_id":"s1","scar_title":"Test scar","scar_severity":"high","surfaced_at":"2026-01-01T00:00:00Z","source":"recall"}]'
create_session_data "test-session" "$SCARS" "[]"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "block"; then
    fail "Non-consequential + unconfirmed scars → does NOT block" \
         "No block decision" \
         "$OUTPUT"
else
    pass "Non-consequential + unconfirmed scars → does NOT block (gate is consequential-only)"
fi

# Test 3.6: Confirmation gate DOES block consequential actions with unconfirmed scars
setup_state 0 0
create_session_registry "test-session"
SCARS='[{"scar_id":"s1","scar_title":"Test scar","scar_severity":"high","surfaced_at":"2026-01-01T00:00:00Z","source":"recall"}]'
create_session_data "test-session" "$SCARS" "[]"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "block"; then
    pass "Consequential + unconfirmed scars → blocks"
else
    fail "Consequential + unconfirmed scars → blocks" \
         "Contains 'block'" \
         "$OUTPUT"
fi

# Test 3.7: Nag cooldown — second nag within 90s is suppressed
setup_state 15 0
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
# First call triggers nag
echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null > /dev/null
# Second call within 90s — should be suppressed
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if [ -z "$OUTPUT" ]; then
    pass "Nag cooldown → second nag within 90s suppressed"
else
    fail "Nag cooldown → suppressed" \
         "Empty output (cooldown active)" \
         "$OUTPUT"
fi

# Test 3.8: Agent that already recalled → no nag even with many tool calls
setup_state 20 0
create_session_registry "test-session"
SCARS='[{"scar_id":"s1","scar_title":"Test scar","scar_severity":"high","surfaced_at":"2026-01-01T00:00:00Z","source":"recall"}]'
CONFS='[{"scar_id":"s1","decision":"APPLYING","evidence":"test"}]'
create_session_data "test-session" "$SCARS" "$CONFS"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if [ -z "$OUTPUT" ]; then
    pass "Agent already recalled + confirmed → no nag"
else
    fail "Already recalled → no nag" \
         "Empty output" \
         "$OUTPUT"
fi

# Clean up
rm -rf /tmp/gitmem-hooks-*

# ============================================================================
# TEST GROUP 4: post-tool-use.sh (PostToolUse hook — audit trail)
# ============================================================================

echo ""
echo -e "${YELLOW}=== PostToolUse Hook (Audit Trail) ===${NC}"

# Test 4.1: No active session → passes silently (no audit written)
remove_session_registry
rm -rf /tmp/gitmem-hooks-*
setup_state 0 0
OUTPUT=$(echo '{"tool_name":"mcp__gitmem__recall","tool_input":{"query":"test"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ -z "$OUTPUT" ] && [ ! -f "/tmp/gitmem-hooks-test-$$/audit.jsonl" ]; then
    pass "No active session → no audit written"
else
    fail "No active session → no audit written" \
         "exit 0, no output, no audit.jsonl" \
         "exit=$EXIT_CODE, output='$OUTPUT', audit exists=$([ -f /tmp/gitmem-hooks-test-$$/audit.jsonl ] && echo yes || echo no)"
fi

# Test 4.2: recall call → LOOKED event logged
setup_state 0 0
create_session_registry "test-session"
OUTPUT=$(echo '{"tool_name":"mcp__gitmem__recall","tool_input":{"query":"deployment verification"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)
EXIT_CODE=$?

AUDIT_FILE="/tmp/gitmem-hooks-test-$$/audit.jsonl"
if [ $EXIT_CODE -eq 0 ] && [ -f "$AUDIT_FILE" ] && grep -q '"type":"LOOKED"' "$AUDIT_FILE"; then
    pass "recall call → LOOKED event in audit.jsonl"
else
    fail "recall call → LOOKED event" \
         "exit 0, audit.jsonl contains LOOKED" \
         "exit=$EXIT_CODE, file=$([ -f $AUDIT_FILE ] && cat $AUDIT_FILE || echo 'missing')"
fi

# Test 4.3: Consequential Bash (git push) → ACTION event logged
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)

if [ -f "$AUDIT_FILE" ] && grep -q '"type":"ACTION"' "$AUDIT_FILE" && grep -q 'git push' "$AUDIT_FILE"; then
    pass "git push → ACTION event in audit.jsonl"
else
    fail "git push → ACTION event" \
         "audit.jsonl contains ACTION + git push" \
         "$([ -f $AUDIT_FILE ] && cat $AUDIT_FILE || echo 'missing')"
fi

# Test 4.4: Non-consequential Bash (ls) → no audit entry
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ ! -f "$AUDIT_FILE" ]; then
    pass "Non-consequential Bash (ls) → no audit entry"
else
    fail "Non-consequential Bash → no audit" \
         "exit 0, no audit.jsonl" \
         "exit=$EXIT_CODE, audit=$([ -f $AUDIT_FILE ] && cat $AUDIT_FILE || echo 'missing')"
fi

# Test 4.5: Write .sql file → ACTION event
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
OUTPUT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/migration.sql"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)

if [ -f "$AUDIT_FILE" ] && grep -q '"type":"ACTION"' "$AUDIT_FILE" && grep -q 'migration.sql' "$AUDIT_FILE"; then
    pass "Write .sql → ACTION event"
else
    fail "Write .sql → ACTION event" \
         "audit.jsonl contains ACTION + migration.sql" \
         "$([ -f $AUDIT_FILE ] && cat $AUDIT_FILE || echo 'missing')"
fi

# Test 4.9: Write .ts file → no audit entry (non-sensitive)
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
OUTPUT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/component.ts"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null)

if [ ! -f "$AUDIT_FILE" ]; then
    pass "Write .ts → no audit entry (non-sensitive)"
else
    fail "Write .ts → no audit" \
         "no audit.jsonl" \
         "$(cat $AUDIT_FILE)"
fi

# Test 4.10: Multiple events → JSONL appends (multiple lines)
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
echo '{"tool_name":"mcp__gitmem__recall","tool_input":{"query":"test"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null
echo '{"tool_name":"mcp__gitmem__search","tool_input":{"query":"hooks"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null

LINE_COUNT=$(wc -l < "$AUDIT_FILE" 2>/dev/null || echo "0")
LOOKED_COUNT=$(grep -c '"type":"LOOKED"' "$AUDIT_FILE" 2>/dev/null || echo "0")
ACTION_COUNT=$(grep -c '"type":"ACTION"' "$AUDIT_FILE" 2>/dev/null || echo "0")

if [ "$LINE_COUNT" -eq 3 ] && [ "$LOOKED_COUNT" -eq 2 ] && [ "$ACTION_COUNT" -eq 1 ]; then
    pass "Multiple events → JSONL appends correctly (2 LOOKED, 1 ACTION)"
else
    fail "Multiple events → correct JSONL" \
         "3 lines, 2 LOOKED, 1 ACTION" \
         "lines=$LINE_COUNT, looked=$LOOKED_COUNT, action=$ACTION_COUNT"
fi

# Test 4.11: Hook always exits 0 (never blocks)
setup_state 0 0
create_session_registry "test-session"
rm -f "/tmp/gitmem-hooks-test-$$/audit.jsonl"
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/post-tool-use.sh" 2>/dev/null
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    pass "PostToolUse hook always exits 0 (non-blocking)"
else
    fail "PostToolUse exits 0" \
         "exit 0" \
         "exit=$EXIT_CODE"
fi

# Clean up
rm -rf /tmp/gitmem-hooks-*

# ============================================================================
# TEST GROUP: .gitmem root resolution (GIT-99)
# ============================================================================

echo ""
echo -e "${YELLOW}=== Root Resolution (GIT-99) ===${NC}"

# Resolve in a clean subshell and print GITMEM_ROOT.
resolve_root() {
    ( cd "$1" && shift && env -u GITMEM_DIR -u GITMEM_HOME "$@" bash -c '. "$0/scripts/resolve-root.sh"; printf "%s" "$GITMEM_ROOT"' "$SCRIPT_DIR" )
}
R_HOME="$TMPDIR/r-home"; R_GH="$TMPDIR/r-gh"; R_DIR="$TMPDIR/r-dir/.gitmem"; R_CWD="$TMPDIR/r-cwd"
mkdir -p "$R_HOME" "$R_GH" "$R_DIR" "$R_CWD/.gitmem"

GOT=$(resolve_root "$R_CWD" HOME="$R_HOME" GITMEM_HOME="$R_GH" GITMEM_DIR="$R_DIR")
[ "$GOT" = "$R_DIR" ] && pass "GITMEM_DIR wins over GITMEM_HOME and HOME" \
    || fail "GITMEM_DIR precedence" "$R_DIR" "$GOT"

GOT=$(resolve_root "$R_CWD" HOME="$R_HOME" GITMEM_HOME="$R_GH")
[ "$GOT" = "$R_GH/.gitmem" ] && pass "GITMEM_HOME/.gitmem wins over HOME" \
    || fail "GITMEM_HOME precedence" "$R_GH/.gitmem" "$GOT"

GOT=$(resolve_root "$R_CWD" HOME="$R_HOME")
[ "$GOT" = "$R_HOME/.gitmem" ] && pass "falls back to ~/.gitmem — never cwd/.gitmem" \
    || fail "HOME fallback" "$R_HOME/.gitmem" "$GOT"

GOT=$(resolve_root "$R_CWD" HOME="$R_HOME" GITMEM_DIR="rel/.gitmem")
[ "$GOT" = "$R_CWD/rel/.gitmem" ] && pass "relative GITMEM_DIR is made absolute" \
    || fail "relative GITMEM_DIR" "$R_CWD/rel/.gitmem" "$GOT"

# Hooks find the store from any cwd, and ignore a decoy .gitmem in cwd.
setup_state 10 60
create_session_registry "test-session"
echo '{"sessions":[]}' > "$R_CWD/.gitmem/active-sessions.json"
OUTPUT=$( cd "$R_CWD" && echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null )
echo "$OUTPUT" | grep -q '"decision": "block"' && pass "Stop hook reads GITMEM_DIR from an unrelated cwd (decoy cwd/.gitmem ignored)" \
    || fail "Stop hook cwd independence" "block" "$OUTPUT"

# The Stop hook names the absolute payload path it resolved.
PAYLOAD_EXPECTED="$GITMEM_DIR/closing-payload.json"
echo "$OUTPUT" | grep -qF "WRITE structured payload to $PAYLOAD_EXPECTED (this exact absolute path" \
    && pass "Stop hook text prints the resolved absolute payload path" \
    || fail "Stop hook payload path" "$PAYLOAD_EXPECTED" "$OUTPUT"
echo "$OUTPUT" | (command -v node >/dev/null && node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{JSON.parse(d)})' 2>/dev/null) \
    && pass "Stop hook output with the path is valid JSON" \
    || fail "Stop hook JSON" "parseable JSON" "$OUTPUT"

# A path that needs escaping still yields valid JSON.
Q_DIR="$TMPDIR/q\"uote/.gitmem"; mkdir -p "$Q_DIR"
echo '{"sessions":[{"session_id":"q"}]}' > "$Q_DIR/active-sessions.json"
setup_state 10 60
OUTPUT=$( GITMEM_DIR="$Q_DIR" bash -c 'echo "{}" | bash "$0/scripts/session-close-check.sh"' "$SCRIPT_DIR" 2>/dev/null )
echo "$OUTPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.reason.includes(process.argv[1]))process.exit(1)})' "$Q_DIR/closing-payload.json" 2>/dev/null \
    && pass "payload path with a quote is JSON-escaped" \
    || fail "payload path escaping" "valid JSON containing $Q_DIR/closing-payload.json" "$OUTPUT"

# Registry entries whose pid is dead on this host are skipped.
DEAD_PID=99999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID - 1)); done
HOST=$(hostname)
setup_state 10 60
echo "{\"sessions\":[{\"session_id\":\"dead-one\",\"pid\":$DEAD_PID,\"hostname\":\"$HOST\",\"started_at\":\"2026-09-21T00:00:00Z\"}]}" > "$GITMEM_DIR/active-sessions.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
! echo "$OUTPUT" | grep -q "block" && pass "Stop hook ignores a registry entry whose server pid is dead" \
    || fail "dead pid skipped (Stop)" "no block" "$OUTPUT"

setup_state 10 60
echo "{\"sessions\":[{\"session_id\":\"dead-one\",\"pid\":$DEAD_PID,\"hostname\":\"other-host-$HOST\",\"started_at\":\"2026-09-21T00:00:00Z\"}]}" > "$GITMEM_DIR/active-sessions.json"
OUTPUT=$(echo '{}' | bash "$SCRIPT_DIR/scripts/session-close-check.sh" 2>/dev/null)
echo "$OUTPUT" | grep -q "block" && pass "an entry from another host is kept (its pid cannot be checked here)" \
    || fail "other-host entry kept" "block" "$OUTPUT"

# recall-check uses the newest LIVE session, not sessions[0].
remove_session_registry
echo "{\"sessions\":[
  {\"session_id\":\"live-old\",\"pid\":$$,\"hostname\":\"$HOST\",\"started_at\":\"2026-09-21T00:00:00Z\"},
  {\"session_id\":\"dead-new\",\"pid\":$DEAD_PID,\"hostname\":\"$HOST\",\"started_at\":\"2026-09-21T09:00:00Z\"}]}" > "$GITMEM_DIR/active-sessions.json"
create_session_data "live-old" '[{"scar_id":"s1","scar_title":"Unconfirmed","source":"recall"}]' '[]'
create_session_data "dead-new" '[]' '[]'
GOT=$(bash -c '. "$0/scripts/resolve-root.sh"; gitmem_live_session_ids | tr "\n" " "' "$SCRIPT_DIR")
[ "$GOT" = "live-old " ] && pass "gitmem_live_session_ids: newest first, dead pid skipped" \
    || fail "live session ids" "live-old" "$GOT"
setup_state 0 0
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)
echo "$OUTPUT" | grep -q "block" && pass "recall-check reads the live session's scars (dead newer entry skipped)" \
    || fail "recall-check live session" "block on unconfirmed scar of live-old" "$OUTPUT"

# The pid check needs no `ps` (minimal images have none).
GOT=$(PATH="$TMPDIR/no-ps-bin" "$BASH" -c '. "$0/scripts/resolve-root.sh"; gitmem_pid_alive $$ && echo alive; gitmem_pid_alive '"$DEAD_PID"' || echo dead' "$SCRIPT_DIR" 2>/dev/null | tr "\n" " ")
[ "$GOT" = "alive dead " ] && pass "gitmem_pid_alive works with no ps on PATH" \
    || fail "pid check without ps" "alive dead" "$GOT"
GOT=$(bash -c '. "$0/scripts/resolve-root.sh"; gitmem_pid_alive 1 && echo alive' "$SCRIPT_DIR")
[ "$GOT" = "alive" ] && pass "a live pid owned by another user (EPERM) counts as alive" \
    || fail "EPERM pid alive" "alive" "$GOT"

remove_session_registry

# ============================================================================
# TEST GROUP: portability (GIT-116)
# ============================================================================

echo ""
echo -e "${YELLOW}=== Portability (GIT-116) ===${NC}"

# A PATH holding every command on the current PATH except the ones named.
path_without() {
    local out="$1"; shift
    mkdir -p "$out"
    local d f n old_ifs="$IFS"
    IFS=:
    for d in $PATH; do
        [ -d "$d" ] || continue
        for f in "$d"/*; do
            n=$(basename "$f")
            [ -x "$f" ] && [ ! -e "$out/$n" ] && ln -s "$f" "$out/$n" 2>/dev/null || true
        done
    done
    IFS="$old_ifs"
    for n in "$@"; do rm -f "$out/$n"; done
    echo "$out"
}

# A fake installed package: hooks/scripts next to dist/hooks/quick-retrieve.js.
PKG="$TMPDIR/pkg"
mkdir -p "$PKG/hooks/scripts" "$PKG/dist/hooks"
cp "$SCRIPT_DIR"/scripts/*.sh "$PKG/hooks/scripts/"
cat > "$PKG/dist/hooks/quick-retrieve.js" <<'STUB'
process.stdout.write("STUB-SCAR for: " + process.argv[2]);
STUB
PROMPT_JSON='{"prompt":"add a retry to the deploy script before the migration"}'

NO_TIMEOUT_PATH=$(path_without "$TMPDIR/bin-no-timeout" timeout gtimeout)
OUT=$(echo "$PROMPT_JSON" | PATH="$NO_TIMEOUT_PATH" bash "$PKG/hooks/scripts/auto-retrieve-hook.sh" 2>/dev/null) || true
echo "$OUT" | grep -q "STUB-SCAR" && pass "auto-retrieve works with no timeout/gtimeout on PATH (stock macOS)" \
    || fail "auto-retrieve without timeout" "STUB-SCAR in additionalContext" "$OUT"

NO_NODE_PATH=$(path_without "$TMPDIR/bin-no-node" node)
set +e
ERR=$(echo "$PROMPT_JSON" | PATH="$NO_NODE_PATH" bash "$PKG/hooks/scripts/auto-retrieve-hook.sh" 2>&1 >/dev/null); CODE=$?
set -e
[ "$CODE" = "1" ] && echo "$ERR" | grep -q "node is not on the hook's PATH" \
    && pass "no node: visible non-blocking error (exit 1, reason on stderr)" \
    || fail "no node visible" "exit 1 + reason" "exit=$CODE err=$ERR"

# Hooks copied into a repo (init / install-hooks): no dist beside them.
COPIED="$TMPDIR/repo/.gitmem/hooks"; mkdir -p "$COPIED"; cp "$SCRIPT_DIR"/scripts/*.sh "$COPIED/"
EMPTY_HOME="$TMPDIR/empty-home"; mkdir -p "$EMPTY_HOME"
NO_PKG_PATH=$(path_without "$TMPDIR/bin-no-pkg" gitmem-mcp npm)
set +e
ERR=$(echo "$PROMPT_JSON" | HOME="$EMPTY_HOME" PATH="$NO_PKG_PATH" bash "$COPIED/auto-retrieve-hook.sh" 2>&1 >/dev/null); CODE=$?
set -e
[ "$CODE" = "1" ] && echo "$ERR" | grep -q "quick-retrieve.js not found" \
    && pass "module not found: visible non-blocking error, not a silent 'nothing relevant'" \
    || fail "module not found visible" "exit 1 + reason" "exit=$CODE err=$ERR"

NPX_HOME="$TMPDIR/npx-home"
mkdir -p "$NPX_HOME/.npm/_npx/abc123/node_modules/gitmem-mcp/dist/hooks"
cp "$PKG/dist/hooks/quick-retrieve.js" "$NPX_HOME/.npm/_npx/abc123/node_modules/gitmem-mcp/dist/hooks/"
OUT=$(echo "$PROMPT_JSON" | HOME="$NPX_HOME" PATH="$NO_PKG_PATH" bash "$COPIED/auto-retrieve-hook.sh" 2>/dev/null) || true
echo "$OUT" | grep -q "STUB-SCAR" && pass "copied hooks find gitmem-mcp in npx's cache" \
    || fail "npx cache lookup" "STUB-SCAR" "$OUT"

# session-start: no pgrep must not stall the 10 s hook for the 7 s gate.
NO_PGREP_PATH=$(path_without "$TMPDIR/bin-no-pgrep" pgrep)
T0=$(date +%s)
OUT=$(echo '{}' | GITMEM_ENABLED=true PATH="$NO_PGREP_PATH" bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null) || true
ELAPSED=$(( $(date +%s) - T0 ))
[ "$ELAPSED" -lt 4 ] && echo "$OUT" | grep -q "SESSION START" \
    && pass "session-start without pgrep does not stall (${ELAPSED}s)" \
    || fail "session-start without pgrep" "<4s and SESSION START" "${ELAPSED}s: $OUT"

# session-start: an unwritable debug log must not kill the hook under set -e.
BAD_TMP="$TMPDIR/bad-tmp"; mkdir -p "$BAD_TMP/gitmem-hooks-plugin-debug-$(id -u).log"
OUT=$(echo '{}' | GITMEM_ENABLED=true TMPDIR="$BAD_TMP" PATH="$NO_PGREP_PATH" bash "$SCRIPT_DIR/scripts/session-start.sh" 2>/dev/null) || true
echo "$OUT" | grep -q "SESSION START" && pass "session-start survives an unwritable debug log" \
    || fail "unwritable debug log" "SESSION START" "$OUT"

# credential-guard: a quote or backslash in the path must still produce JSON that blocks.
OUT=$(printf '{"tool_name":"Read","tool_input":{"file_path":"/x/we\\"ird\\\\d/.env"}}' | bash "$SCRIPT_DIR/scripts/credential-guard.sh" 2>/dev/null) || true
echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.exit(JSON.parse(d).decision==="block"?0:1)})' 2>/dev/null \
    && pass "credential-guard block is valid JSON for a path with quotes" \
    || fail "credential-guard JSON" "valid JSON, decision block" "$OUT"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${YELLOW}=== Results ===${NC}"
echo -e "  Total: $TOTAL | ${GREEN}Pass: $PASS${NC} | ${RED}Fail: $FAIL${NC}"
echo ""

if [ $FAIL -gt 0 ]; then
    echo -e "${RED}SOME TESTS FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}ALL TESTS PASSED${NC}"
    exit 0
fi
