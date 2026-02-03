/**
 * Embedding Service — Multi-provider embedding abstraction
 *
 * Generates text embeddings for semantic search using multiple providers.
 * Auto-detects provider from available API keys.
 *
 * Provider detection (in priority order):
 *   GITMEM_EMBEDDING_PROVIDER=openai|openrouter|ollama — force provider
 *   OPENAI_API_KEY → OpenAI direct (text-embedding-3-small)
 *   OPENROUTER_API_KEY → OpenRouter (text-embedding-3-small via openrouter.ai)
 *   OLLAMA_URL → Ollama local (nomic-embed-text, 768-dim — requires pgvector dimension match)
 *
 * If no provider is configured, embed() returns null (graceful degradation).
 * Records stored without embeddings can still be retrieved by ID/filters,
 * but won't appear in semantic search results.
 */

// Default embedding dimensions per provider
const OPENAI_EMBEDDING_DIM = 1536;
const OLLAMA_DEFAULT_DIM = 768;

// Model configuration
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

// API URLs
const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/embeddings";

export type EmbeddingProvider = "openai" | "openrouter" | "ollama" | "none";

interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
  expectedDim: number;
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
 * Detect the best available embedding provider from environment
 */
export function detectProvider(): EmbeddingConfig {
  const forced = process.env.GITMEM_EMBEDDING_PROVIDER?.toLowerCase();

  // Forced provider
  if (forced && forced !== "auto") {
    switch (forced) {
      case "openai": {
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
          console.warn("[embedding] GITMEM_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY not set");
          return { provider: "none", apiUrl: "", apiKey: "", model: "", expectedDim: 0 };
        }
        return {
          provider: "openai",
          apiUrl: OPENAI_API_URL,
          apiKey: key,
          model: OPENAI_EMBEDDING_MODEL,
          expectedDim: OPENAI_EMBEDDING_DIM,
        };
      }
      case "openrouter": {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) {
          console.warn("[embedding] GITMEM_EMBEDDING_PROVIDER=openrouter but OPENROUTER_API_KEY not set");
          return { provider: "none", apiUrl: "", apiKey: "", model: "", expectedDim: 0 };
        }
        return {
          provider: "openrouter",
          apiUrl: OPENROUTER_API_URL,
          apiKey: key,
          model: OPENROUTER_EMBEDDING_MODEL,
          expectedDim: OPENAI_EMBEDDING_DIM,
        };
      }
      case "ollama": {
        const url = process.env.OLLAMA_URL || "http://localhost:11434";
        return {
          provider: "ollama",
          apiUrl: `${url}/api/embed`,
          apiKey: "",
          model: process.env.GITMEM_OLLAMA_MODEL || OLLAMA_EMBEDDING_MODEL,
          expectedDim: parseInt(process.env.GITMEM_EMBEDDING_DIM || String(OLLAMA_DEFAULT_DIM), 10),
        };
      }
      default:
        console.warn(`[embedding] Unknown provider: ${forced}`);
        return { provider: "none", apiUrl: "", apiKey: "", model: "", expectedDim: 0 };
    }
  }

  // Auto-detect from available keys (priority: OpenAI > OpenRouter > Ollama)
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiUrl: OPENAI_API_URL,
      apiKey: process.env.OPENAI_API_KEY,
      model: OPENAI_EMBEDDING_MODEL,
      expectedDim: OPENAI_EMBEDDING_DIM,
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: "openrouter",
      apiUrl: OPENROUTER_API_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
      model: OPENROUTER_EMBEDDING_MODEL,
      expectedDim: OPENAI_EMBEDDING_DIM,
    };
  }

  if (process.env.OLLAMA_URL) {
    const url = process.env.OLLAMA_URL;
    return {
      provider: "ollama",
      apiUrl: `${url}/api/embed`,
      apiKey: "",
      model: process.env.GITMEM_OLLAMA_MODEL || OLLAMA_EMBEDDING_MODEL,
      expectedDim: parseInt(process.env.GITMEM_EMBEDDING_DIM || String(OLLAMA_DEFAULT_DIM), 10),
    };
  }

  return { provider: "none", apiUrl: "", apiKey: "", model: "", expectedDim: 0 };
}

// Cached config (loaded once per process)
let _config: EmbeddingConfig | null = null;

/**
 * Get the current embedding configuration (cached)
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  if (!_config) {
    _config = detectProvider();
    if (_config.provider !== "none") {
      console.error(`[embedding] Provider: ${_config.provider} (model: ${_config.model}, dim: ${_config.expectedDim})`);
    } else {
      console.error("[embedding] No embedding provider configured — scars will be stored without embeddings");
    }
  }
  return _config;
}

/**
 * Reset cached config (for testing)
 */
export function resetEmbeddingConfig(): void {
  _config = null;
}

/**
 * Generate an embedding for text using OpenAI-compatible API (OpenAI or OpenRouter)
 */
async function embedOpenAI(text: string, config: EmbeddingConfig): Promise<number[]> {
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${config.provider} embedding error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding: number[] }>;
  };

  if (!data.data || data.data.length === 0) {
    throw new Error(`No embedding data in ${config.provider} response`);
  }

  return data.data[0].embedding;
}

/**
 * Generate an embedding using Ollama local API
 */
async function embedOllama(text: string, config: EmbeddingConfig): Promise<number[]> {
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embedding error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    embeddings?: number[][];
  };

  if (!data.embeddings || data.embeddings.length === 0) {
    throw new Error("No embedding data in Ollama response");
  }

  return data.embeddings[0];
}

/**
 * Generate an embedding for the given text.
 *
 * Returns normalized embedding vector, or null if no provider is configured.
 * Throws on API errors (network, auth, rate limit).
 */
export async function embed(text: string): Promise<number[] | null> {
  const config = getEmbeddingConfig();

  if (config.provider === "none") {
    return null;
  }

  let raw: number[];

  switch (config.provider) {
    case "openai":
    case "openrouter":
      raw = await embedOpenAI(text, config);
      break;
    case "ollama":
      raw = await embedOllama(text, config);
      break;
    default:
      return null;
  }

  // Validate dimensions
  if (raw.length !== config.expectedDim) {
    console.warn(
      `[embedding] Unexpected dimensions: got ${raw.length}, expected ${config.expectedDim}`
    );
    // Don't throw — store what we got, let pgvector validate
  }

  return normalize(raw);
}

/**
 * Get the expected embedding dimension for the current provider.
 * Returns 0 if no provider configured.
 */
export function getEmbeddingDim(): number {
  return getEmbeddingConfig().expectedDim;
}

/**
 * Check if embedding generation is available.
 */
export function isEmbeddingAvailable(): boolean {
  return getEmbeddingConfig().provider !== "none";
}

/**
 * Get the current provider name.
 */
export function getProviderName(): EmbeddingProvider {
  return getEmbeddingConfig().provider;
}
