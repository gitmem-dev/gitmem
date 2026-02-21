# GitMem Privacy Policy

**Last Updated:** February 20, 2026
**Version:** 1.0

## Our Commitment

Your institutional memory is yours. GitMem telemetry is **opt-in, anonymous, and transparent**. We collect only what helps improve the product, and you can inspect everything before it's sent.

## What We Collect (When Enabled)

When you enable telemetry, we collect:

```json
{
  "event": "tool_called",
  "tool": "recall",
  "success": true,
  "duration_ms": 234,
  "result_count": 3,
  "version": "1.2.0",
  "platform": "darwin",
  "mcp_host": "claude-desktop",
  "tier": "free",
  "timestamp": "2026-02-20T12:34:56Z",
  "session_id": "7a4f2c91"  // Random per-session, not persistent
}
```

**Purpose:**
- Understand which tools are most useful
- Identify error patterns to prioritize fixes
- Measure performance across platforms
- Guide feature development

## What We Never Collect

❌ **Your content:**
- Queries or search terms
- Scar text or descriptions
- Learning/decision content
- Session reflections
- Code or file paths

❌ **Personal identifiers:**
- Email addresses
- IP addresses
- Persistent user IDs
- Project names
- GitHub usernames

❌ **Environment data:**
- API keys or credentials
- Environment variables
- Directory paths
- Database connection strings

## How It Works

### 1. Default State: Disabled

Telemetry is **off by default**. No data is sent unless you explicitly opt in.

### 2. Transparent Collection

All events are logged locally at `.gitmem/telemetry.log` BEFORE being sent:

```bash
$ cat .gitmem/telemetry.log
{"event":"tool_called","tool":"recall","success":true,"duration_ms":234,...}
{"event":"tool_called","tool":"session_close","success":true,"duration_ms":567,...}
```

You can review every event before it's transmitted.

### 3. Batch Transmission

Events are sent in batches every 24 hours or when you run `gitmem telemetry flush`. This gives you time to review before transmission.

### 4. Anonymous Session IDs

Each session gets a random ID (like `7a4f2c91`) that's **not stored** or linked across sessions. We can't correlate activity to individual users.

## Controlling Telemetry

### Enable Telemetry

```bash
$ gitmem telemetry enable
✓ Telemetry enabled
  Data logged to: .gitmem/telemetry.log
  Review anytime: gitmem telemetry show
  Disable anytime: gitmem telemetry disable
```

### Check Status

```bash
$ gitmem telemetry status
Telemetry: Enabled
Session ID: 7a4f2c91 (random, not persistent)
Events logged: 47 (last 24 hours)
Last sent: 2 hours ago
Next batch: in 22 hours
```

### View Pending Events

```bash
$ gitmem telemetry show
Showing last 100 events that will be sent:

[2026-02-20 12:34:56] tool_called: recall (success, 234ms, 3 results)
[2026-02-20 12:35:12] tool_called: confirm_scars (success, 45ms)
[2026-02-20 12:40:33] tool_called: create_learning (success, 123ms)
...
```

### Disable Telemetry

```bash
$ gitmem telemetry disable
✓ Telemetry disabled
  Pending events: cleared (not sent)
  Local logs: preserved at .gitmem/telemetry.log
```

### Clear Local Logs

```bash
$ gitmem telemetry clear
✓ Cleared all local telemetry logs
  (Remote data cannot be deleted — it's already anonymous)
```

## Data Storage & Retention

- **Local logs:** Stored in `.gitmem/telemetry.log`, rotated after 30 days
- **Remote storage:** Plausible Analytics (privacy-first, no cookies, GDPR compliant)
- **Retention:** 90 days aggregate statistics, no raw events stored
- **Location:** EU servers (GDPR compliant)

## Your Rights

✓ **Right to disable:** One command, instant effect
✓ **Right to inspect:** View all data before it's sent
✓ **Right to clarity:** This policy, in plain English
✓ **Right to privacy:** No tracking, no profiling, no ads

## Public Dashboard

We publish aggregate telemetry data publicly:

**https://gitmem.ai/stats**

- Most-used tools
- Error rates by version
- Platform distribution
- Performance percentiles

This transparency helps the community understand product health and priorities.

## Changes to This Policy

If we change what we collect, we'll:
1. Update this document with a new version number
2. Require re-consent before collecting new data types
3. Announce changes in release notes

## Contact

Questions about privacy or telemetry?
- **Email:** privacy@gitmem.ai
- **GitHub:** https://github.com/gitmem-dev/gitmem/issues

---

**Summary:**
- **Opt-in only** — disabled by default
- **Zero PII** — no way to identify users
- **Local-first** — inspect before sending
- **Easy control** — enable/disable in one command
- **Transparent** — public dashboard with aggregate stats
