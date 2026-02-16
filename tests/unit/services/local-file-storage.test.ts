/**
 * Unit tests for LocalFileStorage — starter scars timestamp fix
 *
 * Verifies that loadStarterScars stamps created_at to install time
 * instead of using hardcoded dates from starter-scars.json.
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
