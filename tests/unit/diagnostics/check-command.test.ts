/**
 * Unit tests for check command argument parsing
 *
 *
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "../../../src/commands/check.js";

describe("parseArgs", () => {
  it("defaults to quick mode", () => {
    const options = parseArgs([]);
    expect(options.full).toBe(false);
    expect(options.output).toBeUndefined();
  });

  it("parses --full flag", () => {
    const options = parseArgs(["--full"]);
    expect(options.full).toBe(true);
  });

  it("parses -f short flag", () => {
    const options = parseArgs(["-f"]);
    expect(options.full).toBe(true);
  });

  it("parses --output option", () => {
    const options = parseArgs(["--output", "report.json"]);
    expect(options.output).toBe("report.json");
  });

  it("parses -o short option", () => {
    const options = parseArgs(["-o", "my-report.json"]);
    expect(options.output).toBe("my-report.json");
  });

  it("parses combined flags", () => {
    const options = parseArgs(["--full", "--output", "full-report.json"]);
    expect(options.full).toBe(true);
    expect(options.output).toBe("full-report.json");
  });

  it("handles flags in any order", () => {
    const options = parseArgs(["-o", "report.json", "-f"]);
    expect(options.full).toBe(true);
    expect(options.output).toBe("report.json");
  });

  it("ignores unknown flags", () => {
    const options = parseArgs(["--unknown", "--full"]);
    expect(options.full).toBe(true);
  });
});
