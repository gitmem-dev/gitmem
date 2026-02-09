import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";

// Mock fs before importing timezone module
vi.mock("fs");

// Mock gitmem-dir to control config path
vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: vi.fn((filename: string) => `/tmp/test-gitmem/${filename}`),
}));

import {
  formatDate,
  formatTimestamp,
  formatThreadForDisplay,
  getTimezone,
  resetTimezone,
} from "../../../src/services/timezone.js";

describe("timezone service", () => {
  beforeEach(() => {
    resetTimezone();
    delete process.env.TZ;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue("");
  });

  describe("getTimezone", () => {
    it("defaults to UTC when no config exists", () => {
      expect(getTimezone()).toBe("UTC");
    });

    it("reads from config.json when present", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      expect(getTimezone()).toBe("America/New_York");
    });

    it("falls back to TZ env var when no config file", () => {
      process.env.TZ = "Europe/London";
      expect(getTimezone()).toBe("Europe/London");
    });

    it("config.json takes precedence over TZ env var", () => {
      process.env.TZ = "Europe/London";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      expect(getTimezone()).toBe("America/New_York");
    });

    it("rejects invalid timezone names gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "Not/A/Timezone" })
      );
      expect(getTimezone()).toBe("UTC");
    });

    it("caches after first load", () => {
      getTimezone();
      getTimezone();
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledTimes(1);
    });
  });

  describe("formatDate", () => {
    it("returns original string when timezone is UTC", () => {
      expect(formatDate("2026-02-09")).toBe("2026-02-09");
    });

    it("formats when timezone is configured", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      const result = formatDate("2026-02-09");
      expect(result).toBe("Feb 9, 2026");
    });

    it("handles empty string gracefully", () => {
      expect(formatDate("")).toBe("");
    });

    it("handles short/invalid strings gracefully", () => {
      expect(formatDate("bad")).toBe("bad");
    });
  });

  describe("formatTimestamp", () => {
    it("returns original string when timezone is UTC", () => {
      const iso = "2026-02-09T18:45:00.000Z";
      expect(formatTimestamp(iso)).toBe(iso);
    });

    it("formats to local timezone when configured", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      const result = formatTimestamp("2026-02-09T18:45:00.000Z");
      // 18:45 UTC = 1:45 PM EST
      expect(result).toMatch(/Feb 9, 2026/);
      expect(result).toMatch(/1:45/);
      expect(result).toMatch(/PM/);
    });

    it("handles empty string gracefully", () => {
      expect(formatTimestamp("")).toBe("");
    });

    it("handles invalid ISO strings gracefully", () => {
      expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    });
  });

  describe("formatThreadForDisplay", () => {
    it("returns same reference when timezone is UTC", () => {
      const thread = {
        id: "t-abcd1234",
        text: "Test thread",
        status: "open" as const,
        created_at: "2026-02-09T18:45:00.000Z",
      };
      expect(formatThreadForDisplay(thread)).toBe(thread);
    });

    it("formats created_at when timezone configured", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      const thread = {
        id: "t-abcd1234",
        text: "Test thread",
        status: "open" as const,
        created_at: "2026-02-09T18:45:00.000Z",
      };
      const result = formatThreadForDisplay(thread);
      expect(result.created_at).toMatch(/Feb 9, 2026/);
      expect(result).not.toBe(thread); // New object
    });

    it("formats resolved_at when present and timezone configured", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      const thread = {
        id: "t-abcd1234",
        text: "Test thread",
        status: "resolved" as const,
        created_at: "2026-02-09T18:45:00.000Z",
        resolved_at: "2026-02-09T20:00:00.000Z",
      };
      const result = formatThreadForDisplay(thread);
      expect(result.created_at).toMatch(/Feb 9, 2026/);
      expect(result.resolved_at).toMatch(/Feb 9, 2026/);
      expect(result.resolved_at).toMatch(/3:00/); // 20:00 UTC = 3:00 PM EST
    });

    it("does not add resolved_at when not present", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timezone: "America/New_York" })
      );
      const thread = {
        id: "t-abcd1234",
        text: "Test thread",
        status: "open" as const,
        created_at: "2026-02-09T18:45:00.000Z",
      };
      const result = formatThreadForDisplay(thread);
      expect(result.resolved_at).toBeUndefined();
    });
  });
});
