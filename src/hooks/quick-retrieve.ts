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
 * Uses keyword matching (same algorithm as LocalFileStorage.keywordSearch).
 */
function searchDiskCache(query: string, k: number): FormattableScar[] {
  const cachePath = path.join(process.cwd(), ".gitmem", "cache", "hook-scars.json");
  if (!fs.existsSync(cachePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const scars = JSON.parse(raw) as Array<Record<string, unknown>>;
    const queryTokens = tokenize(query.toLowerCase());

    if (queryTokens.length === 0) return [];

    const maxScore = queryTokens.length * 6; // max per token: title(3) + keyword(2) + desc(1)

    const scored = scars.map((s) => {
      let score = 0;
      const titleTokens = tokenize(String(s.title || "").toLowerCase());
      const descTokens = tokenize(String(s.description || "").toLowerCase());
      const kwTokens = ((s.keywords as string[]) || []).map((k: string) => k.toLowerCase());

      for (const qt of queryTokens) {
        if (titleTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 3;
        if (kwTokens.some((kw) => kw.includes(qt) || qt.includes(kw))) score += 2;
        if (descTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
      }

      return { scar: s, score, similarity: maxScore > 0 ? Math.round((score / maxScore) * 1000) / 1000 : 0 };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => ({
        id: String(s.scar.id),
        title: String(s.scar.title),
        description: String(s.scar.description || ""),
        severity: String(s.scar.severity || "medium"),
        counter_arguments: (s.scar.counter_arguments as string[]) || [],
        similarity: s.similarity,
        why_this_matters: s.scar.why_this_matters as string | undefined,
        action_protocol: s.scar.action_protocol as string[] | undefined,
        self_check_criteria: s.scar.self_check_criteria as string[] | undefined,
      }));
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
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
