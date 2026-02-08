/**
 * Recall Benchmarks
 *
 * Benchmarks for recall operation latency with varying scar counts.
 * Tests local vector search performance.
 */

import { bench, describe, beforeAll } from "vitest";
import { BASELINES } from "./baselines.js";

// Generate mock scars with embeddings for local search benchmarks
function generateMockScars(count: number): Array<{
  id: string;
  title: string;
  description: string;
  severity: string;
  embedding: number[];
}> {
  return Array.from({ length: count }, (_, i) => ({
    id: `scar-${i}`,
    title: `Test Scar ${i}`,
    description: `Description for test scar ${i}. This contains enough text to simulate realistic scar descriptions.`,
    severity: ["critical", "high", "medium", "low"][i % 4],
    embedding: generateRandomVector(1536),
  }));
}

// Generate a random unit vector
function generateRandomVector(dimensions: number): number[] {
  const vector: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    vector.push(Math.random() * 2 - 1);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / magnitude);
}

// Cosine similarity for local search
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  return dotProduct; // Vectors are already normalized
}

// Local vector search implementation
function localVectorSearch(
  queryEmbedding: number[],
  scars: Array<{ id: string; embedding: number[] }>,
  topK: number
): Array<{ id: string; similarity: number }> {
  const scored = scars.map((scar) => ({
    id: scar.id,
    similarity: cosineSimilarity(queryEmbedding, scar.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

describe("Recall - Local Vector Search", () => {
  let scars15: ReturnType<typeof generateMockScars>;
  let scars100: ReturnType<typeof generateMockScars>;
  let scars500: ReturnType<typeof generateMockScars>;
  let scars1000: ReturnType<typeof generateMockScars>;
  let queryEmbedding: number[];

  beforeAll(() => {
    // Pre-generate test data
    scars15 = generateMockScars(15);
    scars100 = generateMockScars(100);
    scars500 = generateMockScars(500);
    scars1000 = generateMockScars(1000);
    queryEmbedding = generateRandomVector(1536);
  });

  bench(
    "vector search - 15 scars (starter)",
    () => {
      localVectorSearch(queryEmbedding, scars15, 5);
    },
    {
      time: 2000,
      iterations: 1000,
    }
  );

  bench(
    "vector search - 100 scars (small)",
    () => {
      localVectorSearch(queryEmbedding, scars100, 5);
    },
    {
      time: 2000,
      iterations: 500,
    }
  );

  bench(
    "vector search - 500 scars (medium)",
    () => {
      localVectorSearch(queryEmbedding, scars500, 5);
    },
    {
      time: 3000,
      iterations: 100,
    }
  );

  bench(
    "vector search - 1000 scars (large)",
    () => {
      localVectorSearch(queryEmbedding, scars1000, 5);
    },
    {
      time: 3000,
      iterations: 50,
    }
  );
});

describe("Recall - Embedding Generation (simulated)", () => {
  // Simulate the cost of embedding generation
  // In production, this would be an API call to OpenAI/OpenRouter

  bench(
    "embedding text preparation",
    () => {
      const text = "Check deployment verification before marking as done";
      const prepared = text.toLowerCase().trim();
      const tokens = prepared.split(/\s+/);
    },
    {
      time: 1000,
      iterations: 10000,
    }
  );

  bench(
    "similarity score calculation",
    () => {
      const a = generateRandomVector(1536);
      const b = generateRandomVector(1536);
      cosineSimilarity(a, b);
    },
    {
      time: 2000,
      iterations: 1000,
    }
  );
});

describe("Recall - Full Flow Simulation", () => {
  let scars500: ReturnType<typeof generateMockScars>;

  beforeAll(() => {
    scars500 = generateMockScars(500);
  });

  bench(
    "recall full flow - 500 scars, top 5",
    () => {
      // Simulate full recall flow
      // 1. Prepare query text
      const query = "deployment verification process";
      const preparedQuery = query.toLowerCase().trim();

      // 2. Generate query embedding (simulated - just random vector)
      const queryEmbedding = generateRandomVector(1536);

      // 3. Local vector search
      const results = localVectorSearch(queryEmbedding, scars500, 5);

      // 4. Format results
      const formatted = results.map((r) => ({
        id: r.id,
        similarity: r.similarity.toFixed(3),
      }));

      return formatted;
    },
    {
      time: 5000,
      iterations: 50,
    }
  );
});
