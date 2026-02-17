# GitMem Cursor Wizard — Clean Room Test Plan

**Date:** 2026-02-16
**Purpose:** Validate `npx gitmem-mcp init` for Cursor IDE users in a clean environment. Mirrors WIZARD-TEST-PLAN.md but for Cursor.

---

## Launch (on your Mac)

```bash
cd ~/nTEG-Labs/gitmem
./testing/clean-room/cursor-test.sh
```

This builds a Docker container with:
- Node 20, git, curl, jq
- `gitmem-mcp` installed from local source (not npm registry)
- A fresh git repo at `/home/developer/my-project`
- `.cursor/` directory present (triggers auto-detection)
- You as `developer` user in a bash shell

**No gitmem config exists yet.** No `.gitmem/`, no `.cursor/mcp.json`, no `.cursorrules`, no hooks.

---

## Phase 1: Wizard Interactive Mode

### Test 1.1 — Run the wizard

```bash
npx gitmem-mcp init
```

**Observe:**
- [ ] Banner says **"Setup for Cursor"** (not Claude Code)
- [ ] Says `(client: cursor — auto-detected)`
- [ ] Step 1 (Memory Store): asks to create `.gitmem/` — say **Y**
- [ ] Step 2 (MCP Server): asks to add gitmem to `.cursor/mcp.json` — say **Y**
- [ ] Step 3 (Project Instructions): asks to create `.cursorrules` — say **Y**
- [ ] Step 4 (Lifecycle Hooks): asks to install hooks to `.cursor/hooks.json` — say **Y**
- [ ] Step 5 (Gitignore): asks to add `.gitmem/` to `.gitignore` — say **Y**
- [ ] Summary at end shows all **5 steps** completed (not 6 — no permissions step)
- [ ] No errors or stack traces
- [ ] Final message says **"Open Cursor (Agent mode)"** not "Open Claude"

### Test 1.2 — Verify what was created

```bash
# Memory store
ls .gitmem/
# Expected: config.json, learnings.json, sessions.json, decisions.json, scar-usage.json, hooks/

# Starter scars
cat .gitmem/learnings.json | jq '. | length'
# Expected: 12

# MCP server config — Cursor-specific path
cat .cursor/mcp.json | jq .
# Expected: mcpServers.gitmem with command "npx" and args ["-y", "gitmem-mcp"]

# Instructions file — .cursorrules, NOT CLAUDE.md
head -3 .cursorrules
# Expected: # --- gitmem:start ---

# Hooks — Cursor format
cat .cursor/hooks.json | jq '.hooks | keys'
# Expected: ["afterMCPExecution", "beforeMCPExecution", "sessionStart", "stop"]

# Gitignore
cat .gitignore
# Expected: contains .gitmem/
```

- [ ] All 5 artifacts exist and are correct
- [ ] Free tier detected (no SUPABASE_URL set)
- [ ] No orchestra-specific content leaked

### Test 1.3 — What should NOT exist

```bash
ls .mcp.json 2>&1          # Should say "No such file"
ls CLAUDE.md 2>&1           # Should say "No such file"
ls -d .claude 2>&1          # Should say "No such file"
```

- [ ] None of the Claude-specific files were created

### Test 1.4 — Content leak check

```bash
grep -ri "claude" .cursorrules            # Should return nothing
grep -ri "claude" .cursor/mcp.json        # Should return nothing
grep -ri "CLAUDE.md" .cursorrules         # Should return nothing
grep -ri "orchestra" .gitmem/config.json  # Should return nothing
```

- [ ] Zero Claude/orchestra references in any generated file

### Test 1.5 — Hook format check

```bash
# Cursor hooks use flat {command, timeout} — NOT nested {hooks: [{type, command}]}
cat .cursor/hooks.json | jq '.hooks.sessionStart[0]'
# Expected: {"command": "bash .gitmem/hooks/session-start.sh", "timeout": 5000}

# Events use camelCase — NOT PascalCase
cat .cursor/hooks.json | jq '.hooks | keys'
# Expected: sessionStart, beforeMCPExecution, afterMCPExecution, stop
# NOT: SessionStart, PreToolUse, PostToolUse, Stop
```

- [ ] Hook entries are `{command, timeout}` objects (Cursor format)
- [ ] Event names are camelCase (Cursor convention)
- [ ] Hook scripts exist at the referenced paths

```bash
ls .gitmem/hooks/
# Expected: session-start.sh, credential-guard.sh, recall-check.sh, post-tool-use.sh, session-close-check.sh
```

- [ ] All referenced hook scripts are present

### Test 1.6 — Health check

```bash
npx gitmem-mcp check
```

- [ ] Tier shows "free"
- [ ] All checks pass
- [ ] No crash

### Test 1.7 — Idempotency

```bash
npx gitmem-mcp init --yes
```

- [ ] Wizard detects existing config for each step
- [ ] Shows "already exists" or "merged" messages (not "created")
- [ ] Scar count still 12 (not 24 — no duplicates)
- [ ] No files corrupted
- [ ] `.cursor/mcp.json` still has exactly one `gitmem` entry
- [ ] `.cursorrules` gitmem section not duplicated

```bash
cat .gitmem/learnings.json | jq '. | length'
# Expected: still 12

grep -c "gitmem:start" .cursorrules
# Expected: 1 (not 2)
```

---

## Phase 2: Uninstall

### Test 2.1 — Clean uninstall (preserve data)

```bash
npx gitmem-mcp uninstall
```

- [ ] Says **"Uninstall (Cursor)"** — not "Uninstall (Claude Code)"
- [ ] Shows **4 steps** (not 5 — no permissions step)
- [ ] Step 1: Removes gitmem section from `.cursorrules`
- [ ] Step 2: Removes gitmem from `.cursor/mcp.json`
- [ ] Step 3: Removes gitmem hooks from `.cursor/hooks.json`
- [ ] Step 4: Asks about `.gitmem/` directory — say **N** (preserve)
- [ ] Summary shows what was removed

```bash
# Verify removal
cat .cursor/mcp.json | jq .
# Expected: {"mcpServers": {}} (empty, not deleted)

cat .cursor/hooks.json | jq '.hooks | keys'
# Expected: empty or no gitmem hooks

ls .cursorrules 2>&1
# Expected: "No such file" (was gitmem-only, so deleted)

ls .gitmem/
# Expected: still exists (data preserved)
```

### Test 2.2 — Uninstall does NOT touch Claude files

```bash
# These should still not exist (never created)
ls .mcp.json 2>&1       # "No such file"
ls CLAUDE.md 2>&1        # "No such file"
ls -d .claude 2>&1       # "No such file"
```

- [ ] Uninstall only touched Cursor-specific paths

### Test 2.3 — Uninstall idempotency

```bash
npx gitmem-mcp uninstall --yes
```

- [ ] Handles gracefully — "No gitmem hooks found" or similar
- [ ] No crashes or errors
- [ ] `.gitmem/` still preserved

### Test 2.4 — Reinstall after uninstall

```bash
npx gitmem-mcp init --yes
```

- [ ] Fresh install works after uninstall
- [ ] 12 starter scars loaded (not 24)
- [ ] All config files recreated correctly

---

## Phase 3: Edge Cases

### Test 3.1 — Force client flag

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
rm -rf .cursor                         # remove auto-detection signal
npx gitmem-mcp init --client cursor --yes
```

- [ ] Creates Cursor files even without `.cursor/` directory
- [ ] `.cursor/mcp.json` created (wizard creates the directory)
- [ ] `.cursorrules` created
- [ ] `.cursor/hooks.json` created

### Test 3.2 — Dual-client project (both .cursor/ and .claude/ exist)

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
mkdir -p .cursor .claude
npx gitmem-mcp init --yes
```

- [ ] Auto-detection picks one client (document which)
- [ ] Only one set of files created (not both)
- [ ] Output states which client was chosen and why

### Test 3.3 — Existing .cursorrules with user content

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
mkdir -p .cursor

# Create a .cursorrules with existing user rules
cat > .cursorrules << 'EOF'
# My project rules
- Always use TypeScript
- Prefer functional style
EOF

npx gitmem-mcp init --yes
```

- [ ] Gitmem section **appended** to existing content (not replacing)
- [ ] User's original rules preserved above gitmem section
- [ ] Both markers present: `# --- gitmem:start ---` and `# --- gitmem:end ---`

```bash
head -3 .cursorrules
# Expected: # My project rules (user content preserved)

grep "gitmem:start" .cursorrules
# Expected: found (gitmem section appended)
```

### Test 3.4 — Existing .cursor/mcp.json with other servers

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
mkdir -p .cursor

# Create .cursor/mcp.json with an existing server
cat > .cursor/mcp.json << 'EOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  }
}
EOF

npx gitmem-mcp init --yes
```

- [ ] Gitmem entry **added** alongside existing server
- [ ] Filesystem server preserved
- [ ] Both servers in final `.cursor/mcp.json`

```bash
cat .cursor/mcp.json | jq '.mcpServers | keys'
# Expected: ["filesystem", "gitmem"]
```

Then uninstall and verify the other server survives:

```bash
npx gitmem-mcp uninstall --yes
cat .cursor/mcp.json | jq '.mcpServers | keys'
# Expected: ["filesystem"] (gitmem removed, filesystem preserved)
```

### Test 3.5 — Existing .cursor/hooks.json with user hooks

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
mkdir -p .cursor

# Create hooks.json with existing user hooks
cat > .cursor/hooks.json << 'EOF'
{
  "hooks": {
    "sessionStart": [
      {
        "command": "echo 'my custom hook'",
        "timeout": 1000
      }
    ]
  }
}
EOF

npx gitmem-mcp init --yes
```

- [ ] Gitmem hooks **merged** with existing hooks
- [ ] User's custom sessionStart hook preserved
- [ ] sessionStart array has both user hook AND gitmem hook

```bash
cat .cursor/hooks.json | jq '.hooks.sessionStart | length'
# Expected: 2 (user hook + gitmem hook)
```

Then uninstall:

```bash
npx gitmem-mcp uninstall --yes
cat .cursor/hooks.json | jq '.hooks.sessionStart'
# Expected: array with only the user's custom hook (gitmem removed)
```

---

## Pass/Fail Matrix

### Phase 1: Wizard

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 1.1 | Wizard interactive mode (5 steps) | | |
| 1.2 | All 5 artifacts created correctly | | |
| 1.3 | No Claude-specific files | | |
| 1.4 | No content leaks | | |
| 1.5 | Hook format correct (Cursor style) | | |
| 1.6 | Health check passes | | |
| 1.7 | Idempotency (no duplicates) | | |

### Phase 2: Uninstall

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 2.1 | Uninstall preserves data (4 steps) | | |
| 2.2 | Uninstall doesn't touch Claude files | | |
| 2.3 | Uninstall idempotency | | |
| 2.4 | Reinstall after uninstall | | |

### Phase 3: Edge Cases

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 3.1 | Force --client cursor flag | | |
| 3.2 | Dual-client auto-detection | | |
| 3.3 | Preserves existing .cursorrules content | | |
| 3.4 | Preserves other MCP servers | | |
| 3.5 | Preserves user hooks on merge/uninstall | | |

**Ship criteria:** All Phase 1 and Phase 2 tests pass. Phase 3 edge cases should pass but individual failures are not blockers if documented.

---

## Notes

- This tests **free tier only** (no Supabase in clean room)
- No Cursor IDE in the container — this tests CLI/wizard behavior only
- Live Cursor IDE testing (MCP connection, Agent mode, hooks firing) requires opening the project in Cursor on your Mac
- For live testing: install from local source (`npm pack && npm install -g gitmem-mcp-*.tgz`), then open the test project in Cursor
