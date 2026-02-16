# Human User Journey Test — Free Tier (New User)

The idea: simulate what a developer does when they first discover GitMem. Start in a **fresh empty project directory** so there's zero contamination.

## Step 0: Clean Room Setup

```bash
mkdir ~/test-gitmem-v1 && cd ~/test-gitmem-v1
git init
```

This gives you a pristine project with no `.gitmem/`, no `.claude/`, no `.mcp.json`.

---

## Step 1: `npx gitmem-mcp init`

**Run:**
```bash
npx gitmem-mcp init
```

**What to verify:**
- Output says "free tier (local storage)" (no Supabase env vars set)
- Lists 12 starter scars with `+` prefix (all new)
- Says "Auto-allowed gitmem tools in .claude/settings.json"
- `.gitmem/` directory created with `learnings.json`, `sessions.json`, `decisions.json`, `scar-usage.json`
- `.claude/settings.json` exists with `"allow": ["mcp__gitmem__*"]`
- **No references to "orchestra", "weekend_warrior", or "orchestra_dev" anywhere**

**Spot checks:**
```bash
cat .gitmem/learnings.json | grep -i orchestra    # should return nothing
cat .gitmem/learnings.json | jq length            # should be 12
cat .claude/settings.json                          # should show permissions
```

---

## Step 2: `npx gitmem-mcp init` (idempotency)

**Run the same command again:**
```bash
npx gitmem-mcp init
```

**What to verify:**
- All 12 scars show `=` prefix ("already exists")
- Says "0 new scars added"
- No duplicate scars in `learnings.json`

---

## Step 3: `npx gitmem-mcp configure`

**Run:**
```bash
npx gitmem-mcp configure
```

**What to verify:**
- Says "Free tier — no API keys needed!"
- Outputs valid JSON with `"command": "npx"` and `"args": ["-y", "gitmem-mcp"]`
- No env block (free tier doesn't need one)
- **No orchestra references**

**Then create the `.mcp.json` from the output:**
```bash
cat > .mcp.json << 'EOF'
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp"]
    }
  }
}
EOF
```

---

## Step 4: `npx gitmem-mcp check`

**Run:**
```bash
npx gitmem-mcp check
```

**What to verify:**
- Health checks run (supabase should show "skip" or "not configured" — that's correct for free tier)
- Cache check passes
- No crashes, clean exit
- **No orchestra references**

---

## Step 5: `npx gitmem-mcp install-hooks`

**Run:**
```bash
npx gitmem-mcp install-hooks
```

**What to verify:**
- Says "Hooks written to .claude/settings.json"
- `.claude/settings.json` now has `hooks` section with SessionStart, PreToolUse, PostToolUse, Stop
- Hook script paths reference `node_modules/gitmem-mcp/hooks/scripts/`
- The existing `permissions.allow` from Step 1 is **preserved** (not wiped)

**Spot check:**
```bash
cat .claude/settings.json | jq '.hooks | keys'
# Should show: ["PreToolUse", "PostToolUse", "SessionStart", "Stop"]

cat .claude/settings.json | jq '.permissions'
# Should still have: {"allow": ["mcp__gitmem__*"]}
```

---

## Step 6: Copy CLAUDE.md template

**Run:**
```bash
cp node_modules/gitmem-mcp/CLAUDE.md.template CLAUDE.md
```

**What to verify:**
- File exists and is readable
- Contains the 7 reflection questions
- Contains the tool quick reference table
- **No orchestra/weekend_warrior references**

```bash
grep -i orchestra CLAUDE.md    # should return nothing
grep -i "session_start" CLAUDE.md  # should find references
```

---

## Step 7: Add `.gitmem/` to `.gitignore`

```bash
echo '.gitmem/' >> .gitignore
```

---

## Step 8: Open Claude Code and verify live session

**Run:**
```bash
claude
```

**What to verify in this order:**

1. **SessionStart hook fires** — you should see a system-reminder with "SESSION START — ACTIVE" and instructions to call session_start
2. **Agent calls session_start** — it should load context (empty for fresh project, but no errors)
3. **Ask the agent: "recall for deploying to production"** — it should call `recall` and surface relevant starter scars (like "Done != Deployed != Verified Working")
4. **Ask the agent to do something consequential** (e.g., "write a deployment script") — if recall surfaced scars and they weren't confirmed, the PreToolUse hook should nag or block
5. **Say "closing"** — the Stop hook should enforce the closing ceremony (7 questions)

**Key UX moments to evaluate:**
- Is the session start smooth or confusing?
- Does the recall output feel useful or noisy?
- Is the closing ceremony clear?
- Are the starter scars relevant and well-written?

---

## Step 9: Verify the closing ceremony works

When you say "closing":
1. Agent should answer the 7 reflection questions itself
2. Agent should ask YOU: "Any corrections or additions?"
3. You respond (even just "looks good")
4. Agent writes `closing-payload.json` and calls `session_close`
5. Session ends cleanly

---

## Step 10: Second session — verify continuity

```bash
claude
```

**What to verify:**
- Session start loads context from the previous session
- Any learnings or decisions created in Step 8 are visible
- Open threads carry over

---

## Bonus: Hooks-Only Checks

If you want to isolate hook behavior:

```bash
# Verify session-start hook output directly
bash node_modules/gitmem-mcp/hooks/scripts/session-start.sh

# Verify close ceremony wording
bash node_modules/gitmem-mcp/hooks/scripts/session-close-check.sh
```

---

## What You're Evaluating

| Area | What to look for |
|------|-----------------|
| **Clarity** | Can a new user follow the flow without docs? |
| **Leaks** | Any "orchestra", "weekend_warrior", project-specific references? |
| **Errors** | Any crashes, missing files, bad paths? |
| **Idempotency** | Running init twice doesn't duplicate scars |
| **Permissions** | `.claude/settings.json` correctly merges hooks + permissions |
| **Starter scars** | Are the 12 scars useful and well-written for a general developer? |
| **Ceremony** | Is the closing ceremony clear about who answers what? |
| **Continuity** | Does session 2 know about session 1? |
