/**
 * Tests for archive_learning prefix resolution
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SUPABASE_TIER_MOCKS } from "../../helpers/supabase-mocks.js";

// --- Mocks ---

const mockDirectPatch = vi.fn().mockResolvedValue(undefined);
const mockDirectQuery = vi.fn().mockResolvedValue([]);
const mockIsConfigured = vi.fn(() => true);

vi.mock("../../../src/services/supabase-client.js", () => ({
  directPatch: (...args: unknown[]) => mockDirectPatch(...args),
  directQuery: (...args: unknown[]) => mockDirectQuery(...args),
  isConfigured: () => mockIsConfigured(),
}));

vi.mock("../../../src/services/tier.js", () => SUPABASE_TIER_MOCKS);

const mockStorageGet = vi.fn().mockResolvedValue(null);
const mockStorageUpsert = vi.fn().mockResolvedValue(undefined);
const mockStorageQuery = vi.fn().mockResolvedValue([]);

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: () => ({
    get: mockStorageGet,
    upsert: mockStorageUpsert,
    query: mockStorageQuery,
  }),
}));

vi.mock("../../../src/services/startup.js", () => ({
  flushCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/services/metrics.js", () => ({
  Timer: class { stop() { return 42; } },
}));

vi.mock("../../../src/services/display-protocol.js", () => ({
  wrapDisplay: (msg: string) => msg,
}));

import { archiveLearning } from "../../../src/tools/archive-learning.js";
import { hasSupabase } from "../../../src/services/tier.js";

const FULL_UUID = "a501c95e-1234-5678-9abc-def012345678";

describe("archive_learning prefix resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasSupabase).mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
  });

  // --- Input validation ---

  it("rejects empty id", async () => {
    const result = await archiveLearning({ id: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("rejects non-hex input", async () => {
    const result = await archiveLearning({ id: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ID format");
  });

  it("rejects prefix shorter than 4 chars", async () => {
    const result = await archiveLearning({ id: "eb4" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ID format");
  });

  it("rejects mixed hex/non-hex", async () => {
    const result = await archiveLearning({ id: "ab12zz" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ID format");
  });

  // --- Full UUID passthrough ---

  it("passes full UUID through without resolution", async () => {
    const result = await archiveLearning({ id: FULL_UUID });
    expect(result.success).toBe(true);
    // Should NOT call directQuery for resolution
    expect(mockDirectQuery).not.toHaveBeenCalled();
    // Should call directPatch with full UUID
    expect(mockDirectPatch).toHaveBeenCalledWith(
      expect.any(String),
      { id: `eq.${FULL_UUID}` },
      expect.objectContaining({ is_active: false }),
    );
  });

  // --- Supabase prefix resolution ---

  it("resolves 8-char prefix via Supabase like filter", async () => {
    mockDirectQuery.mockResolvedValueOnce([{ id: FULL_UUID }]);

    const result = await archiveLearning({ id: "a501c95e" });
    expect(result.success).toBe(true);
    expect(result.id).toBe(FULL_UUID);

    // Check directQuery was called with like filter
    expect(mockDirectQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        select: "id",
        filters: { id: "like.a501c95e%" },
        limit: 2,
      }),
    );

    // Check directPatch used the resolved full UUID
    expect(mockDirectPatch).toHaveBeenCalledWith(
      expect.any(String),
      { id: `eq.${FULL_UUID}` },
      expect.objectContaining({ is_active: false }),
    );
  });

  it("resolves 4-char prefix", async () => {
    mockDirectQuery.mockResolvedValueOnce([{ id: FULL_UUID }]);

    const result = await archiveLearning({ id: "a501" });
    expect(result.success).toBe(true);
    expect(result.id).toBe(FULL_UUID);
    expect(mockDirectQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filters: { id: "like.a501%" },
      }),
    );
  });

  it("returns error when no matches found", async () => {
    mockDirectQuery.mockResolvedValueOnce([]);

    const result = await archiveLearning({ id: "deadbeef" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No learning found with ID prefix");
  });

  it("returns error on ambiguous prefix", async () => {
    mockDirectQuery.mockResolvedValueOnce([
      { id: "a501c95e-1111-1111-1111-111111111111" },
      { id: "a501c95e-2222-2222-2222-222222222222" },
    ]);

    const result = await archiveLearning({ id: "a501c95e" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Ambiguous prefix");
    expect(result.error).toContain("a501c95e-111");
    expect(result.error).toContain("a501c95e-222");
  });

  // --- Display: shows resolution ---

  it("shows resolution in display when prefix differs from full UUID", async () => {
    mockDirectQuery.mockResolvedValueOnce([{ id: FULL_UUID }]);

    const result = await archiveLearning({ id: "a501c95e" });
    expect(result.success).toBe(true);
    expect(result.display).toContain("a501c95e →");
    expect(result.display).toContain(FULL_UUID);
  });

  it("does not show resolution arrow for full UUID", async () => {
    const result = await archiveLearning({ id: FULL_UUID });
    expect(result.success).toBe(true);
    expect(result.display).not.toContain("→");
  });

  // --- Local storage path ---

  it("resolves prefix via local storage when Supabase unavailable", async () => {
    vi.mocked(hasSupabase).mockReturnValue(false);

    mockStorageQuery.mockResolvedValueOnce([
      { id: FULL_UUID, title: "test scar", is_active: true },
    ]);
    mockStorageGet.mockResolvedValueOnce({ id: FULL_UUID, title: "test scar", is_active: true });

    const result = await archiveLearning({ id: "a501c95e" });
    expect(result.success).toBe(true);
    expect(result.id).toBe(FULL_UUID);

    // Should have queried local storage
    expect(mockStorageQuery).toHaveBeenCalledWith("learnings", {});
    // Should NOT have called directQuery
    expect(mockDirectQuery).not.toHaveBeenCalled();
  });

  it("returns not-found from local storage when prefix has no match", async () => {
    vi.mocked(hasSupabase).mockReturnValue(false);
    mockStorageQuery.mockResolvedValueOnce([
      { id: "bbbb1111-0000-0000-0000-000000000000" },
    ]);

    const result = await archiveLearning({ id: "aaaa" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No learning found");
  });

  // --- Reason passthrough ---

  it("includes reason in result", async () => {
    const result = await archiveLearning({ id: FULL_UUID, reason: "superseded" });
    expect(result.success).toBe(true);
    expect(result.reason).toBe("superseded");
    expect(result.display).toContain("superseded");
  });
});
