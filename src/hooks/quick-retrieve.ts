/**
 * Quick Retrieve — lightweight scar search for hook invocation.
 *
 * Designed to be called from the auto-retrieve UserPromptSubmit hook
 * via: node dist/hooks/quick-retrieve.js <prompt> <level> [token_budget]
 *
 * Imports the storage layer directly (no MCP overhead).
 * Routes to keyword search (free tier) or local vector search (pro tier)
 * via the StorageBackend abstraction.
 *
 * No side effects: no surfaced scar tracking, no variant assignment,
 * no confirmation gate. Pure retrieval for passive context injection.
 *
 * Performance target: <300ms total.
 */

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
    // Pro/dev tier: prefer local vector search if cache is warm
    if (hasSupabase() && isLocalSearchReady(project)) {
      const results = await localScarSearch(prompt, matchCount, project);
      scars = results.map(toFormattable);
    } else {
      // Free tier keyword search, or pro tier fallback
      const storage = getStorage();
      const results = await storage.search(prompt, matchCount);
      scars = results.map(toFormattable);
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
