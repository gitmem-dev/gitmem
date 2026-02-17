# OpenClaw Directory Listing — gitmem

## Submission Target
https://openclawdir.com → "Submit Skill" (requires Google sign-in)

## Listing Fields

**Name:** `gitmem`

**Tagline / Short Description:**
Institutional memory for AI agents. Your agent stops repeating the same mistakes.

**Full Description:**
GitMem is an MCP server that gives your agent persistent memory across sessions — not chat history, but earned knowledge. It tracks mistakes (scars), successes (wins), architectural decisions, and unfinished work so your agent learns from experience instead of starting from scratch every time. Complements OpenClaw's built-in memory by adding institutional knowledge on top of conversational context.

**Category:** Memory / Productivity / Developer Tools

**Tags:** `memory`, `mcp`, `institutional-memory`, `session-management`, `learning`, `scars`, `decisions`

**Homepage:** https://gitmem.ai

**Repository:** https://github.com/gitmem-dev/gitmem

**npm:** https://www.npmjs.com/package/gitmem-mcp

**Install command:**
```bash
openclaw mcp add gitmem -- npx -y gitmem-mcp
```

---

## Submission Checklist

- [ ] Sign in to openclawdir.com with Google
- [ ] Go to "Submit Skill"
- [ ] Upload or paste SKILL.md content
- [ ] Verify fields auto-populate from frontmatter
- [ ] Submit — AI review runs automatically
- [ ] If approved, listing goes live immediately

## Post-Listing Promotion

### OpenClaw Discord
Post in #skills or #show-and-tell:

> **gitmem — institutional memory for your agent**
>
> Your agent forgets everything between sessions. gitmem fixes that.
>
> It's an MCP server that tracks mistakes (scars), wins, decisions, and open threads — so your agent learns from experience. Not chat history — earned lessons.
>
> `openclaw mcp add gitmem -- npx -y gitmem-mcp`
>
> Works alongside OpenClaw's built-in memory. It handles conversational context; gitmem handles institutional knowledge.
>
> https://gitmem.ai | https://github.com/gitmem-dev/gitmem

### GitHub awesome-openclaw-skills
PR to https://github.com/VoltAgent/awesome-openclaw-skills adding gitmem under "Memory" category.

### X / Twitter
Draft tweet (see /tweet skill or post manually):

> Your AI agent makes the same mistakes every session because it starts from zero.
>
> gitmem gives it institutional memory — scars from past failures, wins from what worked, decisions with rationale.
>
> Now available as an OpenClaw skill.
>
> openclaw mcp add gitmem -- npx -y gitmem-mcp
>
> https://gitmem.ai

## Differentiation Talking Points

When the community asks "how is this different from OpenClaw memory?":

1. **OpenClaw memory = what was said.** GitMem = what was learned.
2. **OpenClaw persists conversations.** GitMem persists lessons.
3. **OpenClaw recalls context.** GitMem recalls warnings before you act.
4. **They're complementary.** Use both. OpenClaw remembers you like Python; GitMem remembers you got burned by Python 2/3 migration last week.

When asked "how is this different from triple-memory?":

1. **triple-memory is broad recall** — LanceDB vectors, git-notes, file search
2. **gitmem is opinionated workflow** — recall → confirm → work → reflect → close
3. **Scars have counter-arguments** — not just "don't do X" but "here's why you might ignore this"
4. **Session ceremonies** — structured reflection captures what broke, what worked, what to do differently
5. **Threads** — unfinished work carries across sessions automatically
