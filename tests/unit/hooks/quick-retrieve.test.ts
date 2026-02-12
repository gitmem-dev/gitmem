/**
 * Unit tests for quick-retrieve.ts (OD-612)
 *
 * Tests the quickRetrieve function and disk cache search.
 * Mocks external dependencies (tier, storage, local-vector-search, fs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// --- Mock external dependencies ---

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => false),
}));

vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: vi.fn(() => false),
  localScarSearch: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: vi.fn(() => ({
    search: vi.fn(() => Promise.resolve([])),
  })),
}));

// Import after mocks
import { quickRetrieve } from "../../../src/hooks/quick-retrieve.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { isLocalSearchReady, localScarSearch } from "../../../src/services/local-vector-search.js";
import { getStorage } from "../../../src/services/storage.js";

// --- Test fixtures ---

const MOCK_SCARS = [
  {
    id: "scar-1",
    title: "Done != Deployed != Verified Working",
    description: "Always verify deployment after merge. Check the running service.",
    severity: "critical",
    counter_arguments: ["Sometimes deploy is automatic", "CI handles it"],
    keywords: ["deploy", "verification", "production"],
    why_this_matters: "Prevents silent deployment failures",
    action_protocol: ["Check service health after deploy"],
    self_check_criteria: ["Service responds 200"],
  },
  {
    id: "scar-2",
    title: "Trace execution path before hypothesizing",
    description: "Read the actual code path before guessing at bugs.",
    severity: "high",
    counter_arguments: ["Sometimes intuition is faster", "For obvious bugs"],
    keywords: ["debugging", "trace", "code"],
  },
  {
    id: "scar-3",
    title: "Check existing working code before building new",
    description: "Reference patterns that already work in the codebase.",
    severity: "medium",
    counter_arguments: ["New approach might be better", "Legacy code"],
    keywords: ["patterns", "reference", "existing"],
  },
];

// --- Disk cache setup/teardown ---

const CACHE_DIR = path.join(process.cwd(), ".gitmem", "cache");
const CACHE_PATH = path.join(CACHE_DIR, "hook-scars.json");

function writeDiskCache(scars: unknown[]): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(scars));
}

function removeDiskCache(): void {
  if (fs.existsSync(CACHE_PATH)) {
    fs.unlinkSync(CACHE_PATH);
  }
}

// --- Tests ---

describe("quickRetrieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no supabase, no local search
    vi.mocked(hasSupabase).mockReturnValue(false);
    vi.mocked(isLocalSearchReady).mockReturnValue(false);
  });

  afterEach(() => {
    removeDiskCache();
  });

  it("returns null for 'none' retrieval level", async () => {
    const result = await quickRetrieve("test prompt", "none");
    expect(result).toBeNull();
  });

  it("returns null for empty prompt", async () => {
    const result = await quickRetrieve("", "scars");
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only prompt", async () => {
    const result = await quickRetrieve("   ", "scars");
    expect(result).toBeNull();
  });

  describe("disk cache path (hook child process)", () => {
    it("returns results from disk cache when available", async () => {
      writeDiskCache(MOCK_SCARS);

      const result = await quickRetrieve("deploy verification production", "scars");

      expect(result).not.toBeNull();
      expect(result).toContain("INSTITUTIONAL MEMORY");
      expect(result).toContain("Done != Deployed");
    });

    it("keyword search matches title tokens", async () => {
      writeDiskCache(MOCK_SCARS);

      const result = await quickRetrieve("trace execution debugging", "scars");

      expect(result).not.toBeNull();
      expect(result).toContain("Trace execution path");
    });

    it("keyword search matches keyword fields", async () => {
      writeDiskCache(MOCK_SCARS);

      const result = await quickRetrieve("patterns reference", "scars");

      expect(result).not.toBeNull();
      expect(result).toContain("Check existing working code");
    });

    it("returns null when no keywords match", async () => {
      writeDiskCache(MOCK_SCARS);

      const result = await quickRetrieve("quantum physics", "scars");

      expect(result).toBeNull();
    });

    it("returns more results with 'full' retrieval level", async () => {
      // Create enough scars to show the difference (full=5 vs scars=3)
      const manyScars = Array.from({ length: 10 }, (_, i) => ({
        id: `scar-${i}`,
        title: `Deploy scar ${i}`,
        description: `Deploy related scar number ${i}.`,
        severity: "medium",
        keywords: ["deploy"],
      }));
      writeDiskCache(manyScars);

      const scarsResult = await quickRetrieve("deploy", "scars");
      const fullResult = await quickRetrieve("deploy", "full");

      // Both should return results
      expect(scarsResult).not.toBeNull();
      expect(fullResult).not.toBeNull();

      // Full should contain more lines (header + 5 vs header + 3)
      const scarsLines = scarsResult!.split("\n").length;
      const fullLines = fullResult!.split("\n").length;
      expect(fullLines).toBeGreaterThan(scarsLines);
    });

    it("handles corrupt disk cache gracefully", async () => {
      // Write invalid JSON
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(CACHE_PATH, "not valid json {{{");

      const result = await quickRetrieve("deploy", "scars");

      // Should not throw, falls through to storage.search which returns []
      expect(result).toBeNull();
    });

    it("handles missing disk cache gracefully", async () => {
      removeDiskCache();

      const result = await quickRetrieve("deploy", "scars");

      // Falls through to storage.search which returns []
      expect(result).toBeNull();
    });
  });

  describe("in-memory vector search path (MCP server)", () => {
    it("uses local vector search when supabase is configured and cache is warm", async () => {
      vi.mocked(hasSupabase).mockReturnValue(true);
      vi.mocked(isLocalSearchReady).mockReturnValue(true);
      vi.mocked(localScarSearch).mockResolvedValue([
        {
          id: "scar-1",
          title: "Vector result",
          description: "Found via vector search",
          severity: "high",
          counter_arguments: [],
          similarity: 0.92,
        },
      ]);

      const result = await quickRetrieve("test query", "scars");

      expect(result).not.toBeNull();
      expect(result).toContain("Vector result");
      expect(localScarSearch).toHaveBeenCalledWith("test query", 3, "default");
    });

    it("uses matchCount=5 for full retrieval level", async () => {
      vi.mocked(hasSupabase).mockReturnValue(true);
      vi.mocked(isLocalSearchReady).mockReturnValue(true);
      vi.mocked(localScarSearch).mockResolvedValue([]);

      await quickRetrieve("test query", "full");

      expect(localScarSearch).toHaveBeenCalledWith("test query", 5, "default");
    });
  });

  describe("token budget", () => {
    it("respects custom token budget", async () => {
      writeDiskCache(
        Array.from({ length: 50 }, (_, i) => ({
          id: `scar-${i}`,
          title: `Scar ${i} with deploy in the title for matching`,
          description: `Description for deploy scar ${i} that adds tokens.`,
          severity: "medium",
          keywords: ["deploy"],
        }))
      );

      const result = await quickRetrieve("deploy", "scars", { tokenBudget: 100 });

      expect(result).not.toBeNull();
      // With tiny budget, should have very few scars
      const lines = result!.split("\n");
      expect(lines.length).toBeLessThanOrEqual(5); // header + up to 3 scars max
    });
  });
});
