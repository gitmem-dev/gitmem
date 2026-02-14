/**
 * Unit tests for search_transcripts schema
 */

import { describe, it, expect } from "vitest";
import {
  SearchTranscriptsParamsSchema,
  validateSearchTranscriptsParams,
} from "../../../src/schemas/search-transcripts.js";

describe("SearchTranscriptsParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params (query only)", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "deployment verification",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "session close protocol",
        match_count: 5,
        similarity_threshold: 0.4,
        project: "orchestra_dev",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.match_count).toBe(5);
        expect(result.data.similarity_threshold).toBe(0.4);
      }
    });
  });

  describe("required params missing", () => {
    it("rejects missing query", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty query", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({ query: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("match_count validation", () => {
    it("accepts match_count of 1", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        match_count: 1,
      });
      expect(result.success).toBe(true);
    });

    it("accepts match_count of 50", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        match_count: 50,
      });
      expect(result.success).toBe(true);
    });

    it("rejects match_count of 0", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        match_count: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects match_count over 50", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        match_count: 51,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer match_count", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        match_count: 3.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("similarity_threshold validation", () => {
    it("accepts 0", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        similarity_threshold: 0,
      });
      expect(result.success).toBe(true);
    });

    it("accepts 1", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        similarity_threshold: 1,
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        similarity_threshold: -0.1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects over 1", () => {
      const result = SearchTranscriptsParamsSchema.safeParse({
        query: "test",
        similarity_threshold: 1.1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSearchTranscriptsParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateSearchTranscriptsParams({
        query: "deployment",
      });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("returns error for empty params", () => {
      const result = validateSearchTranscriptsParams({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("query");
    });

    it("returns error for invalid match_count", () => {
      const result = validateSearchTranscriptsParams({
        query: "test",
        match_count: 100,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("match_count");
    });
  });
});
