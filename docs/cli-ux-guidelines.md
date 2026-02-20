# GitMem CLI UX Guidelines

Design system for all MCP tool output. Every surface the user sees should feel like the same product — minimal, precise, confident, with just enough color to carry the brand.

## Brand Identity

GitMem's visual language extends from its web presence at gitmem.ai into the terminal:

| Token | Web Value | Terminal Mapping |
|-------|-----------|------------------|
| **Accent** | Racing Red `#c41920` | ANSI red `\x1b[31m` — product name, critical severity, errors |
| **Text** | Carbon Black `#1a1a1a` | Default terminal foreground |
| **Metadata** | Charcoal `#5b5a59` | ANSI dim `\x1b[2m` |
| **Background** | White Smoke `#f2f2f2` | Default terminal background (we never set it) |
| **Font** | IBM Plex Mono | Terminal default (already monospace) |
| **Voice** | Terse, factual | "3 scars found" not "I found some scars for you!" |

### Design Principles

1. **Terminal-native.** Output must look good in any monospace renderer — VS Code integrated terminal, iTerm2, Windows Terminal, Cursor, Windsurf, SSH sessions, tmux.
2. **Brand through color, not decoration.** Racing Red in the terminal carries the same identity as Racing Red on the website. One accent color, used sparingly, is more memorable than a rainbow.
3. **No emoji.** Emoji have unpredictable column width across terminals. They also signal "chatbot" rather than "developer tool." We use text indicators and ANSI color instead.
4. **Graceful degradation.** When ANSI is stripped (piped output, log files, MCP clients that don't support it), the output must still be fully readable and well-structured as plain text.
5. **Quiet confidence.** The output should feel like `cargo`, `docker`, or `git` — developer tools that use color with purpose, not for decoration.

## Color System

### ANSI Palette

Five ANSI codes, mapped to brand semantics. Nothing else.

| Code | Name | Brand Role | Use |
|------|------|------------|-----|
| `\x1b[31m` | Red | **Racing Red accent** | Product name `gitmem`, critical severity `[!!]`, errors, `FAIL`, `REJECTED` |
| `\x1b[33m` | Yellow | **Warning/attention** | High severity `[!]`, `WARN`, verification gates |
| `\x1b[32m` | Green | **Success/positive** | `ok`, confirmations, wins, `+` checklist pass |
| `\x1b[1m` | Bold | **Emphasis** | Section headers, key labels |
| `\x1b[2m` | Dim | **De-emphasis** | Timestamps, metadata, IDs, secondary text |
| `\x1b[0m` | Reset | — | Always pair with any of the above |

**Not used:**

| Code | Why not |
|------|---------|
| Blue/Cyan/Magenta | Too many colors dilute the brand. Three semantic colors (red/yellow/green) plus two weights (bold/dim) is the full palette. |
| Background colors (`\x1b[41m`+) | Bleeds into surrounding text. Conflicts with terminal themes. Never set backgrounds. |
| 256-color / True color | Not supported in all terminals. We use only the base 8 ANSI colors that work everywhere. |
| Underline (`\x1b[4m`) | Inconsistent rendering across terminals. |
| Blink (`\x1b[5m`) | No. |
| Reverse (`\x1b[7m`) | Theme-dependent, unpredictable. |
| Hidden (`\x1b[8m`) | Not supported by agg (our GIF renderer) or many terminals. |

### Color Semantics

Every use of color must map to exactly one of these meanings:

| Meaning | Color | Examples |
|---------|-------|---------|
| **Brand / identity** | Red | `gitmem` in product line |
| **Danger / critical** | Red | `[!!]` severity, `FAIL`, `REJECTED`, error messages |
| **Warning / attention** | Yellow | `[!]` severity, `WARN`, verification required |
| **Success / positive** | Green | `ok`, `+` checklist, win entries, confirmations accepted |
| **Neutral / info** | Default (no color) | Medium/low severity, body text, descriptions |
| **Secondary / metadata** | Dim | Timestamps, IDs, scores, issue references |
| **Structure / labels** | Bold | Section headers (`Threads`, `Decisions`, `Scars`) |

> **Rule: Red is the only color that appears in every session.** It's on the product line. Yellow and green appear only when their semantic meaning is triggered. This makes red feel like brand identity, not noise.

### Degradation

When ANSI codes are stripped, the output remains fully functional:

| With ANSI | Without ANSI |
|-----------|--------------|
| `\x1b[31mgitmem\x1b[0m ── recall` | `gitmem ── recall` |
| `\x1b[31m[!!]\x1b[0m Title` | `[!!] Title` |
| `\x1b[32m+\x1b[0m Session state read` | `+ Session state read` |

The text indicators (`[!!]`, `[!]`, `+`, `-`, `ok`, `FAIL`) carry the meaning. Color reinforces it but is never the only signal.

### Environment Variable Override

`GITMEM_NO_COLOR=1` or the [standard `NO_COLOR`](https://no-color.org/) convention disables all ANSI output. Piped output (non-TTY) should auto-disable color.

## Character Set

### Unicode Policy

Three tiers of Unicode characters, with clear rules for each:

**Tier 1: Safe — always use**

Characters that render correctly and at predictable width in every terminal, including `cmd.exe`, SSH over restricted locale, tmux, and all IDE integrated terminals.

| Characters | Range | Example |
|-----------|-------|---------|
| ASCII printable | U+0020–U+007E | `a-z`, `0-9`, `+`, `-`, `*`, `[`, `]` |
| Box-drawing light | U+2500–U+257F | `──`, `│`, `┌`, `└` |
| Middle dot | U+00B7 | `·` (used as separator) |
| Ellipsis | U+2026 | `…` (used in truncation) |

**Tier 2: Conditional — behind `NO_COLOR=0` explicit opt-in only**

Characters that work in most modern terminals but break in legacy Windows (`cmd.exe`, older ConEmu), some SSH sessions, and when piped to files.

| Characters | Range | Example |
|-----------|-------|---------|
| Checkmarks | U+2713, U+2717 | `✓`, `✗` |
| Arrows | U+2190–U+21FF | `→`, `←` |
| Bullets | U+2022 | `•` |

We don't currently use Tier 2 characters. Reserved for potential future `--rich` mode.

**Tier 3: Banned — never use**

Characters with unpredictable width rendering (1 vs 2 columns), inconsistent glyph support, or that undermine the brand's technical identity.

| Characters | Range | Why banned |
|-----------|-------|------------|
| Emoji | U+1F000+ | Double-width in some terminals, single in others. Column-aligned output breaks. Depends on OS emoji font. Signals "chatbot" not "tool." |
| Colored circles | U+1F534, U+1F7E0, etc. | Emoji — same problems. We use ANSI color on text instead. |
| CJK-width symbols | U+2600–U+26FF (misc) | `⚡`, `⛔`, `⚪` are "Miscellaneous Symbols" but many terminals render them at emoji width |
| Skin-tone/ZWJ sequences | U+200D combos | Width calculation impossible |

> **Why ban emoji but allow ANSI color?** Different problems. Emoji break *layout* — their column width is unpredictable, so aligned text shifts. ANSI color doesn't affect layout at all — it wraps text that already has correct width. When ANSI is stripped, the text is still there, still aligned. When emoji are stripped, you get missing characters or replacement glyphs.

### Text Indicators

All semantic indicators use plain ASCII text, colored by meaning:

| Purpose | Old (emoji) | New (text) | Color |
|---------|-------------|------------|-------|
| **Severity: critical** | `🔴` | `[!!]` | Red |
| **Severity: high** | `🟠` | `[!]` | Yellow |
| **Severity: medium** | `🟡` | `[~]` | Default |
| **Severity: low** | `🟢` | `[-]` | Dim |
| **Type: scar** | `⚡` | `scar` | Default |
| **Type: win** | `🏆` | `win` | Green |
| **Type: pattern** | `🔄` | `pat` | Default |
| **Type: anti-pattern** | `⛔` | `anti` | Yellow |
| **Type: decision** | `📋` | `dec` | Default |
| **Success** | `✅` | `ok` | Green |
| **Failure** | `❌` / `⛔` | `FAIL` | Red |
| **Warning** | `🚨` | `WARN` | Yellow |
| **Checklist pass** | `✓` (U+2713) | `+` | Green |
| **Checklist fail** | `✗` (U+2717) | `-` | Red |
| **Brain/memory** | `🧠` | *(dropped)* | — |

The severity brackets (`[!!]`, `[!]`, `[~]`, `[-]`) are 4 chars wide including brackets — consistent column width that emoji can never guarantee.

## Layout Structure

### Product Line

Every display output starts with a **product line** — the tool identity. The word `gitmem` is always red:

```
{red}gitmem{/} ── <tool> [· <count/context>] [· <scope>]
```

Examples:
```
gitmem ── active
gitmem ── log · 10 most recent · orchestra_dev
gitmem ── search · 5 results · "deployment"
gitmem ── threads · 12 open · 3 resolved
gitmem ── recall · 3 scars · "deploy edge function"
```

The `──` (U+2500 box-drawing) is the product separator. It appears in exactly one place: the product line.

### Session Identity Line

Immediately after the product line in `session_start`, `session_close`, and `session_refresh`:

```
{dim}<session-id-8char> · <agent> [· <project>]{/}
```

The entire session ID line is dim — it's metadata, not content.

Example:
```
gitmem ── active
8970e043 · cli · orchestra_dev
```

### Section Headers

Use **bold text** for section labels, no decorators:

```
{bold}Threads (16){/}
  Publish "The Static LLM That Learns" blog post…
  Re-measure scar quality metrics in 2-3 weeks…
```

Not:
```
📋 Threads (16)       ← no emoji
--- Threads (16) ---  ← no box borders
## Threads (16)       ← no markdown headers in display output
```

### Separator

A single horizontal rule using box-drawing characters. Used for:
- Display protocol footer
- Between recall scar entries (`---` three dashes)

```
───────────────────────────────────────────────────
```

**Never use `═══` (double-line).** One separator style only.

### Indentation

- **2 spaces** for list items under a section header
- **4 spaces** for sub-details (e.g., decision rationale under decision title)
- **No tabs**

## Tool Output Templates

Color annotations: `{red}`, `{yellow}`, `{green}`, `{bold}`, `{dim}`, `{/}` (reset).
In actual code these are ANSI escape sequences. Shown as tokens here for readability.

### session_start

```
{red}gitmem{/} ── active
{dim}8970e043 · cli · orchestra_dev{/}

{bold}Threads (16){/}
  Publish "The Static LLM That Learns" blog post…
  Re-measure scar quality metrics in 2-3 weeks…
  {dim}+14 more{/}

{bold}Decisions (3){/}
  GitMem Console tech stack: React 19 + Vite 7 {dim}· Feb 19{/}
  Knowledge graph enrichment: batch scripts {dim}· Feb 18{/}
```

### recall

```
{red}gitmem{/} ── recall · 3 scars · "deploy edge function"

{red}[!!]{/} {bold}Done != Deployed != Verified Working{/} {dim}(critical, 0.87) · id:3a4b5c6d{/}
Full deployment loop required: merge, push, pull on target, restart, verify.

  {dim}You might think:{/}
    - "The CI passed so it's deployed"
    - "I pushed so it's live"

  {dim}Applies when: deployment, shipping, release{/}

---

{yellow}[!]{/} {bold}RLS policies must cover storage.objects{/} {dim}(high, 0.71) · id:9c0d1e2f{/}
When creating Supabase storage buckets, RLS on the table is not enough.

---

[~] {bold}Check existing working code first{/} {dim}(medium, 0.62) · id:7e8f9a0b{/}
Before debugging forward, check if working reference code exists elsewhere.
```

### recall (with blocking gate)

```
{red}gitmem{/} ── recall · 1 scar · "write migration SQL"

{yellow}VERIFICATION REQUIRED{/}

  {bold}RLS Policy Verification for New Tables{/}
  When: Adding or modifying Supabase tables

  Run:
    SELECT schemaname, tablename, policyname FROM pg_policies;

  Must show: RLS policy exists for every new table

  {red}Do not proceed until verification output is shown.{/}

---

[~] {bold}Check existing working code first{/} {dim}(medium, 0.62) · id:7e8f9a0b{/}
...
```

### confirm_scars

```
{red}gitmem{/} ── confirm · 3 scars addressed

  {green}+{/} Done != Deployed != Verified Working {dim}-> APPLYING{/}
  + RLS policies must cover storage.objects {dim}-> N_A{/}
  {green}+{/} Check existing working code first {dim}-> APPLYING{/}

{green}All scars addressed. Proceeding.{/}
```

On rejection:

```
{red}gitmem{/} ── confirm · {red}REJECTED{/}

  {bold}Validation errors:{/}
    {red}-{/} Evidence too short for scar 3a4b5c6d (minimum 50 chars)

  {bold}Unaddressed scars:{/}
    {red}-{/} Done != Deployed != Verified Working
```

### log

```
{red}gitmem{/} log · 10 most recent · orchestra_dev

scar {red}[!!]{/} Done != Deployed != Verified Working          {dim}2d ago  OD-42{/}
scar {yellow}[!]{/}  RLS policies must cover storage.objects       {dim}3d ago  OD-55{/}
scar [~]  Check existing working code first             {dim}5d ago  OD-88{/}
{green}win{/}  {dim}[-]{/}  Parallel recall with code reads               {dim}1w ago{/}
{green}win{/}  {dim}[-]{/}  Haiku subagents for classification            {dim}1w ago{/}
pat  {dim}[-]{/}  Session close payload path convention         {dim}2w ago{/}
scar [~]  Trace execution path before hypothesizing     {dim}2w ago{/}
dec       GitMem Console tech stack decision            {dim}2w ago{/}
scar {dim}[-]{/}  Create pointer scars for filesystem research  {dim}3w ago{/}
{green}win{/}  {dim}[-]{/}  Docker host port auto-detection               {dim}3w ago{/}

{dim}10 total: 5 scars, 3 wins, 1 pattern, 1 decision{/}
```

### search

```
{red}gitmem{/} search · 5 results · "deployment"

scar {red}[!!]{/} Done != Deployed != Verified Working          {dim}(0.87)  OD-42{/}
   Full deployment loop required: merge, push, pull…  {dim}id:3a4b5c{/}
scar {yellow}[!]{/}  RLS policies must cover storage.objects       {dim}(0.71)  OD-55{/}
   When creating Supabase storage buckets, RLS on…    {dim}id:9c0d1e{/}
{green}win{/}  {dim}[-]{/}  Docker host port auto-detection               {dim}(0.58){/}
   curl docker socket, parse JSON, report localhost…  {dim}id:b2c3d4{/}

{dim}5 results found{/}
```

### list_threads

```
{red}gitmem{/} threads · 12 open · 3 resolved

  #  ID            Thread                                          Active
  1  {dim}t-d573c47f{/}    Publish "The Static LLM That Learns" blog       {dim}Feb 15{/}
  2  {dim}t-a1b2c3d4{/}    Re-measure scar quality metrics                 {dim}Feb 12{/}
  3  {dim}t-e5f6a7b8{/}    Credential rotation required                    {dim}Feb 10{/}
  4  {dim}t-1a2b3c4d{/}    Remaining gitmem-dev org migration tasks        {dim}Feb 08{/}
  5  {dim}t-5e6f7a8b{/}    Set up conduct@gitmem.ai email aliases          {dim}Feb 05{/}
```

### session_close

```
{bold}STANDARD CLOSE — {green}COMPLETE{/}
{dim}8970e043 · cli{/}

  {green}+{/} Session state read
  {green}+{/} Reflection (9 questions)
  {green}+{/} Human corrections
  {green}+{/} Persisted

{bold}Decisions{/}
  GitMem CLI output: no emoji, text indicators
    {dim}Switched all display output to ASCII text indicators…{/}

{bold}Learnings (2){/}
  {dim}3a4b5c6d{/}
  {dim}7e8f9a0b{/}

{bold}Scars (2 applied){/}
  {dim}3a4b5c{/}    applied   Verified deployment after push
  {dim}7e8f9a{/}    ack'd     Checked existing code reference

{bold}Threads{/}: 12 open

{bold}What worked{/}: Parallel recall with initial code reads
{bold}Next time{/}: Confirm scar before spawning sub-agent
```

### session_close (failed)

```
{bold}STANDARD CLOSE — {red}FAILED{/}
{dim}8970e043 · cli{/}

  {green}+{/} Session state read
  {green}+{/} Reflection (9 questions)
  {red}-{/} Human corrections
  {red}-{/} Persisted

  {red}!! Missing closing_reflection in payload{/}
  {red}!! Human corrections not recorded{/}
```

## Anti-Patterns

**Never do this:**

```
🧠 INSTITUTIONAL MEMORY ACTIVATED          ← emoji + caps shouting
═══════════════════════════════════════     ← double-line borders
Found 3 relevant scars for your plan:      ← chatbot voice
🔴 **Title** (critical, 0.87)              ← emoji severity
✅ SCAR CONFIRMATIONS ACCEPTED             ← emoji status
⛔ SCAR CONFIRMATIONS REJECTED             ← emoji status
```

**Do this instead:**

```
gitmem ── recall · 3 scars · "your plan"   ← red product name, clean layout
                                            ← whitespace
[!!] Title (critical, 0.87)                ← red text severity
                                            ← breathing room
gitmem ── confirm · 3 scars addressed      ← green confirmation
gitmem ── confirm · REJECTED               ← red rejection
```

## Implementation

### Constants Module

All color and indicator definitions live in `src/services/display-protocol.ts`:

```typescript
// ANSI codes
const R = "\x1b[31m";  // red (brand accent)
const Y = "\x1b[33m";  // yellow (warning)
const G = "\x1b[32m";  // green (success)
const B = "\x1b[1m";   // bold
const D = "\x1b[2m";   // dim
const X = "\x1b[0m";   // reset

// Severity indicators (with color)
const SEV = {
  critical: `${R}[!!]${X}`,
  high:     `${Y}[!]${X}`,
  medium:   `[~]`,
  low:      `${D}[-]${X}`,
};

// Type labels (with color)
const TYPE = {
  scar:         "scar",
  win:          `${G}win${X}`,
  pattern:      "pat",
  anti_pattern: `${Y}anti${X}`,
  decision:     "dec",
};

// Product line
function productLine(tool: string, detail?: string): string {
  const parts = [`${R}gitmem${X} ── ${tool}`];
  if (detail) parts[0] += ` · ${detail}`;
  return parts[0];
}
```

### Files To Update

| File | Current State | Changes Needed |
|------|---------------|----------------|
| `src/services/display-protocol.ts` | Emoji maps (`SEV`, `TYPE`) | Replace with colored text indicators, add `productLine()` helper |
| `src/tools/session-start.ts` | Clean layout, no color | Add red product name, dim metadata |
| `src/tools/session-close.ts` | `✓`/`✗`, ANSI bold only | Add green/red checklist, colored status |
| `src/tools/recall.ts` | Emoji severity, `🧠` header, `═══` borders | Colored severity, clean product line, remove borders |
| `src/tools/confirm-scars.ts` | `✅`/`⛔`/`🟢`/`⚪`/`🟠` | Green/red text indicators |
| `src/tools/log.ts` | Uses `SEV`/`TYPE` emoji maps | Auto-updates via `display-protocol.ts` |
| `src/tools/search.ts` | Uses `SEV`/`TYPE` emoji maps | Auto-updates via `display-protocol.ts` |
| `src/tools/list-threads.ts` | Markdown table | Fixed-width columns, dim metadata |
| `src/tools/cleanup-threads.ts` | Markdown table | Fixed-width columns, dim metadata |
| `src/tools/prepare-context.ts` | `🚨` header, `═══` borders | Yellow `VERIFICATION REQUIRED`, no borders |
| `src/hooks/format-utils.ts` | Emoji severity (Unicode escaped) | Colored text indicators |

### NO_COLOR Support

Respect [no-color.org](https://no-color.org/) convention:

```typescript
function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.GITMEM_NO_COLOR !== undefined) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}
```

When color is disabled, all ANSI codes resolve to empty strings. The output is identical minus the escape sequences.
