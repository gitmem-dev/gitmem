/**
 * Quick Retrieve — lightweight scar search for hook invocation.
 *
 * Designed to be called from the auto-retrieve UserPromptSubmit hook
 * via: node dist/hooks/quick-retrieve.js <prompt> <level> [token_budget]
 *
 * Imports the storage layer directly (no MCP overhead).
 * Routes to:
 *   1. In-memory vector search (MCP server process with warm cache)
 *   2. Disk cache keyword search (hook child process reading hook-scars.json)
 *   3. LocalStorage keyword search (free tier fallback)
 *
 * No side effects: no surfaced scar tracking, no variant assignment,
 * no confirmation gate. Pure retrieval for passive context injection.
 *
 * Performance target: <300ms total.
 */

import * as fs from "fs";
import * as path from "path";
import { getStorage } from "../services/storage.js";
import { hasSupabase } from "../services/tier.js";
import { isLocalSearchReady, localScarSearch } from "../services/local-vector-search.js";
import { bm25Search, type BM25Document } from "../services/bm25.js";
import { formatCompact, estimateTokens } from "./format-utils.js";
import type { FormattableScar } from "./format-utils.js";
import type { RelevantScar } from "../types/index.js";
import type { Project } from "../types/index.js";

export interface QuickRetrieveOptions {
  project?: Project;
  tokenBudget?: number;
}

/**
 * Perform a quick scar search optimized for hook invocation.
 *
 * Returns formatted compact text suitable for additionalContext injection,
 * or null if no relevant scars found or retrieval level is "none".
 */
export async function quickRetrieve(
  prompt: string,
  retrievalLevel: string,
  options: QuickRetrieveOptions = {}
): Promise<string | null> {
  if (retrievalLevel === "none" || !prompt || prompt.trim().length === 0) {
    return null;
  }

  const matchCount = retrievalLevel === "full" ? 5 : 3;
  const defaultBudget = hasSupabase() ? 4000 : 2000;
  const tokenBudget = options.tokenBudget ?? defaultBudget;
  const project = options.project ?? ("default" as Project);

  let scars: FormattableScar[] = [];

  try {
    // Path 1: In-memory vector search (MCP server process with warm cache)
    if (hasSupabase() && isLocalSearchReady(project)) {
      const results = await localScarSearch(prompt, matchCount, project);
      scars = results.map(toFormattable);
    }
    // Path 2: Disk cache keyword search (hook child process)
    else {
      const diskResults = searchDiskCache(prompt, matchCount);
      if (diskResults.length > 0) {
        scars = diskResults;
      } else {
        // Path 3: LocalStorage fallback (free tier .gitmem/learnings.json)
        const storage = getStorage();
        const results = await storage.search(prompt, matchCount);
        scars = results.map(toFormattable);
      }
    }
  } catch {
    // Fail open — return nothing rather than block
    return null;
  }

  if (scars.length === 0) {
    return null;
  }

  const { payload } = formatCompact(scars, prompt, tokenBudget);
  return payload;
}

/**
 * Search the disk cache written by the MCP server's startup.ts.
 * Uses BM25 ranking with field boosting (title 3x, keywords 2x, description 1x).
 */
function searchDiskCache(query: string, k: number): FormattableScar[] {
  const cachePath = path.join(process.cwd(), ".gitmem", "cache", "hook-scars.json");
  if (!fs.existsSync(cachePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const scars = JSON.parse(raw) as Array<Record<string, unknown>>;

    const docs: BM25Document[] = scars.map((s) => ({
      id: String(s.id),
      fields: [
        { text: String(s.title || ""), boost: 3 },
        { text: ((s.keywords as string[]) || []).join(" "), boost: 2 },
        { text: String(s.description || ""), boost: 1 },
      ],
    }));

    const results = bm25Search(query, docs, k);
    const byId = new Map(scars.map((s) => [String(s.id), s]));

    const mapped: FormattableScar[] = [];
    for (const r of results) {
      const s = byId.get(r.id);
      if (!s) continue;
      mapped.push({
        id: r.id,
        title: String(s.title),
        description: String(s.description || ""),
        severity: String(s.severity || "medium"),
        counter_arguments: (s.counter_arguments as string[]) || [],
        similarity: r.similarity,
        why_this_matters: s.why_this_matters as string | undefined,
        action_protocol: s.action_protocol as string[] | undefined,
        self_check_criteria: s.self_check_criteria as string[] | undefined,
      });
    }
    return mapped;
  } catch {
    return [];
  }
}

function toFormattable(scar: RelevantScar): FormattableScar {
  return {
    id: scar.id,
    title: scar.title,
    description: scar.description || "",
    severity: scar.severity || "medium",
    counter_arguments: scar.counter_arguments || [],
    similarity: scar.similarity || 0,
    why_this_matters: scar.why_this_matters,
    action_protocol: scar.action_protocol,
    self_check_criteria: scar.self_check_criteria,
  };
}

// --- CLI entry point ---
// Called from hook: node dist/hooks/quick-retrieve.js <prompt> <level> [token_budget]

const isMainModule = process.argv[1]?.endsWith("quick-retrieve.js");

if (isMainModule) {
  const prompt = process.argv[2];
  const level = process.argv[3] || "scars";
  const budget = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;

  if (!prompt) {
    process.exit(0);
  }

  quickRetrieve(prompt, level, { tokenBudget: budget })
    .then((result) => {
      if (result) {
        process.stdout.write(result);
      }
    })
    .catch(() => {
      // Fail open
      process.exit(0);
    });
}
