/**
 * Unit tests for save_transcript and get_transcript schemas
 */

import { describe, it, expect } from "vitest";
import {
  SaveTranscriptParamsSchema,
  TranscriptFormatSchema,
  validateSaveTranscriptParams,
} from "../../../src/schemas/save-transcript.js";
import {
  GetTranscriptParamsSchema,
  validateGetTranscriptParams,
} from "../../../src/schemas/get-transcript.js";

describe("TranscriptFormatSchema", () => {
  it("accepts json", () => {
    expect(TranscriptFormatSchema.safeParse("json").success).toBe(true);
  });

  it("accepts markdown", () => {
    expect(TranscriptFormatSchema.safeParse("markdown").success).toBe(true);
  });

  it("rejects invalid format", () => {
    expect(TranscriptFormatSchema.safeParse("text").success).toBe(false);
  });
});

describe("SaveTranscriptParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test-session",
        transcript: "Hello, this is the transcript content",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test-session",
        transcript: "Transcript content",
        format: "json",
        project: "my-project",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required params missing", () => {
    it("rejects missing session_id", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        transcript: "Content",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing transcript", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty session_id", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "",
        transcript: "Content",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty transcript", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test",
        transcript: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid format", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test",
        transcript: "Content",
        format: "text",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = SaveTranscriptParamsSchema.safeParse({
        session_id: "test",
        transcript: "Content",
        project: 123,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSaveTranscriptParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateSaveTranscriptParams({
        session_id: "test",
        transcript: "Content",
      });
      expect(result.success).toBe(true);
    });

    it("returns error for invalid params", () => {
      const result = validateSaveTranscriptParams({});
      expect(result.success).toBe(false);
    });
  });
});

describe("GetTranscriptParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts valid session_id", () => {
      const result = GetTranscriptParamsSchema.safeParse({
        session_id: "test-session-123",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required params missing", () => {
    it("rejects missing session_id", () => {
      const result = GetTranscriptParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty session_id", () => {
      const result = GetTranscriptParamsSchema.safeParse({ session_id: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("validateGetTranscriptParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateGetTranscriptParams({ session_id: "test" });
      expect(result.success).toBe(true);
    });

    it("returns error for missing session_id", () => {
      const result = validateGetTranscriptParams({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("session_id");
    });
  });
});
