import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  parseCastHeader,
  parseCastEntry,
  streamCastFile,
} from "../../scripts/audit/cast-parser.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("parseCastHeader", () => {
  it("parses v3 header", () => {
    const header = parseCastHeader(
      '{"version":3,"term":{"cols":120,"rows":40},"timestamp":1771200000}'
    );
    expect(header.version).toBe(3);
    expect(header.term.cols).toBe(120);
    expect(header.term.rows).toBe(40);
    expect(header.timestamp).toBe(1771200000);
  });

  it("rejects unsupported versions", () => {
    expect(() =>
      parseCastHeader('{"version":1,"term":{"cols":80,"rows":24}}')
    ).toThrow("Unsupported cast version");
  });
});

describe("parseCastEntry", () => {
  it("parses output entry", () => {
    const entry = parseCastEntry('[1.5, "o", "hello\\n"]');
    expect(entry).toEqual({
      timestamp: 1.5,
      eventType: "o",
      text: "hello\n",
    });
  });

  it("parses input entry", () => {
    const entry = parseCastEntry('[2.0, "i", "q"]');
    expect(entry).toEqual({
      timestamp: 2.0,
      eventType: "i",
      text: "q",
    });
  });

  it("returns null for malformed lines", () => {
    expect(parseCastEntry("not json")).toBeNull();
    expect(parseCastEntry("[]")).toBeNull();
    expect(parseCastEntry("[1]")).toBeNull();
  });
});

describe("streamCastFile", () => {
  it("streams minimal.cast file", async () => {
    const items: unknown[] = [];
    for await (const item of streamCastFile(join(FIXTURES, "minimal.cast"))) {
      items.push(item);
    }

    // First item is header
    expect(items[0]).toHaveProperty("header");
    const header = (items[0] as { header: { version: number } }).header;
    expect(header.version).toBe(3);

    // Remaining items are output entries (only "o" type)
    const entries = items.slice(1);
    expect(entries.length).toBeGreaterThan(0);

    // All entries should have timestamps
    for (const entry of entries) {
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("text");
    }
  });

  it("yields only output entries (filters input)", async () => {
    const items: unknown[] = [];
    for await (const item of streamCastFile(join(FIXTURES, "minimal.cast"))) {
      items.push(item);
    }

    const entries = items.slice(1);
    for (const entry of entries) {
      expect((entry as { eventType: string }).eventType).toBe("o");
    }
  });
});
