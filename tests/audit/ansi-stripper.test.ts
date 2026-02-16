import { describe, it, expect } from "vitest";
import { stripAnsi, cleanLine } from "../../scripts/audit/ansi-stripper.js";

describe("stripAnsi", () => {
  it("removes CSI color codes", () => {
    expect(stripAnsi("\x1b[1;33mhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[0;34mblue\x1b[0m")).toBe("blue");
  });

  it("removes CSI cursor movement", () => {
    expect(stripAnsi("\x1b[2Amove up")).toBe("move up");
    expect(stripAnsi("\x1b[10Bmove down")).toBe("move down");
    expect(stripAnsi("\x1b[?25lhide cursor")).toBe("hide cursor");
  });

  it("removes OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07content")).toBe("content");
    expect(stripAnsi("\x1b]0;title\x1b\\content")).toBe("content");
  });

  it("removes 2-char ESC sequences", () => {
    expect(stripAnsi("\x1b(Btext")).toBe("text");
  });

  it("removes carriage returns", () => {
    expect(stripAnsi("hello\r\nworld")).toBe("hello\nworld");
  });

  it("handles text without ANSI codes", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles multiple codes in sequence", () => {
    expect(
      stripAnsi("\x1b[1;33m\x1b[0;34mtext\x1b[0m")
    ).toBe("text");
  });
});

describe("cleanLine", () => {
  it("returns cleaned text for normal lines", () => {
    expect(cleanLine("hello world")).toBe("hello world");
  });

  it("returns null for empty lines", () => {
    expect(cleanLine("")).toBeNull();
    expect(cleanLine("   ")).toBeNull();
  });

  it("returns null for spinner characters", () => {
    expect(cleanLine("\u2722")).toBeNull();
    expect(cleanLine("*")).toBeNull();
    expect(cleanLine("\u00B7")).toBeNull();
  });

  it("returns null for decoration lines", () => {
    expect(cleanLine("─────────")).toBeNull();
    expect(cleanLine("═══════")).toBeNull();
    expect(cleanLine("----------")).toBeNull();
  });

  it("strips ANSI and returns content", () => {
    expect(cleanLine("\x1b[1;33mhello\x1b[0m")).toBe("hello");
  });
});
