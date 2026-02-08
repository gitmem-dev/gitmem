/**
 * Unit tests for record_scar_usage and record_scar_usage_batch schemas
 */

import { describe, it, expect } from "vitest";
import {
  RecordScarUsageParamsSchema,
  validateRecordScarUsageParams,
} from "../../../src/schemas/record-scar-usage.js";
import {
  RecordScarUsageBatchParamsSchema,
  validateRecordScarUsageBatchParams,
} from "../../../src/schemas/record-scar-usage-batch.js";

describe("RecordScarUsageParamsSchema", () => {
  const validUUID = "123e4567-e89b-12d3-a456-426614174000";
  const validTimestamp = "2026-02-03T10:00:00Z";

  describe("valid inputs", () => {
    it("accepts minimal valid params", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        surfaced_at: validTimestamp,
        reference_type: "acknowledged",
        reference_context: "Applied during deployment",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        issue_id: "issue-123",
        issue_identifier: "OD-123",
        session_id: "session-123",
        agent: "CLI",
        surfaced_at: validTimestamp,
        acknowledged_at: "2026-02-03T10:01:00Z",
        reference_type: "explicit",
        reference_context: "Used in deployment",
        execution_successful: true,
      });
      expect(result.success).toBe(true);
    });

    it("accepts all reference types", () => {
      const types = ["explicit", "implicit", "acknowledged", "refuted", "none"];
      for (const reference_type of types) {
        const result = RecordScarUsageParamsSchema.safeParse({
          scar_id: validUUID,
          surfaced_at: validTimestamp,
          reference_type,
          reference_context: "Context",
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("required params missing", () => {
    it("rejects missing scar_id", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        surfaced_at: validTimestamp,
        reference_type: "acknowledged",
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing surfaced_at", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        reference_type: "acknowledged",
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing reference_type", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        surfaced_at: validTimestamp,
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid UUID for scar_id", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: "not-a-uuid",
        surfaced_at: validTimestamp,
        reference_type: "acknowledged",
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain("UUID");
    });

    it("rejects invalid timestamp", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        surfaced_at: "invalid-date",
        reference_type: "acknowledged",
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid reference_type", () => {
      const result = RecordScarUsageParamsSchema.safeParse({
        scar_id: validUUID,
        surfaced_at: validTimestamp,
        reference_type: "invalid",
        reference_context: "Context",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("RecordScarUsageBatchParamsSchema", () => {
  const validEntry = {
    scar_identifier: "test-scar",
    surfaced_at: "2026-02-03T10:00:00Z",
    reference_type: "acknowledged" as const,
    reference_context: "Context",
  };

  describe("valid inputs", () => {
    it("accepts single entry", () => {
      const result = RecordScarUsageBatchParamsSchema.safeParse({
        scars: [validEntry],
      });
      expect(result.success).toBe(true);
    });

    it("accepts multiple entries", () => {
      const result = RecordScarUsageBatchParamsSchema.safeParse({
        scars: [validEntry, { ...validEntry, scar_identifier: "scar-2" }],
        project: "orchestra_dev",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required params missing", () => {
    it("rejects missing scars", () => {
      const result = RecordScarUsageBatchParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty scars array", () => {
      const result = RecordScarUsageBatchParamsSchema.safeParse({
        scars: [],
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain("cannot be empty");
    });
  });

  describe("validateRecordScarUsageBatchParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateRecordScarUsageBatchParams({
        scars: [validEntry],
      });
      expect(result.success).toBe(true);
    });

    it("returns error for empty array", () => {
      const result = validateRecordScarUsageBatchParams({ scars: [] });
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });
  });
});
