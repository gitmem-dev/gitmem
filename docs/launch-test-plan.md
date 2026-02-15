# GitMem v1.0.1 Launch Test Plan (Human Verification)

**Date:** 2026-02-16
**Pre-req:** Commit `b284061` on main, version bumped to 1.0.1, published to npm

---

## Phase 1: Local Build Verification

### Setup

```bash
cd /path/to/gitmem
git pull origin main
npm run build
```

Point Claude Desktop at local build in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gitmem": {
      "command": "node",
      "args": ["/absolute/path/to/gitmem/dist/server.js"]
    }
  }
}
```

Restart Claude Desktop (Cmd+Q, reopen).

### Test 1: No stdout corruption (OD-590)

Tell the agent:
> "Run `gm-open` to start a session"

- [ ] No red error toast appears
- [ ] No "invalid JSON" errors in the UI
- [ ] Session starts cleanly with session_id and agent displayed

### Test 2: Error messages surface (OD-554)

Tell the agent:
> "Create a scar with title 'test scar' and description 'testing error surface' but don't include severity"

- [ ] Response contains `errors` array (not just `success: false`)
- [ ] Error message mentions missing severity
- [ ] You can read the error and understand what went wrong

### Test 3: Session ID validation (OD-548)

Tell the agent:
> "Close the session with session_id 'SESSION_AUTO'"

- [ ] Returns validation error (not a confusing DB lookup failure)
- [ ] Error message says "Invalid session_id format"
- [ ] Error message includes a UUID example
- [ ] Error message suggests running session_start first

### Test 4: Arbitrary project names (OD-640)

Tell the agent:
> "Start a new session with project 'my-cool-project'"

- [ ] Session starts successfully
- [ ] No enum rejection error
- [ ] Project shows as `my-cool-project` in the response

### Test 5: Happy path end-to-end

Run these in sequence:

1. `gm-open` (start session)
2. `gitmem-r` with plan "verify launch readiness" (recall scars)
3. `gm-close` (close session)

- [ ] All three complete without errors
- [ ] Session opens, scars surface (or "no scars found" message), session closes cleanly

---

## Phase 2: npm Publish + Verification

### Publish

```bash
cd /path/to/gitmem

# Version should already be 1.0.1 in package.json
npm run build
npm publish

# Verify on npm
npm info gitmem-mcp version
# Expected: 1.0.1
```

### Fresh install verification

```bash
# Install fresh from npm (new terminal)
npx gitmem-mcp@1.0.1 --help 2>&1 | head -5
```

### Point Claude Desktop at npm package

Update `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp@1.0.1"]
    }
  }
}
```

Restart Claude Desktop.

### Re-run Tests 1-5 from Phase 1

- [ ] Test 1: No stdout corruption
- [ ] Test 2: Error messages surface
- [ ] Test 3: Session ID validation
- [ ] Test 4: Arbitrary project names
- [ ] Test 5: Happy path end-to-end

---

## Pass/Fail

**All 5 tests must pass in both phases to ship.**

| Phase | Test | Pass? |
|-------|------|-------|
| Local | 1. No stdout corruption | |
| Local | 2. Error messages surface | |
| Local | 3. Session ID validation | |
| Local | 4. Arbitrary project names | |
| Local | 5. Happy path e2e | |
| npm | 1. No stdout corruption | |
| npm | 2. Error messages surface | |
| npm | 3. Session ID validation | |
| npm | 4. Arbitrary project names | |
| npm | 5. Happy path e2e | |

---

## Ship Blockers Fixed in v1.0.1

| Issue | Fix | Tests |
|-------|-----|-------|
| OD-590 | 22 console.log replaced with console.error in check.ts | +2 regression tests |
| OD-554 | errors[] added to create_learning and record_scar_usage results | +8 tests |
| OD-548 | UUID/short-ID format validation in session_close | +10 tests |
| OD-640 | Removed hardcoded project enum, free-form string | covered by schema tests |

## Known Limitations (shipping as v1.0.2)

- OD-557/563: Multi-session concurrency (last-write-wins on active-sessions.json)
