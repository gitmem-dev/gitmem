/**
 * Knowledge Triple Writer Service
 *
 * Phase 2: Rule-based extraction of knowledge triples from
 * create_learning and create_decision operations.
 *
 * Design principles:
 * - Fire-and-forget: never blocks the main tool response
 * - High-confidence only: rule-based, no guessing
 * - Uses directUpsert pattern from supabase-client.ts
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "./supabase-client.js";
import { hasSupabase } from "./tier.js";

// --- Types ---

/** Controlled predicate vocabulary (Phase 2 subset) */
type Predicate =
  | "created_in"
  | "influenced_by"
  | "supersedes"
  | "demonstrates";

interface TripleCandidate {
  subject: string;
  predicate: Predicate;
  object: string;
  source_type: string;
  source_id: string;
  source_linear_issue?: string;
  domain?: string[];
  project: string;
  half_life_days: number;
  created_by: string;
}

// --- Constants ---

/** Half-life profiles (days). Process = structural, never decays. */
const HALF_LIFE_PROCESS = 9999;

// --- Helpers ---

/**
 * Build a human-readable subject label following the existing DB convention:
 * "Win: Read-side enrichment pattern for denormalization gaps"
 */
function buildSubjectLabel(type: string, title: string): string {
  const typeLabels: Record<string, string> = {
    scar: "Scar",
    win: "Win",
    pattern: "Pattern",
    anti_pattern: "Anti-Pattern",
    decision: "Decision",
  };
  const label = typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1);
  return `${label}: ${title}`;
}

// --- Extraction Rules ---

export interface LearningTripleParams {
  id: string;
  learning_type: string;
  title: string;
  description: string;
  scar_type?: string;
  source_linear_issue?: string;
  persona_name: string;
  domain?: string[];
  project: string;
}

/**
 * Extract triples from a newly created learning using rule-based logic.
 * Pure function — no side effects.
 */
export function extractLearningTriples(params: LearningTripleParams): TripleCandidate[] {
  const triples: TripleCandidate[] = [];
  const subjectLabel = buildSubjectLabel(params.learning_type, params.title);
  const base = {
    source_type: "learning",
    source_id: params.id,
    source_linear_issue: params.source_linear_issue,
    domain: params.domain,
    project: params.project,
    half_life_days: HALF_LIFE_PROCESS,
    created_by: params.persona_name,
  };

  // RULE 1: source_linear_issue -> "created_in"
  if (params.source_linear_issue) {
    triples.push({
      ...base,
      subject: subjectLabel,
      predicate: "created_in",
      object: `Issue: ${params.source_linear_issue}`,
    });
  }

  // RULE 2: persona_name -> "influenced_by"
  if (params.persona_name && params.persona_name !== "Unknown") {
    triples.push({
      ...base,
      subject: subjectLabel,
      predicate: "influenced_by",
      object: `Agent: ${params.persona_name}`,
    });
  }

  // RULE 3: Description contains "supersedes" with a reference
  const supersedesMatch = params.description.match(
    /supersedes?\s+(?:scar|learning|pattern|win)?\s*[:\-]?\s*["']?([^"'\n.]{10,80})["']?/i
  );
  if (supersedesMatch) {
    triples.push({
      ...base,
      subject: subjectLabel,
      predicate: "supersedes",
      object: supersedesMatch[1].trim(),
    });
  }

  return triples;
}

export interface DecisionTripleParams {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  personas_involved?: string[];
  linear_issue?: string;
  session_id?: string;
  project: string;
  agent: string;
}

/**
 * Extract triples from a newly created decision using rule-based logic.
 * Pure function — no side effects.
 */
export function extractDecisionTriples(params: DecisionTripleParams): TripleCandidate[] {
  const triples: TripleCandidate[] = [];
  const subjectLabel = buildSubjectLabel("decision", params.title);
  const base = {
    source_type: "decision",
    source_id: params.id,
    source_linear_issue: params.linear_issue,
    project: params.project,
    half_life_days: HALF_LIFE_PROCESS,
    created_by: params.agent,
  };

  // RULE 1: linear_issue -> "created_in"
  if (params.linear_issue) {
    triples.push({
      ...base,
      subject: subjectLabel,
      predicate: "created_in",
      object: `Issue: ${params.linear_issue}`,
    });
  }

  // RULE 2: Each persona -> "influenced_by"
  if (params.personas_involved?.length) {
    for (const persona of params.personas_involved) {
      triples.push({
        ...base,
        subject: subjectLabel,
        predicate: "influenced_by",
        object: `Persona: ${persona}`,
      });
    }
  }

  // RULE 3: Agent identity -> "influenced_by" (if not already covered by personas)
  if (params.agent && params.agent !== "Unknown") {
    const alreadyCovered = params.personas_involved?.some(
      (p) => p.toLowerCase() === params.agent.toLowerCase()
    );
    if (!alreadyCovered) {
      triples.push({
        ...base,
        subject: subjectLabel,
        predicate: "influenced_by",
        object: `Agent: ${params.agent}`,
      });
    }
  }

  return triples;
}

// --- Write ---

/**
 * Write triples to knowledge_triples table.
 * Fire-and-forget: errors logged but never thrown to caller.
 */
export async function writeTriples(candidates: TripleCandidate[]): Promise<number> {
  if (candidates.length === 0 || !hasSupabase()) {
    return 0;
  }

  let written = 0;

  for (const candidate of candidates) {
    try {
      await supabase.directUpsert("knowledge_triples", {
        id: uuidv4(),
        subject: candidate.subject,
        predicate: candidate.predicate,
        object: candidate.object,
        event_time: new Date().toISOString(),
        decay_weight: 1.0,
        half_life_days: candidate.half_life_days,
        decay_floor: 0.1,
        source_type: candidate.source_type,
        source_id: candidate.source_id,
        source_linear_issue: candidate.source_linear_issue || null,
        domain: candidate.domain || [],
        project: candidate.project,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: candidate.created_by,
      });
      written++;
    } catch (error) {
      console.error(
        `[triple-writer] Failed to write triple: ${candidate.subject} ${candidate.predicate} ${candidate.object}`,
        error instanceof Error ? error.message : error
      );
    }
  }

  if (written > 0) {
    console.error(`[triple-writer] Wrote ${written}/${candidates.length} triples`);
  }

  return written;
}

// --- Public API ---

/**
 * Generate and write triples for a newly created learning.
 * Fire-and-forget — call with .catch(() => {}).
 */
export function writeTriplesForLearning(params: LearningTripleParams): Promise<number> {
  const triples = extractLearningTriples(params);
  return writeTriples(triples);
}

/**
 * Generate and write triples for a newly created decision.
 * Fire-and-forget — call with .catch(() => {}).
 */
export function writeTriplesForDecision(params: DecisionTripleParams): Promise<number> {
  const triples = extractDecisionTriples(params);
  return writeTriples(triples);
}
