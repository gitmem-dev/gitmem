# GitMem Wizard — Clean Room Test Plan

**Date:** 2026-02-15
**Purpose:** Validate the `npx gitmem-mcp init` wizard as a first-time user in a clean environment.

---

## Launch (on your Mac)

```bash
cd ~/nTEG-Labs/gitmem
./testing/clean-room/wizard-test.sh
```

This builds a Docker container with:
- Node 20, git, curl, jq
- Claude CLI installed globally
- `gitmem-mcp` npm-installed (but NOT initialized)
- A fresh git repo at `/home/developer/my-project`
- You as `developer` user in a bash shell

**No gitmem config exists yet.** No `.gitmem/`, no `.mcp.json`, no `CLAUDE.md`, no hooks.

---

## Phase 1: Wizard Interactive Mode

### Test 1.1 — Run the wizard

```bash
npx gitmem-mcp init
```

**Observe:**
- [ ] Banner displays with version number
- [ ] Step 1 (Memory Store): asks to create `.gitmem/` — say **Y**
- [ ] Step 2 (MCP Server): asks to add gitmem to `.mcp.json` — say **Y**
- [ ] Step 3 (CLAUDE.md): asks to create/update project instructions — say **Y**
- [ ] Step 4 (Permissions): asks to allow gitmem tools — say **Y**
- [ ] Step 5 (Hooks): asks to install lifecycle hooks — say **Y**
- [ ] Step 6 (Gitignore): asks to add `.gitmem/` to `.gitignore` — say **Y**
- [ ] Summary at end shows all 6 steps completed
- [ ] No errors or stack traces

### Test 1.2 — Verify what was created

```bash
# Memory store
ls .gitmem/
# Expected: config.json, learnings.json, sessions.json, decisions.json, scar-usage.json

# Starter scars
cat .gitmem/learnings.json | jq '. | length'
# Expected: 12

# MCP server config
cat .mcp.json | jq .
# Expected: mcpServers.gitmem with command "npx" and args ["-y", "gitmem-mcp"]

# CLAUDE.md
head -3 CLAUDE.md
# Expected: <!-- gitmem:start -->

# Permissions
cat .claude/settings.json | jq '.permissions.allow'
# Expected: array containing "mcp__gitmem__*"

# Hooks
cat .claude/settings.json | jq '.hooks | keys'
# Expected: ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]

# Gitignore
cat .gitignore
# Expected: contains .gitmem/
```

- [ ] All 6 artifacts exist and are correct
- [ ] Free tier detected (no SUPABASE_URL set)
- [ ] No orchestra-specific content leaked (no "orchestra_dev" in any file)

### Test 1.3 — Health check

```bash
npx gitmem-mcp check
```

- [ ] Tier shows "free"
- [ ] All checks pass (or show expected warnings for free tier — no Supabase)
- [ ] No crash

### Test 1.4 — Idempotency

```bash
npx gitmem-mcp init --yes
```

- [ ] Wizard detects existing config for each step
- [ ] Shows "already exists" or "merged" messages (not "created")
- [ ] Scar count still 12 (not 24 — no duplicates)
- [ ] No files corrupted

```bash
cat .gitmem/learnings.json | jq '. | length'
# Expected: still 12
```

---

## Phase 2: Live Claude Code Session

### Test 2.1 — Launch Claude

```bash
claude
```

- [ ] Claude starts without errors
- [ ] No "invalid JSON" errors from MCP
- [ ] SessionStart hook fires (you should see the session start banner)
- [ ] gitmem session opens successfully

### Test 2.2 — Session lifecycle (type these into Claude)

**Prompt 1 — Session start:**
> Run `gm-open` to start a session

- [ ] Session starts with a session_id
- [ ] No red error toast
- [ ] Agent identity shown (should be "CLI")

**Prompt 2 — Recall scars:**
> Run `gitmem-r` with plan "test the gitmem wizard install"

- [ ] Scars surface from the 12 starter scars
- [ ] No crash or "undefined" errors
- [ ] Results show relevant scar titles

**Prompt 3 — Create a scar:**
> Create a scar with title "test scar" and description "testing wizard install" with severity "low" and counter_arguments ["might not need this", "could be noise"]

- [ ] Scar created successfully
- [ ] Returns confirmation with scar details

**Prompt 4 — Verify scar persists:**
> Search for scars about "wizard install"

- [ ] Finds the scar you just created
- [ ] Shows title "test scar"

**Prompt 5 — Close session:**
> Close this session with a quick close

- [ ] Session closes without errors
- [ ] No "invalid session_id" errors

### Test 2.3 — Exit and verify persistence

Type `/exit` or Ctrl+C to leave Claude.

```bash
# Verify scar was written to local storage
cat .gitmem/learnings.json | jq '. | length'
# Expected: 13 (12 starter + 1 you created)
```

- [ ] Scar count is 13
- [ ] Session was recorded in `.gitmem/sessions.json`

---

## Phase 3: Cross-Session Continuity

### Test 3.1 — Relaunch Claude

```bash
claude
```

**Prompt:**
> What do you know from previous sessions?

- [ ] Agent references the previous session or recalls scars
- [ ] SessionStart hook fires again
- [ ] Previous session context is available

Exit Claude.

---

## Phase 4: Uninstall

### Test 4.1 — Clean uninstall (preserve data)

```bash
npx gitmem-mcp uninstall
```

- [ ] Asks to confirm each removal step
- [ ] Removes gitmem from `.mcp.json`
- [ ] Removes gitmem section from `CLAUDE.md`
- [ ] Removes gitmem hooks from `.claude/settings.json`
- [ ] Removes gitmem permissions
- [ ] **Does NOT delete `.gitmem/` directory** (preserves data by default)
- [ ] Summary shows what was removed

```bash
# Verify removal
cat .mcp.json | jq .
# Expected: empty mcpServers or no gitmem key

cat .claude/settings.json | jq '.hooks'
# Expected: no gitmem hooks (or null/empty)

ls .gitmem/
# Expected: still exists (data preserved)
```

### Test 4.2 — Full uninstall (delete data)

```bash
npx gitmem-mcp uninstall --all
```

- [ ] Deletes `.gitmem/` directory
- [ ] Confirms data deletion before proceeding

```bash
ls .gitmem/ 2>&1
# Expected: "No such file or directory"
```

### Test 4.3 — Reinstall after uninstall

```bash
npx gitmem-mcp init --yes
```

- [ ] Fresh install works after uninstall
- [ ] 12 starter scars loaded
- [ ] All config files recreated

---

## Phase 5: Edge Cases

### Test 5.1 — Dry run mode

```bash
npx gitmem-mcp uninstall --all --yes  # clean slate
npx gitmem-mcp init --dry-run
```

- [ ] Shows what WOULD be configured
- [ ] Creates NO files (verify with `ls .gitmem/` — should not exist)

### Test 5.2 — With project name

```bash
npx gitmem-mcp init --yes --project my-cool-project
```

- [ ] Project name appears in `.gitmem/config.json`

```bash
cat .gitmem/config.json | jq .project
# Expected: "my-cool-project"
```

---

## Pass/Fail Matrix

| # | Test | Pass? |
|---|------|-------|
| 1.1 | Wizard interactive mode | |
| 1.2 | All 6 artifacts created correctly | |
| 1.3 | Health check passes | |
| 1.4 | Idempotency (no duplicates) | |
| 2.1 | Claude launches, hooks fire | |
| 2.2 | Session lifecycle (5 prompts) | |
| 2.3 | Scar persists to local storage | |
| 3.1 | Cross-session continuity | |
| 4.1 | Uninstall preserves data | |
| 4.2 | Uninstall --all deletes data | |
| 4.3 | Reinstall after uninstall | |
| 5.1 | Dry run creates nothing | |
| 5.2 | Project name flag works | |

**Ship criteria:** All tests pass. Any failure is a blocker.

---

## Notes

- This tests **free tier only** (no Supabase in clean room)
- Pro tier testing requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars passed to container
- Container has no internet access to Supabase — scars are local JSON only
- The Docker container IS Docker-inside-Docker from your dev environment
