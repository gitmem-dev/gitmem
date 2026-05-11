/**
 * Document Index — Storage and search for indexed doc chunks
 *
 * Supports two backends:
 * - Free tier: Local JSON file with BM25 keyword search
 * - Pro/dev tier: In-memory vector index with embeddings
 *
 * Follows the same patterns as local-vector-search.ts and local-file-storage.ts
 */

import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { getGitmemDir } from "./gitmem-dir.js";
import { bm25Search, type BM25Document } from "./bm25.js";
import { embed as generateEmbedding, isEmbeddingAvailable } from "./embedding.js";
import { hasSupabase } from "./tier.js";
import type { DocChunk } from "./doc-chunker.js";

// --- Types ---

export interface IndexedDocChunk {
  id: string;
  file_path: string;
  chunk_index: number;
  title: string;
  section_title: string;
  category: string;
  content: string;
  file_hash: string;
  project: string;
  embedding?: number[];
  indexed_at: string;
}

export interface DocSearchResult {
  id: string;
  file_path: string;
  chunk_index: number;
  title: string;
  section_title: string;
  category: string;
  content: string;
  similarity: number;
  project: string;
}

export interface IndexStats {
  total_chunks: number;
  total_files: number;
  files_indexed: string[];
  categories: Record<string, number>;
  project: string;
  has_embeddings: boolean;
}

// --- Local File Index ---

const INDEX_FILE = "docs-index.json";
const MAX_INDEX_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Get the path to the local docs index file
 */
function getIndexPath(): string {
  return path.join(getGitmemDir(), INDEX_FILE);
}

/**
 * Read the local index from disk
 */
function readLocalIndex(): IndexedDocChunk[] {
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as IndexedDocChunk[];
  } catch {
    console.error("[doc-index] Failed to read docs-index.json, starting fresh");
    return [];
  }
}

/**
 * Write the local index to disk
 */
function writeLocalIndex(chunks: IndexedDocChunk[]): void {
  const indexPath = getIndexPath();
  const dir = path.dirname(indexPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Strip embeddings from local file to save space
  const stripped = chunks.map(({ embedding: _e, ...rest }) => rest);
  const json = JSON.stringify(stripped, null, 2);

  if (Buffer.byteLength(json, "utf-8") > MAX_INDEX_SIZE) {
    console.error("[doc-index] Warning: docs-index.json exceeds 20MB");
  }

  fs.writeFileSync(indexPath, json, "utf-8");
}

// --- In-Memory Vector Index ---

interface VectorEntry {
  chunk: IndexedDocChunk;
  embedding: number[];
}

let vectorIndex: VectorEntry[] = [];

/**
 * Compute cosine similarity between two normalized vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// --- Public API ---

/**
 * Index doc chunks into storage.
 *
 * - Removes old chunks for the same project + file_path
 * - Generates embeddings if available (pro/dev tier)
 * - Stores to local JSON file
 * - Loads into in-memory vector index if embeddings present
 *
 * Returns count of chunks indexed.
 */
export async function indexChunks(
  chunks: DocChunk[],
  project: string,
  options: { batchSize?: number } = {}
): Promise<{ indexed: number; embedded: number; errors: number }> {
  const batchSize = options.batchSize || 10;
  const now = new Date().toISOString();
  let embedded = 0;
  let errors = 0;

  // Read existing index
  const existing = readLocalIndex();

  // Build set of file paths being re-indexed
  const reindexedPaths = new Set(chunks.map((c) => `${project}:${c.file_path}`));

  // Remove old chunks for files being re-indexed
  const kept = existing.filter(
    (c) => !reindexedPaths.has(`${c.project}:${c.file_path}`)
  );

  // Create new indexed chunks
  const newChunks: IndexedDocChunk[] = [];

  // Process in batches for embedding
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    for (const chunk of batch) {
      const indexed: IndexedDocChunk = {
        id: uuidv4(),
        file_path: chunk.file_path,
        chunk_index: chunk.chunk_index,
        title: chunk.title,
        section_title: chunk.section_title,
        category: chunk.category,
        content: chunk.content,
        file_hash: chunk.file_hash,
        project,
        indexed_at: now,
      };

      // Generate embedding if available
      if (isEmbeddingAvailable()) {
        try {
          // Embed title + section + content for richer representation
          const textToEmbed = [
            indexed.title,
            indexed.section_title,
            indexed.content,
          ]
            .filter(Boolean)
            .join(" | ");

          const embedding = await generateEmbedding(textToEmbed);
          if (embedding) {
            indexed.embedding = embedding;
            embedded++;
          }
        } catch (err) {
          console.error(
            `[doc-index] Embedding failed for ${chunk.file_path}:${chunk.chunk_index}:`,
            err instanceof Error ? err.message : err
          );
          errors++;
        }
      }

      newChunks.push(indexed);
    }

    // Progress logging for large batches (every ~100 chunks)
    if (chunks.length > 50 && i + batchSize < chunks.length && (i + batchSize) % 100 < batchSize) {
      console.error(
        `[doc-index] Progress: ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks`
      );
    }
  }

  // Merge and write
  const merged = [...kept, ...newChunks];
  writeLocalIndex(merged);

  // Update in-memory vector index
  rebuildVectorIndex(merged);

  return { indexed: newChunks.length, embedded, errors };
}

/**
 * Rebuild the in-memory vector index from stored chunks
 */
function rebuildVectorIndex(chunks: IndexedDocChunk[]): void {
  vectorIndex = chunks
    .filter((c) => c.embedding && Array.isArray(c.embedding) && c.embedding.length > 0)
    .map((c) => ({
      chunk: c,
      embedding: c.embedding!,
    }));

  console.error(
    `[doc-index] Vector index rebuilt: ${vectorIndex.length} entries with embeddings`
  );
}

/**
 * Search indexed docs using semantic similarity (pro/dev) or BM25 (free)
 */
export async function searchDocs(
  query: string,
  options: {
    project?: string;
    category?: string;
    match_count?: number;
  } = {}
): Promise<DocSearchResult[]> {
  const matchCount = options.match_count || 5;

  // Try vector search first (pro/dev tier with embeddings)
  if (isEmbeddingAvailable() && vectorIndex.length > 0) {
    return vectorSearchDocs(query, options);
  }

  // Fall back to BM25 keyword search
  return bm25SearchDocs(query, options);
}

/**
 * Vector-based semantic search over doc chunks
 */
async function vectorSearchDocs(
  query: string,
  options: {
    project?: string;
    category?: string;
    match_count?: number;
  }
): Promise<DocSearchResult[]> {
  const matchCount = options.match_count || 5;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    console.error("[doc-index] Query embedding failed, falling back to BM25");
    return bm25SearchDocs(query, options);
  }

  // Filter candidates
  let candidates = vectorIndex;
  if (options.project) {
    candidates = candidates.filter((e) => e.chunk.project === options.project);
  }
  if (options.category) {
    candidates = candidates.filter((e) => e.chunk.category === options.category);
  }

  // Score by cosine similarity
  const scored = candidates.map((entry) => ({
    chunk: entry.chunk,
    similarity: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  // Sort and take top k
  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, matchCount);

  return topK.map(({ chunk, similarity }) => ({
    id: chunk.id,
    file_path: chunk.file_path,
    chunk_index: chunk.chunk_index,
    title: chunk.title,
    section_title: chunk.section_title,
    category: chunk.category,
    content: chunk.content,
    similarity: Math.round(similarity * 1000) / 1000,
    project: chunk.project,
  }));
}

/**
 * BM25 keyword search over doc chunks (free tier)
 */
function bm25SearchDocs(
  query: string,
  options: {
    project?: string;
    category?: string;
    match_count?: number;
  }
): DocSearchResult[] {
  const matchCount = options.match_count || 5;
  const chunks = readLocalIndex();

  // Filter by project and category
  let filtered = chunks;
  if (options.project) {
    filtered = filtered.filter((c) => c.project === options.project);
  }
  if (options.category) {
    filtered = filtered.filter((c) => c.category === options.category);
  }

  if (filtered.length === 0) return [];

  // Build BM25 documents with field boosting
  const docs: BM25Document[] = filtered.map((c) => ({
    id: c.id,
    fields: [
      { text: c.title, boost: 3 },
      { text: c.section_title || "", boost: 2 },
      { text: c.category, boost: 1.5 },
      { text: c.content, boost: 1 },
    ],
  }));

  const results = bm25Search(query, docs, matchCount);

  // Map back to DocSearchResult
  const byId = new Map(filtered.map((c) => [c.id, c]));
  return results
    .map((r) => {
      const c = byId.get(r.id);
      if (!c) return null;
      return {
        id: c.id,
        file_path: c.file_path,
        chunk_index: c.chunk_index,
        title: c.title,
        section_title: c.section_title,
        category: c.category,
        content: c.content,
        similarity: r.similarity,
        project: c.project,
      };
    })
    .filter((r): r is DocSearchResult => r !== null);
}

/**
 * Get index statistics
 */
export function getIndexStats(project?: string): IndexStats {
  const chunks = readLocalIndex();
  const filtered = project
    ? chunks.filter((c) => c.project === project)
    : chunks;

  const files = new Set(filtered.map((c) => c.file_path));
  const categories: Record<string, number> = {};
  for (const c of filtered) {
    categories[c.category] = (categories[c.category] || 0) + 1;
  }

  return {
    total_chunks: filtered.length,
    total_files: files.size,
    files_indexed: Array.from(files).sort(),
    categories,
    project: project || "all",
    has_embeddings: vectorIndex.length > 0,
  };
}

/**
 * Check which files have changed since last index (by hash)
 */
export function getChangedFiles(
  fileHashes: Map<string, string>,
  project: string
): { changed: string[]; unchanged: string[]; new_files: string[] } {
  const existing = readLocalIndex().filter((c) => c.project === project);
  const existingHashes = new Map<string, string>();
  for (const c of existing) {
    existingHashes.set(c.file_path, c.file_hash);
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  const newFiles: string[] = [];

  for (const [filePath, hash] of fileHashes) {
    const existingHash = existingHashes.get(filePath);
    if (!existingHash) {
      newFiles.push(filePath);
    } else if (existingHash !== hash) {
      changed.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }

  return { changed, unchanged, new_files: newFiles };
}

/**
 * Initialize vector index from local storage on startup
 */
export function initDocVectorIndex(): void {
  const chunks = readLocalIndex();
  rebuildVectorIndex(chunks);
}

/**
 * Clear the doc index for a project (or all)
 */
export function clearDocIndex(project?: string): number {
  const existing = readLocalIndex();
  if (!project) {
    writeLocalIndex([]);
    vectorIndex = [];
    return existing.length;
  }

  const kept = existing.filter((c) => c.project !== project);
  writeLocalIndex(kept);
  rebuildVectorIndex(kept);
  return existing.length - kept.length;
}
