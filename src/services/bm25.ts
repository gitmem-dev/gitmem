/**
 * BM25 Text Search — Free Tier Semantic Search Alternative
 *
 * Okapi BM25 ranking function with field boosting.
 * Significantly better than naive keyword matching:
 * - Term frequency saturation (repeated terms don't dominate)
 * - Inverse document frequency (rare terms score higher)
 * - Document length normalization (short docs don't get penalized)
 * - Stemming via Porter-like suffix stripping
 *
 * Zero dependencies. ~100 lines of actual logic.
 */

// --- BM25 Parameters ---
const K1 = 1.2;   // Term frequency saturation
const B = 0.75;    // Length normalization strength

// --- Stemming ---

/** Simple suffix-stripping stemmer. Covers ~80% of English morphology. */
function stem(word: string): string {
  if (word.length < 4) return word;

  let w = word;

  // Step 1: Normalize -ying/-ying → -y, -ies → -y, -ied → -y
  if (w.endsWith("ying") && w.length > 5) w = w.slice(0, -3);       // deploying → deploy
  else if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ied") && w.length > 4) w = w.slice(0, -3) + "y";

  // Step 2: Strip common suffixes (longest first, min 3 chars remain)
  const suffixes = [
    "ation", "ment", "ness", "ible", "able", "ious",
    "ical", "ally",
    "ing", "ion", "ous", "ity", "ful", "ess", "ant", "ent",
    "ly", "ed", "er", "es", "al",
    "s",
  ];
  for (const suffix of suffixes) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      return w.slice(0, w.length - suffix.length);
    }
  }
  return w;
}

// --- Tokenization ---

/** Tokenize and stem text. Strips punctuation, lowercases, stems. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

// --- BM25 Engine ---

export interface BM25Document {
  /** Unique ID */
  id: string;
  /** Fields to index, with boost weights. Higher boost = more important. */
  fields: { text: string; boost: number }[];
}

export interface BM25Result {
  id: string;
  score: number;
  /** Normalized score 0-1 for compatibility with similarity field */
  similarity: number;
}

/**
 * Score documents against a query using BM25 with field boosting.
 *
 * @param query - Search query text
 * @param docs - Documents to search
 * @param k - Max results to return
 * @returns Scored and ranked results
 */
export function bm25Search(
  query: string,
  docs: BM25Document[],
  k: number
): BM25Result[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];

  // Build corpus stats: document frequency per term, average doc length
  const N = docs.length;
  const docFreq = new Map<string, number>(); // term -> number of docs containing it
  const docLengths: number[] = [];

  // Pre-tokenize all docs
  const tokenizedDocs = docs.map((doc) => {
    const allTokens: { token: string; boost: number }[] = [];
    for (const field of doc.fields) {
      const tokens = tokenize(field.text);
      for (const token of tokens) {
        allTokens.push({ token, boost: field.boost });
      }
    }
    docLengths.push(allTokens.length);
    return allTokens;
  });

  const avgDl = docLengths.reduce((a, b) => a + b, 0) / N || 1;

  // Compute document frequency for query terms only
  const queryTermSet = new Set(queryTerms);
  for (const tokenized of tokenizedDocs) {
    const seen = new Set<string>();
    for (const { token } of tokenized) {
      if (queryTermSet.has(token) && !seen.has(token)) {
        seen.add(token);
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
  }

  // Score each document
  const scored: BM25Result[] = [];

  for (let i = 0; i < N; i++) {
    const tokenized = tokenizedDocs[i];
    const dl = docLengths[i];
    let totalScore = 0;

    for (const qt of queryTerms) {
      const df = docFreq.get(qt) || 0;
      if (df === 0) continue;

      // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // Term frequency with field boosting
      let tf = 0;
      for (const { token, boost } of tokenized) {
        if (token === qt) tf += boost;
      }

      if (tf === 0) continue;

      // BM25 formula
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + B * (dl / avgDl));
      totalScore += idf * (numerator / denominator);
    }

    if (totalScore > 0) {
      scored.push({ id: docs[i].id, score: totalScore, similarity: 0 });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Normalize to 0-1 similarity
  const maxScore = scored.length > 0 ? scored[0].score : 1;
  for (const result of scored) {
    result.similarity = Math.round((result.score / maxScore) * 1000) / 1000;
  }

  return scored.slice(0, k);
}
