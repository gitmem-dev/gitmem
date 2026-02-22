/**
 * Unit tests for LocalFileStorage
 *
 * Covers: loadStarterScars, keywordSearch learning_type propagation,
 * list() is_active filter handling, and learning_type filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LocalFileStorage } from "../../../src/services/local-file-storage.js";

describe("LocalFileStorage.loadStarterScars", () => {
  let tmpDir: string;
  let storage: LocalFileStorage;
  let scarsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-test-"));
    storage = new LocalFileStorage(tmpDir);

    // Write a minimal starter scars file
    scarsPath = path.join(tmpDir, "test-starter-scars.json");
    const starterScars = [
      {
        id: "starter-scar-1",
        title: "Test Starter Scar",
        description: "A test scar",
        learning_type: "scar",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "starter-scar-2",
        title: "Another Starter Scar",
        description: "Another test scar",
        learning_type: "scar",
        created_at: "2025-06-01T00:00:00Z",
      },
    ];
    fs.writeFileSync(scarsPath, JSON.stringify(starterScars));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps created_at to install time, not hardcoded date", async () => {
    const before = new Date().toISOString();
    await storage.loadStarterScars(scarsPath);
    const after = new Date().toISOString();

    // Read the learnings file to check timestamps
    const learningsPath = path.join(tmpDir, "learnings.json");
    const learnings = JSON.parse(fs.readFileSync(learningsPath, "utf-8"));

    expect(learnings).toHaveLength(2);
    for (const scar of learnings) {
      // created_at should be between before and after, NOT the hardcoded date
      expect(scar.created_at >= before).toBe(true);
      expect(scar.created_at <= after).toBe(true);
      expect(scar.created_at).not.toBe("2026-01-01T00:00:00Z");
      expect(scar.created_at).not.toBe("2025-06-01T00:00:00Z");
    }
  });

  it("returns count of loaded scars", async () => {
    const count = await storage.loadStarterScars(scarsPath);
    expect(count).toBe(2);
  });

  it("does not reload scars that already exist", async () => {
    // Load once
    await storage.loadStarterScars(scarsPath);
    // Load again — should skip existing
    const count = await storage.loadStarterScars(scarsPath);
    expect(count).toBe(0);

    // Still only 2 learnings total
    const learningsPath = path.join(tmpDir, "learnings.json");
    const learnings = JSON.parse(fs.readFileSync(learningsPath, "utf-8"));
    expect(learnings).toHaveLength(2);
  });
});

describe("LocalFileStorage.keywordSearch — learning_type propagation", () => {
  let tmpDir: string;
  let storage: LocalFileStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-test-"));
    storage = new LocalFileStorage(tmpDir);

    // Seed learnings with different types
    const learnings = [
      {
        id: "scar-1",
        title: "Database migration rollback",
        description: "Always test rollback before migrating",
        learning_type: "scar",
        severity: "high",
        keywords: ["database", "migration"],
        is_active: true,
      },
      {
        id: "pattern-1",
        title: "Database connection pooling pattern",
        description: "Use connection pooling for database access",
        learning_type: "pattern",
        severity: "low",
        keywords: ["database", "connection"],
        is_active: true,
      },
      {
        id: "win-1",
        title: "Database query optimization win",
        description: "Indexing improved database query speed 10x",
        learning_type: "win",
        severity: "medium",
        keywords: ["database", "optimization"],
        is_active: true,
      },
    ];
    const filePath = path.join(tmpDir, "learnings.json");
    fs.writeFileSync(filePath, JSON.stringify(learnings));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns learning_type for each result", async () => {
    const results = await storage.keywordSearch("database", 10);
    expect(results.length).toBeGreaterThanOrEqual(3);

    const types = results.map((r) => r.learning_type);
    expect(types).toContain("scar");
    expect(types).toContain("pattern");
    expect(types).toContain("win");
  });

  it("does not default all results to scar", async () => {
    const results = await storage.keywordSearch("database", 10);
    const nonScars = results.filter((r) => r.learning_type !== "scar");
    expect(nonScars.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves learning_type for patterns", async () => {
    const results = await storage.keywordSearch("connection pooling", 5);
    const pattern = results.find((r) => r.id === "pattern-1");
    expect(pattern).toBeDefined();
    expect(pattern!.learning_type).toBe("pattern");
  });

  it("preserves learning_type for wins", async () => {
    const results = await storage.keywordSearch("optimization", 5);
    const win = results.find((r) => r.id === "win-1");
    expect(win).toBeDefined();
    expect(win!.learning_type).toBe("win");
  });
});

describe("LocalFileStorage.list — is_active filter", () => {
  let tmpDir: string;
  let storage: LocalFileStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-test-"));
    storage = new LocalFileStorage(tmpDir);

    // Seed learnings: some with is_active, some without (should default to active)
    const learnings = [
      {
        id: "active-explicit",
        title: "Explicitly active",
        learning_type: "scar",
        severity: "high",
        is_active: true,
        created_at: "2026-02-22T00:00:00Z",
      },
      {
        id: "active-implicit",
        title: "Implicitly active (no is_active field)",
        learning_type: "pattern",
        severity: "low",
        created_at: "2026-02-21T00:00:00Z",
        // NOTE: no is_active field — should be treated as active
      },
      {
        id: "archived",
        title: "Archived learning",
        learning_type: "scar",
        severity: "medium",
        is_active: false,
        created_at: "2026-02-20T00:00:00Z",
      },
    ];
    const filePath = path.join(tmpDir, "learnings.json");
    fs.writeFileSync(filePath, JSON.stringify(learnings));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes records without is_active when filtering for active", async () => {
    const results = await storage.list("learnings", {
      filters: { is_active: "eq.true" },
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("active-explicit");
    expect(ids).toContain("active-implicit");
    expect(ids).not.toContain("archived");
  });

  it("excludes archived records", async () => {
    const results = await storage.list("learnings", {
      filters: { is_active: "eq.true" },
    });
    expect(results).toHaveLength(2);
  });

  it("filters by learning_type correctly", async () => {
    const results = await storage.list("learnings", {
      filters: { learning_type: "pattern" },
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("active-implicit");
  });

  it("combines is_active and learning_type filters", async () => {
    const results = await storage.list("learnings", {
      filters: { is_active: "eq.true", learning_type: "scar" },
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("active-explicit");
  });
});
