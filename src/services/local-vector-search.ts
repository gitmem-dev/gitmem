/**
 * Local Vector Search Service
 *
 * Provides consistent, local semantic search using:
 * - OpenRouter API for query embeddings (same model as ww-mcp)
 * - Pure JavaScript cosine similarity (no native dependencies)
 * - In-memory scar index (loaded once from Supabase)
 *
 * Solves the 500-employees-at-8AM problem:
 * - No Supabase contention (data loaded once at startup)
 * - Deterministic results (same model + same data = same results)
 * - Per-container consistency (each loads same data)
 *
 * Issue: OD-473 (cache consistency)
 */

import type { Project, RelevantScar } from "../types/index.js";
import { embed as generateEmbedding, getEmbeddingDim, isEmbeddingAvailable } from "./embedding.js";

// Embedding dimension — read from provider config at runtime
const getExpectedDim = () => getEmbeddingDim() || 1536;

// Scar record from database
interface ScarRecord {
  id: string;
  title: string;
  learning_type?: string;
  description: string;
  severity: string;
  counter_arguments?: string[];
  project?: string;
  embedding?: number[];
  decay_multiplier?: number;
  // OD-508: LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
}

// Indexed scar with normalized embedding
interface IndexedScar {
  scar: ScarRecord;
  embedding: number[]; // Normalized
}

/**
 * Compute cosine similarity between two vectors
 * Assumes vectors are already normalized (dot product = cosine similarity)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }

  return dotProduct;
}

/**
 * Normalize a vector to unit length
 */
function normalize(vec: number[]): number[] {
  let magnitude = 0;
  for (const v of vec) {
    magnitude += v * v;
  }
  magnitude = Math.sqrt(magnitude);

  if (magnitude === 0) return vec;

  return vec.map((v) => v / magnitude);
}

/**
 * Cache metadata for staleness detection
 */
export interface CacheMetadata {
  loadedAt: Date;
  scarCount: number;
  latestUpdatedAt: string | null;
  ageMinutes: number;
  isStale: boolean;
}

/**
 * LocalVectorSearch class
 *
 * Manages an in-memory index for fast, consistent scar search.
 * Uses pure JavaScript - no native dependencies.
 */
export class LocalVectorSearch {
  private scars: IndexedScar[] = [];
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private project: Project;

  // Cache metadata
  private loadedAt: Date | null = null;
  private latestUpdatedAt: string | null = null;
  private staleTtlMinutes: number = 15;

  constructor(project: Project = "default") {
    this.project = project;
  }

  /**
   * Set cache TTL for staleness detection
   */
  setTtlMinutes(minutes: number): void {
    this.staleTtlMinutes = Math.max(1, minutes);
  }

  /**
   * Initialize the search index with scars from Supabase
   */
  async initialize(scars: ScarRecord[], latestUpdatedAt?: string): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize(scars, latestUpdatedAt);
    return this.initPromise;
  }

  /**
   * Force re-initialization with new scars (for flush/refresh)
   */
  async reinitialize(scars: ScarRecord[], latestUpdatedAt?: string): Promise<void> {
    this.scars = [];
    this.initialized = false;
    this.initPromise = null;
    this.loadedAt = null;
    this.latestUpdatedAt = null;

    await this.initialize(scars, latestUpdatedAt);
  }

  private async _doInitialize(scars: ScarRecord[], latestUpdatedAt?: string): Promise<void> {
    const startTime = Date.now();
    console.error(`[local-vector] Initializing with ${scars.length} scars...`);

    // Parse and filter scars with valid embeddings
    // Note: Supabase REST API returns embeddings as JSON strings, not arrays
    const scarsWithEmbeddings: Array<{ scar: ScarRecord; parsedEmbedding: number[] }> = [];

    for (const scar of scars) {
      if (!scar.embedding) continue;

      // Parse embedding if it's a string (Supabase REST API returns vector as JSON string)
      let embedding: number[];
      if (typeof scar.embedding === 'string') {
        try {
          embedding = JSON.parse(scar.embedding);
        } catch {
          console.warn(`[local-vector] Failed to parse embedding for scar ${scar.id}`);
          continue;
        }
      } else if (Array.isArray(scar.embedding)) {
        embedding = scar.embedding;
      } else {
        continue;
      }

      // Validate embedding dimensions (accept any valid length, store for comparison)
      const expectedDim = getExpectedDim();
      if (embedding.length !== expectedDim && embedding.length !== 1536) {
        console.warn(`[local-vector] Scar ${scar.id} has unexpected embedding dimension: ${embedding.length}`);
        continue;
      }

      scarsWithEmbeddings.push({ scar, parsedEmbedding: embedding });
    }

    if (scarsWithEmbeddings.length === 0) {
      console.warn("[local-vector] No scars with valid embeddings found");
      this.initialized = true;
      this.loadedAt = new Date();
      return;
    }

    console.error(`[local-vector] ${scarsWithEmbeddings.length} scars have valid embeddings`);

    // Store scars with normalized embeddings
    this.scars = scarsWithEmbeddings.map(({ scar, parsedEmbedding }) => ({
      scar,
      embedding: normalize(parsedEmbedding),
    }));

    // Track cache metadata
    this.loadedAt = new Date();
    this.latestUpdatedAt = latestUpdatedAt || null;

    this.initialized = true;
    const elapsed = Date.now() - startTime;
    console.error(`[local-vector] Initialized in ${elapsed}ms`);
  }


  /**
   * Check if the index is ready for queries
   */
  isReady(): boolean {
    return this.initialized && this.scars.length > 0;
  }

  /**
   * Get the number of indexed scars
   */
  getScarCount(): number {
    return this.scars.length;
  }

  /**
   * Search for scars similar to the query
   *
   * Returns consistent results: same query = same results every time
   */
  async search(query: string, k: number = 5): Promise<RelevantScar[]> {
    if (!this.isReady()) {
      console.warn("[local-vector] Index not ready, returning empty results");
      return [];
    }

    const startTime = Date.now();

    // Generate query embedding locally
    const queryEmbedding = await this._embed(query);

    // Compute similarities to all scars, weighted by behavioral decay
    const scored = this.scars.map((indexed) => ({
      scar: indexed.scar,
      similarity: cosineSimilarity(queryEmbedding, indexed.embedding)
        * (indexed.scar.decay_multiplier ?? 1.0),
    }));

    // Sort by similarity (descending) and take top k
    scored.sort((a, b) => b.similarity - a.similarity);
    const topK = scored.slice(0, k);

    // Map to result format
    const results: RelevantScar[] = topK.map(({ scar, similarity }) => ({
      id: scar.id,
      title: scar.title,
      learning_type: scar.learning_type || "scar",
      description: scar.description,
      severity: scar.severity || "medium",
      counter_arguments: scar.counter_arguments || [],
      similarity: Math.round(similarity * 1000) / 1000, // 3 decimal places
      // OD-508: Include enriched fields for LLM-cooperative enforcement
      why_this_matters: scar.why_this_matters,
      action_protocol: scar.action_protocol,
      self_check_criteria: scar.self_check_criteria,
      decay_multiplier: scar.decay_multiplier,
    }));

    const elapsed = Date.now() - startTime;
    console.error(`[local-vector] Search completed in ${elapsed}ms, found ${results.length} results`);

    return results;
  }

  /**
   * Generate embedding for text using the shared embedding service.
   * Supports multiple providers (OpenAI, OpenRouter, Ollama) via auto-detection.
   */
  private async _embed(text: string): Promise<number[]> {
    if (!isEmbeddingAvailable()) {
      throw new Error("No embedding provider configured (set OPENAI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_URL)");
    }

    const result = await generateEmbedding(text);
    if (!result) {
      throw new Error("Embedding generation returned null");
    }

    // Result is already normalized by the embedding service
    return result;
  }

  /**
   * Clear the index and release memory
   */
  clear(): void {
    this.scars = [];
    this.initialized = false;
    this.initPromise = null;
    this.loadedAt = null;
    this.latestUpdatedAt = null;
    console.error("[local-vector] Index cleared");
  }

  /**
   * Get cache metadata for status/health checks
   */
  getCacheMetadata(): CacheMetadata | null {
    if (!this.loadedAt) return null;

    const now = new Date();
    const ageMs = now.getTime() - this.loadedAt.getTime();
    const ageMinutes = Math.floor(ageMs / 60000);

    return {
      loadedAt: this.loadedAt,
      scarCount: this.scars.length,
      latestUpdatedAt: this.latestUpdatedAt,
      ageMinutes,
      isStale: ageMinutes >= this.staleTtlMinutes,
    };
  }

  /**
   * Get the latest updated_at timestamp from loaded scars
   */
  getLatestUpdatedAt(): string | null {
    return this.latestUpdatedAt;
  }
}

// Unified cache — all scars loaded into single instance regardless of project.
// At ~400 scars, semantic similarity handles relevance better than project partitioning.
// Project params kept in signatures for backward compat but ignored for cache lookup.
const UNIFIED_KEY: Project = "__all__" as Project;
const instances: Map<Project, LocalVectorSearch> = new Map();

/**
 * Get the LocalVectorSearch instance (unified, cross-project)
 */
export function getLocalVectorSearch(_project?: Project): LocalVectorSearch {
  let instance = instances.get(UNIFIED_KEY);
  if (!instance) {
    instance = new LocalVectorSearch(UNIFIED_KEY);
    instances.set(UNIFIED_KEY, instance);
  }
  return instance;
}

/**
 * Initialize local vector search with scars from Supabase
 *
 * Call this once at startup with pre-fetched scars
 */
export async function initializeLocalSearch(
  scars: ScarRecord[],
  _project?: Project,
  latestUpdatedAt?: string
): Promise<void> {
  const instance = getLocalVectorSearch();
  await instance.initialize(scars, latestUpdatedAt);
}

/**
 * Reinitialize local search (for cache flush/refresh)
 */
export async function reinitializeLocalSearch(
  scars: ScarRecord[],
  _project?: Project,
  latestUpdatedAt?: string
): Promise<void> {
  const instance = getLocalVectorSearch();
  await instance.reinitialize(scars, latestUpdatedAt);
}

/**
 * Search for scars using local vector search
 *
 * Falls back to empty results if not initialized
 */
export async function localScarSearch(
  query: string,
  k: number = 5,
  _project?: Project
): Promise<RelevantScar[]> {
  const instance = getLocalVectorSearch();
  return instance.search(query, k);
}

/**
 * Check if local search is ready
 */
export function isLocalSearchReady(_project?: Project): boolean {
  const instance = instances.get(UNIFIED_KEY);
  return instance?.isReady() ?? false;
}

/**
 * Get cache metadata for a project
 */
export function getCacheMetadata(_project?: Project): CacheMetadata | null {
  const instance = instances.get(UNIFIED_KEY);
  return instance?.getCacheMetadata() ?? null;
}

/**
 * Set cache TTL for a project
 */
export function setCacheTtl(minutes: number, _project?: Project): void {
  const instance = getLocalVectorSearch();
  instance.setTtlMinutes(minutes);
}

/**
 * Clear the local search index
 */
export function clearLocalSearch(_project?: Project): void {
  const instance = instances.get(UNIFIED_KEY);
  instance?.clear();
}
