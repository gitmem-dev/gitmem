/**
 * Unit tests for reading the Supabase URL and key through getProConfig()
 *
 * Verifies, for transcript search, the transcript chunker, the behavioral decay
 * refresh and both `gitmem check` sites (the health check with its counts, and
 * the --full recall benchmark):
 * - the URL and key in config.json alone are used
 * - SUPABASE_KEY alone is used, as getProConfig() accepts it
 * - the environment wins over config.json, and SUPABASE_SERVICE_ROLE_KEY over SUPABASE_KEY
 * - with neither set, the answer is the one each site gave before
 * that `check --full` reads the values before its timed runs and the decay
 * module when it loads, and that no other src/ file reads the key or URL
 * directly (guard).
 *
 * Nothing here touches the network or the developer's store: fetch is stubbed,
 * the store is a temp folder and the cache is a stand-in.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { writeFileSync, readFileSync, readdirSync, statSync, rmSync, mkdtempSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "gitmem-supabase-config-test-"));
const CONFIG_PATH = join(TEST_DIR, "config.json");

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  getInstallId: () => "test-install-id",
}));

// `check --full` creates a CacheService on a fixed /tmp path; a stand-in keeps
// the test from writing there.
vi.mock("../../../src/services/cache.js", () => {
  class CacheService {
    isEnabled() { return true; }
    async getStats() { return { resultCount: 0, resultBytes: 0, oldestEntry: null }; }
    scarSearchKey() { return "health-check"; }
    async getResult() { return null; }
    async setResult() {}
  }
  return { CacheService, getCache: () => new CacheService() };
});

// search_transcripts embeds the query first; the embedding is not under test.
vi.mock("../../../src/services/embedding.js", () => ({
  embed: async () => [0.1, 0.2, 0.3],
}));

vi.mock("../../../src/services/session-state.js", () => ({
  getProject: () => null,
}));

const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_KEY",
  "GITMEM_TIER",
  "GITMEM_API_KEY",
  "GITMEM_DEV",
  "GITMEM_TABLE_PREFIX",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENAI_API_KEY",
  "OLLAMA_URL",
  "GITMEM_EMBEDDING_PROVIDER",
];

// Made-up values only.
const ENV_URL = "https://env-project.example";
const FILE_URL = "https://file-project.example";
const ROLE_KEY = "test-service-role-key-env";
const ALT_KEY = "test-supabase-key-env";
const FILE_KEY = "test-supabase-key-file";
// What config.json holds after a value has been read, in the read-once cases.
const LATER_CONFIG = { supabase_url: "https://later-project.example", supabase_key: "test-supabase-key-later" };

const EMBEDDING_BODY = { data: [{ embedding: new Array(1536).fill(0.1) }] };

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const SRC = join(__dirname, "../../../src");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * A read of one of `names` from the environment by name: `process.env.X` or
 * `process.env["X"]`, the same through an alias named `env`, or
 * `const { X } = process.env`. A name built at run time is not caught.
 */
function envRead(names: string): RegExp {
  return new RegExp(`\\benv(?:\\.|\\[\\s*["'\`])(?:${names})\\b|\\{[^}]*\\b(?:${names})\\b[^}]*\\}\\s*=\\s*[\\w.]*\\benv\\b`);
}

/**
 * Direct reads: `key` is SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY from the
 * environment, `url` is SUPABASE_URL from the environment, `file` is
 * config.json's supabase_url or supabase_key.
 */
const DIRECT_READS = {
  key: envRead("SUPABASE_SERVICE_ROLE_KEY|SUPABASE_KEY"),
  url: envRead("SUPABASE_URL"),
  file: /\.supabase_(?:url|key)\b|\[\s*["'`]supabase_(?:url|key)["'`]\s*\]/,
};
type DirectRead = keyof typeof DIRECT_READS;

/**
 * The files that still read the Supabase key or URL directly, and why. Every
 * other file calls getProConfig(). The list should only shrink.
 */
const ALLOWED_DIRECT_READS: Record<string, { reads: DirectRead[]; why: string }> = {
  "services/license.ts": { reads: ["key", "url", "file"], why: "getProConfig() itself" },
  "services/tier.ts": { reads: ["url"], why: "detectTier(), left as it is until Pro without a license key is settled" },
  "services/config.ts": { reads: ["url"], why: "search-mode detection from the URL's shape; no key" },
  "lib/telemetry.ts": { reads: ["url"], why: "the free/pro label on telemetry events; no key" },
  "commands/activate.ts": { reads: ["file"], why: "saves what it resolved and offers to keep the saved values" },
  "commands/deactivate.ts": { reads: ["file"], why: "removes the saved values" },
};

describe("only getProConfig() reads the Supabase key (guard)", () => {
  it("no src/ file outside the list reads the key or URL directly", () => {
    const found: Record<string, DirectRead[]> = {};
    for (const full of collectTsFiles(SRC)) {
      // Comment lines name these freely; only code counts.
      const code = readFileSync(full, "utf-8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      const reads = (Object.keys(DIRECT_READS) as DirectRead[]).filter((kind) => DIRECT_READS[kind].test(code));
      if (reads.length > 0) found[relative(SRC, full).split("\\").join("/")] = reads;
    }

    const allowed = Object.fromEntries(Object.entries(ALLOWED_DIRECT_READS).map(([file, { reads }]) => [file, reads]));
    expect(found, "read them through getProConfig() (src/services/license.ts)").toEqual(allowed);
  });
});

interface Site {
  name: string;
  /** Set in every case. */
  env?: Record<string, string>;
  /** Set only when a URL and key are configured. */
  envWhenConfigured?: Record<string, string>;
  /** Which fetch calls are this site's Supabase requests. */
  isRequest: (url: string) => boolean;
  run: () => Promise<unknown>;
  /** The answer with no URL or key set anywhere, as before the change. */
  expectUnset: (result: unknown) => void;
}

const SITES: Site[] = [
  {
    name: "search_transcripts",
    isRequest: (url) => url.includes("/rpc/match_transcript_chunks"),
    run: async () => {
      const { searchTranscripts } = await import("../../../src/tools/search-transcripts.js");
      return searchTranscripts({ query: "deploy", project: "default" });
    },
    expectUnset: (result) => {
      expect((result as { error?: string }).error).toBe("Supabase configuration missing");
    },
  },
  {
    name: "the transcript chunker",
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    isRequest: (url) => url.includes("transcript_chunks"),
    run: async () => {
      const { processTranscript } = await import("../../../src/services/transcript-chunker.js");
      return processTranscript("session-1", JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }));
    },
    expectUnset: (result) => {
      expect(result).toEqual({ success: false, chunksCreated: 0, error: "Supabase configuration missing" });
    },
  },
  {
    name: "the behavioral decay refresh",
    isRequest: (url) => url.includes("/rpc/refresh_scar_behavioral_scores") || url.includes("scar_usage"),
    run: async () => {
      const decay = await import("../../../src/services/behavioral-decay.js");
      const refreshed = await decay.refreshBehavioralScores();
      await decay.fetchDismissalCounts(["00000000-0000-4000-8000-000000000001"]);
      return refreshed;
    },
    expectUnset: (result) => {
      expect(result).toBeNull();
    },
  },
  {
    // GITMEM_TIER is set so the check runs without relying on how the tier is
    // detected from these values. With nothing set, detection gives free.
    name: "gitmem check (health check and counts)",
    envWhenConfigured: { GITMEM_TIER: "pro" },
    isRequest: (url) => /\/gitmem_(learnings|sessions|decisions)\?select=id&limit=[01]$/.test(url),
    run: async () => {
      const { runQuickCheck } = await import("../../../src/commands/check.js");
      return runQuickCheck();
    },
    expectUnset: (result) => {
      const { health, configuration } = result as {
        health: { supabase: { status: string } };
        configuration: { supabaseUrl: string };
      };
      expect(health.supabase.status).toBe("skip");
      expect(configuration.supabaseUrl).toBe("not_configured");
    },
  },
  {
    name: "gitmem check --full (recall benchmark)",
    envWhenConfigured: { GITMEM_TIER: "pro" },
    isRequest: (url) => url.includes("select=id,title"),
    run: async () => {
      const { runCheck } = await import("../../../src/commands/check.js");
      const output = join(TEST_DIR, "report.json");
      await runCheck({ full: true, output });
      return JSON.parse(readFileSync(output, "utf-8"));
    },
    expectUnset: (report) => {
      expect((report as { benchmarks?: Record<string, unknown> }).benchmarks?.recall).toBeUndefined();
    },
  },
];

describe("the Supabase URL and key come from getProConfig() at every call site", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
    vi.resetModules();
    fetchMock = vi.fn(async (url: unknown) => (String(url).endsWith("/embeddings") ? okJson(EMBEDDING_BODY) : okJson([])));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(CONFIG_PATH, { force: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function configure(site: Site, env: Record<string, string>, file?: Record<string, string>): void {
    for (const [name, value] of Object.entries({ ...site.env, ...env })) vi.stubEnv(name, value);
    if (file) writeFileSync(CONFIG_PATH, JSON.stringify(file));
  }

  /** Each Supabase request the site sent, as the base URL and the two key headers. */
  function sent(site: Site) {
    return fetchMock.mock.calls
      .filter(([url]) => site.isRequest(String(url)))
      .map(([url, init]) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return { base: String(url).split("/rest/v1/")[0], apikey: headers.apikey, authorization: headers.Authorization };
      });
  }

  function expectSentWith(site: Site, base: string, key: string): void {
    const requests = sent(site);
    expect(requests.length, `${site.name} sent no Supabase request`).toBeGreaterThan(0);
    expect(requests).toEqual(requests.map(() => ({ base, apikey: key, authorization: `Bearer ${key}` })));
  }

  describe.each(SITES)("$name", (site) => {
    it("uses the URL and key from config.json when the environment has neither", async () => {
      configure(site, { ...site.envWhenConfigured }, { supabase_url: FILE_URL, supabase_key: FILE_KEY });

      await site.run();

      expectSentWith(site, FILE_URL, FILE_KEY);
    });

    it("uses SUPABASE_KEY when it is the only key set", async () => {
      configure(site, { ...site.envWhenConfigured, SUPABASE_URL: ENV_URL, SUPABASE_KEY: ALT_KEY });

      await site.run();

      expectSentWith(site, ENV_URL, ALT_KEY);
    });

    it("prefers the environment to config.json, and SUPABASE_SERVICE_ROLE_KEY to SUPABASE_KEY", async () => {
      configure(
        site,
        { ...site.envWhenConfigured, SUPABASE_URL: ENV_URL, SUPABASE_SERVICE_ROLE_KEY: ROLE_KEY, SUPABASE_KEY: ALT_KEY },
        { supabase_url: FILE_URL, supabase_key: FILE_KEY },
      );

      await site.run();

      expectSentWith(site, ENV_URL, ROLE_KEY);
    });

    it("with no URL or key anywhere, sends nothing and answers as before", async () => {
      configure(site, {});

      const result = await site.run();

      expect(sent(site)).toEqual([]);
      site.expectUnset(result);
    });
  });

  describe("two sites read the values once", () => {
    const siteNamed = (name: string) => SITES.find((site) => site.name === name)!;

    it("gitmem check --full reads them before its five timed runs, so each run times the request only", async () => {
      const site = siteNamed("gitmem check --full (recall benchmark)");
      configure(site, { ...site.envWhenConfigured }, { supabase_url: FILE_URL, supabase_key: FILE_KEY });
      // From the first timed request on, config.json names another project;
      // a read inside the timed function would pick it up in runs 2 to 5.
      const answer = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url: unknown) => {
        if (site.isRequest(String(url))) writeFileSync(CONFIG_PATH, JSON.stringify(LATER_CONFIG));
        return answer(url);
      });

      await site.run();

      expect(sent(site)).toHaveLength(5);
      expectSentWith(site, FILE_URL, FILE_KEY);
    });

    it("the decay module reads them when it loads, as the storage layer does", async () => {
      const site = siteNamed("the behavioral decay refresh");
      configure(site, {}, { supabase_url: FILE_URL, supabase_key: FILE_KEY });
      const decay = await import("../../../src/services/behavioral-decay.js");
      writeFileSync(CONFIG_PATH, JSON.stringify(LATER_CONFIG));

      await decay.refreshBehavioralScores();
      await decay.fetchDismissalCounts(["00000000-0000-4000-8000-000000000001"]);

      expectSentWith(site, FILE_URL, FILE_KEY);
    });
  });
});
