---
description: Show GitMem session status, hook activity, and recall state
allowed-tools: ["Bash", "Read", "mcp__gitmem__gitmem-cache-status"]
---

# GitMem Status

Check the current state of the GitMem hooks plugin and active session.

## Instructions

1. **Check if gitmem MCP is connected:**
   Call the `mcp__gitmem__gitmem-cache-status` tool. If it returns a response, the server is connected. Report scar count and cache age from the response.
   Do NOT use `claude mcp list` — its health check returns false negatives.

2. **Check active session:**
   Read `.gitmem/active-session.json` if it exists. Report:
   - Session ID
   - Agent identity
   - Start time
   - Whether scars have been surfaced (surfaced_scars timestamp)

3. **Check hook state:**
   Look for `/tmp/gitmem-hooks-*` directories. Report:
   - Session start time
   - Tool call count
   - Last nag time
   - Whether stop_hook_active guard is set

4. **Check audit trail:**
   Read `/tmp/gitmem-hooks-*/audit.jsonl` if it exists. Report:
   - Total LOOKED events (recall/search calls)
   - Total ACTION events (consequential actions)
   - Whether any ACTION was taken without a prior LOOKED (potential gap)
   - Last 5 audit entries

5. **Summary:**
   Present a concise status block:
   ```
   GitMem Status
   ├── MCP Server: connected/disconnected
   ├── Active Session: <id> (started <time>)
   ├── Recall: last called <time> / never called
   ├── Tool Calls: <count>
   ├── Audit Trail: <looked> LOOKED / <action> ACTION events
   │   └── Look-before-act: <yes/gap detected>
   └── Hooks: session-start ✓ | recall-check ✓ | post-tool-use ✓ | close-check ✓
   ```
