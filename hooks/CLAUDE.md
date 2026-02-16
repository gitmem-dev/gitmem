# GitMem Hooks — Behavioral Constraints

This file is loaded automatically by the gitmem-hooks plugin. These constraints are enforced by infrastructure (PreToolUse hooks) and cannot be overridden.

## Red Lines (CONSTITUTIONAL)

Red lines are absolute behavioral constraints. Crossing them causes direct, irreversible harm. No task urgency, efficiency gain, or rationalization justifies violating them.

### Red Line 1: Credential Protection

Credential exposure in conversation history is permanent and irreversible. Once a secret appears in output, it cannot be retracted.

**Rules:**

1. **NEVER read credential files in full.** Files like `mcp-config.json`, `.env`, `.credentials.json`, `.netrc`, `.npmrc`, `.pypirc`, SSH keys, or `.pem`/`.key` files must NEVER be read with the Read tool or dumped with cat/head/tail.

2. **NEVER print environment variable values that contain secrets.** Commands like `env | grep KEY`, `echo $API_KEY`, or `printenv TOKEN` expose credentials in output.

3. **NEVER display API keys, tokens, or secrets in conversation output.** If a tool result contains credentials, do not echo or summarize the values.

**Safe alternatives:**

- `env | grep -c VARNAME` — returns count, not value
- `[ -n "$VARNAME" ] && echo "set" || echo "unset"` — existence check only
- `grep -c '"key_name"' config.json` — checks structure, not secrets

**Enforcement:** A `PreToolUse` hook (`credential-guard.sh`) runs before every `Bash` and `Read` tool call. It pattern-matches against credential exposure commands and returns `{"decision": "block"}` — a hard block that prevents execution. This cannot be disabled or bypassed by the agent.

### Red Line 2: Recall Gates Consequential Actions

Institutional memory exists to prevent repeating mistakes. Running `recall()` in parallel with the actions it's meant to inform defeats the safety mechanism entirely.

**Rules:**

1. **NEVER parallelize `recall()` with actions that could expose, modify, or transmit sensitive data.** Recall must complete and its scars must be reviewed before any consequential action proceeds.

2. **When the user requests recall before acting, treat recall as a blocking gate.** Complete recall, confirm scars (APPLYING/N_A/REFUTED for each), then act.

3. **Parallel recall is ONLY safe with benign reads** — source code, documentation, non-sensitive config. If uncertain whether a target contains secrets, recall first.

**Enforcement:** The `recall-check.sh` PreToolUse hook monitors consequential actions. If `recall()` surfaced scars but `confirm_scars()` has not been called, the hook blocks the action until every scar is explicitly addressed as APPLYING (with past-tense evidence), N_A (with explanation), or REFUTED (with risk acknowledgment).
