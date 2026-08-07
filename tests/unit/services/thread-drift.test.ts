/**
 * Unit tests for Thread Drift Detection (GIT-69 item 2)
 *
 * Pure function tests — no mocks, no I/O.
 *
 * The governing case is ad5ca35a: cache-health reported healthy while two
 * threads were divergent. These assert that a divergence of any kind is
 * detectable, and — equally — that the detector does not manufacture drift
 * from the local cache's lack of project partitioning.
 */

import { describe, it, expect } from "vitest";
import {
  diffThreads,
  describeThreadDrift,
} from "../../../src/services/thread-drift.js";

describe("diffThreads()", () => {
  it("reports in sync when both stores agree", () => {
    const both = [
      { id: "t-aaaa1111", status: "open" },
      { id: "t-bbbb2222", status: "open" },
    ];
    const drift = diffThreads(both, both);

    expect(drift.in_sync).toBe(true);
    expect(drift.drift_count).toBe(0);
    expect(drift.in_sync_count).toBe(2);
  });

  it("detects a status disagreement on a thread both stores hold", () => {
    // The ad5ca35a shape: same thread, different state, counts identical.
    const local = [{ id: "t-aaaa1111", status: "open" }];
    const remote = [{ id: "t-aaaa1111", status: "resolved" }];

    const drift = diffThreads(local, remote);

    expect(drift.in_sync).toBe(false);
    expect(drift.drift_count).toBe(1);
    expect(drift.divergent).toEqual([
      { id: "t-aaaa1111", local_status: "open", remote_status: "resolved" },
    ]);
  });

  it("catches divergence that equal counts would hide", () => {
    // Both stores hold exactly 2 threads. A count-parity check calls this
    // healthy — which is precisely the reported defect.
    const local = [
      { id: "t-aaaa1111", status: "open" },
      { id: "t-bbbb2222", status: "open" },
    ];
    const remote = [
      { id: "t-aaaa1111", status: "resolved" },
      { id: "t-bbbb2222", status: "open" },
    ];

    expect(local.length).toBe(remote.length);
    expect(diffThreads(local, remote).in_sync).toBe(false);
  });

  it("reports a remote thread missing locally as drift", () => {
    const drift = diffThreads([], [{ id: "t-cccc3333", status: "open" }]);

    expect(drift.only_remote).toEqual(["t-cccc3333"]);
    expect(drift.drift_count).toBe(1);
    expect(drift.in_sync).toBe(false);
  });
});

describe("local cache is not project-partitioned", () => {
  it("does NOT count a local-only thread as drift", () => {
    // ThreadObject has no project field, so a local thread absent from this
    // project's remote scope may simply belong to another project. Calling it
    // drift would be false drift, and a detector that cries wolf trains its
    // reader to ignore the real signal.
    const local = [
      { id: "t-aaaa1111", status: "open" },
      { id: "t-wwww9999", status: "open" }, // weekend_warrior, say
    ];
    const remote = [{ id: "t-aaaa1111", status: "open" }];

    const drift = diffThreads(local, remote);

    expect(drift.unattributable_local).toEqual(["t-wwww9999"]);
    expect(drift.drift_count).toBe(0);
    expect(drift.in_sync).toBe(true);
  });

  it("still reports genuine drift alongside unattributable locals", () => {
    const local = [
      { id: "t-aaaa1111", status: "open" },
      { id: "t-wwww9999", status: "open" },
    ];
    const remote = [
      { id: "t-aaaa1111", status: "resolved" },
      { id: "t-cccc3333", status: "open" },
    ];

    const drift = diffThreads(local, remote);

    expect(drift.divergent.map((d) => d.id)).toEqual(["t-aaaa1111"]);
    expect(drift.only_remote).toEqual(["t-cccc3333"]);
    expect(drift.unattributable_local).toEqual(["t-wwww9999"]);
    expect(drift.drift_count).toBe(2); // unattributable excluded
  });
});

describe("edge cases", () => {
  it("treats both stores empty as in sync", () => {
    const drift = diffThreads([], []);
    expect(drift.in_sync).toBe(true);
    expect(drift.in_sync_count).toBe(0);
  });

  it("does not flag divergence when a status is unknown on either side", () => {
    // Absent status means "not compared", not "disagrees".
    expect(diffThreads([{ id: "t-a" }], [{ id: "t-a", status: "open" }]).in_sync).toBe(true);
    expect(diffThreads([{ id: "t-a", status: "open" }], [{ id: "t-a" }]).in_sync).toBe(true);
  });

  it("ignores entries with no id rather than crashing", () => {
    const drift = diffThreads([{ id: "", status: "open" }], []);
    expect(drift.drift_count).toBe(0);
    expect(drift.unattributable_local).toEqual([]);
  });

  it("produces deterministic ordering", () => {
    const local = [
      { id: "t-cccc", status: "open" },
      { id: "t-aaaa", status: "open" },
      { id: "t-bbbb", status: "open" },
    ];
    const remote = [
      { id: "t-cccc", status: "resolved" },
      { id: "t-aaaa", status: "resolved" },
      { id: "t-bbbb", status: "resolved" },
    ];

    const first = diffThreads(local, remote);
    const second = diffThreads([...local].reverse(), [...remote].reverse());

    expect(first.divergent.map((d) => d.id)).toEqual(["t-aaaa", "t-bbbb", "t-cccc"]);
    expect(first).toEqual(second);
  });
});

describe("three-valued status (R9a) — healthy is earned, never defaulted", () => {
  it("is healthy only with full attribution AND no divergence", () => {
    const both = [{ id: "t-a", status: "open" }];
    expect(diffThreads(both, both).status).toBe("healthy");
  });

  it("is unverifiable when nothing diverges but something is unattributable", () => {
    // The state binary status has no room for: no known divergence, but the
    // check did not complete. Green here would be a completeness claim over an
    // incomplete check.
    const drift = diffThreads(
      [
        { id: "t-a", status: "open" },
        { id: "t-w", status: "open" },
      ],
      [{ id: "t-a", status: "open" }]
    );

    expect(drift.drift_count).toBe(0);
    expect(drift.in_sync).toBe(true);
    expect(drift.status).toBe("unverifiable");
  });

  it("is drift when divergence is known", () => {
    const drift = diffThreads(
      [{ id: "t-a", status: "open" }],
      [{ id: "t-a", status: "resolved" }]
    );
    expect(drift.status).toBe("drift");
  });

  it("reports drift over unverifiable when both apply", () => {
    // Known divergence is the stronger claim — it must not be masked by the
    // weaker one.
    const drift = diffThreads(
      [
        { id: "t-a", status: "open" },
        { id: "t-w", status: "open" },
      ],
      [{ id: "t-a", status: "resolved" }]
    );

    expect(drift.unattributable_local).toEqual(["t-w"]);
    expect(drift.status).toBe("drift");
  });

  it("never returns healthy while any bucket is non-empty", () => {
    const cases = [
      diffThreads([{ id: "t-a", status: "open" }], [{ id: "t-a", status: "resolved" }]),
      diffThreads([], [{ id: "t-c", status: "open" }]),
      diffThreads([{ id: "t-w", status: "open" }], []),
    ];
    for (const drift of cases) {
      expect(drift.status).not.toBe("healthy");
    }
  });
});

describe("describeThreadDrift()", () => {
  it("states plain agreement when there is nothing to disclose", () => {
    const drift = diffThreads(
      [{ id: "t-a", status: "open" }],
      [{ id: "t-a", status: "open" }]
    );
    expect(describeThreadDrift(drift)).toBe("threads healthy (1 compared, all attributed)");
  });

  it("names the unattributable count even though it is not drift", () => {
    // An omitted number reads as zero. The reader cannot otherwise tell
    // "no local extras" from "local extras I declined to classify".
    const drift = diffThreads(
      [
        { id: "t-a", status: "open" },
        { id: "t-w", status: "open" },
      ],
      [{ id: "t-a", status: "open" }]
    );

    expect(drift.in_sync).toBe(true);
    const text = describeThreadDrift(drift);
    // R9a: count AND reason in the status line itself.
    expect(text).toContain("unverifiable");
    expect(text).toContain("1 unattributable");
    expect(text).toContain("no project field");
  });

  it("names each drift kind separately", () => {
    const drift = diffThreads(
      [{ id: "t-a", status: "open" }],
      [
        { id: "t-a", status: "resolved" },
        { id: "t-c", status: "open" },
      ]
    );
    const text = describeThreadDrift(drift);

    expect(text).toContain("1 divergent");
    expect(text).toContain("1 missing locally");
  });
});
