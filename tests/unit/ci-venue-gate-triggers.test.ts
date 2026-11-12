/**
 * GIT-135: the venue gate must run between releases, and only a v* tag may publish.
 *
 * v1.11.3 never reached npm: its tag run failed in venue-gate because the venue
 * project had been paused, and nothing had run the gate since the previous
 * release. These checks keep the scheduled trigger and the job conditions from
 * drifting. Plain text checks: the repo has no direct YAML dependency.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ci = readFileSync(join(__dirname, "../../.github/workflows/ci.yml"), "utf8");

/** The text of one top-level job, from its header to the next job header. */
function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} not found in ci.yml`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function ifLine(jobText: string): string {
  const m = jobText.match(/^    if: (.+)$/m);
  expect(m, "job has no if: line").not.toBeNull();
  return m![1];
}

describe("ci.yml venue gate triggers (GIT-135)", () => {
  it("has a schedule trigger that runs at least weekly", () => {
    const m = ci.match(/^  schedule:\n((?:\s+- cron: .+\n)+)/m);
    expect(m, "no schedule: trigger under on:").not.toBeNull();
    const crons = [...m![1].matchAll(/cron: '([^']+)'/g)].map((c) => c[1]);
    expect(crons.length).toBeGreaterThan(0);
    // Day-of-week field must name specific days (or *), not be a monthly schedule.
    for (const c of crons) {
      const [, , dom, month] = c.split(/\s+/);
      expect(dom, `cron ${c} pins a day of month`).toBe("*");
      expect(month, `cron ${c} pins a month`).toBe("*");
    }
  });

  it("runs venue-gate on a schedule, a manual dispatch and a v* tag", () => {
    const cond = ifLine(job("venue-gate"));
    expect(cond).toContain("github.event_name == 'schedule'");
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it("publishes only on a v* tag, never on a schedule or dispatch", () => {
    const pub = job("publish");
    expect(ifLine(pub)).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(pub).toMatch(/needs: \[[^\]]*venue-gate[^\]]*\]/);
  });
});
