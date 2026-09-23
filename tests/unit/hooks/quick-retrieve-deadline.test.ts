/**
 * GIT-116: quick-retrieve bounds its own run. The hook used to wrap it in
 * `timeout 2.5`, which macOS does not ship, so on a stock Mac nothing was
 * ever retrieved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { armDeadline, QUICK_RETRIEVE_DEADLINE_MS } from "../../../src/hooks/quick-retrieve.js";

afterEach(() => { vi.useRealTimers(); });

describe("quick-retrieve deadline (GIT-116)", () => {
  it("fires after the budget and not before", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    armDeadline(100, expire);
    vi.advanceTimersByTime(99);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("does not keep a finished run alive (unref'd)", () => {
    const timer = armDeadline(60_000, () => {});
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });

  it("leaves 500 ms of the hook's 3 s budget", () => {
    expect(QUICK_RETRIEVE_DEADLINE_MS).toBe(2500);
  });

  it("no hook script calls timeout/gtimeout any more", () => {
    const dir = path.resolve(__dirname, "../../../hooks/scripts");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
      const code = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter((l) => !l.trim().startsWith("#"));
      expect(code.filter((l) => /(^|[\s;(|&`$])g?timeout\s+[0-9]/.test(l)), f).toEqual([]);
    }
  });
});
