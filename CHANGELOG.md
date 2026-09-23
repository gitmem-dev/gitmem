# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Just upgrade the package. Nothing to change on your database.** Every fix below works on a project
still on the `setup.sql` you first ran, back to 1.8.0, and was checked against a project on exactly
that schema and on the current one.

**Recall works when it has to ask your database.** When the local index was not ready, or with
`GITMEM_SEARCH_MODE=remote`, recall called a database function that `setup.sql` never created. It
got an error and returned no scars. It now calls `gitmem_scar_search`, which every project has, and
falls back to the older function only where that exists. (GIT-114)

**`install-hooks` and `uninstall-hooks` keep your own hooks.** They used to replace or delete every
hook in `.claude/settings.json` or `.cursor/hooks.json`. Now they add or remove only gitmem's hooks,
back the file up first, and print what changed. A file that is not valid JSON is left alone instead
of being replaced. (GIT-120)

### Fixed

- **Hooks work on a stock Mac.** The prompt hook ran `timeout`, which macOS does not have, so it
  never returned scars there. The time limit now lives inside gitmem. When gitmem or node cannot be
  found, the hook says so instead of staying silent. (GIT-116)
- **A thread that failed to sync is no longer marked synced.** `session_close` reports PARTIAL and
  names the thread ids that did not reach your database. Those threads stay in `threads.json` and
  the next session tries again. (GIT-117)
- **A failed index reload no longer empties recall.** If reloading scars from your database fails,
  gitmem keeps the index it had, falls back to the on-disk cache, and retries in the background.
  `create_learning` says when the new learning is saved but not yet searchable. (GIT-118)
- **`archive_learning` accepts a short id.** Archiving by id prefix failed on every project with
  "operator does not exist". Archiving an id that does not exist used to report success; it now says
  nothing was archived. (GIT-119)
- **Updates that change no row are reported as not saved.** This covers thread resolve, touch and
  auto-archive, session embeddings, superseded sessions, relevance data and transcript paths. Each
  one used to count as success. (GIT-119)

## [1.11.0] - 2026-09-21

**Just upgrade the package. Nothing to change on your database.** Every fix in this release works on
a project still on the `setup.sql` you first ran, back to 1.8.0. Each one was checked against a
project on exactly that schema.

**A chat in one project no longer continues another project's session.** The desktop app runs one
gitmem process for every chat. Starting a session for project Y while a project X chat was open used
to resume X's session, swapping the project you asked for for X's and saying so only on stderr.
`session_start(project: Y)` now starts a Y session and leaves X open and resumable. Called with no
project, it resumes the most recent session and names that session's project in its output.
`force: true` carries activity forward only from a session of the same project. (GIT-86)

**Every write now says whether it was actually saved.** `create_learning`, `create_decision`,
`create_thread`, `resolve_thread`, `archive_learning`, `record_scar_usage` (single and batch),
`session_close`, `promote_suggestion` and `save_transcript` now report `durable` and `stored_in`
alongside `success`. `success` means the record reached your database. Before this,
`resolve_thread` reported success even when your database never recorded the resolve, so other
sessions still saw the thread as open. Now it says `RESOLVED LOCALLY ONLY — not durable`. (GIT-101)

**Stop enforcement was inactive on machines without jq; fixed.** (GIT-112)

### Fixed

- **Sessions start without re-downloading the whole index.** On Pro, nearly every `session_start`
  changes a few scar scores, and the next start used to download every learning with its embedding
  again. Now only the changed rows are fetched: in testing, 42 KB instead of 922 KB for 250
  learnings. (GIT-98)
- **The hooks read the same store as the server.** They looked for `.gitmem` in the current directory
  instead of `GITMEM_DIR`, then `GITMEM_HOME`, then `~/.gitmem`, so they could see no session or
  someone else's. They now skip sessions whose server process has exited, and the Stop hook prints
  the exact path of `closing-payload.json`. (GIT-99)
- **`session_close` says where it looked for your payload.** With no `closing-payload.json` and no
  inline reflection, it now reports `closing-payload.json not found at <path>` instead of asking you
  to answer the closing questions again. (GIT-99)
- **The startup write check can no longer hang silently.** It gives up after 10 seconds and reports
  "timed out, durability UNVERIFIED", and a database that refuses the connection is reported as
  unreachable rather than OK. `health` now shows the latest verdict. (GIT-102)
- **`session_close` warnings say what failed.** Each warning names the part that failed and why, and
  says whether the session itself was saved. Before, a close showed only `WARN N write failures`.
  (GIT-102)
- **No more `metrics` failure at `session_start`.** A metrics row now waits for its session row to
  exist. (GIT-73, listed under *Known issues* in 1.10.0)
- **Knowledge-graph links for threads are saved.** They wrote a thread id where the database expects a
  UUID, so every one was rejected. (GIT-105, listed under *Known issues* in 1.10.0)
- **`migrate-root` merges your memory instead of skipping it.** If your home store already had
  learnings, threads, decisions or sessions, the project store's were skipped as "already exists". They
  are now merged record by record: the newer version wins and the other is written to
  `migrate-root-conflicts.json`, after a backup. Running it again changes nothing. (GIT-100)
- **No false "Memory store found but NOT being read" on macOS.** Paths under `/var` and
  `/private/var` (and any symlink) were compared as text, so the store gitmem was reading could be
  reported as unread. (GIT-107)

### Changed

- **Releases are gated on a database still on 1.8.0's `setup.sql`, and on the hooks passing
  without jq.** Nothing is published unless both pass. (GIT-83, GIT-109)

## [1.10.0] - 2026-09-21

**Sessions that weren't being saved now save.** On your own Supabase project, a `session_close` was
rejected by the database, and the session never saved, whenever it carried sub-agent observations,
child-agent records, or a Claude Code session id. gitmem attaches that id whenever it finds the
session's transcript, which is most Claude Code CLI and desktop sessions. The close reported
`FAILED`, but the session was gone. Those closes now save. (GIT-110)

**Re-running `setup.sql` is recommended, not required. It's safe to run more than once.** If you
skip it, everything still works. The one difference: the scar-scoring function keeps its old
behaviour, rewriting every scored scar on each `session_start`. That makes the next process start
re-download your embedding index instead of reading it from disk. Re-running `setup.sql` installs
the version that only rewrites scars whose score actually changed.

**`health` will probably show more failures than before. That isn't a regression.** Those writes
were already failing; `health` used to count them as successes. The ones that remain are listed
under *Known issues*.

This release is for Pro stores, meaning your own Supabase project. Before it, gitmem assumed columns
and tables that a project set up from `setup.sql` doesn't have. Anything written to them failed, and
in the worst case a whole session was lost. gitmem now writes only what your project has, whether or
not you've re-run `setup.sql`.

### Fixed

- **Session closes were being lost (GIT-110).** If a Claude Code CLI or desktop session found its
  transcript, or recorded sub-agent observations or child agents, `session_close` sent columns your
  project doesn't have. The database rejected the whole write, and the session was never saved (the
  close did report `FAILED`). gitmem now checks once per process which optional columns your
  project has, using a
  small read-only query, and writes only those.
- **Scar usage is recorded again.** Usage was written to a table name that doesn't exist on your
  project, so every usage record was lost. That also meant the scar-scoring and blindspot features
  had nothing to work from. (GIT-84)
- **`confirm_scars` relevance is now saved.** Which surfaced scars you applied, and how relevant you
  rated each one, is now stored in the recall row of `gitmem_query_metrics`, inside its existing
  `metadata` field (`memories_applied`, `memory_relevance`). Before, it went to a column that doesn't
  exist and was matched against the wrong kind of value, so nothing was ever saved. (GIT-109)
- **`archive_learning` now archives.** It also wrote an `archived_at` column your project doesn't
  have, so the update was rejected and the scar stayed active. The column is now written only where
  it exists; the row's `updated_at` still records when it was archived.
- **Analytics, the `session_start` insights and the `session_close` blindspot check work again.**
  They asked the usage table for title and severity columns it has never had. Those now come from
  your learnings. (GIT-108)
- **`health` reports failed writes as failures.** It used to count as a success any write that
  failed but didn't throw an error. That's why the problems above went unnoticed. (GIT-104)
- **`setup.sql` can be re-run.** A second run used to fail partway through. (GIT-84)

### Changed

- **A/B testing of scar enforcement variants is off outside dev tier.** It depends on tables
  `setup.sql` doesn't create, so on your project every variant read and write failed. (GIT-106)
- **Transcripts are uploaded only where the project is set up for them.** `setup.sql` creates
  neither the Storage bucket nor the table transcript upload needs.
- **`hook-scars.json` is now readable only by your user account** (mode `0600`), like the embedding
  cache. It holds learning text. Existing files are tightened on the next start. (GIT-109)
- **The scar-scoring function only rewrites scars whose score changed.** A scored scar stays cached
  on disk across sessions unless its score actually moves. This needs the re-run `setup.sql`.
  (GIT-84)

### Known issues

- **One `metrics` failure at `session_start` can appear in `health`.** A metrics row sometimes
  arrives before its session row exists. Nothing is lost except that one metrics row. (GIT-73)
- **A knowledge-graph link for new threads fails in `health`.** It writes a thread id where the
  database expects a UUID. (GIT-105)

## [1.9.0] - 2026-09-20

**No schema change. You do not need to re-run `setup.sql`.**

This release is about Pro stores, meaning your own Supabase project. It covers two things: gitmem now
works fully on a project that has only `setup.sql` in it, which is every customer project. And it
no longer downloads your whole memory every time a process starts.

### Fixed

- **gitmem no longer depends on an edge function your project doesn't have.** Some reads went
  through `/functions/v1/ww-mcp`, an edge function that exists only on nTEG's own Supabase project
  and was never shipped with the package. On your project every one of those reads returned 404,
  and gitmem quietly carried on without the data. Every read and write now goes directly to your
  project's REST API (PostgREST). What you'll notice:
  - **The `session_start` thread panel now matches `list_threads`.** It used to fall back to the
    local `threads.json` file, which can be stale, while `list_threads` read your Supabase table,
    so the two could show different threads. Both now show the same threads from Supabase. A failed
    session-history read also no longer throws away a successful thread read.
  - **Your last session and recent decisions load at `session_start` again.** Before, that step
    failed silently with `Failed to load last session`.
  - Filter values containing a `.`, such as a title or a version string, are now always treated as
    data. (GIT-97)

### Added

- **An on-disk copy of your embedding index, so short-lived processes stop re-downloading it.** In
  local search mode, every gitmem process downloaded every learning with its 1536-number embedding
  at startup and threw it away on exit. Sub-agents, parallel workers and CI jobs each paid that cost
  again, and one user used up a Supabase egress allowance this way.
  - **How it works now:** each start asks your store one small question, how many learnings it holds
    and when the newest changed (about 100 bytes). If that matches the copy on disk, gitmem loads
    from disk and skips the download. With 250 learnings, a second start went from about 920 KB
    received to about 100 bytes.
  - **Staleness:** any mismatch, corruption or unreadable file counts as a miss, and gitmem
    downloads fresh. It never serves a copy it can't confirm is current.
  - **Parallel starts:** when several processes start at once, one of them downloads and the others
    wait for its copy, instead of all downloading at the same time.
  - **`cache-flush`** skips the disk copy and rewrites it.
  - **Where it lives:** `<gitmem dir>/cache/learnings-vectors-<hash>.json`. The gitmem dir is
    `~/.gitmem`, or `GITMEM_DIR` if you set it. `<hash>` is derived from your Supabase URL, so
    different stores never share a file.
  - **What it contains:** a local copy of your learnings, including titles, descriptions and
    embeddings. The file is written with mode `0600`, so only your user account can read it.
    Deleting it is always safe; gitmem downloads again on the next start.
  - **Opting out:** set `GITMEM_VECTOR_DISK_CACHE=0` (or `false`) to download on every start, as
    before. (GIT-98)

### Known issues

- **A session that changes scar scores can still cause one re-download.** At `session_start`, gitmem
  recalculates scar scores from their usage history. Any scar whose score changes gets a new
  timestamp, and the next process start downloads the index again. Stores with no usage history
  aren't affected. This goes away when per-row delta sync lands.
- **Scar usage and `confirm_scars` relevance aren't recorded on your project yet.** The usage write
  still targets a table name that doesn't exist on customer stores. It's fixed separately (GIT-84)
  and isn't part of this release.

## [1.8.0] - 2026-08-09

**No one loses any information.** Nothing is deleted, nothing is moved, nothing is overwritten.

gitmem now reads one memory store — `~/.gitmem` — no matter which directory a process starts in.
That has been the default since v1.0.10 in February, so for almost everyone this changes nothing
visible. If you are one of the rare installs that still keeps memory in a project-local `.gitmem/`,
your first `session_start` after upgrading will show you exactly where it is, how many learnings,
threads and sessions are in it, and the one command that copies them across. `migrate-root` copies
and leaves the original untouched. Pro users' Supabase memory is unaffected either way.

The rest of this release is about a quieter problem: gitmem was reporting success for failures. A
session that survived an MCP restart was told it had none. A scar search that never reached the
store was answered with "proceed freely". Both are fixed, and both now say what actually happened.

### Fixed

- **A session no longer loses its identity when the MCP server restarts.** Identity was bound to
  `process.pid` and looked up through the active-sessions registry, so any restart — an app update,
  a rebuild, a relaunch — orphaned the entry and every session-required tool reported "No active
  session" for the rest of the session, while writes continued to land correctly. Identity now
  resolves from the durable per-session store on disk; PID is only a disambiguator, and the registry
  is repaired from disk rather than gating access to it. A live session belonging to another server
  is still never claimed, so concurrent sessions remain isolated. `session_close` also no longer
  requires you to pass `session_id` — it resolves the session itself, which is the case a restart
  exists to break. (GIT-89)
- **Scar retrieval failed on every call whenever the local index was cold.** The Supabase fallback
  built its RPC name from the table prefix and a verb, producing a function that exists under no
  prefix, on any deployment — so a `recall` issued before the in-memory index finished loading
  returned nothing at all. That window includes the first `recall` of a session. The RPCs are now
  called by their deployed names. (GIT-93)
- **`confirm_scars` reported a failed retrieval as a clean check.** With nothing surfaced it replied
  "No recall-surfaced scars to confirm. Proceed freely" — the same answer whether the search had run
  and matched nothing or had never reached the store. It now distinguishes the two and names the
  underlying error, and the distinction survives a restart. This is why the retrieval defect above
  could persist unnoticed. (GIT-93)
- **The pre-publish clean-room images could not build.** Every clean-room Dockerfile installed
  `npm@latest` onto a Node 20 base, which stopped working once npm began requiring Node 22.22+. The
  gate that tests the packaged tarball the way a user installs it had been failing silently, because
  a gate only run by hand has no failure signal between uses. (GIT-91)

### Added

- **`npx gitmem-mcp migrate-root`** — copies a project-local memory store into `~/.gitmem`. It copies
  rather than moves, never overwrites a file that already exists at the destination, and reports
  every file it skipped and why. `--dry-run` shows the exact plan first. (GIT-91)
- **A first-run signpost for project-local stores.** If one is found, `session_start` names the path,
  the record counts it holds, and the one command that copies it in. Detection only — the store is
  never read from behind your back, and never silently unread either. (GIT-91)
- **`GITMEM_HOME`** — relocates the developer-scoped root without short-circuiting resolution the way
  `GITMEM_DIR` does. Useful for containers and CI. (GIT-91)

### Changed

- **The `.gitmem` root no longer depends on the working directory.** Resolution used to walk up from
  `process.cwd()`, which meant the MCP server and the SessionStart hook — which do not share a
  directory — could bind one session to two different stores, with writes landing where identity
  resolution never looked. Project-local stores are still fully supported and are now selected
  explicitly with `GITMEM_DIR`. (GIT-91)
- **CI gates publishing on a real restart.** The release pipeline now runs an end-to-end test that
  kills the MCP server process and drives a recovered session over the MCP protocol, so the identity
  fix above cannot regress into a release. (GIT-89)

## [1.7.0] - 2026-08-07

**No destructive changes, no data loss, no migration.** But if you start seeing errors after
upgrading, those failures were occurring before and being reported as success. 1.7.0 makes them
visible.

That is the whole shape of this release. The response contracts changed — new refusal semantics on
dedup, hard errors on sessionless Pro writes, `success: false` closes, a third cache-health status —
so a write that quietly did nothing now says so. Nothing that worked before stops working.

### Fixed

- **`create_learning` silently dropped fields for most learning types.** `applies_when` was assigned
  only inside the `win` branch, so every scar, pattern and anti-pattern since 2026-02-03 had the
  field validated, acknowledged, and discarded. `problem_context` and `solution_approach` had the
  identical defect at the identical site, and `anti_pattern` had no branch at all, reaching the row
  with no severity. All four are fixed together, guarded by a parameterized test asserting that
  every schema-accepted field persists to the stored row for every learning type. Nineteen affected
  records were recovered from session transcripts and row-verified. (GIT-76)
- **`session_close` could fail to persist against a correctly-provisioned store.** The upsert payload
  was built by spreading the existing session record, which on the Supabase-miss path is the local
  file record — a different shape, carrying rendering fields the table does not define. One unknown
  key failed the entire close, so a fresh Pro install could not close its first session. The payload
  is now filtered to the table's known columns, which fixes the shape-drift class rather than the one
  field that surfaced it. (GIT-74)
- **`syncThreadsToSupabase` created duplicate threads at session close.** An unordered 200-row dedup
  window silently truncated the candidate set, so a text-matching thread outside the window fell
  through to "genuinely new" and was created again. The candidate load is now deterministically
  ordered and complete. (GIT-70)
- **Thread scope was resolved four different ways.** `session_start`'s panel, `list_threads`,
  `resolve_thread` and dedup candidate selection each implemented their own view, which is how a
  `weekend_warrior` thread appeared in a `gitmem` session panel while `list_threads` correctly
  excluded it. All four now import one resolver. (GIT-69)
- **Session identity survives an MCP server restart**, instead of the enforcement layer reporting
  "No active session" while the process kept serving. (GIT-51)
- **Write tools no longer fabricate IDs for writes that did not land.** With no active session or an
  unreachable store, `create_thread` returns an unambiguous failure with no minted ID, rather than a
  success payload and an enforcement banner in the same response. (GIT-67, GIT-63)

### Changed

- **Scar surfacing is tiered by confidence.** Recall renders a stub below 0.55, a compact body from
  0.55 to 0.75, an extended body at 0.75 or for the top hit, and the full body for
  blocking-verification scars regardless of score. Measured against the real corpus: high-yield
  recall dropped from 2565 to 487 tokens (81%), low-yield from 246 to 115 (53%). The citation line,
  the acknowledge line that drives `confirm_scars`, and one footer were deliberately left in place —
  they are load-bearing, and trimming honesty to hit a round number is the metric becoming the
  target. (GIT-74, GIT-50)
- **One citation rule, every surface.** `recall`, `search`, `prepare_context` and the compact hook
  path had four separately-drifting copies. They now share one constant — and the two surfaces that
  instructed agents to cite record IDs while rendering none now render them, because an instruction
  ships only where the capability to obey it does. (GIT-74)
- **Compact renderings show honest fields or nothing.** The one-line lesson is drawn from
  `why_this_matters` and `applies_when`; when neither exists the tier is the header alone. The
  previous first-sentence-of-description heuristic rendered provenance metadata or an echoed title
  about as often as a lesson, and a fragment that looks like a judgment is worse than an absent line.

### Known gaps

Consumer verification for three fixes (GIT-67, GIT-69, GIT-70) is deferred to 1.7.1 and tracked in
GIT-83. The test environment is provisioned and standing; the deferral is scope discipline, not an
unknown.


## [1.6.6] - 2026-06-27

### Changed
- **`recall` stubs low-confidence scars to cut wasted tokens**: scars scoring below the `0.55` similarity threshold (already flagged `[low confidence]`, ~66% N/A rate in that band) now render as a one-line stub — title, severity, score, short id, and the `[low confidence]` tag — instead of hydrating their full body (description, counter-arguments, applies-when, why-this-matters, action-protocol, self-check, related triples). High-confidence scars (≥ 0.55) are unchanged, and blocking-verification scars always render in full regardless of score. The `0.55` cutoff is now a single named constant (`LOW_CONFIDENCE_THRESHOLD`) shared by the tag and the stub so they can't drift apart. The scar's id stays visible, so an agent can still pull detail on demand. (GIT-49)

## [1.6.5] - 2026-06-27

### Fixed
- **`resolve_thread` can now resolve threads created by other sessions**: `list_threads` reads the Supabase source-of-truth, but `resolve_thread` previously matched only the local/session cache — so a thread created by another session showed up in `list_threads` yet returned "Thread not found" when you tried to resolve it. These "visible-but-unresolvable" threads piled up across sessions. `resolve_thread` now falls back to looking the thread up in Supabase (by ID, or by text for `text_match`) before failing, resolves it in the source-of-truth, and syncs the local cache. (GIT-46)

## [1.6.4] - 2026-06-11

### Fixed
- **Init wizard upgrades stale configs**: Running `npx gitmem-mcp@latest init` on a project with an existing gitmem config now detects `"gitmem-mcp"` without `@latest` in the args and upgrades it in-place. Previously it skipped with "already configured" and left the stale reference untouched.

## [1.6.3] - 2026-06-11

### Fixed
- **Stale npx cache**: All MCP server configs now use `gitmem-mcp@latest` instead of `gitmem-mcp`. Without `@latest`, npx can serve a cached older version indefinitely — the `-y` flag only auto-confirms prompts, it does not force a registry check. Affects: init wizard, configure command, README, docs, and distribution configs.

## [1.6.2] - 2026-06-11

### Fixed
- **`archive_learning` short-ID resolution**: Accepts 8-character ID prefixes (e.g., `6edd41e6`) in addition to full UUIDs, matching the short IDs shown by `recall` and `search`.

### Added
- **Write-path health check**: New startup diagnostic detects two silent failure classes — (1) Supabase credentials present but tier resolved to FREE (writes go to local files instead of Supabase), and (2) pro/dev tier but resolved tables don't exist (prefix mismatch). Logs a loud warning at startup instead of failing silently on the first write.
- **`GITMEM_TABLE_PREFIX` documentation**: Pro setup guide now documents custom table prefix configuration, mismatch symptoms, and troubleshooting steps.

## [1.6.1] - 2026-05-25

### Fixed
- **Embeddings not generated on Pro tier**: `embedding.ts`, `variant-generation.ts`, and `transcript-chunker.ts` only checked `process.env.OPENROUTER_API_KEY` — never read the key from `.gitmem/config.json` written by `activate`. Now falls back to `getProConfig()` matching how `supabase-client.ts` already resolves credentials.
- **Lossy free→pro migration**: Migration sent all local JSON fields to PostgREST — unknown columns caused 400 rejections, silently dropping records (only first 3 errors shown). Added `KNOWN_COLUMNS` whitelist per table, type coercion for `action_protocol`/`self_check_criteria` (array→TEXT), and full error visibility (no cap).
- **Migration log file**: `.gitmem/migration.log` now written with per-record outcomes (OK/FAIL/SKIP) for debugging.
- **Mid-migration recovery**: `activate` now detects `.pre-migration` backup files from a previous failed upgrade and re-imports them automatically. No new command — just re-run `activate`.
- **Credential exposure**: `activate` now auto-adds `.gitmem/` to the project's `.gitignore` when inside a git repo.

### Changed
- **E2E stress test v1.4**: Restructured from 6 to 8 simulated days. Day 0 wipes Supabase to blank slate. Day 1 seeds realistic 3+ month free-tier user data (starter scars, unknown fields, type mismatches, mixed projects) and tests full upgrade journey including mid-failure recovery and real embeddings from config.json (not env var). 178 tests total.

## [1.6.0] - 2026-05-25

### Added
- **Free→Pro migration**: Running `activate` with existing local `.gitmem/` data automatically migrates learnings, sessions, decisions, and scar usage to Supabase. Local files are archived with `.pre-migration` suffix.
- **Schema auto-apply via DATABASE_URL**: `activate` now falls back to direct Postgres connection when `SUPABASE_ACCESS_TOKEN` is unavailable, using `DATABASE_URL` from env, config, or interactive prompt.

### Fixed
- **Idempotent schema SQL**: `setup.sql` now uses `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, and `DO $$ ... END $$` guards throughout — safe to re-run for upgrades without errors.

## [1.5.1] - 2026-05-13

### Fixed
- **CI smoke test tool count**: Updated `EXPECTED_TOOL_COUNTS` to reflect `index_docs` and `search_docs` additions (+2 per tier). The 1.5.0 release failed to publish because the smoke test expected 23 free-tier tools but found 25.

## [1.5.0] - 2026-05-11

### Added
- **`index_docs` tool**: Scan a directory of markdown files, chunk them, and store in a local doc index for semantic search. Supports incremental indexing (only re-processes changed files), force re-index, and project-scoped indexes. Aliases: `gitmem-idx`.
- **`search_docs` tool**: Search indexed repository documentation using semantic similarity (pro tier) or BM25 keyword search (free tier). Returns relevant chunks with file paths for targeted reading. Aliases: `gitmem-sd`.
- **Citation protocol**: `recall`, `search`, and `prepare_context` now include a citation rule instructing agents to cite record IDs when referencing facts from institutional memory.
- **Low confidence tagging**: Recall and search results with similarity below 0.55 are tagged `[low confidence]` — these matches have a 66% N/A rate historically.
- **Session duration on resume**: `session_start` now shows elapsed session time and loaded scar count when resuming or refreshing an existing session.

### Changed
- **Quick close hard gate**: `session_close` with `close_type: "quick"` now rejects sessions over 30 minutes, requiring standard close instead.
- **Standard close recall gate**: `session_close` with `close_type: "standard"` now requires at least one `recall()` call during the session (exemptions: quick close, autonomous agents, sessions with inline reflection).

## [1.4.4] - 2026-03-31

### Fixed
- **Project drift on session resume eliminated**: When resuming an existing session (same hostname+PID), the stored project now overrides whatever the agent passes. Previously, context compaction could cause agents to send the wrong project (e.g., `orchestra_dev` instead of `weekend_warrior`), creating a session under the wrong project with wrong threads and decisions. The active-sessions registry already stored the correct project — it just wasn't used on resume.
- **`closing_reflection` array coercion**: Values passed as arrays in `closing_reflection` are now coerced to strings, preventing schema validation errors on session close.
- **`create_thread` no longer triggers false enforcement warnings**: Removed from `CONSEQUENTIAL_TOOLS` list — creating threads is lightweight and shouldn't require prior recall.

## [1.4.3] - 2026-02-24

### Fixed
- **NULL agent values in query metrics eliminated**: `recordMetrics()` now auto-detects agent via `getAgentIdentity()` when callers don't provide it. Previously 15 of 18 tools omitted the agent field, resulting in NULL values in `gitmem_query_metrics`.

### Performance
- **session_start ~200-300ms faster**: Sessions and threads queries now run in parallel (`Promise.all`) instead of sequentially inside `loadLastSession`.
- **session_close transcript upload no longer blocks**: Transcript save moved from blocking `await` to fire-and-forget via effect tracker. Removes 500-5000ms variable cost from `latency_ms`. Claude session ID extraction remains synchronous.

## [1.4.2] - 2026-02-22

### Fixed
- **Scar usage `execution_successful` nulls eliminated**: N_A confirmations now record `true` (was null/undefined). Q6 text matches now include `execution_successful: true` (was omitted). Fixes 80% null rate in scar effectiveness data.
- **Auto-bridge fires on all session closes**: Previously required Q6 `scars_applied` to be non-empty. Now fires whenever no explicit `scars_to_record` is provided, ensuring confirmations from `confirm_scars` always get recorded.
- **Surfaced scars survive MCP restart**: `getSurfacedScars()` now recovers from the active-sessions registry when `currentSession` is null after MCP restart. Scars surfaced early in a session are no longer silently lost.
- **Session close display shows scar titles**: `reference_context` now leads with the scar title instead of boilerplate. Display uses +/! indicators for applied/refuted scars.

## [1.4.1] - 2026-02-22

### Added
- **AGENTS.md generation**: Init wizard now creates an IDE-agnostic `AGENTS.md` file alongside the client-specific instructions file. Contains tool table, core workflow, sub-agent patterns (`prepare_context`, `absorb_observations`), and example JSON tool calls. Read by Codex, Copilot, Gemini, Cursor, and other AI coding assistants for automatic project discovery.

## [1.4.0] - 2026-02-22

### Changed
- **Starter scar penalty doubled** (0.7x → 0.4x): Earned scars now decisively outrank starter scars in recall and search results. 6 community reports of starter scars drowning out project-specific lessons.
- **Display protocol footer trimmed**: Removed the "Success: You echoed..." line from the display suffix — reduced noise without losing the echo instruction.
- **First-recall message rewritten**: Replaced patronizing welcome text with actionable nudge: "No project-specific lessons yet. Use create_learning to capture your first."
- **Session close description simplified**: Tool descriptions now clearly present two modes (inline params or payload file) instead of demanding the file-first approach.

### Added
- **Thread positional resolve (`#N`)**: `resolve_thread` now accepts `#3` to resolve the 3rd thread in display order. Matches the `#` column shown by `list_threads`.
- **Thread ID column in list_threads**: Thread table now shows short IDs (e.g., `t-24aefd13`) alongside positional numbers — agents can reference by either.
- **Provenance `[starter]` tag**: Recall and search results now annotate starter scars with a dim `[starter]` tag, so agents can distinguish earned vs bundled lessons.
- **Inline `closing_reflection` parameter**: `session_close` schema now exposes `closing_reflection` and `human_corrections` as direct parameters — no payload file needed for simple closes.

### Fixed
- **`log` tool missing `anti_pattern` type**: TypeScript type for `learning_type` filter excluded `"anti_pattern"`, causing type errors when filtering by anti-patterns.

## [1.3.5] - 2026-02-22

### Fixed
- **Free tier recall→confirm_scars flow broken**: Recall on free tier returned scars to the agent but never tracked them in session state, causing confirm_scars to respond with "No recall-surfaced scars to confirm" even when valid confirmations were submitted. Reported across 3 clean room sessions.

### Added
- **E2E regression test for recall→confirm_scars**: Verifies the full free tier flow — create scar, recall it, confirm it — catches the session state tracking gap.

## [1.3.4] - 2026-02-22

### Added
- **Expanded starter scar pack** (7 → 12): Five new community-proposed scars covering multi-agent delegation, memory hygiene, and communication patterns.
- **Closing payload pre-seeded during init**: `closing-payload.json` template created at install time, preventing Write permission prompt on first session close.
- **`contribute_feedback` tool**: Agents can submit anonymous feedback (feature requests, bugs, friction) to help improve gitmem.

### Fixed
- **`is_active` filter for free tier**: `list()` now treats missing `is_active` as `true` instead of filtering out all learnings without the field.
- **`learning_type` in recall results**: Recall now returns `learning_type` in search results so agents can distinguish scars from wins and patterns.
- **Explicit `is_active: true` on learning creation**: New learnings are created with `is_active: true` to prevent filter mismatches.

## [1.3.1] - 2026-02-22

### Fixed
- **Archived learnings excluded from free tier search/log**: `keywordSearch` and `log` on the free tier (local JSON storage) now filter out `is_active === false` learnings, matching pro tier behavior.

### Changed
- **Removed uninstall line from init success footer**: Cleaner post-install output.

## [1.3.0] - 2026-02-22

### Added
- **Expanded starter scars** (3 → 7): New scars covering testing, config drift, dependency management, and root-cause debugging.
- **Real UUIDs on starter scars**: Replaced placeholder `00000000-*` IDs with real v4 UUIDs — fixes 8-char prefix matching in `confirm_scars`.
- **First-recall welcome message**: When all recall results are starter scars, shows "This is your first recall — results will get more relevant as you add your own lessons."
- **Starter thread**: Fresh installs get a welcome thread nudging users to add their first project-specific scar.
- **Clean room Dockerfile for local builds**: `testing/clean-room/Dockerfile.local` for testing local tarballs.

### Fixed
- **Enforcement false positives**: `recall()` returning 0 scars no longer triggers "No recall() was run" warning. Tracks `recallCalled` boolean independently of result count.
- **Init wizard brand styling**: Unified color system and ripple branding in both init and uninstall wizards.

### Changed
- **Clean room Dockerfiles**: Updated npm to latest to suppress upgrade nag during testing.

## [1.2.1] - 2026-02-21

### Added
- **MCP Registry metadata**: Added `mcpName` field to package.json and `server.json` for official MCP Registry listing.

## [1.2.0] - 2026-02-20

### Added
- **Telemetry CLI**: `npx gitmem-mcp telemetry` command for viewing scar effectiveness metrics and recall statistics.
- **Confirm-scars prefix matching**: `confirm_scars` now accepts 8-character ID prefixes instead of requiring full UUIDs — faster agent workflows.
- **Session-close timing**: `session_close` now tracks and reports ceremony duration for performance visibility.

### Fixed
- **Test assertion alignment**: Updated smoke and E2E test assertions to match current CLI output format (branded `((●))` display, lowercase identifiers).
- **No-console-log allowlist**: CLI commands correctly excluded from console.log lint rule.

## [1.1.4] - 2026-02-20

### Changed
- **Recall default switched to c-review**: Production nudge header changed from "INSTITUTIONAL MEMORY ACTIVATED" to "N scars to review". Nudge-bench testing (54 runs × 3 models) showed 89% scar reference rate vs 44% — a 2x improvement across Opus, Sonnet, and Haiku.

### Fixed
- **Thread display cleanup**: Removed internal thread IDs from `list_threads` output. Threads now show `# | Thread | Active` — IDs were implementation detail with no user value.

## [1.1.3] - 2026-02-19

### Added
- **Multi-client init wizard**: `npx gitmem-mcp init` now supports VS Code, Windsurf, and generic MCP clients in addition to Claude Code and Cursor.
- **Server-side enforcement layer**: Universal compliance enforcement that works across all MCP clients — recall before consequential actions, scar confirmation gates.
- **Scar framing guidance**: `create_learning` tool now guides agents to frame scars as "what we now know" (factual discovery) rather than "what I did wrong" (self-criticism).
- **Auto-detect agent and session**: Scar usage tracking automatically detects the current agent identity and session context.
- **Closing payload schema**: Session close payload schema now ships with `init` and `session_start` for client reference.
- **npm discoverability keywords**: Added `mcp-server`, `claude-code`, `ai-memory`, `ai-agent` keywords for npm search.
- **Documentation site**:
  - Restored Fumadocs source for gitmem.ai/docs with emerald theme.
  - Redesigned docs landing page with improved messaging and branding.
  - Added FAQ page with 11 questions.
  - Added MCP one-liner explainer for new users.
  - Added 3 docs examples (scar stories): credential leak, phantom deploy, and first scar.
  - Inline mailing list signup form in docs pages.
  - Rich installation page with multi-client instructions.

### Fixed
- **Thread display output**: `list_threads` and `cleanup_threads` replaced ASCII box-drawing tables with markdown tables. Thread text truncation increased from 40-48 to 60 characters. Output now renders cleanly in all MCP clients instead of clipping on narrow terminals.
- **Version reporting**: Server now reads version from `package.json` instead of hardcoded `1.0.3`.
- **Log header clarity**: `gitmem log` header now says "most recent learnings" instead of ambiguous label.
- **Analyze output**: Relabeled misleading "Open Threads" to "Threads Referenced" in analyze output.
- **Stale thread cleanup**: Drop stale local-only threads on `session_start` when Supabase is authoritative source.
- **Package name in docs**: Corrected to `npx gitmem-mcp init` (was `npx gitmem init`).
- **Docs fixes**: Removed duplicate h1 headers, fixed sidebar nav duplicate entry, corrected GitHub URLs after org migration.

## [1.1.2] - 2026-02-17

### Changed
- **Repository migration**: Moved from `nTEG-dev/gitmem` to `gitmem-dev/gitmem`. All references updated.

### Added
- **OpenClaw distribution**: SKILL.md and listing materials for OpenClaw skill directory.

## [1.1.1] - 2026-02-17

### Removed
- **Dead dependency `@huggingface/transformers`**: Massive package (ONNX runtime + model files) was declared as a runtime dependency but never imported anywhere. Embedding service uses raw `fetch()` to external APIs. Shipped unused since initial release, bloating every `npx gitmem-mcp` install.

### Added
- **CI dependency audit**: `depcheck` now runs in CI pipeline. Unused runtime dependencies will fail the build. This gap allowed the dead dependency to ship through 15+ versions undetected.

## [1.1.0] - 2026-02-17

### Added
- **Cursor IDE support**: `npx gitmem-mcp init` auto-detects Cursor projects (`.cursor/` directory) and generates Cursor-specific config: `.cursor/mcp.json`, `.cursorrules`, `.cursor/hooks.json` with camelCase event names. Also supports `--client cursor` flag for explicit selection.
- **Cursor uninstall**: `npx gitmem-mcp uninstall` cleanly removes gitmem from Cursor config while preserving user hooks, other MCP servers, and existing `.cursorrules` content.
- **Cursor clean room testing**: Docker container (`Dockerfile.cursor`) with Cursor CLI v2026.02.13 + gitmem for end-to-end validation. Includes comprehensive test plan (16 tests across 3 phases).
- **34 new E2E tests**: Cross-tool Cursor integration tests covering init/uninstall for both clients, idempotency, content isolation, and edge cases.
- **454 new unit tests**: Confirm-scars rejection rate tests, recall threshold tests.

### Fixed
- **Confirm-scars rejection rate**: Reduced false rejections by improving scar matching tolerance.
- **Recall relevance threshold**: Added minimum relevance floor to reduce noise in recall results.
- **Recall nudge**: Improved guidance when recall returns low-relevance results.

### Validated
- Independent Cursor AI agent scored gitmem **88% (18.5/21)** across 7 test scenarios run 3 times each. Verdict: "GitMem is a must-have." ([OD-695](https://linear.app/nteg-labs/issue/OD-695), [OD-696](https://linear.app/nteg-labs/issue/OD-696), [OD-697](https://linear.app/nteg-labs/issue/OD-697), [OD-698](https://linear.app/nteg-labs/issue/OD-698) filed from findings.)

## [1.0.15] - 2026-02-16

### Fixed
- **Thread dedup without API key**: Dedup silently fell back to exact text match when no embedding API key (OpenAI/OpenRouter/Ollama) was set — which is the default for free tier users. Near-duplicate threads with the same topic but different wording slipped through. Added zero-dependency token overlap coefficient as a middle tier (threshold 0.6, lowered to 0.4 when threads share an issue prefix like `OD-692:`). Also upgraded `deduplicateThreadList` with the same logic. +18 unit tests.

## [1.0.12] - 2026-02-16

### Fixed
- **Table prefix for pro tier**: `getTableName()` was resolving to `gitmem_*` tables for pro tier, but those tables don't exist yet. All tiers now default to `orchestra_` prefix until schema migration is complete.

### Changed
- **Dynamic table names**: Replaced all hardcoded `orchestra_*` table name strings across 22 source files with `getTableName()` calls, making table prefixes configurable via `GITMEM_TABLE_PREFIX` env var.
- **Release status script**: Added `npm run release-status` to check unpublished commits vs npm.

## [1.0.11] - 2026-02-16

### Changed
- **CI pipeline cleanup**: `build` script is now just `tsc` (was `tsc && npm run test:unit`). Tests ran 8x per CI run due to `build`, `test`, and `prepublishOnly` all triggering the same 764-test suite. Now each step does one thing: typecheck, compile, test, smoke, publish.

## [1.0.10] - 2026-02-16

### Fixed
- **CI smoke test**: `session_close` test looked for `active-sessions.json` at `process.cwd()` instead of `GITMEM_DIR`, failing in CI where they differ.
- **CI peer dependencies**: Added `--legacy-peer-deps` to `npm ci` for `zod@4` conflict with `claude-agent-sdk`.
- **CI unit test**: `quick-retrieve.test.ts` now sets `GITMEM_DIR` so disk cache tests resolve correctly in CI.

## [1.0.9] - 2026-02-16

### Fixed
- **Closing payload field name mismatch**: `CLAUDE.md.template` documented wrong field names (`institutional_memory` instead of `institutional_memory_items`, bogus `started_at`/`completed_at` in task_completion) causing agents to write payloads that `session_close` couldn't parse. Fixed template and added `institutional_memory` as normalizer alias.
- **Missing Q8/Q9 in closing template**: Added `collaborative_dynamic` and `rapport_notes` fields to payload example.

## [1.0.6] - 2026-02-16

### Fixed
- **Session close crash on malformed scars_to_record**: Agents writing `{title, description, severity}` (create_learning shape) instead of `{scar_identifier, reference_type, reference_context}` (ScarUsageEntry shape) in closing payload caused `Cannot read properties of undefined (reading 'length')` crash in `formatCloseDisplay`. Now auto-coerces salvageable entries and drops invalid ones with warnings.
- **Defensive property access in formatCloseDisplay**: Guard against undefined `scar_identifier`, `reference_type`, and `reference_context` as belt-and-suspenders protection.

## [1.0.3] - 2026-02-15

### Changed
- **Tool alias consolidation**: Reduced advertised tools from 55 to 20 (free tier). Aliases still work when called directly. Set `GITMEM_FULL_ALIASES=1` to restore all.
- **Starter scars reduced**: Ship with 3 high-quality starter scars instead of 12. Starter scars deprioritized with 0.7x score multiplier so earned scars outrank them.
- **Recall similarity threshold**: Weak matches below threshold (0.4 BM25, 0.35 embeddings) are suppressed. Empty results show helpful guidance instead of noise.
- **Adaptive session closing**: Auto-detects ceremony level (micro/standard/full) based on session activity. Removed hard rejection gate that blocked standard closes on short sessions.
- **Scar relevance feedback**: Optional `relevance` field (high/low/noise) on `confirm_scars` for recall quality improvement. Defaults derived from decision type.
- **Pro tier messaging**: Rewritten from agent's perspective with concrete value propositions.

### Added
- **Agent briefing**: Generates `.gitmem/agent-briefing.md` at session close with memory state summary for MEMORY.md bridge.
- **PMEM/GitMem boundary docs**: README section documenting how GitMem complements MEMORY.md/cursorrules.

## [1.0.2] - 2026-02-15

### Fixed
- **Free tier crash**: `markSessionSuperseded` called Supabase without `hasSupabase()` guard
- **Session close UX**: Write health block only shown when failures exist (was always visible)
- **E2E test suite**: Updated for display protocol changes (session_id extraction, display format assertions, recall display text, CLAUDE.md template wording)

## [1.0.0] - 2026-02-10

### Added
- **Hooks plugin bundled**: `gitmem install-hooks` / `uninstall-hooks` CLI commands
- **CLI `check` command wired**: `gitmem check` now reachable from CLI (was defined but unreachable)
- **Fresh-install E2E tests**: 16 integration tests covering CLI commands, hooks, and MCP server lifecycle
- **README rewrite**: External-developer-facing docs with no internal jargon
- **CONTRIBUTING.md**: Dev setup, testing tiers, and PR guidelines
- **First public npm release**

### Changed
- Package name standardized to `gitmem-mcp` for npm
- `gitmem configure` output uses `gitmem-mcp` (matching npm package name)
- Removed internal project defaults from CLI commands

## [0.2.0] - 2026-02-08

### Added
- **Full monorepo sync**: Standalone repo is now source of truth
- **Zod schemas**: 14 schema files for all tool parameter validation (`src/schemas/`)
- **Diagnostics suite**: Health checks, channel instrumentation, anonymization (`src/diagnostics/`)
- **Single source of truth constants**: Closing questions defined once (`src/constants/closing-questions.ts`)
- **Multi-agent tools**: `prepare_context` and `absorb_observations`
- **Tool definitions module**: Centralized tool registration (`src/tools/definitions.ts`)
- **Commands module**: `gitmem check` CLI health diagnostics (`src/commands/check.ts`)
- **Full test suite**: 354+ unit tests across 20 test files, plus integration, e2e, and performance benchmarks
- **Vitest configs**: Separate configs for unit, integration, e2e, and performance tests
- **Compliance validator warnings**: Q3/Q5 substantive answers warn if no learnings created

### Fixed
- **Critical**: GitMem now loads ALL learning types (scars, patterns, wins, anti-patterns) instead of just scars
- Closing reflection schema now includes Q7 (`institutional_memory_items`) field

### Changed
- `build` script now runs unit tests after compilation (`tsc && npm run test:unit`)
- Version bumped to 0.2.0 to reflect full feature parity with monorepo

## [0.1.0] - 2026-02-03

### Added
- Initial MCP server implementation
- Predict tool (scar search with temporal decay)
- Session lifecycle (session_start, session_close)
- Learning capture (scars, wins, patterns)
- Decision logging
- Scar usage tracking
- Local vector search with OpenRouter embeddings
- Cache management (status, flush, health)
- Agent identity detection

[Unreleased]: https://github.com/gitmem-dev/gitmem/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gitmem-dev/gitmem/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/gitmem-dev/gitmem/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gitmem-dev/gitmem/releases/tag/v0.1.0
