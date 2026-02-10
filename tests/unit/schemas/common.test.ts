/**
 * Unit tests for common schemas
 */

import { describe, it, expect } from "vitest";
import {
  ProjectSchema,
  AgentIdentitySchema,
  LearningTypeSchema,
  ScarSeveritySchema,
  CloseTypeSchema,
  ReferenceTypeSchema,
  ISOTimestampSchema,
  UUIDSchema,
  NonEmptyStringSchema,
  PositiveIntSchema,
  NonNegativeIntSchema,
} from "../../../src/schemas/common.js";

describe("ProjectSchema", () => {
  it("accepts default", () => {
    expect(ProjectSchema.safeParse("default").success).toBe(true);
  });

  it("accepts other-project", () => {
    expect(ProjectSchema.safeParse("other-project").success).toBe(true);
  });

  it("accepts any string as project", () => {
    expect(ProjectSchema.safeParse("invalid_project").success).toBe(true);
    expect(ProjectSchema.safeParse("custom_project").success).toBe(true);
  });

  it("rejects non-string project", () => {
    expect(ProjectSchema.safeParse(123).success).toBe(false);
  });
});

describe("AgentIdentitySchema", () => {
  const validAgents = ["CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud", "Unknown"];

  it.each(validAgents)("accepts %s", (agent) => {
    expect(AgentIdentitySchema.safeParse(agent).success).toBe(true);
  });

  it("rejects invalid agent", () => {
    expect(AgentIdentitySchema.safeParse("InvalidAgent").success).toBe(false);
  });
});

describe("LearningTypeSchema", () => {
  it.each(["scar", "win", "pattern"])("accepts %s", (type) => {
    expect(LearningTypeSchema.safeParse(type).success).toBe(true);
  });

  it("rejects invalid type", () => {
    expect(LearningTypeSchema.safeParse("lesson").success).toBe(false);
  });
});

describe("ScarSeveritySchema", () => {
  it.each(["critical", "high", "medium", "low"])("accepts %s", (severity) => {
    expect(ScarSeveritySchema.safeParse(severity).success).toBe(true);
  });

  it("rejects invalid severity", () => {
    expect(ScarSeveritySchema.safeParse("urgent").success).toBe(false);
  });
});

describe("CloseTypeSchema", () => {
  it.each(["standard", "quick", "autonomous", "retroactive"])("accepts %s", (type) => {
    expect(CloseTypeSchema.safeParse(type).success).toBe(true);
  });

  it("rejects invalid close type", () => {
    expect(CloseTypeSchema.safeParse("emergency").success).toBe(false);
  });
});

describe("ReferenceTypeSchema", () => {
  it.each(["explicit", "implicit", "acknowledged", "refuted", "none"])("accepts %s", (type) => {
    expect(ReferenceTypeSchema.safeParse(type).success).toBe(true);
  });

  it("rejects invalid reference type", () => {
    expect(ReferenceTypeSchema.safeParse("mentioned").success).toBe(false);
  });
});

describe("ISOTimestampSchema", () => {
  it("accepts valid ISO timestamp", () => {
    expect(ISOTimestampSchema.safeParse("2026-02-03T10:00:00Z").success).toBe(true);
  });

  it("accepts timestamp with milliseconds", () => {
    expect(ISOTimestampSchema.safeParse("2026-02-03T10:00:00.123Z").success).toBe(true);
  });

  it("accepts timestamp with timezone offset", () => {
    expect(ISOTimestampSchema.safeParse("2026-02-03T10:00:00+05:00").success).toBe(true);
  });

  it("rejects invalid timestamp", () => {
    expect(ISOTimestampSchema.safeParse("not-a-date").success).toBe(false);
  });

  it("accepts date-only string (JavaScript Date accepts YYYY-MM-DD)", () => {
    // Note: JavaScript's Date() constructor accepts "2026-02-03" as valid
    // It parses to midnight UTC. This is expected behavior.
    expect(ISOTimestampSchema.safeParse("2026-02-03").success).toBe(true);
  });
});

describe("UUIDSchema", () => {
  it("accepts valid UUID", () => {
    expect(UUIDSchema.safeParse("123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
  });

  it("rejects invalid UUID", () => {
    expect(UUIDSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("rejects short UUID", () => {
    expect(UUIDSchema.safeParse("123e4567-e89b-12d3-a456").success).toBe(false);
  });
});

describe("NonEmptyStringSchema", () => {
  it("accepts non-empty string", () => {
    expect(NonEmptyStringSchema.safeParse("hello").success).toBe(true);
  });

  it("accepts single character", () => {
    expect(NonEmptyStringSchema.safeParse("x").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(NonEmptyStringSchema.safeParse("").success).toBe(false);
  });
});

describe("PositiveIntSchema", () => {
  it("accepts positive integer", () => {
    expect(PositiveIntSchema.safeParse(5).success).toBe(true);
  });

  it("accepts 1", () => {
    expect(PositiveIntSchema.safeParse(1).success).toBe(true);
  });

  it("rejects zero", () => {
    expect(PositiveIntSchema.safeParse(0).success).toBe(false);
  });

  it("rejects negative", () => {
    expect(PositiveIntSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects float", () => {
    expect(PositiveIntSchema.safeParse(3.5).success).toBe(false);
  });
});

describe("NonNegativeIntSchema", () => {
  it("accepts positive integer", () => {
    expect(NonNegativeIntSchema.safeParse(5).success).toBe(true);
  });

  it("accepts zero", () => {
    expect(NonNegativeIntSchema.safeParse(0).success).toBe(true);
  });

  it("rejects negative", () => {
    expect(NonNegativeIntSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects float", () => {
    expect(NonNegativeIntSchema.safeParse(3.5).success).toBe(false);
  });
});
