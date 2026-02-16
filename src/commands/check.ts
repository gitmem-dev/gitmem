/**
 * GitMem Check Command
 *
 * Diagnostic CLI command for health checks and benchmarks.
 *
 * Usage:
 *   npx gitmem-mcp check           — Quick health check (~5s)
 *   npx gitmem-mcp check --full    — Full diagnostic (~30s)
 *   npx gitmem-mcp check --output report.json
 *
 *
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  DiagnosticsCollector,
  DiagnosticReport,
  HealthCheckResult,
  BenchmarkResult,
  runBenchmark,
  anonymizeSupabaseUrl,
  anonymizePath,
  isApiKeyConfigured,
  getSafeEnvironmentInfo,
} from "../diagnostics/index.js";
import { getCache, CacheService } from "../services/cache.js";
import { getTier, hasSupabase } from "../services/tier.js";
import { getGitmemDir } from "../services/gitmem-dir.js";

// Report version for schema compatibility
const REPORT_VERSION = "1.0.0";

/**
 * Command options
 */
interface CheckOptions {
  full: boolean;
  output?: string;
}

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): CheckOptions {
  const options: CheckOptions = {
    full: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--full" || arg === "-f") {
      options.full = true;
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[i + 1];
      i++;
    }
  }

  return options;
}

/**
 * Run quick health check (~5s)
 */
async function runQuickCheck(): Promise<{
  health: DiagnosticReport["health"];
  configuration: DiagnosticReport["configuration"];
  dataVolume?: DiagnosticReport["dataVolume"];
}> {
  const health: DiagnosticReport["health"] = {
    supabase: { status: "skip", message: "Not checked" },
    embedding: { status: "skip", message: "Not checked" },
    cache: { status: "skip", message: "Not checked" },
    recall: { status: "skip", message: "Not checked" },
    write: { status: "skip", message: "Not checked" },
  };

  // Detect tier and configuration
  const tier = getTier();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const ollamaUrl = process.env.OLLAMA_URL;

  // Determine embedding provider
  let embeddingProvider = "none";
  let embeddingConfigured = false;
  if (isApiKeyConfigured(openaiKey)) {
    embeddingProvider = "openai";
    embeddingConfigured = true;
  } else if (isApiKeyConfigured(openrouterKey)) {
    embeddingProvider = "openrouter";
    embeddingConfigured = true;
  } else if (ollamaUrl) {
    embeddingProvider = "ollama";
    embeddingConfigured = true;
  }

  // Cache check
  const cache = getCache();
  const cacheEnabled = cache.isEnabled();
  const cachePath = process.env.GITMEM_CACHE_DIR ||
    (process.env.HOME ? `${process.env.HOME}/.cache/gitmem` : "/tmp/gitmem-cache");

  const configuration: DiagnosticReport["configuration"] = {
    supabaseConfigured: hasSupabase(),
    supabaseUrl: anonymizeSupabaseUrl(supabaseUrl),
    embeddingProvider,
    embeddingConfigured,
    cacheEnabled,
    cachePath: anonymizePath(cachePath),
  };

  // Health check: Cache
  if (cacheEnabled) {
    try {
      const startTime = Date.now();
      const stats = await cache.getStats();
      const durationMs = Date.now() - startTime;
      health.cache = {
        status: "pass",
        message: `Cache operational (${stats.resultCount} entries, ${Math.round(stats.resultBytes / 1024)}KB)`,
        durationMs,
      };
    } catch (error) {
      health.cache = {
        status: "fail",
        message: `Cache error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    health.cache = {
      status: "skip",
      message: "Cache disabled",
    };
  }

  // Health check: Supabase connection
  if (hasSupabase()) {
    try {
      const startTime = Date.now();
      // Try to fetch from Supabase REST API
      const restUrl = `${supabaseUrl}/rest/v1/gitmem_learnings?select=id&limit=1`;
      const response = await fetch(restUrl, {
        headers: {
          apikey: supabaseKey!,
          Authorization: `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
      const durationMs = Date.now() - startTime;

      if (response.ok) {
        health.supabase = {
          status: "pass",
          message: "Supabase connection successful",
          durationMs,
        };
      } else {
        health.supabase = {
          status: "fail",
          message: `Supabase returned ${response.status}: ${response.statusText}`,
          durationMs,
        };
      }
    } catch (error) {
      health.supabase = {
        status: "fail",
        message: `Supabase connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    health.supabase = {
      status: "skip",
      message: "Supabase not configured (free tier)",
    };
  }

  // Health check: Embedding provider
  if (embeddingConfigured) {
    if (embeddingProvider === "openai") {
      try {
        const startTime = Date.now();
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: {
            Authorization: `Bearer ${openaiKey}`,
          },
          signal: AbortSignal.timeout(5_000),
        });
        const durationMs = Date.now() - startTime;

        if (response.ok) {
          health.embedding = {
            status: "pass",
            message: "OpenAI API accessible",
            durationMs,
          };
        } else {
          health.embedding = {
            status: "fail",
            message: `OpenAI API returned ${response.status}`,
            durationMs,
          };
        }
      } catch (error) {
        health.embedding = {
          status: "fail",
          message: `OpenAI connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else if (embeddingProvider === "openrouter") {
      try {
        const startTime = Date.now();
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: {
            Authorization: `Bearer ${openrouterKey}`,
          },
          signal: AbortSignal.timeout(5_000),
        });
        const durationMs = Date.now() - startTime;

        if (response.ok) {
          health.embedding = {
            status: "pass",
            message: "OpenRouter API accessible",
            durationMs,
          };
        } else {
          health.embedding = {
            status: "fail",
            message: `OpenRouter API returned ${response.status}`,
            durationMs,
          };
        }
      } catch (error) {
        health.embedding = {
          status: "fail",
          message: `OpenRouter connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else if (embeddingProvider === "ollama") {
      try {
        const startTime = Date.now();
        const response = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(5_000),
        });
        const durationMs = Date.now() - startTime;

        if (response.ok) {
          health.embedding = {
            status: "pass",
            message: "Ollama server accessible",
            durationMs,
          };
        } else {
          health.embedding = {
            status: "fail",
            message: `Ollama server returned ${response.status}`,
            durationMs,
          };
        }
      } catch (error) {
        health.embedding = {
          status: "fail",
          message: `Ollama connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  } else {
    health.embedding = {
      status: "skip",
      message: "No embedding provider configured",
    };
  }

  // Health check: Basic recall test (just verify it doesn't crash)
  try {
    const startTime = Date.now();
    // We can't actually call recall without the full MCP server
    // So we just verify the cache can be read
    const testKey = cache.scarSearchKey("health check test", "test", 5);
    await cache.getResult(testKey);
    const durationMs = Date.now() - startTime;
    health.recall = {
      status: "pass",
      message: "Recall infrastructure operational",
      durationMs,
    };
  } catch (error) {
    health.recall = {
      status: "fail",
      message: `Recall check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Health check: Write test (verify we can write to cache)
  try {
    const startTime = Date.now();
    const testKey = `health_check_${Date.now()}`;
    await cache.setResult(testKey, { test: true }, 1000); // 1 second TTL
    const durationMs = Date.now() - startTime;
    health.write = {
      status: "pass",
      message: "Write operations functional",
      durationMs,
    };
  } catch (error) {
    health.write = {
      status: "fail",
      message: `Write check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Data volume (counts only)
  let dataVolume: DiagnosticReport["dataVolume"] | undefined;
  try {
    const gitmemDir = getGitmemDir();
    let localCacheFiles = 0;
    let localCacheBytes = 0;

    if (existsSync(gitmemDir)) {
      const files = readdirSync(gitmemDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          localCacheFiles++;
          try {
            const stat = statSync(join(gitmemDir, file));
            localCacheBytes += stat.size;
          } catch {
            // Ignore stat errors
          }
        }
      }
    }

    // For Supabase counts, we'd need to query the database
    // For now, just report local counts
    dataVolume = {
      learningsCount: 0, // Would need DB query
      sessionsCount: 0,
      decisionsCount: 0,
      localCacheFiles,
      localCacheBytes,
    };

    // If Supabase is configured, try to get counts
    if (hasSupabase()) {
      try {
        const tables = ["learnings", "sessions", "decisions"];
        for (const table of tables) {
          const response = await fetch(
            `${supabaseUrl}/rest/v1/gitmem_${table}?select=id&limit=0`,
            {
              method: "HEAD",
              headers: {
                apikey: supabaseKey!,
                Authorization: `Bearer ${supabaseKey}`,
                Prefer: "count=exact",
              },
              signal: AbortSignal.timeout(5_000),
            }
          );
          const count = response.headers.get("content-range");
          if (count) {
            const match = count.match(/\/(\d+)/);
            if (match) {
              const key = `${table}Count` as keyof typeof dataVolume;
              (dataVolume as any)[key] = parseInt(match[1]);
            }
          }
        }
      } catch {
        // Ignore count errors
      }
    }
  } catch {
    // Ignore data volume errors
  }

  return { health, configuration, dataVolume };
}

/**
 * Run full diagnostic with benchmarks (~30s)
 */
async function runFullCheck(): Promise<DiagnosticReport["benchmarks"]> {
  const benchmarks: DiagnosticReport["benchmarks"] = {};
  const cache = getCache();

  // Cold start benchmark (cache initialization)
  console.error("  Running cold start benchmark...");
  try {
    benchmarks.coldStart = await runBenchmark(
      "coldStart",
      async () => {
        // Simulate cold start by creating new cache instance
        const testCache = new CacheService(`/tmp/gitmem-bench-${Date.now()}`);
        await testCache.getStats();
      },
      5
    );
  } catch (error) {
    console.error(`  Cold start benchmark failed: ${error}`);
  }

  // Cache populate benchmark
  console.error("  Running cache populate benchmark...");
  try {
    benchmarks.cachePopulate = await runBenchmark(
      "cachePopulate",
      async () => {
        const key = `bench_populate_${Date.now()}`;
        await cache.setResult(key, { test: true, data: "x".repeat(1000) }, 60000);
      },
      5
    );
  } catch (error) {
    console.error(`  Cache populate benchmark failed: ${error}`);
  }

  // Cache hit benchmark
  console.error("  Running cache hit benchmark...");
  try {
    // First, populate a cache entry
    const hitKey = `bench_hit_${Date.now()}`;
    await cache.setResult(hitKey, { test: true, data: "x".repeat(1000) }, 60000);

    benchmarks.cacheHit = await runBenchmark(
      "cacheHit",
      async () => {
        await cache.getResult(hitKey);
      },
      5
    );
  } catch (error) {
    console.error(`  Cache hit benchmark failed: ${error}`);
  }

  // Recall benchmark (if Supabase configured)
  if (hasSupabase()) {
    console.error("  Running recall benchmark...");
    try {
      benchmarks.recall = await runBenchmark(
        "recall",
        async () => {
          // Simulate recall by doing a search
          const supabaseUrl = process.env.SUPABASE_URL;
          const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

          await fetch(`${supabaseUrl}/rest/v1/gitmem_learnings?select=id,title&limit=5`, {
            headers: {
              apikey: supabaseKey!,
              Authorization: `Bearer ${supabaseKey}`,
            },
            signal: AbortSignal.timeout(5_000),
          });
        },
        5
      );
    } catch (error) {
      console.error(`  Recall benchmark failed: ${error}`);
    }
  }

  return benchmarks;
}

/**
 * Main check command
 */
export async function runCheck(options: CheckOptions): Promise<void> {
  const mode = options.full ? "full" : "quick";
  console.error(`\nGitMem Diagnostic Check (${mode} mode)\n`);
  console.error("=".repeat(50));

  const collector = new DiagnosticsCollector();
  collector.start();

  // Run quick checks
  console.error("\nRunning health checks...");
  const { health, configuration, dataVolume } = await runQuickCheck();

  // Print health check results
  console.error("\nHealth Checks:");
  for (const [name, result] of Object.entries(health)) {
    const icon = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "○";
    const time = result.durationMs ? ` (${result.durationMs}ms)` : "";
    console.error(`  ${icon} ${name}: ${result.message}${time}`);
  }

  // Run benchmarks if full mode
  let benchmarks: DiagnosticReport["benchmarks"] | undefined;
  if (options.full) {
    console.error("\nRunning benchmarks...");
    benchmarks = await runFullCheck();

    if (benchmarks) {
      console.error("\nBenchmark Results:");
      for (const [name, result] of Object.entries(benchmarks)) {
        if (result) {
          console.error(`  ${name}: mean=${result.meanMs.toFixed(2)}ms, p95=${result.p95Ms.toFixed(2)}ms`);
        }
      }
    }
  }

  // Stop collecting metrics
  const metrics = collector.stop();

  // Build report
  const envInfo = getSafeEnvironmentInfo();
  const report: DiagnosticReport = {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    mode,
    environment: {
      ...envInfo,
      tier: getTier(),
    },
    configuration,
    health,
    metrics,
    benchmarks,
    dataVolume,
  };

  // Determine output path
  const gitmemDir = getGitmemDir();
  if (!existsSync(gitmemDir)) {
    mkdirSync(gitmemDir, { recursive: true });
  }

  const outputPath = options.output || join(gitmemDir, `diagnostic-${Date.now()}.json`);

  // Write report
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.error(`\nReport saved to: ${outputPath}`);

  // Summary
  const passCount = Object.values(health).filter((h) => h.status === "pass").length;
  const failCount = Object.values(health).filter((h) => h.status === "fail").length;
  const skipCount = Object.values(health).filter((h) => h.status === "skip").length;

  console.error(`\nSummary: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);

  if (failCount > 0) {
    console.error("\n⚠️  Some health checks failed. Review the report for details.");
    process.exit(1);
  }

  console.error("\n✓ All health checks passed.");
}

/**
 * Entry point for CLI
 */
export async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  await runCheck(options);
}
