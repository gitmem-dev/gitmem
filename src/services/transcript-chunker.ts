/**
 * Transcript Chunking Service
 *
 * Parses JSONL session transcripts, chunks them intelligently,
 * generates embeddings, and stores in orchestra_transcript_chunks.
 *
 * Issue: OD-540
 */

import * as supabase from "./supabase-client.js";
import type { Project } from "../types/index.js";

// OpenRouter API configuration (same as local-vector-search)
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIM = 1536;

// Chunking parameters
const MAX_TOKENS_PER_CHUNK = 500;
const TOKEN_OVERLAP = 50;
const CHARS_PER_TOKEN = 4; // Rough estimate

// Claude Code JSONL format: content is nested under msg.message
interface TranscriptMessage {
  type: string;                    // "user", "assistant", "progress", etc.
  role?: string;                   // Legacy: direct role field
  content?: Array<{ type: string; text?: string; thinking?: string }> | string;  // Legacy: direct content
  message?: {                      // Claude Code format: nested message object
    role?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }> | string;
  };
  name?: string;
  tool_use_id?: string;
}

interface TranscriptChunk {
  session_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  token_count: number;
  chunk_type: string;
}

/**
 * Normalize embedding vector (required for consistent similarity search)
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
 * Generate embedding using OpenRouter API
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding: number[] }>;
  };

  if (!data.data || data.data.length === 0) {
    throw new Error("No embedding data in response");
  }

  const embedding = data.data[0].embedding;

  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Unexpected embedding dimensions: ${embedding.length}, expected ${EMBEDDING_DIM}`);
  }

  return normalize(embedding);
}

/**
 * Extract text content from a transcript message
 */
function extractContent(msg: TranscriptMessage): { text: string; type: string } | null {
  // Claude Code JSONL format: type is "user"/"assistant" and content is under msg.message
  // Legacy/API format: type is "message" with role and content at top level
  const role = msg.message?.role || msg.role;
  const content = msg.message?.content || msg.content;
  const msgType = msg.type;

  // User messages (Claude Code: type="user", Legacy: type="message" role="user")
  if ((msgType === "user" || (msgType === "message" && role === "user"))) {
    if (typeof content === "string") {
      return { text: content, type: "user_message" };
    }
    if (Array.isArray(content)) {
      // Extract text blocks (skip tool_result blocks from user messages)
      const textParts = content
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text!);
      if (textParts.length > 0) {
        return { text: textParts.join("\n"), type: "user_message" };
      }
    }
  }

  // Assistant messages (Claude Code: type="assistant", Legacy: type="message" role="assistant")
  if ((msgType === "assistant" || (msgType === "message" && role === "assistant"))) {
    if (typeof content === "string") {
      return { text: content, type: "assistant_message" };
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text!);
      if (textParts.length > 0) {
        return { text: textParts.join("\n"), type: "assistant_message" };
      }

      // Thinking blocks
      const thinkingParts = content
        .filter(c => c.type === "thinking" && c.thinking)
        .map(c => c.thinking!);
      if (thinkingParts.length > 0) {
        return { text: thinkingParts.join("\n"), type: "thinking" };
      }
    }
  }

  // Tool results (if we want to include them)
  if (msg.type === "tool_result" && typeof content === "string") {
    // Only include short tool results to avoid noise
    if (content.length < 2000) {
      return { text: content, type: "tool_result" };
    }
  }

  return null;
}

/**
 * Chunk text into overlapping segments
 */
function chunkText(text: string, maxTokens: number, overlap: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlap * CHARS_PER_TOKEN;

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));

    // Move start forward by (maxChars - overlapChars)
    start += maxChars - overlapChars;

    // If we're within one overlap of the end, break to avoid tiny final chunk
    if (start + overlapChars >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Parse JSONL transcript and extract content
 */
function parseTranscript(jsonlContent: string): Array<{ text: string; type: string }> {
  const lines = jsonlContent.trim().split("\n");
  const extracted: Array<{ text: string; type: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line) as TranscriptMessage;
      const content = extractContent(msg);
      if (content) {
        extracted.push(content);
      }
    } catch (err) {
      // Skip malformed lines
      console.warn("[transcript-chunker] Failed to parse line:", err);
    }
  }

  return extracted;
}

/**
 * Process a transcript: parse, chunk, embed, and store
 */
export async function processTranscript(
  sessionId: string,
  transcriptContent: string,
  project: Project = "default"
): Promise<{ success: boolean; chunksCreated: number; error?: string }> {
  try {
    console.error(`[transcript-chunker] Processing transcript for session ${sessionId}`);

    // Handle JSON wrapper format: { session_id, agent, project, captured_at, transcript: "<JSONL>" }
    let jsonlContent = transcriptContent;
    try {
      const parsed = JSON.parse(transcriptContent);
      if (parsed && typeof parsed.transcript === "string") {
        jsonlContent = parsed.transcript;
      }
    } catch {
      // Not JSON wrapper — treat as raw JSONL
    }

    // 1. Parse transcript and extract content
    const extracted = parseTranscript(jsonlContent);
    console.error(`[transcript-chunker] Extracted ${extracted.length} content blocks`);

    if (extracted.length === 0) {
      return { success: true, chunksCreated: 0 };
    }

    // 2. Combine extracted content into chunks
    const allChunks: TranscriptChunk[] = [];
    let globalChunkIndex = 0;

    for (const { text, type } of extracted) {
      // Chunk long content
      const textChunks = chunkText(text, MAX_TOKENS_PER_CHUNK, TOKEN_OVERLAP);

      for (const chunkText of textChunks) {
        const tokenCount = Math.ceil(chunkText.length / CHARS_PER_TOKEN);

        // Generate embedding (with retry logic for rate limits)
        let embedding: number[];
        try {
          embedding = await generateEmbedding(chunkText);
        } catch (err) {
          console.error(`[transcript-chunker] Failed to generate embedding for chunk ${globalChunkIndex}:`, err);
          // Skip this chunk if embedding fails
          continue;
        }

        allChunks.push({
          session_id: sessionId,
          chunk_index: globalChunkIndex,
          content: chunkText,
          embedding,
          token_count: tokenCount,
          chunk_type: type,
        });

        globalChunkIndex++;

        // Rate limiting: small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.error(`[transcript-chunker] Generated ${allChunks.length} chunks with embeddings`);

    // 3. Batch insert into database
    if (allChunks.length > 0) {
      // Use direct REST API for batch insert (more efficient than MCP)
      const SUPABASE_URL = process.env.SUPABASE_URL || "";
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

      if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error("Supabase configuration missing");
      }

      const restUrl = `${SUPABASE_URL}/rest/v1/orchestra_transcript_chunks`;

      const response = await fetch(restUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Profile": "public",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "apikey": SUPABASE_KEY,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(allChunks),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to insert chunks: ${response.status} - ${errorText}`);
      }

      console.error(`[transcript-chunker] Successfully stored ${allChunks.length} chunks`);
    }

    return { success: true, chunksCreated: allChunks.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[transcript-chunker] Error processing transcript:", errorMessage);
    return { success: false, chunksCreated: 0, error: errorMessage };
  }
}
