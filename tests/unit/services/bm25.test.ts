import { describe, it, expect } from "vitest";
import { bm25Search, tokenize, type BM25Document } from "../../../src/services/bm25.js";

describe("bm25", () => {
  describe("tokenize", () => {
    it("lowercases and stems tokens", () => {
      const tokens = tokenize("Deploying applications");
      // "deploying" → "deploy" (ying strip), "applications" → "applicat" (ion strip after s strip)
      expect(tokens[0]).toBe("deploy");
      expect(tokens.length).toBe(2);
    });

    it("strips punctuation", () => {
      const tokens = tokenize("don't stop! (please)");
      expect(tokens[0]).toBe("don");
      expect(tokens[1]).toBe("stop");
      expect(tokens.length).toBe(3);
    });

    it("filters single-char tokens", () => {
      const tokens = tokenize("I am a test");
      expect(tokens).toEqual(["am", "test"]);
    });
  });

  describe("bm25Search", () => {
    const docs: BM25Document[] = [
      {
        id: "1",
        fields: [
          { text: "deployment verification checklist", boost: 3 },
          { text: "deploy verify production", boost: 2 },
          { text: "Always verify deployment is running after push", boost: 1 },
        ],
      },
      {
        id: "2",
        fields: [
          { text: "database migration safety", boost: 3 },
          { text: "database migrate schema", boost: 2 },
          { text: "Run migrations with dry-run first", boost: 1 },
        ],
      },
      {
        id: "3",
        fields: [
          { text: "test coverage requirements", boost: 3 },
          { text: "test coverage unit", boost: 2 },
          { text: "Every feature needs test coverage before merge", boost: 1 },
        ],
      },
    ];

    it("returns empty for empty query", () => {
      expect(bm25Search("", docs, 5)).toEqual([]);
    });

    it("returns empty for no matches", () => {
      expect(bm25Search("quantum physics", docs, 5)).toEqual([]);
    });

    it("ranks deployment query correctly", () => {
      const results = bm25Search("deploy to production", docs, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1"); // deployment doc should rank first
    });

    it("ranks database query correctly", () => {
      const results = bm25Search("database migration", docs, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("2");
    });

    it("ranks test query correctly", () => {
      const results = bm25Search("test coverage", docs, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("3");
    });

    it("returns similarity scores between 0 and 1", () => {
      const results = bm25Search("deploy", docs, 5);
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0);
        expect(r.similarity).toBeLessThanOrEqual(1);
      }
    });

    it("top result has similarity 1.0", () => {
      const results = bm25Search("deploy", docs, 5);
      expect(results[0].similarity).toBe(1);
    });

    it("respects k limit", () => {
      const results = bm25Search("deploy database test", docs, 2);
      expect(results.length).toBe(2);
    });

    it("stemming matches morphological variants", () => {
      // "deploying" stems to "deploy", should match "deployment" (also stems to "deploy")
      const results = bm25Search("deploying", docs, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1");
    });

    it("field boost affects ranking", () => {
      // Create docs where "deploy" appears only in description (low boost) vs only in title (high boost)
      const boostDocs: BM25Document[] = [
        {
          id: "title-match",
          fields: [
            { text: "deploy checklist", boost: 3 },
            { text: "", boost: 2 },
            { text: "some unrelated description", boost: 1 },
          ],
        },
        {
          id: "desc-match",
          fields: [
            { text: "unrelated title", boost: 3 },
            { text: "", boost: 2 },
            { text: "remember to deploy carefully", boost: 1 },
          ],
        },
      ];
      const results = bm25Search("deploy", boostDocs, 5);
      expect(results[0].id).toBe("title-match");
    });

    it("IDF gives rare terms more weight", () => {
      // "verify" only appears in doc 1, so it should be a stronger signal
      // "run" appears in doc 2's description
      // All docs have common words, but rare terms distinguish
      const results = bm25Search("verify", docs, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1");
    });
  });
});
