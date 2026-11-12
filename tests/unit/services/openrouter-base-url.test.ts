/**
 * Unit tests for OPENROUTER_BASE_URL at every OpenRouter call site
 *
 * Verifies:
 * - No OpenRouter API URL literal is left in src/ outside license.ts (guard)
 * - Embedding provider detection (forced and auto) uses the base; an unusable
 *   base turns the provider off and never falls through to Ollama
 * - Transcript embedding, variant generation and `gitmem check` use the base,
 *   and send nothing when it is unusable
 * - The provider log line shows the base's origin only when it is not the default
 *
 * Nothing here touches the network or the developer's store: fetch is stubbed
 * and the store and cache directories are temp folders.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "gitmem-or-base-test-"));
// cache.ts reads GITMEM_CACHE_DIR when it is imported (via check.ts), so set it first.
process.env.GITMEM_CACHE_DIR = join(TEST_DIR, "cache");

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  getInstallId: () => "test-install-id",
}));

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

const ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENAI_API_KEY",
  "OLLAMA_URL",
  "GITMEM_EMBEDDING_PROVIDER",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_KEY",
];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("OPENROUTER_BASE_URL", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
    vi.resetModules();
    fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("leaves no OpenRouter API URL literal in src/ outside license.ts (AC-3.1)", () => {
    const offenders = collectTsFiles(SRC)
      .filter((f) => readFileSync(f, "utf-8").includes("openrouter.ai/api"))
      .map((f) => relative(SRC, f).split("\\").join("/"));

    expect(offenders).toEqual(["services/license.ts"]);
  });

  describe("embedding provider", () => {
    async function load() {
      const embedding = await import("../../../src/services/embedding.js");
      embedding.resetEmbeddingConfig();
      return embedding;
    }

    it("auto-detect posts to <base>/embeddings (AC-4.1)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "https://gw.example/v1");
      const { detectProvider } = await load();

      const config = detectProvider();

      expect(config.provider).toBe("openrouter");
      expect(config.apiUrl).toBe("https://gw.example/v1/embeddings");
    });

    it("a forced openrouter provider uses the base too (AC-4.2)", async () => {
      vi.stubEnv("GITMEM_EMBEDDING_PROVIDER", "openrouter");
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "https://forced.example/v1");
      const { detectProvider } = await load();

      expect(detectProvider().apiUrl).toBe("https://forced.example/v1/embeddings");
    });

    it("an unusable base turns the provider off and sends nothing (AC-4.3)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      const { detectProvider, embed } = await load();

      expect(detectProvider().provider).toBe("none");
      await expect(embed("hello")).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an unusable base turns a forced openrouter provider off too (AC-4.3)", async () => {
      vi.stubEnv("GITMEM_EMBEDDING_PROVIDER", "openrouter");
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      const { detectProvider } = await load();

      expect(detectProvider().provider).toBe("none");
    });

    it("uses openrouter.ai when no base is set (AC-4.4)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      const { detectProvider } = await load();

      expect(detectProvider().apiUrl).toBe("https://openrouter.ai/api/v1/embeddings");
    });

    it("Ollama selection is unchanged without an OpenRouter key, and an unusable base never falls through to it (AC-4.5)", async () => {
      vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:11434");
      const first = await load();
      const config = first.detectProvider();
      expect(config.provider).toBe("ollama");
      expect(config.apiUrl).toBe("http://127.0.0.1:11434/api/embed");

      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      vi.resetModules();
      const second = await load();
      expect(second.detectProvider().provider).toBe("none");
    });

    it("shows the base's origin on the provider line when it is not the default (AC-8.1)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "https://gw.example:8443/or/v1");
      const { getEmbeddingConfig } = await load();

      getEmbeddingConfig();

      const line = stderr.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("[embedding] Provider:"));
      expect(line).toContain("base: https://gw.example:8443");
      expect(line).not.toContain("/or/v1");
    });

    it("leaves the provider line alone with no base set (AC-8.2)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      const { getEmbeddingConfig } = await load();

      getEmbeddingConfig();

      const line = stderr.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("[embedding] Provider:"));
      expect(line).toBeDefined();
      expect(line).not.toContain("base:");
    });
  });

  describe("transcript embedding", () => {
    const embeddingBody = { data: [{ embedding: new Array(1536).fill(0.1) }] };

    it("posts to <base>/embeddings (AC-5.1)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "https://gw.example/v1");
      fetchMock.mockResolvedValueOnce(okJson(embeddingBody));
      const { generateEmbedding } = await import("../../../src/services/transcript-chunker.js");

      await generateEmbedding("x");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://gw.example/v1/embeddings");
    });

    it("rejects naming OPENROUTER_BASE_URL and sends nothing when the base is unusable (AC-5.2)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      const { generateEmbedding } = await import("../../../src/services/transcript-chunker.js");

      await expect(generateEmbedding("x")).rejects.toThrow(/OPENROUTER_BASE_URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("variant generation", () => {
    const scar = { id: "s1", title: "A scar", description: "Something went wrong" };
    const completion = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              imperative: { steps: ["do the thing"] },
              declarative: { success_state: "done", verification_tests: ["check it"], constraints: ["none"] },
            }),
          },
        },
      ],
    };

    it("posts to <base>/chat/completions (AC-6.1)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "https://gw.example/v1");
      fetchMock.mockResolvedValueOnce(okJson(completion));
      const { generateWithLLM } = await import("../../../src/services/variant-generation.js");

      const result = await generateWithLLM(scar);

      expect(result).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://gw.example/v1/chat/completions");
    });

    it("returns null and sends nothing when the base is unusable (AC-6.2)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      const { generateWithLLM } = await import("../../../src/services/variant-generation.js");

      await expect(generateWithLLM(scar)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("gitmem check", () => {
    it("probes <base>/models (AC-7.1)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "http://127.0.0.1:9/api/v1");
      const { runQuickCheck } = await import("../../../src/commands/check.js");

      const { health } = await runQuickCheck();

      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9/api/v1/models", expect.anything());
      expect(health.embedding.status).toBe("pass");
    });

    it("fails naming OPENROUTER_BASE_URL and sends no /models request when the base is unusable (AC-7.2)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
      vi.stubEnv("OPENROUTER_BASE_URL", "ftp://x");
      const { runQuickCheck } = await import("../../../src/commands/check.js");

      const { health } = await runQuickCheck();

      expect(health.embedding.status).toBe("fail");
      expect(health.embedding.message).toContain("OPENROUTER_BASE_URL");
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.endsWith("/models"))).toBe(false);
    });
  });

});
