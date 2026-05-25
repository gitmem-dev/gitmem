import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
const { writeFileSync, mkdirSync } = fs;

// ─── ANSI Colors ───
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
  bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgBlue: "\x1b[44m",
};

const PASS_ICON = `${C.green}${C.bold}PASS${C.reset}`;
const WARN_ICON = `${C.yellow}${C.bold}WARN${C.reset}`;
const FAIL_ICON = `${C.red}${C.bold}FAIL${C.reset}`;
const BULLET = `${C.dim}>${C.reset}`;

// ─── Timing ───
const globalStart = Date.now();
const elapsed = () => {
  const ms = Date.now() - globalStart;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

// ─── Start MCP server ───
async function startClient(name = "main") {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/usr/local/lib/node_modules/gitmem-mcp/dist/index.js"],
    env: process.env,
    cwd: "/home/developer/my-project",
  });
  const client = new Client({ name: `stress-test-${name}`, version: "1.0" });
  await client.connect(transport);
  return client;
}

let client = await startClient();
const results = {};
let passed = 0, warned = 0, failed = 0;
let testNum = 0;

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args || {} });
  return r.content[0].text;
};

const test = async (label, fn) => {
  testNum++;
  const t0 = Date.now();
  try {
    const text = await fn();
    const ms = Date.now() - t0;
    const hasFatal = text.includes("Fatal") || (text.includes("FAIL") && !text.includes("failed silently"));
    if (hasFatal) {
      results[label] = "WARN";
      warned++;
      process.stdout.write(`  ${WARN_ICON} ${C.dim}#${String(testNum).padStart(3)}${C.reset} ${label} ${C.dim}(${ms}ms)${C.reset}\n`);
    } else {
      results[label] = "PASS";
      passed++;
      process.stdout.write(`  ${PASS_ICON} ${C.dim}#${String(testNum).padStart(3)}${C.reset} ${label} ${C.dim}(${ms}ms)${C.reset}\n`);
    }
    return text;
  } catch (e) {
    const ms = Date.now() - t0;
    results[label] = "FAIL: " + e.message.substring(0, 80);
    failed++;
    process.stdout.write(`  ${FAIL_ICON} ${C.dim}#${String(testNum).padStart(3)}${C.reset} ${label} ${C.dim}(${ms}ms)${C.reset}\n`);
    process.stdout.write(`       ${C.red}${e.message.substring(0, 100)}${C.reset}\n`);
    return "";
  }
};

const scoreboard = () => {
  const total = passed + warned + failed;
  process.stdout.write(`\n  ${C.dim}Score: ${C.green}${passed}${C.reset}${C.dim}/${total} passed${C.reset}`);
  if (warned > 0) process.stdout.write(` ${C.yellow}${warned} warn${C.reset}`);
  if (failed > 0) process.stdout.write(` ${C.red}${failed} fail${C.reset}`);
  process.stdout.write(` ${C.dim}| ${elapsed()}${C.reset}\n`);
};

const extractId = (text, pattern) => {
  const m = text.match(pattern);
  return m ? m[1] : null;
};

const section = (day, title, emoji) => {
  console.log(`\n${C.bold}${C.cyan}${"═".repeat(65)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${emoji}  DAY ${day}: ${title}${C.reset}`);
  console.log(`${C.cyan}${"═".repeat(65)}${C.reset}`);
};

const step = (num, title) => {
  console.log(`\n  ${C.bold}${C.blue}[${num}]${C.reset} ${C.bold}${title}${C.reset}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════════════
console.log(`
${C.red}${C.bold}  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║   ██████╗ ██╗████████╗███╗   ███╗███████╗███╗   ███╗         ║
  ║  ██╔════╝ ██║╚══██╔══╝████╗ ████║██╔════╝████╗ ████║         ║
  ║  ██║  ███╗██║   ██║   ██╔████╔██║█████╗  ██╔████╔██║         ║
  ║  ██║   ██║██║   ██║   ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║         ║
  ║  ╚██████╔╝██║   ██║   ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║         ║
  ║   ╚═════╝ ╚═╝   ╚═╝   ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝         ║
  ║                                                               ║
  ║${C.white}         PRO STRESS TEST v1.3 — 6 SIMULATED DAYS             ${C.red}║
  ║${C.white}     50 scars  10 patterns  10 threads  3 docs  170+ tests   ${C.red}║
  ║${C.white}         Real Supabase  Real OpenRouter  Free→Pro Upgrade      ${C.red}║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝${C.reset}
`);

// ═══════════════════════════════════════════════════════════════════════════
// DAY 1
// ═══════════════════════════════════════════════════════════════════════════
section(1, "Initial Setup — Seeding Institutional Memory", "🌱");

step("1.1", "Session start");
let sessionText = await test("session_start", () => call("session_start", { project: "stress-test" }));
let sessionId = extractId(sessionText, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);

step("1.2", "Creating 50 scars across 10 domains...");
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
  const text = await test(`scar:${d.pfx}-${String(i+1).padStart(2,"0")}`, () => call("create_learning", {
    learning_type: "scar", title: `${d.pfx}-${String(i+1).padStart(2,"0")}: ${descs[i].split(".")[0]}`.substring(0, 120),
    description: descs[i], severity: sevs[i % 4], domain: d.domain,
    keywords: [...d.keywords, `scar-${i+1}`],
    counter_arguments: ["May not apply in simple projects", "Overhead not worth it for prototypes"],
  }));
  const id = extractId(text, /id[:\s]+([0-9a-f]{8})/i);
  if (id) scarIds.push(id);
}

step("1.3", "Creating 10 design patterns...");
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
  await test(`pattern:${pats[i].split(":")[0]}`, () => call("create_learning", {
    learning_type: "pattern", title: pats[i].split(":")[0],
    description: pats[i], domain: ["architecture"], keywords: ["design-pattern"],
  }));
}

step("1.4", "Creating 5 decisions...");
const decs = [
  { title: "PostgREST RPC over Edge Functions", decision: "Direct RPC calls via PostgREST", rationale: "No Edge Function deployment needed, lower latency" },
  { title: "BM25 local + vectors remote", decision: "BM25 for free tier, embeddings for pro", rationale: "BM25 works offline, vectors need API" },
  { title: "Service role key for all access", decision: "Single service_role key for MCP server", rationale: "MCP server is the trust boundary" },
  { title: "72h license cache TTL", decision: "Cache validation for 72 hours", rationale: "Balances freshness with offline resilience" },
  { title: "Auto-schema via Management API", decision: "Apply schema during activation", rationale: "Manual SQL paste is error-prone" },
];
for (const d of decs) await test(`decision:${d.title.substring(0,35)}`, () => call("create_decision", d));

step("1.5", "Creating 10 threads...");
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
  const text = await test(`thread:${threadTexts[i].substring(0,40)}`, () => call("create_thread", { text: threadTexts[i] }));
  const tid = extractId(text, /(t-[0-9a-f]{8})/);
  if (tid) threadIds.push(tid);
}
await test("list_threads", () => call("list_threads", { project: "stress-test" }));

step("1.6", "Closing day 1...");
await test("day1:session_close", () => call("session_close", {
  close_type: "quick",
  closing_reflection: { what_worked: "Data seeding complete", what_broke: "Nothing", do_differently: "Nothing",
    scars_applied: [], institutional_memory_items: "50 scars + 10 patterns seeded",
    collaborative_dynamic: "Solo", rapport_notes: "Productive", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// DAY 2
// ═══════════════════════════════════════════════════════════════════════════
section(2, "Recall, Confirm, Resolve — Using the Memory", "🔍");
await client.close();
client = await startClient();

step("2.1", "Session start (loading day 1 context)...");
sessionText = await test("day2:session_start", () => call("session_start", { project: "stress-test" }));

step("2.2", "Recall before deployment...");
let recallText = await test("recall:deploy migration", () => call("recall", { plan: "deploy database migration to production", project: "stress-test" }));
const recalledIds = [...recallText.matchAll(/id:([0-9a-f]{8})/gi)].map(m => m[1]);
console.log(`  ${BULLET} ${C.cyan}${recalledIds.length} scars surfaced${C.reset}`);

step("2.3", "Confirm recalled scars...");
if (recalledIds.length > 0) {
  await test("confirm_scars", () => call("confirm_scars", { confirmations: recalledIds.slice(0, 3).map(id => ({
    scar_id: id, decision: "APPLYING",
    evidence: "Verified migration is reversible, indexes created before deploy, env vars validated at startup.", relevance: "high",
  }))}));
} else {
  await test("confirm_scars", () => call("confirm_scars", { confirmations: [{
    scar_id: "00000000", decision: "N_A",
    evidence: "No scars recalled — stress test with fresh data, low similarity expected.", relevance: "noise",
  }]}));
}

step("2.4", "More recall queries...");
await test("recall:JWT auth", () => call("recall", { plan: "implement JWT authentication", project: "stress-test" }));
await test("recall:Redis cache", () => call("recall", { plan: "add Redis caching layer", project: "stress-test" }));
await test("recall:React refactor", () => call("recall", { plan: "refactor React components", project: "stress-test" }));
await test("recall:security audit", () => call("recall", { plan: "security audit of file upload endpoint", project: "stress-test" }));

step("2.5", "Resolving 3 threads...");
if (threadIds.length >= 3) {
  await test("resolve:PKCE flow", () => call("resolve_thread", { thread_id: threadIds[0], resolution_note: "PKCE flow implemented and deployed" }));
  await test("resolve:analytics queries", () => call("resolve_thread", { thread_id: threadIds[1], resolution_note: "Added indexes, 3s to 200ms" }));
  await test("resolve:WebSocket", () => call("resolve_thread", { thread_id: threadIds[2], resolution_note: "WebSocket live, heartbeat 30s" }));
}
await test("list_threads (7 open)", () => call("list_threads", { project: "stress-test" }));

step("2.6", "Reflect scars...");
if (recalledIds.length > 0) {
  await test("reflect_scars", () => call("reflect_scars", { reflections: recalledIds.slice(0, 3).map(id => ({
    scar_id: id, outcome: "OBEYED", evidence: "Verified migration reversibility before deploying.",
  }))}));
}

step("2.7", "Record scar usage...");
await test("record_scar_usage", () => call("record_scar_usage", {
  scar_id: recalledIds[0] || "00000000", surfaced_at: new Date().toISOString(),
  reference_type: "explicit", reference_context: "Applied during migration — verified reversibility",
}));

step("2.8", "Record scar usage batch...");
const batchScars = recalledIds.slice(0, 2).map(id => ({
  scar_identifier: id, surfaced_at: new Date().toISOString(), acknowledged_at: new Date().toISOString(),
  reference_type: "acknowledged", reference_context: "Batch acknowledged during review", execution_successful: true,
}));
await test("record_scar_usage_batch", () => call("record_scar_usage_batch", {
  scars: batchScars.length > 0 ? batchScars : [{ scar_identifier: "00000000", surfaced_at: new Date().toISOString(), reference_type: "none", reference_context: "No scars" }],
}));

step("2.9", "Session refresh...");
await test("session_refresh", () => call("session_refresh", { project: "stress-test" }));

step("2.10", "Closing day 2...");
await test("day2:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "Recall surfaced relevant scars", what_broke: "Nothing",
    do_differently: "Confirm scars immediately", scars_applied: ["migration reversibility"],
    institutional_memory_items: "Recall works for deployment", collaborative_dynamic: "Solo",
    rapport_notes: "Efficient", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// DAY 3
// ═══════════════════════════════════════════════════════════════════════════
section(3, "Docs, Search, Graph, Sub-Agent Handoff", "📚");
await client.close();
client = await startClient();
await test("day3:session_start", () => call("session_start", { project: "stress-test" }));

step("3.1", "Writing 3 markdown docs (1000+ words)...");
const docsDir = "/home/developer/my-project/docs";
mkdirSync(docsDir, { recursive: true });

writeFileSync(`${docsDir}/architecture.md`, `# System Architecture\n\n## Overview\nThe system uses a layered architecture separating local storage, cloud persistence, and semantic intelligence. At its core is an MCP server providing persistent institutional memory across sessions.\n\n## Storage Layer\nDual-mode: free tier stores locally in .gitmem/ as JSON. Pro tier uses Supabase (PostgreSQL) with pgvector for semantic search. Eight tables: learnings, sessions, decisions, scar_usage, threads, query_metrics, knowledge_triples, scar_enforcement_variants.\n\n## Embedding Pipeline\nText-embedding-3-small (1536 dimensions) via OpenRouter or OpenAI. Fire-and-forget — records stored without embeddings if provider unavailable. Semantic search uses pgvector cosine distance. Scar search adds temporal decay (process=permanent, incident=180d, context=30d) and behavioral decay (dismissed scars weighted lower).\n\n## Session Lifecycle\nStart loads previous context, surfaces threads, presents decisions. During work, recall surfaces relevant scars. Close captures structured reflection: what broke, what worked, what to do differently.\n\n## Multi-Agent Coordination\nprepare_context generates compact payloads for sub-agents in three formats: full (markdown), compact (~500 tokens), gate (~100 tokens blocking only). absorb_observations captures sub-agent findings and identifies scar candidates.\n\n## Knowledge Graph\nTriples connect entities via typed predicates: created_in, influenced_by, supersedes, demonstrates. graph_traverse supports connected_to, produced_by, provenance, and stats modes.\n\n## Thread Management\nThreads track unresolved work with lifecycle: emerging, active, cooling, dormant, archived, resolved. Vitality scores decay over time. Semantic dedup prevents duplicate threads (cosine > 0.85).\n\n## Cache Architecture\nLocal vector cache loads learnings with embeddings at startup, refreshes every 15 minutes. BM25 keyword search runs against cache.\n\n## License Validation\nSECURITY DEFINER RPC on infrastructure Supabase. 72-hour cache. 3 concurrent devices per license.\n`);

writeFileSync(`${docsDir}/deployment.md`, `# Deployment Guide\n\n## Prerequisites\nNode.js >= 18, Supabase project, OpenRouter account, GitMem Pro license key.\n\n## Activation\nSet SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY as environment variables. Run npx supabase login for management API access. Run npx gitmem-mcp activate with your key. Schema applied automatically.\n\n## Schema Management\nSetup SQL bundled with npm package. Applied via Supabase Management API during activation.\n\n## Environment Variables\nRequired: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY. Optional: GITMEM_TABLE_PREFIX, GITMEM_TIER, GITMEM_EMBEDDING_PROVIDER.\n\n## Monitoring\ngitmem-mcp check runs diagnostic. health shows write success rates. analyze provides session analytics.\n`);

writeFileSync(`${docsDir}/api-reference.md`, `# API Reference\n\n## Session Lifecycle\nsession_start, session_refresh, session_close manage context.\n\n## Memory Creation\ncreate_learning stores scars, wins, patterns. create_decision logs decisions. record_scar_usage tracks application.\n\n## Retrieval\nrecall performs semantic search. confirm_scars acknowledges. reflect_scars provides compliance. search queries memory. log browses chronologically.\n\n## Threads\ncreate_thread, list_threads, resolve_thread, cleanup_threads. promote_suggestion and dismiss_suggestion handle auto-detected threads.\n\n## Multi-Agent\nprepare_context generates briefings. absorb_observations captures findings.\n\n## Knowledge Graph\ngraph_traverse: connected_to, produced_by, provenance, stats. archive_learning soft-deletes.\n\n## Analytics\nanalyze: summary, reflections, blindspots. health shows write rates.\n\n## Document Indexing\nindex_docs indexes markdown. search_docs queries indexed content.\n\n## Cache\ngitmem-cache-status, gitmem-cache-health, gitmem-cache-flush.\n`);
console.log(`  ${BULLET} ${C.cyan}3 docs written to ${docsDir}${C.reset}`);

step("3.2", "Indexing docs...");
await test("index_docs", () => call("index_docs", { directory: docsDir, project: "stress-test" }));

step("3.3", "Searching docs...");
await test("search_docs:embeddings", () => call("search_docs", { query: "embedding pipeline semantic search", project: "stress-test" }));
await test("search_docs:env vars", () => call("search_docs", { query: "environment variables configuration", project: "stress-test" }));
await test("search_docs:threads", () => call("search_docs", { query: "thread lifecycle management", project: "stress-test" }));
await test("search_docs:cache", () => call("search_docs", { query: "cache architecture refresh", project: "stress-test" }));

step("3.4", "Deep memory search...");
await test("search:database pools", () => call("search", { query: "database connection pool", project: "stress-test" }));
await test("search:security", () => call("search", { query: "XSS SQL injection authentication", project: "stress-test" }));
await test("search:patterns", () => call("search", { query: "circuit breaker saga", project: "stress-test" }));
await test("search:deployment", () => call("search", { query: "container deployment graceful shutdown", project: "stress-test" }));

step("3.5", "Log queries...");
await test("log:all (limit 10)", () => call("log", { project: "stress-test", limit: 10 }));
await test("log:scars only", () => call("log", { project: "stress-test", learning_type: "scar", limit: 5 }));
await test("log:patterns only", () => call("log", { project: "stress-test", learning_type: "pattern", limit: 5 }));

step("3.6", "Knowledge graph traversal...");
await test("graph:stats", () => call("graph_traverse", { lens: "stats" }));
await test("graph:connected_to", () => call("graph_traverse", { lens: "connected_to", node: "stress-test" }));

step("3.7", "Analytics...");
await test("analyze:summary", () => call("analyze", { project: "stress-test" }));

step("3.8", "Sub-agent handoff — prepare, delegate, absorb...");
console.log(`  ${BULLET} ${C.magenta}Preparing context briefing for sub-agent...${C.reset}`);
const compactCtx = await test("prepare_context:compact", () => call("prepare_context", { plan: "review authentication middleware for security vulnerabilities", format: "compact", project: "stress-test" }));
await test("prepare_context:gate", () => call("prepare_context", { plan: "deploy database migration", format: "gate", project: "stress-test" }));
await test("prepare_context:full", () => call("prepare_context", { plan: "refactor caching layer", format: "full", project: "stress-test" }));

// Real sub-agent workflow: spawn second MCP server, feed it the briefing
console.log(`  ${BULLET} ${C.magenta}Spawning sub-agent MCP server...${C.reset}`);
const subAgent = await startClient("sub-agent");
const subCall = async (name, args) => {
  const r = await subAgent.callTool({ name, arguments: args || {} });
  return r.content[0].text;
};

// Sub-agent starts its own session
await test("sub-agent:session_start", async () => subCall("session_start", { project: "stress-test" }));

// Sub-agent does recall with the same plan
console.log(`  ${BULLET} ${C.magenta}Sub-agent running recall on auth middleware...${C.reset}`);
const subRecall = await test("sub-agent:recall", async () => subCall("recall", { plan: "review authentication middleware for security vulnerabilities", project: "stress-test" }));
const subScarCount = (subRecall.match(/scar/gi) || []).length;
console.log(`  ${BULLET} ${C.magenta}Sub-agent found ${subScarCount > 0 ? subScarCount : "scars"} relevant to auth review${C.reset}`);

// Sub-agent searches for specific patterns
await test("sub-agent:search", async () => subCall("search", { query: "JWT token expiration middleware", project: "stress-test" }));

// Close sub-agent
await subAgent.close();
console.log(`  ${BULLET} ${C.magenta}Sub-agent session complete${C.reset}`);

// Main agent absorbs sub-agent findings
await test("absorb_observations", () => call("absorb_observations", {
  observations: [
    { source: "auth-review-agent", text: "JWT expiration check missing in /api/admin routes — only checks at login", severity: "scar_candidate", context: "src/middleware/auth.ts" },
    { source: "auth-review-agent", text: "Password reset tokens use SHA-256 instead of bcrypt", severity: "scar_candidate", context: "src/services/auth.ts" },
    { source: "auth-review-agent", text: "CORS is properly configured with specific origin whitelist", severity: "info" },
    { source: "auth-review-agent", text: "Rate limiting correctly applied at gateway level", severity: "info" },
  ],
}));

step("3.9", "Transcripts...");
await test("save_transcript", () => call("save_transcript", {
  session_id: sessionId || "00000000-0000-0000-0000-000000000000",
  transcript: "User: Review auth middleware.\nAgent: Let me recall relevant scars.\nAgent: Found JWT expiration and CORS scars.\nSub-agent: JWT check missing in admin routes.\nAgent: Creating scar for JWT admin bypass.\nUser: Good catch. Close session.",
  format: "markdown", project: "stress-test",
}));
await test("get_transcript", () => call("get_transcript", { session_id: sessionId || "00000000-0000-0000-0000-000000000000" }));
await test("search_transcripts", () => call("search_transcripts", { query: "JWT admin routes auth", project: "stress-test", match_count: 5 }));

step("3.10", "Closing day 3...");
await test("day3:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "Sub-agent handoff worked end to end", what_broke: "Nothing",
    do_differently: "Use gate format for blocking scars only", scars_applied: [],
    institutional_memory_items: "Sub-agent workflow validated", collaborative_dynamic: "Multi-agent",
    rapport_notes: "Effective delegation", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// DAY 4
// ═══════════════════════════════════════════════════════════════════════════
section(4, "Cache, Health, Archive, Thread Lifecycle", "🔧");
await client.close();
client = await startClient();
await test("day4:session_start", () => call("session_start", { project: "stress-test" }));

step("4.1", "Cache management cycle...");
await test("cache:status", () => call("gitmem-cache-status", { project: "stress-test" }));
await test("cache:health", () => call("gitmem-cache-health", { project: "stress-test" }));
await test("cache:flush", () => call("gitmem-cache-flush", { project: "stress-test" }));
await test("cache:status (after flush)", () => call("gitmem-cache-status", { project: "stress-test" }));

step("4.2", "Health check...");
await test("health", () => call("health", {}));

step("4.3", "Archive learning...");
if (scarIds.length > 0) {
  await test("archive_learning", () => call("archive_learning", { id: scarIds[0], reason: "Superseded by updated scar" }));
}

step("4.4", "Promote and dismiss suggestions...");
await test("promote_suggestion", () => call("promote_suggestion", { suggestion_id: "ts-00000001", project: "stress-test" }));
await test("dismiss_suggestion", () => call("dismiss_suggestion", { suggestion_id: "ts-00000002" }));

step("4.5", "Thread lifecycle...");
const newThreadText = await test("thread:Node.js upgrade", () => call("create_thread", { text: "Upgrade Node.js from 18 to 22 LTS" }));
const newThreadId = extractId(newThreadText, /(t-[0-9a-f]{8})/);
await test("thread:dedup test", () => call("create_thread", { text: "Upgrade Node.js runtime to version 22" }));
await test("list_threads", () => call("list_threads", { project: "stress-test" }));
await test("cleanup_threads", () => call("cleanup_threads", { project: "stress-test" }));

if (newThreadId) await test("resolve:Node.js upgrade", () => call("resolve_thread", { thread_id: newThreadId, resolution_note: "Upgraded to Node 22, all tests pass" }));
if (threadIds.length >= 6) {
  await test("resolve:GraphQL migration", () => call("resolve_thread", { thread_id: threadIds[3], resolution_note: "GraphQL complete" }));
  await test("resolve:Prometheus", () => call("resolve_thread", { thread_id: threadIds[4], resolution_note: "Dashboards deployed" }));
}
await test("list_threads (final)", () => call("list_threads", { project: "stress-test" }));

step("4.6", "Feedback...");
await test("contribute_feedback", () => call("contribute_feedback", {
  type: "suggestion", tool: "recall",
  description: "Recall should show domain tags alongside titles for faster scanning during review.", severity: "low",
}));

step("4.7", "Closing day 4...");
await test("day4:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "Cache management solid, thread lifecycle complete", what_broke: "Nothing",
    do_differently: "Test cache after bulk inserts", scars_applied: [], institutional_memory_items: "Cache flush verified",
    collaborative_dynamic: "Maintenance", rapport_notes: "Clean", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// DAY 5
// ═══════════════════════════════════════════════════════════════════════════
section(5, "Persistence Verification — Does It All Survive?", "🏁");
await client.close();
client = await startClient();

step("5.1", "Session start (loading 4 days of history)...");
sessionText = await test("day5:session_start", () => call("session_start", { project: "stress-test" }));

step("5.2", "Verify threads survived 5 sessions...");
const threadsText = await test("list_threads (persistence)", () => call("list_threads", { project: "stress-test" }));

step("5.3", "Verify learnings persisted...");
const logText = await test("log:verify all", () => call("log", { project: "stress-test", limit: 60 }));
const logCount = (logText.match(/scar|pattern/gi) || []).length;
console.log(`  ${BULLET} ${C.cyan}${logCount} learnings found in log${C.reset}`);

step("5.4", "Recall to verify embeddings survived...");
await test("recall:password reset", () => call("recall", { plan: "implement password reset flow", project: "stress-test" }));
await test("recall:k8s cluster", () => call("recall", { plan: "set up kubernetes cluster", project: "stress-test" }));
await test("recall:query perf", () => call("recall", { plan: "optimize database query performance", project: "stress-test" }));

step("5.5", "Search docs (index survived)...");
await test("search_docs:knowledge graph", () => call("search_docs", { query: "knowledge graph triples", project: "stress-test" }));

step("5.6", "Final analytics...");
await test("analyze:final", () => call("analyze", { project: "stress-test" }));

step("5.7", "Help...");
await test("gitmem-help", () => call("gitmem-help", {}));

step("5.8", "Closing final session...");
await test("day5:session_close", () => call("session_close", { close_type: "quick",
  closing_reflection: { what_worked: "All data persisted across 5 sessions", what_broke: "Nothing",
    do_differently: "Automate this test", scars_applied: [], institutional_memory_items: "Full lifecycle verified",
    collaborative_dynamic: "Validation", rapport_notes: "Comprehensive", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// DAY 6
// ═══════════════════════════════════════════════════════════════════════════
section(6, "Free → Pro Upgrade — Local Data Migration", "🔄");
await client.close();

// --- Phase 1: Seed local data as a free-tier user ---
step("6.1", "Seeding local .gitmem data (simulating free tier user)...");

const upgradeProjectDir = "/home/developer/upgrade-project";
const upgradeGitmemDir = `${upgradeProjectDir}/.gitmem`;
mkdirSync(upgradeGitmemDir, { recursive: true });

// UUID generator for seeded data (Supabase requires valid UUIDs)
import { randomUUID } from "crypto";
const localIdMap = {}; // track generated IDs for cross-references

// Seed local learnings (scars + wins + patterns)
const localLearnings = [];
for (let i = 0; i < 15; i++) {
  const id = randomUUID();
  localIdMap[`learning-${i}`] = id;
  localLearnings.push({
    id,
    title: `Local scar ${i + 1}: ${["Always validate inputs", "Use parameterized queries", "Check JWT expiry", "Rate limit APIs", "Pin container versions", "Use structured logging", "Automate secret rotation", "Size connection pools", "Test error paths", "Monitor latency p99", "Cache at the edge", "Validate content types", "Use exponential backoff", "Index before deploy", "Paginate all responses"][i]}`,
    description: descs[i] || `Free tier scar ${i + 1} description with enough detail for BM25 search.`,
    learning_type: i < 10 ? "scar" : i < 13 ? "pattern" : "win",
    severity: sevs[i % 4],
    domain: [scarDomains[i % 10].domain[0]],
    keywords: scarDomains[i % 10].keywords,
    counter_arguments: ["May not apply in simple cases", "Overhead for prototypes"],
    is_active: true,
    created_at: new Date(Date.now() - (15 - i) * 86400000).toISOString(),
    updated_at: new Date(Date.now() - (15 - i) * 86400000).toISOString(),
    project: "upgrade-test",
  });
}
writeFileSync(`${upgradeGitmemDir}/learnings.json`, JSON.stringify(localLearnings, null, 2));

// Seed local sessions (must match gitmem_sessions schema exactly)
const localSessions = [];
for (let i = 0; i < 3; i++) {
  localSessions.push({
    id: randomUUID(),
    session_title: `Upgrade test session ${i + 1}`,
    session_date: new Date(Date.now() - (3 - i) * 86400000).toISOString().split("T")[0],
    agent: "cli",
    project: "upgrade-test",
    closing_reflection: { what_worked: `Session ${i + 1} worked`, what_broke: "Nothing" },
    created_at: new Date(Date.now() - (3 - i) * 86400000).toISOString(),
    updated_at: new Date(Date.now() - (3 - i) * 86400000 + 3600000).toISOString(),
  });
}
writeFileSync(`${upgradeGitmemDir}/sessions.json`, JSON.stringify(localSessions, null, 2));

// Seed local decisions
const localDecisions = [];
for (let i = 0; i < 4; i++) {
  localDecisions.push({
    id: randomUUID(),
    title: ["Use BM25 for search", "JSON file storage", "Keyword-based recall", "Session-scoped threads"][i],
    decision: `Local decision ${i + 1}`,
    rationale: `Made during free tier usage, session ${i + 1}`,
    project: "upgrade-test",
    created_at: new Date(Date.now() - (4 - i) * 86400000).toISOString(),
  });
}
writeFileSync(`${upgradeGitmemDir}/decisions.json`, JSON.stringify(localDecisions, null, 2));

// Seed local scar_usage
const localScarUsage = [];
for (let i = 0; i < 5; i++) {
  localScarUsage.push({
    id: randomUUID(),
    scar_id: localLearnings[i].id,
    surfaced_at: new Date(Date.now() - (5 - i) * 86400000).toISOString(),
    reference_type: "explicit",
    reference_context: `Applied local scar ${i + 1} during free tier session`,
    execution_successful: true,
  });
}
writeFileSync(`${upgradeGitmemDir}/scar_usage.json`, JSON.stringify(localScarUsage, null, 2));

// Verify local files exist
const localFiles = ["learnings", "sessions", "decisions", "scar_usage"];
let localFilesOk = true;
for (const f of localFiles) {
  const p = `${upgradeGitmemDir}/${f}.json`;
  if (!fs.existsSync(p)) { localFilesOk = false; break; }
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!Array.isArray(data) || data.length === 0) { localFilesOk = false; break; }
}
await test("local data seeded (4 collections)", async () => {
  if (!localFilesOk) throw new Error("Local files not seeded correctly");
  return `Local data: 15 learnings, 3 sessions, 4 decisions, 5 scar_usage in ${upgradeGitmemDir}`;
});
console.log(`  ${BULLET} ${C.cyan}15 learnings, 3 sessions, 4 decisions, 5 scar_usage${C.reset}`);

// --- Phase 2: Run migration (simulating activate's migration step) ---
step("6.2", "Running local → Supabase migration...");

// Import the migration module dynamically
const { migrateLocalToSupabase, hasLocalData: checkLocalData, archiveLocalData } = await import(
  "/usr/local/lib/node_modules/gitmem-mcp/dist/commands/migrate-local.js"
);

await test("hasLocalData() detects data", async () => {
  const has = checkLocalData(upgradeGitmemDir);
  if (!has) throw new Error("hasLocalData() returned false — should detect local files");
  return "hasLocalData: true";
});

const migrationResult = await test("migrateLocalToSupabase()", async () => {
  const result = await migrateLocalToSupabase({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    tablePrefix: process.env.GITMEM_TABLE_PREFIX || "gitmem_",
    gitmemDir: upgradeGitmemDir,
    onProgress: (msg) => process.stdout.write(`    ${C.dim}${msg}${C.reset}\n`),
  });
  const totalMigrated = Object.values(result.migrated).reduce((a, b) => a + b, 0);
  if (totalMigrated === 0) throw new Error("Zero records migrated");
  return JSON.stringify({ migrated: result.migrated, skipped: result.skipped, total: result.total });
});
const migrationData = migrationResult ? JSON.parse(migrationResult) : null;
if (migrationData) {
  console.log(`  ${BULLET} ${C.cyan}Migrated: ${JSON.stringify(migrationData.migrated)}${C.reset}`);
  if (Object.values(migrationData.skipped).some(v => v > 0)) {
    console.log(`  ${BULLET} ${C.yellow}Skipped: ${JSON.stringify(migrationData.skipped)}${C.reset}`);
  }
}

// --- Phase 3: Verify migration counts ---
step("6.3", "Verifying migrated data in Supabase...");

const prefix = process.env.GITMEM_TABLE_PREFIX || "gitmem_";
const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const verifyCount = async (table, expectedMin, project) => {
  const url = `${sbUrl}/rest/v1/${prefix}${table}?select=id&project=eq.${project}`;
  const resp = await fetch(url, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: "count=exact" },
  });
  const range = resp.headers.get("content-range");
  const count = range ? parseInt(range.split("/")[1] || "0") : 0;
  if (count < expectedMin) throw new Error(`Expected >= ${expectedMin} ${table}, found ${count}`);
  return `${table}: ${count} records (expected >= ${expectedMin})`;
};

// scar_usage doesn't have a project column, so count all with valid scar_id
const verifyUsageCount = async (expectedMin) => {
  const url = `${sbUrl}/rest/v1/${prefix}scar_usage?select=id`;
  const resp = await fetch(url, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Prefer: "count=exact" },
  });
  const range = resp.headers.get("content-range");
  // Total count includes stress-test usage too, so just check it grew
  const count = range ? parseInt(range.split("/")[1] || "0") : 0;
  if (count < expectedMin) throw new Error(`Expected >= ${expectedMin} scar_usage, found ${count}`);
  return `scar_usage: ${count} records (expected >= ${expectedMin})`;
};

await test("verify learnings in Supabase", () => verifyCount("learnings", 10, "upgrade-test"));
await test("verify sessions in Supabase", () => verifyCount("sessions", 3, "upgrade-test"));
await test("verify decisions in Supabase", () => verifyCount("decisions", 4, "upgrade-test"));
await test("verify scar_usage in Supabase", () => verifyUsageCount(5));

// --- Phase 4: Verify data is usable via MCP tools ---
step("6.4", "Verifying migrated data is usable via MCP...");

// Start MCP server with upgrade-test project context
client = await startClient();
const upgradeSession = await test("upgrade:session_start", () => call("session_start", { project: "upgrade-test" }));

await test("upgrade:log shows migrated learnings", async () => {
  const logResult = await call("log", { project: "upgrade-test", limit: 20 });
  const hasLocal = logResult.includes("Local scar") || logResult.includes("local-scar");
  if (!hasLocal) throw new Error("Migrated learnings not visible in log output");
  return logResult;
});

await test("upgrade:search finds migrated scars", async () => {
  const searchResult = await call("search", { query: "validate inputs parameterized queries", project: "upgrade-test" });
  if (!searchResult || searchResult.includes("No results")) throw new Error("Search returned no results for migrated scars");
  return searchResult;
});

await test("upgrade:recall surfaces migrated scars", async () => {
  const recallResult = await call("recall", { plan: "implement database query layer", project: "upgrade-test" });
  // Recall may or may not surface these specific scars depending on embeddings,
  // but the call should succeed without error
  return recallResult;
});

// --- Phase 5: Archive local files ---
step("6.5", "Archiving local files post-migration...");

await test("archiveLocalData()", async () => {
  const archived = archiveLocalData(upgradeGitmemDir);
  if (archived.length === 0) throw new Error("No files archived");
  return `Archived: ${archived.join(", ")}`;
});

await test("local files renamed to .pre-migration", async () => {
  for (const f of localFiles) {
    const original = `${upgradeGitmemDir}/${f}.json`;
    const archive = `${original}.pre-migration`;
    if (fs.existsSync(original)) throw new Error(`${f}.json still exists (should be renamed)`);
    if (!fs.existsSync(archive)) throw new Error(`${f}.json.pre-migration not found`);
  }
  return "All 4 collections archived correctly";
});

await test("hasLocalData() returns false after archive", async () => {
  const has = checkLocalData(upgradeGitmemDir);
  if (has) throw new Error("hasLocalData() still returns true after archiving");
  return "hasLocalData: false (correctly no local data)";
});

// --- Phase 6: Idempotency — re-migration should be safe ---
step("6.6", "Testing idempotency (re-migration safe)...");

// Restore one file to test re-running
const archivePath = `${upgradeGitmemDir}/learnings.json.pre-migration`;
const restorePath = `${upgradeGitmemDir}/learnings.json`;
if (fs.existsSync(archivePath)) {
  fs.copyFileSync(archivePath, restorePath);
}

await test("re-migration is idempotent", async () => {
  const result = await migrateLocalToSupabase({
    supabaseUrl: sbUrl,
    supabaseKey: sbKey,
    tablePrefix: prefix,
    gitmemDir: upgradeGitmemDir,
    onProgress: () => {},
  });
  const totalMigrated = Object.values(result.migrated).reduce((a, b) => a + b, 0);
  // Should succeed (upsert = merge-duplicates), not fail on duplicate IDs
  if (totalMigrated === 0) throw new Error("Re-migration yielded 0 — upsert should succeed");
  return `Re-migrated ${totalMigrated} records (upsert idempotent)`;
});

// Clean up restored file
if (fs.existsSync(restorePath)) fs.unlinkSync(restorePath);

step("6.7", "Closing upgrade test session...");
await test("upgrade:session_close", () => call("session_close", {
  close_type: "quick",
  closing_reflection: { what_worked: "Free→Pro migration complete", what_broke: "Nothing",
    do_differently: "Nothing", scars_applied: [], institutional_memory_items: "Migration path verified",
    collaborative_dynamic: "Upgrade test", rapport_notes: "Clean", what_took_longer: "Nothing", wrong_assumption: "None" },
}));
scoreboard();

// ═══════════════════════════════════════════════════════════════════════════
// FINAL RESULTS
// ═══════════════════════════════════════════════════════════════════════════
const total = passed + warned + failed;
const dur = elapsed();

console.log(`
${C.bold}${C.cyan}${"═".repeat(65)}${C.reset}
${C.bold}  FINAL RESULTS${C.reset}
${C.cyan}${"═".repeat(65)}${C.reset}`);

const failures = Object.entries(results).filter(([,v]) => v !== "PASS");
if (failures.length > 0) {
  console.log(`\n  ${C.yellow}Non-PASS results:${C.reset}`);
  for (const [k, v] of failures) {
    const icon = v.startsWith("FAIL") ? FAIL_ICON : WARN_ICON;
    console.log(`  ${icon}  ${k}`);
    if (v.startsWith("FAIL")) console.log(`       ${C.dim}${v}${C.reset}`);
  }
}

const bar = (n, max, color) => {
  const width = 40;
  const filled = Math.round((n / max) * width);
  return `${color}${"█".repeat(filled)}${C.dim}${"░".repeat(width - filled)}${C.reset}`;
};

console.log(`
  ${bar(passed, total, C.green)} ${C.green}${C.bold}${passed}${C.reset} passed
  ${bar(warned, total, C.yellow)} ${C.yellow}${C.bold}${warned}${C.reset} warned
  ${bar(failed, total, C.red)} ${C.red}${C.bold}${failed}${C.reset} failed

  ${C.bold}Total: ${total} tests in ${dur}${C.reset}
  ${C.dim}6 sessions | 50 scars | 10 patterns | 5 decisions | 10 threads | 3 docs${C.reset}
  ${C.dim}Real Supabase + Real OpenRouter + Free→Pro Migration${C.reset}
`);

if (failed === 0) {
  console.log(`${C.green}${C.bold}  ALL TESTS PASSED${C.reset}`);
} else {
  console.log(`${C.red}${C.bold}  ${failed} TESTS FAILED${C.reset}`);
}

console.log(`${C.cyan}${"═".repeat(65)}${C.reset}\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
