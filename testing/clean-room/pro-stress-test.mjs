import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "fs";

// ─── Helper to start a fresh MCP server ───
async function startClient() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/usr/local/lib/node_modules/gitmem-mcp/dist/index.js"],
    env: process.env,
    cwd: "/home/developer/my-project",
  });
  const client = new Client({ name: "stress-test", version: "1.0" });
  await client.connect(transport);
  return client;
}

let client = await startClient();
const results = {};
let passed = 0, warned = 0, failed = 0;

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args || {} });
  return r.content[0].text;
};

const test = async (label, fn) => {
  try {
    const text = await fn();
    const hasFatal = text.includes("Fatal") || (text.includes("FAIL") && !text.includes("failed silently"));
    results[label] = hasFatal ? "WARN" : "PASS";
    if (hasFatal) warned++; else passed++;
    return text;
  } catch (e) {
    results[label] = "FAIL: " + e.message.substring(0, 80);
    failed++;
    return "";
  }
};

// Extract IDs from tool output
const extractId = (text, pattern) => {
  const m = text.match(pattern);
  return m ? m[1] : null;
};

console.log("╔═══════════════════════════════════════════════════════════════╗");
console.log("║  GITMEM PRO STRESS TEST — 5 simulated days of usage         ║");
console.log("║  50 scars, 10 patterns, 10 threads, docs, full lifecycle    ║");
console.log("╠═══════════════════════════════════════════════════════════════╣");

// ═══════════════════════════════════════════════════════════════════════════
// DAY 1: Initial setup — session, scars, patterns
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n━━━ DAY 1: Initial setup ━━━");

// Session start
console.log("\n[1.1] Session start...");
let sessionText = await test("day1:session_start", () => call("session_start", { project: "stress-test" }));
let sessionId = extractId(sessionText, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
console.log("  Session:", sessionId ? sessionId.substring(0, 8) + "..." : "local");

// 50 scars
console.log("\n[1.2] Creating 50 scars...");
const scarDomains = [
  { domain: ["database"], keywords: ["postgres","supabase","sql"], pfx: "DB" },
  { domain: ["api"], keywords: ["rest","http","endpoint"], pfx: "API" },
  { domain: ["auth"], keywords: ["jwt","token","session"], pfx: "Auth" },
  { domain: ["testing"], keywords: ["unit","e2e","mock"], pfx: "Test" },
  { domain: ["deployment"], keywords: ["docker","ci","deploy"], pfx: "Deploy" },
  { domain: ["frontend"], keywords: ["react","css","component"], pfx: "UI" },
  { domain: ["security"], keywords: ["xss","injection","rls"], pfx: "Sec" },
  { domain: ["performance"], keywords: ["cache","latency","index"], pfx: "Perf" },
  { domain: ["architecture"], keywords: ["pattern","coupling","module"], pfx: "Arch" },
  { domain: ["observability"], keywords: ["logging","metrics","alert"], pfx: "Obs" },
];
const sevs = ["critical","high","medium","low"];
const descs = [
  "Always validate input before passing to database queries. Unvalidated UUIDs cause 500 errors that look like infrastructure failures.",
  "Connection pools must be sized to match concurrent query load. Undersized pools cause cascading timeouts.",
  "Rate limiting should be at the API gateway, not application code. App-level limiting is bypassed by direct DB access.",
  "JWT expiration must be checked every request, not just at login. Expired tokens with valid signatures are an attack vector.",
  "Mock external services in unit tests, use real services in integration tests. Mocks hide contract changes.",
  "Container health checks should verify app readiness, not just process existence.",
  "React useEffect must have cleanup. Race conditions cause stale data rendering.",
  "SQL injection is possible through ORM raw queries. Always use parameterized queries.",
  "Cache invalidation must be event-driven, not time-based. TTL causes stale reads during high traffic.",
  "Never log sensitive data. Implement structured logging with field-level redaction.",
  "Database migrations should be reversible. Forward-only migrations block rollback during incidents.",
  "API versioning should use URL path v1/v2, not headers. Header versioning breaks caching.",
  "Auth middleware must run before authorization. Checking perms on unauthenticated requests leaks resource existence.",
  "Feature flags need expiration dates. Stale flags accumulate tech debt.",
  "Error messages must never include stack traces. Stack traces reveal internal architecture.",
  "Database indexes must be created before deploying dependent code. Missing indexes cause query timeouts.",
  "WebSocket connections need heartbeat mechanisms. Silent disconnects cause ghost sessions.",
  "File uploads must validate content type server-side. Content-Type headers are trivially spoofed.",
  "Retry logic must use exponential backoff with jitter. Fixed retries cause thundering herd.",
  "Environment variables must be validated at startup, not at first use. Missing vars cause prod failures.",
  "Database transactions should be short. Long transactions hold locks causing deadlocks.",
  "API responses must include pagination metadata. Without page counts clients make excessive requests.",
  "CORS must whitelist specific origins, not wildcards. Wildcard CORS enables CSRF.",
  "Background jobs must be idempotent. Retries cause duplicate processing without idempotency keys.",
  "GraphQL resolvers need DataLoader to prevent N+1 queries. Each invocation is a separate DB round-trip.",
  "Password hashing must use bcrypt or argon2. SHA-256 is fast making brute force feasible.",
  "K8s readiness probes must check dependencies. Passing liveness but failing readiness sends unservable traffic.",
  "TypeScript strict mode should be enabled from project start. Enabling later requires fixing hundreds of errors.",
  "DNS TTL should be low during migrations. High TTL causes traffic to hit old servers.",
  "Load balancer affinity should only be for WebSocket. HTTP affinity causes uneven load.",
  "Database connection strings must never be in version control. Use env vars or secret managers.",
  "API endpoints must return consistent error formats. Inconsistent shapes force multiple parsing strategies.",
  "Monitoring alerts need runbooks attached. Alerts without runbooks wake people without telling them what to do.",
  "Service mesh sidecars add latency. Measure baseline before and after mesh adoption.",
  "CSS-in-JS increases JS bundle size. For static styles use CSS modules or utility classes.",
  "OAuth refresh tokens should be rotated on use. Reusable tokens are persistent access vectors if leaked.",
  "Database VACUUM should be off-peak. Large table VACUUM causes I/O spikes affecting queries.",
  "Git hooks must not block on network calls. Slow pre-commit hooks get skipped with --no-verify.",
  "Terraform state must be remote with locking. Local state causes team conflicts.",
  "API rate limit headers should be in responses. Without them clients cannot implement polite backoff.",
  "Log aggregation must correlate by request ID. Without correlation IDs distributed debugging needs timestamp alignment.",
  "Database enums should be reference tables. Altering enums requires migrations and downtime.",
  "CDN cache must be purged on deploy. Scheduled purges serve stale assets between deploys.",
  "Microservice boundaries should align with teams. Cross-team services create coordination overhead.",
  "Circuit breakers need fallback responses. Open circuits without fallbacks return errors to users.",
  "Search indexing should be eventual-consistent. Synchronous indexing adds write latency.",
  "Secrets rotation must be automated. Manual rotation is forgotten creating long-lived credentials.",
  "Database read replicas handle analytics queries. Analytics on primary cause write latency spikes.",
  "Container images must pin exact versions. Latest tags cause non-reproducible builds.",
  "gRPC services must implement graceful shutdown. Abrupt termination drops in-flight requests.",
];
const scarIds = [];
for (let i = 0; i < 50; i++) {
  const d = scarDomains[i % 10];
  const text = await test(`day1:scar_${i+1}`, () => call("create_learning", {
    learning_type: "scar", title: `${d.pfx}-${String(i+1).padStart(2,"0")}: ${descs[i].split(".")[0]}`.substring(0, 120),
    description: descs[i], severity: sevs[i % 4], domain: d.domain,
    keywords: [...d.keywords, `scar-${i+1}`],
    counter_arguments: ["May not apply in simple projects", "Overhead not worth it for prototypes"],
  }));
  const id = extractId(text, /id[:\s]+([0-9a-f]{8})/i);
  if (id) scarIds.push(id);
  if ((i+1) % 10 === 0) console.log(`  ${i+1}/50 scars`);
}

// 10 patterns
console.log("\n[1.3] Creating 10 design patterns...");
const pats = [
  "Repository pattern: abstract DB access behind interfaces for testability",
  "Event sourcing: store changes as immutable events for audit trails",
  "CQRS: separate read/write models for read-heavy workloads",
  "Circuit breaker: wrap external calls with failure thresholds and fallbacks",
  "Saga pattern: coordinate distributed transactions with compensating actions",
  "Strangler fig: incrementally replace legacy via routing facade",
  "Bulkhead isolation: isolate critical resources per service for fault containment",
  "Sidecar pattern: deploy auxiliary containers for cross-cutting concerns",
  "Feature toggle: gate features with percentage rollout and instant rollback",
  "Outbox pattern: reliable messaging via transactional outbox table",
];
for (let i = 0; i < 10; i++) {
  await test(`day1:pattern_${i+1}`, () => call("create_learning", {
    learning_type: "pattern", title: pats[i].split(":")[0],
    description: pats[i], domain: ["architecture"], keywords: ["design-pattern"],
  }));
}
console.log("  10/10 patterns");

// 5 decisions
console.log("\n[1.4] Creating 5 decisions...");
const decs = [
  { title: "PostgREST RPC over Edge Functions", decision: "Direct RPC calls via PostgREST", rationale: "No Edge Function deployment needed, lower latency" },
  { title: "BM25 local + vectors remote", decision: "BM25 for free tier, embeddings for pro", rationale: "BM25 works offline, vectors need API" },
  { title: "Service role key for all access", decision: "Single service_role key for MCP server", rationale: "MCP server is the trust boundary" },
  { title: "72h license cache TTL", decision: "Cache validation for 72 hours", rationale: "Balances freshness with offline resilience" },
  { title: "Auto-schema via Management API", decision: "Apply schema during activation", rationale: "Manual SQL paste is error-prone" },
];
for (const d of decs) {
  await test(`day1:decision_${d.title.substring(0,30)}`, () => call("create_decision", d));
}

// 10 threads
console.log("\n[1.5] Creating 10 threads...");
const threadTexts = [
  "Implement OAuth2 PKCE flow for mobile clients",
  "Profile and optimize slow analytics dashboard queries",
  "Add WebSocket support for real-time notifications",
  "Migrate legacy REST API to GraphQL",
  "Set up Prometheus monitoring with Grafana dashboards",
  "Implement rate limiting at API gateway level",
  "Add end-to-end encryption for user messages",
  "Create automated database backup verification",
  "Build CI/CD pipeline for canary deployments",
  "Design multi-tenant data isolation strategy",
];
const threadIds = [];
for (let i = 0; i < 10; i++) {
  const text = await test(`day1:thread_${i+1}`, () => call("create_thread", { text: threadTexts[i] }));
  const tid = extractId(text, /(t-[0-9a-f]{8})/);
  if (tid) threadIds.push(tid);
}
console.log(`  10 threads created, captured ${threadIds.length} IDs`);

// List threads
await test("day1:list_threads", () => call("list_threads", { project: "stress-test" }));

// Close day 1 session
console.log("\n[1.6] Closing day 1 session...");
await test("day1:session_close", () => call("session_close", {
  close_type: "quick",
  closing_reflection: {
    what_worked: "Initial data seeding went smoothly",
    what_broke: "Nothing — first session",
    do_differently: "Start with fewer scars to validate pipeline first",
    scars_applied: [],
    institutional_memory_items: "50 scars and 10 patterns seeded",
    collaborative_dynamic: "Solo setup session",
    rapport_notes: "Productive",
    what_took_longer: "Nothing notable",
    wrong_assumption: "None",
  },
}));

// ═══════════════════════════════════════════════════════════════════════════
// DAY 2: New session — recall, confirm scars, resolve threads
// Restart MCP server to simulate new session
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n━━━ DAY 2: Recall, confirm, resolve ━━━");

await client.close();
client = await startClient();

console.log("\n[2.1] Session start (should load day 1 context)...");
sessionText = await test("day2:session_start", () => call("session_start", { project: "stress-test" }));
// Should see threads and last session
const hasThreads = sessionText.includes("thread") || sessionText.includes("Thread");
console.log("  Loaded threads:", hasThreads ? "yes" : "no");

// Recall before action
console.log("\n[2.2] Recall before deploying...");
let recallText = await test("day2:recall_deploy", () => call("recall", { plan: "deploy database migration to production", project: "stress-test" }));
const recallScarCount = (recallText.match(/id:[0-9a-f]{8}/gi) || []).length;
console.log(`  Recalled ${recallScarCount} scars for deployment`);

// Confirm scars from recall
console.log("\n[2.3] Confirm recalled scars...");
// Extract scar IDs from recall output
const recalledIds = [...recallText.matchAll(/id:([0-9a-f]{8})/gi)].map(m => m[1]);
if (recalledIds.length > 0) {
  const confirmations = recalledIds.slice(0, 3).map(id => ({
    scar_id: id,
    decision: "APPLYING",
    evidence: "Verified migration is reversible, indexes created before deploy, env vars validated at startup.",
    relevance: "high",
  }));
  await test("day2:confirm_scars", () => call("confirm_scars", { confirmations }));
} else {
  await test("day2:confirm_scars", () => call("confirm_scars", { confirmations: [{
    scar_id: "00000000", decision: "N_A",
    evidence: "No scars were recalled — stress test with fresh data, low similarity expected.", relevance: "noise",
  }]}));
}

// More recall queries
console.log("\n[2.4] More recall queries...");
await test("day2:recall_auth", () => call("recall", { plan: "implement JWT authentication", project: "stress-test" }));
await test("day2:recall_cache", () => call("recall", { plan: "add Redis caching layer", project: "stress-test" }));
await test("day2:recall_frontend", () => call("recall", { plan: "refactor React components", project: "stress-test" }));
await test("day2:recall_security", () => call("recall", { plan: "security audit of file upload endpoint", project: "stress-test" }));

// Resolve 3 threads
console.log("\n[2.5] Resolving 3 threads...");
if (threadIds.length >= 3) {
  await test("day2:resolve_thread_1", () => call("resolve_thread", {
    thread_id: threadIds[0], resolution_note: "PKCE flow implemented and deployed to staging",
  }));
  await test("day2:resolve_thread_2", () => call("resolve_thread", {
    thread_id: threadIds[1], resolution_note: "Added indexes, query time dropped from 3s to 200ms",
  }));
  await test("day2:resolve_thread_3", () => call("resolve_thread", {
    thread_id: threadIds[2], resolution_note: "WebSocket support live, heartbeat every 30s",
  }));
}

// List threads — should show 7 open, 3 resolved
await test("day2:list_threads_open", () => call("list_threads", { project: "stress-test" }));

// Reflect scars at end of day
console.log("\n[2.6] Reflect scars...");
if (recalledIds.length > 0) {
  const reflections = recalledIds.slice(0, 3).map(id => ({
    scar_id: id, outcome: "OBEYED",
    evidence: "Applied the scar — verified migration reversibility before deploying.",
  }));
  await test("day2:reflect_scars", () => call("reflect_scars", { reflections }));
}

// Record scar usage
console.log("\n[2.7] Record scar usage...");
await test("day2:record_scar_usage", () => call("record_scar_usage", {
  scar_id: recalledIds[0] || "00000000",
  surfaced_at: new Date().toISOString(),
  reference_type: "explicit",
  reference_context: "Applied during database migration deployment — verified reversibility",
}));

// Record scar usage batch
console.log("\n[2.8] Record scar usage batch...");
const batchScars = recalledIds.slice(0, 2).map(id => ({
  scar_identifier: id,
  surfaced_at: new Date().toISOString(),
  acknowledged_at: new Date().toISOString(),
  reference_type: "acknowledged",
  reference_context: "Batch test — acknowledged during deployment review",
  execution_successful: true,
}));
if (batchScars.length > 0) {
  await test("day2:record_scar_usage_batch", () => call("record_scar_usage_batch", { scars: batchScars }));
} else {
  await test("day2:record_scar_usage_batch", () => call("record_scar_usage_batch", { scars: [{
    scar_identifier: "00000000", surfaced_at: new Date().toISOString(),
    reference_type: "none", reference_context: "No scars recalled in test",
  }]}));
}

// Session refresh mid-day
console.log("\n[2.9] Session refresh...");
await test("day2:session_refresh", () => call("session_refresh", { project: "stress-test" }));

// Close day 2
console.log("\n[2.9] Closing day 2...");
await test("day2:session_close", () => call("session_close", {
  close_type: "quick",
  closing_reflection: {
    what_worked: "Recall surfaced relevant scars for deployment",
    what_broke: "Nothing",
    do_differently: "Confirm scars immediately after recall",
    scars_applied: ["DB migration reversibility", "Index before deploy"],
    institutional_memory_items: "Recall works well for deployment tasks",
    collaborative_dynamic: "Solo session",
    rapport_notes: "Efficient",
    what_took_longer: "Nothing",
    wrong_assumption: "None",
  },
}));

// ═══════════════════════════════════════════════════════════════════════════
// DAY 3: Docs, search, graph, analytics
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n━━━ DAY 3: Docs, search, graph, analytics ━━━");

await client.close();
client = await startClient();

await test("day3:session_start", () => call("session_start", { project: "stress-test" }));

// Create and index markdown docs
console.log("\n[3.1] Creating markdown docs...");
const docsDir = "/home/developer/my-project/docs";
mkdirSync(docsDir, { recursive: true });

writeFileSync(`${docsDir}/architecture.md`, `# System Architecture

## Overview
The system uses a layered architecture separating local storage, cloud persistence, and semantic intelligence. At its core is an MCP server providing persistent institutional memory across sessions.

## Storage Layer
Dual-mode: free tier stores locally in .gitmem/ as JSON. Pro tier uses Supabase (PostgreSQL) with pgvector for semantic search. Eight tables: learnings, sessions, decisions, scar_usage, threads, query_metrics, knowledge_triples, scar_enforcement_variants.

## Embedding Pipeline
Text-embedding-3-small (1536 dimensions) via OpenRouter or OpenAI. Fire-and-forget — records stored without embeddings if provider unavailable. Semantic search uses pgvector cosine distance. Scar search adds temporal decay (process=permanent, incident=180d, context=30d) and behavioral decay (dismissed scars weighted lower).

## Session Lifecycle
Start loads previous context, surfaces threads, presents decisions. During work, recall surfaces relevant scars. Close captures structured reflection: what broke, what worked, what to do differently.

## Multi-Agent Coordination
prepare_context generates compact payloads for sub-agents in three formats: full (markdown), compact (~500 tokens), gate (~100 tokens blocking only). absorb_observations captures sub-agent findings and identifies scar candidates.

## Knowledge Graph
Triples connect entities via typed predicates: created_in, influenced_by, supersedes, demonstrates. graph_traverse supports connected_to, produced_by, provenance, and stats modes.

## Thread Management
Threads track unresolved work with lifecycle: emerging, active, cooling, dormant, archived, resolved. Vitality scores decay over time. Semantic dedup prevents duplicate threads (cosine > 0.85).

## Cache Architecture
Local vector cache loads learnings with embeddings at startup, refreshes every 15 minutes. BM25 keyword search runs against cache. Persisted to disk for hook processes.

## License Validation
SECURITY DEFINER RPC on infrastructure Supabase. 72-hour cache. 3 concurrent devices per license. Deactivate frees slots server-side.
`);

writeFileSync(`${docsDir}/deployment.md`, `# Deployment Guide

## Prerequisites
Node.js >= 18, Supabase project, OpenRouter account, GitMem Pro license key.

## Activation
Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY as environment variables. Run npx supabase login for management API access. Run npx gitmem-mcp activate with your key. Schema applied automatically.

## Schema Management
Setup SQL bundled with npm package. Applied via Supabase Management API during activation. Manual fallback: npx gitmem-mcp setup outputs SQL for dashboard paste.

## Environment Variables
Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY. Optional: GITMEM_TABLE_PREFIX (default gitmem_), GITMEM_TIER (override detection), GITMEM_EMBEDDING_PROVIDER (force provider).

## Monitoring
gitmem-mcp check runs diagnostic health check. health tool shows write success rates for fire-and-forget operations. analyze tool provides session analytics and blindspot detection.
`);

writeFileSync(`${docsDir}/api-reference.md`, `# API Reference

## Tool Categories

### Session Lifecycle
session_start, session_refresh, session_close manage session context. Start loads last session, threads, decisions. Refresh re-surfaces context mid-session. Close persists reflection.

### Memory Creation
create_learning stores scars, wins, patterns with optional embeddings. create_decision logs architectural decisions with rationale and alternatives. record_scar_usage tracks scar surfacing and application.

### Retrieval
recall performs semantic search before consequential actions. confirm_scars acknowledges recalled scars. reflect_scars provides end-of-session compliance. search queries by keyword or semantics. log browses chronologically.

### Threads
create_thread, list_threads, resolve_thread, cleanup_threads manage cross-session work. promote_suggestion and dismiss_suggestion handle auto-detected threads.

### Multi-Agent
prepare_context generates sub-agent briefings. absorb_observations captures sub-agent findings.

### Knowledge Graph
graph_traverse with four lenses: connected_to, produced_by, provenance, stats. archive_learning soft-deletes entries.

### Analytics
analyze provides summary, reflections, blindspots views. health shows write operation success rates.

### Document Indexing
index_docs indexes markdown directories. search_docs queries indexed content.

### Cache
gitmem-cache-status, gitmem-cache-health, gitmem-cache-flush manage the local vector cache.
`);

console.log("  3 docs written");

console.log("\n[3.2] Indexing docs...");
await test("day3:index_docs", () => call("index_docs", { directory: docsDir, project: "stress-test" }));

console.log("\n[3.3] Searching docs...");
await test("day3:search_docs_arch", () => call("search_docs", { query: "embedding pipeline semantic search", project: "stress-test" }));
await test("day3:search_docs_deploy", () => call("search_docs", { query: "environment variables configuration", project: "stress-test" }));
await test("day3:search_docs_api", () => call("search_docs", { query: "thread lifecycle management", project: "stress-test" }));
await test("day3:search_docs_cache", () => call("search_docs", { query: "cache architecture refresh", project: "stress-test" }));

// Deep search testing
console.log("\n[3.4] Deep search testing...");
await test("day3:search_db", () => call("search", { query: "database connection pool", project: "stress-test" }));
await test("day3:search_security", () => call("search", { query: "XSS SQL injection authentication", project: "stress-test" }));
await test("day3:search_patterns", () => call("search", { query: "circuit breaker saga", project: "stress-test" }));
await test("day3:search_deploy", () => call("search", { query: "container deployment graceful shutdown", project: "stress-test" }));

// Log with filters
console.log("\n[3.5] Log queries...");
await test("day3:log_all", () => call("log", { project: "stress-test", limit: 10 }));
await test("day3:log_scars", () => call("log", { project: "stress-test", learning_type: "scar", limit: 5 }));
await test("day3:log_patterns", () => call("log", { project: "stress-test", learning_type: "pattern", limit: 5 }));

// Graph traverse
console.log("\n[3.6] Graph traversal...");
await test("day3:graph_stats", () => call("graph_traverse", { lens: "stats" }));
await test("day3:graph_connected", () => call("graph_traverse", { lens: "connected_to", node: "stress-test" }));

// Analytics
console.log("\n[3.7] Analytics...");
await test("day3:analyze_summary", () => call("analyze", { project: "stress-test" }));

// Prepare context for sub-agents
console.log("\n[3.8] Prepare context...");
await test("day3:prepare_compact", () => call("prepare_context", { plan: "review authentication middleware", format: "compact", project: "stress-test" }));
await test("day3:prepare_gate", () => call("prepare_context", { plan: "deploy database migration", format: "gate", project: "stress-test" }));
await test("day3:prepare_full", () => call("prepare_context", { plan: "refactor caching layer", format: "full", project: "stress-test" }));

// Absorb observations
console.log("\n[3.9] Absorb observations...");
await test("day3:absorb", () => call("absorb_observations", {
  observations: [
    { source: "code-review-agent", text: "Found hardcoded API key in config.ts line 42", severity: "scar_candidate" },
    { source: "test-runner-agent", text: "Integration tests pass 47/47", severity: "info" },
    { source: "security-scanner", text: "No SQL injection vulnerabilities found", severity: "info" },
    { source: "perf-agent", text: "P95 latency increased from 200ms to 800ms after adding middleware", severity: "warning" },
  ],
}));

// Transcripts
console.log("\n[3.10] Transcripts...");
await test("day3:save_transcript", () => call("save_transcript", {
  session_id: sessionId || "00000000-0000-0000-0000-000000000000",
  transcript: "User: Can you deploy the migration?\nAgent: Let me check recall first.\nAgent: Found 3 relevant scars for deployment.\nUser: Go ahead.\nAgent: Migration applied. All tests pass.\nUser: Great, close the session.\nAgent: Session closed with reflection.",
  format: "markdown",
  project: "stress-test",
}));

await test("day3:get_transcript", () => call("get_transcript", {
  session_id: sessionId || "00000000-0000-0000-0000-000000000000",
}));

await test("day3:search_transcripts", () => call("search_transcripts", {
  query: "deployment migration verification",
  project: "stress-test",
  match_count: 5,
}));

// Close day 3
await test("day3:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "Doc indexing and search work well", what_broke: "Nothing",
    do_differently: "Index docs at project setup", scars_applied: [], institutional_memory_items: "Doc search is useful",
    collaborative_dynamic: "Research focused", rapport_notes: "Good", what_took_longer: "Nothing", wrong_assumption: "None" },
}));

// ═══════════════════════════════════════════════════════════════════════════
// DAY 4: Cache operations, health, archive, more threads
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n━━━ DAY 4: Cache, health, archive, threads ━━━");

await client.close();
client = await startClient();

await test("day4:session_start", () => call("session_start", { project: "stress-test" }));

// Cache management
console.log("\n[4.1] Cache management...");
await test("day4:cache_status", () => call("gitmem-cache-status", { project: "stress-test" }));
await test("day4:cache_health", () => call("gitmem-cache-health", { project: "stress-test" }));
await test("day4:cache_flush", () => call("gitmem-cache-flush", { project: "stress-test" }));
await test("day4:cache_status_after", () => call("gitmem-cache-status", { project: "stress-test" }));

// Health check
console.log("\n[4.2] Health check...");
await test("day4:health", () => call("health", {}));

// Archive a learning
console.log("\n[4.3] Archive learning...");
if (scarIds.length > 0) {
  await test("day4:archive_learning", () => call("archive_learning", {
    id: scarIds[0], reason: "Superseded by updated scar with better counter-arguments",
  }));
}

// Promote and dismiss suggestions
console.log("\n[4.4] Promote and dismiss suggestions...");
// promote_suggestion expects a suggestion_id from session_start's suggested_threads
// Use a synthetic ID — tool should handle gracefully (not found / no suggestions)
await test("day4:promote_suggestion", () => call("promote_suggestion", {
  suggestion_id: "ts-00000001", project: "stress-test",
}));
await test("day4:dismiss_suggestion", () => call("dismiss_suggestion", {
  suggestion_id: "ts-00000002",
}));

// Thread lifecycle: create, list, cleanup, resolve
console.log("\n[4.5] Thread lifecycle...");
const newThreadText = await test("day4:create_thread", () => call("create_thread", { text: "Upgrade Node.js from 18 to 22 LTS" }));
const newThreadId = extractId(newThreadText, /(t-[0-9a-f]{8})/);

// Dedup test — similar thread
await test("day4:thread_dedup", () => call("create_thread", { text: "Upgrade Node.js runtime to version 22" }));

await test("day4:list_threads", () => call("list_threads", { project: "stress-test" }));
await test("day4:cleanup_threads", () => call("cleanup_threads", { project: "stress-test" }));

// Resolve the new thread
if (newThreadId) {
  await test("day4:resolve_new_thread", () => call("resolve_thread", {
    thread_id: newThreadId, resolution_note: "Upgraded to Node 22, all tests pass",
  }));
}

// Resolve more threads to test lifecycle
if (threadIds.length >= 6) {
  await test("day4:resolve_thread_4", () => call("resolve_thread", {
    thread_id: threadIds[3], resolution_note: "GraphQL migration complete, REST deprecated",
  }));
  await test("day4:resolve_thread_5", () => call("resolve_thread", {
    thread_id: threadIds[4], resolution_note: "Prometheus + Grafana dashboards deployed",
  }));
}

// List to verify resolved count
await test("day4:list_threads_final", () => call("list_threads", { project: "stress-test" }));

// Feedback
console.log("\n[4.5] Contribute feedback...");
await test("day4:feedback", () => call("contribute_feedback", {
  type: "suggestion", tool: "recall",
  description: "Recall should show the scar's domain tags alongside the title for faster scanning during review.",
  severity: "low",
}));

// Close day 4
await test("day4:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "Cache flush works, thread lifecycle complete", what_broke: "Nothing",
    do_differently: "Test cache flush after bulk inserts", scars_applied: [], institutional_memory_items: "Cache management is solid",
    collaborative_dynamic: "Maintenance focused", rapport_notes: "Clean", what_took_longer: "Nothing", wrong_assumption: "None" },
}));

// ═══════════════════════════════════════════════════════════════════════════
// DAY 5: Return to open threads, verify persistence, final validation
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n━━━ DAY 5: Verify persistence, final checks ━━━");

await client.close();
client = await startClient();

console.log("\n[5.1] Session start (should load 4 days of context)...");
sessionText = await test("day5:session_start", () => call("session_start", { project: "stress-test" }));
const hasHistory = sessionText.includes("stress-test") || sessionText.includes("session");
console.log("  History loaded:", hasHistory ? "yes" : "no");

// Verify threads persisted across sessions
console.log("\n[5.2] Verify threads survived 5 sessions...");
const threadsText = await test("day5:list_threads", () => call("list_threads", { project: "stress-test" }));
const openCount = (threadsText.match(/open/gi) || []).length;
console.log(`  Open threads visible: ${openCount > 0 ? "yes" : "check output"}`);

// Verify learnings persisted
console.log("\n[5.3] Verify learnings persisted...");
const logText = await test("day5:log_verify", () => call("log", { project: "stress-test", limit: 60 }));
const loggedCount = (logText.match(/scar|pattern/gi) || []).length;
console.log(`  Learnings in log: ${loggedCount}`);

// Recall to verify embeddings survived
console.log("\n[5.4] Recall to verify embeddings...");
await test("day5:recall_final_1", () => call("recall", { plan: "implement password reset flow", project: "stress-test" }));
await test("day5:recall_final_2", () => call("recall", { plan: "set up kubernetes cluster", project: "stress-test" }));
await test("day5:recall_final_3", () => call("recall", { plan: "optimize database query performance", project: "stress-test" }));

// Search to verify index survived
console.log("\n[5.5] Search docs to verify index...");
await test("day5:search_docs_verify", () => call("search_docs", { query: "knowledge graph triples", project: "stress-test" }));

// Final analytics
console.log("\n[5.6] Final analytics...");
await test("day5:analyze_final", () => call("analyze", { project: "stress-test" }));

// Help
console.log("\n[5.7] Help...");
await test("day5:help", () => call("gitmem-help", {}));

// Close final session
await test("day5:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "All data persisted across 5 sessions", what_broke: "Nothing",
    do_differently: "This test should be automated", scars_applied: [], institutional_memory_items: "Full lifecycle verified",
    collaborative_dynamic: "Validation session", rapport_notes: "Comprehensive", what_took_longer: "Nothing", wrong_assumption: "None" },
}));

// ═══════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n╔═══════════════════════════════════════════════════════════════╗");
console.log("║  FINAL RESULTS                                               ║");
console.log("╠═══════════════════════════════════════════════════════════════╣");

const failures = Object.entries(results).filter(([,v]) => v !== "PASS");
if (failures.length > 0) {
  console.log("║  Non-PASS results:                                           ║");
  for (const [k, v] of failures) {
    console.log(`  ${v.startsWith("FAIL") ? "FAIL" : "WARN"}  ${k}`);
    if (v.startsWith("FAIL")) console.log(`       ${v}`);
  }
}

console.log("╠═══════════════════════════════════════════════════════════════╣");
console.log(`║  PASS: ${String(passed).padStart(3)}  |  WARN: ${String(warned).padStart(3)}  |  FAIL: ${String(failed).padStart(3)}  |  TOTAL: ${String(passed + warned + failed).padStart(3)}         ║`);
console.log("╚═══════════════════════════════════════════════════════════════╝");

await client.close();
process.exit(failed > 0 ? 1 : 0);
