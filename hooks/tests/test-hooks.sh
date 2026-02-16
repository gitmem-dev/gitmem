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

# Test 3.2: Non-consequential Bash command → passes silently
setup_state 10 60
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ -z "$OUTPUT" ]; then
    pass "Non-consequential Bash (ls) → passes silently"
else
    fail "Non-consequential Bash → passes silently" \
         "exit 0, empty output" \
         "exit=$EXIT_CODE, output='$OUTPUT'"
fi

# Test 3.3: Consequential Bash (git push) with no recall → nags after >3 calls
setup_state 0 0
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"

# Run 4 git push calls to exceed the 3-call threshold
for i in 1 2 3; do
    echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
        bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null > /dev/null
done
# 4th call should trigger nag
OUTPUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "RECALL REMINDER"; then
    pass "Consequential action + no recall + >3 calls → nags"
else
    fail "Consequential action + >3 calls → nags" \
         "Contains 'RECALL REMINDER'" \
         "$OUTPUT"
fi

# Test 3.4: Write to .sql file → consequential
setup_state 5 0
create_session_registry "test-session"
create_session_data "test-session" "[]" "[]"
OUTPUT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/migration.sql"}}' | \
    bash "$SCRIPT_DIR/scripts/recall-check.sh" 2>/dev/null)

if echo "$OUTPUT" | grep -q "RECALL REMINDER"; then
    pass "Write .sql file + no recall → nags"
else
    fail "Write .sql file → nags" \
         "Contains 'RECALL REMINDER'" \
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
