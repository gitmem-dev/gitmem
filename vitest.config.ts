import { defineConfig } from "vitest/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * GIT-92/GIT-91: every worker gets a throwaway HOME.
 *
 * The suite writes real session state through getGitmemDir(), and since GIT-91
 * removed the cwd walk-up that resolves ~/.gitmem — the developer's actual
 * store. Redirecting HOME (rather than GITMEM_DIR) moves only the final
 * fallback, so the precedence chain GITMEM_DIR > cache > home stays intact and
 * suites that point at their own temp root via setGitmemDir() keep working.
 *
 * GITMEM_HOME rather than HOME: vitest runs on pool "threads", where
 * process.env is a JS-level copy that never reaches native getenv(), so
 * os.homedir() cannot be redirected from inside a worker at all.
 */
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-test-home-"));

/**
 * Vitest configuration for Tier 1 unit tests.
 *
 * Fast tests (<5s total) that don't require:
 * - Docker/containers
 * - Network connections
 * - Supabase
 *
 * Covers:
 * - Zod schema validation
 * - Pure function logic (cache keys, tier detection)
 * - Golden regression tests
 */
export default defineConfig({
  test: {
    // Include only unit tests
    include: ["tests/unit/**/*.test.ts"],

    // Exclude integration/performance/e2e tests
    exclude: [
      "tests/integration/**",
      "tests/performance/**",
      "tests/e2e/**",
      "node_modules/**",
    ],

    // Fast timeout for unit tests
    testTimeout: 5000,

    // Run tests in parallel
    pool: "threads",

    // Coverage configuration
    coverage: {
      provider: "v8",
      include: ["src/schemas/**/*.ts", "src/services/tier.ts", "src/services/cache.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },

    // Environment
    environment: "node",

    // GIT-92/GIT-91: pin every worker to a throwaway .gitmem root before any
    // test imports gitmem-dir. Without this the suite writes session
    // directories into the developer's real store — and since GIT-91 removed
    // the cwd walk-up, "real store" means ~/.gitmem, not a repo-local one.
    setupFiles: ["tests/setup/isolate-gitmem-root.ts"],

    // See TEST_HOME above — this is what actually isolates the store.
    env: { GITMEM_HOME: TEST_HOME },

    // Clear mocks between tests
    clearMocks: true,
    restoreMocks: true,
  },
});
