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

/** Controlled predicate vocabulary */
type Predicate =
  | "created_in"
  | "influenced_by"
  | "supersedes"
  | "demonstrates"
  | "affects_doc"
  | "created_thread"
  | "resolves_thread"
  | "relates_to_thread";

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
 * Canonical persona name map.
 * Raw personas_involved values may contain full names or contextual suffixes.
 * This ensures consistent node identity in the knowledge graph.
 *
 * Users can populate this with their own team/persona names.
 * Keys are lowercase, values are canonical display names.
 */
const CANONICAL_PERSONA_NAMES: Record<string, string> = {};

/**
 * Normalize a persona label to its canonical form.
 * Strips contextual suffixes like " - UX navigation clarity" or ": Prefers non-invasive..."
 * Then maps to canonical short name if known.
 *
 * Examples:
 *   "Alice Smith" → "Alice" (if mapped)
 *   "Bob - Architectural pattern" → "Bob" (if mapped)
 *   "Alice: Prefers non-invasive instrumentation" → "Alice" (if mapped)
 *   "Unknown Developer - Process decision" → "Unknown Developer" (passthrough)
 */
export function normalizePersonaLabel(raw: string): string {
  // Strip contextual suffix after " - " or ": "
  let name = raw.split(" - ")[0].split(": ")[0].trim();

  // Strip parenthetical role descriptions like "(Integration & Deployment)"
  name = name.replace(/\s*\(.*?\)\s*$/, "").trim();

  // Look up canonical name (case-insensitive)
  const canonical = CANONICAL_PERSONA_NAMES[name.toLowerCase()];
  return canonical || name;
}

/** Set of canonical persona names (team members). */
const KNOWN_PERSONAS = new Set(Object.values(CANONICAL_PERSONA_NAMES));

/**
 * Determine if a name refers to a known persona vs an agent.
 * Returns true for names in the CANONICAL_PERSONA_NAMES map.
 */
function isPersonaName(name: string): boolean {
  return KNOWN_PERSONAS.has(normalizePersonaLabel(name));
}

/**
 * Build a prefixed node label: "Persona: X" for known personas, "Agent: X" for agents.
 * Normalizes persona names to canonical form.
 */
export function buildInfluencerLabel(rawName: string): string {
  const normalized = normalizePersonaLabel(rawName);
  if (isPersonaName(normalized)) {
    return `Persona: ${normalized}`;
  }
  return `Agent: ${rawName}`;
}

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
    thread: "Thread",
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
      object: buildInfluencerLabel(params.persona_name),
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
  docs_affected?: string[];
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
    const seen = new Set<string>();
    for (const persona of params.personas_involved) {
      const label = buildInfluencerLabel(persona);
      if (seen.has(label)) continue; // dedup after normalization
      seen.add(label);
      triples.push({
        ...base,
        subject: subjectLabel,
        predicate: "influenced_by",
        object: label,
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

  // RULE 4: Each doc in docs_affected -> "affects_doc"
  if (params.docs_affected?.length) {
    for (const doc of params.docs_affected) {
      triples.push({
        ...base,
        subject: subjectLabel,
        predicate: "affects_doc",
        object: `Doc: ${doc}`,
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

// --- Thread Triple Extraction (Phase 4) ---

export interface ThreadCreationTripleParams {
  thread_id: string;
  text: string;
  linear_issue?: string;
  session_id?: string;
  project: string;
  agent: string;
}

/**
 * Extract triples from a newly created thread.
 * Pure function — no side effects.
 */
export function extractThreadCreationTriples(params: ThreadCreationTripleParams): TripleCandidate[] {
  const triples: TripleCandidate[] = [];
  const threadLabel = buildSubjectLabel("thread", params.text);
  const base = {
    source_type: "thread",
    source_id: params.thread_id,
    source_linear_issue: params.linear_issue,
    project: params.project,
    half_life_days: HALF_LIFE_PROCESS,
    created_by: params.agent,
  };

  // RULE 1: session_id -> "created_thread" (Session created this thread)
  if (params.session_id) {
    triples.push({
      ...base,
      subject: `Session: ${params.session_id}`,
      predicate: "created_thread",
      object: threadLabel,
    });
  }

  // RULE 2: linear_issue -> "relates_to_thread" (Thread relates to issue)
  if (params.linear_issue) {
    triples.push({
      ...base,
      subject: threadLabel,
      predicate: "relates_to_thread",
      object: `Issue: ${params.linear_issue}`,
    });
  }

  return triples;
}

export interface ThreadResolutionTripleParams {
  thread_id: string;
  text: string;
  resolution_note?: string;
  session_id?: string;
  project: string;
  agent: string;
}

/**
 * Extract triples from a resolved thread.
 * Pure function — no side effects.
 */
export function extractThreadResolutionTriples(params: ThreadResolutionTripleParams): TripleCandidate[] {
  const triples: TripleCandidate[] = [];
  const threadLabel = buildSubjectLabel("thread", params.text);
  const base = {
    source_type: "thread",
    source_id: params.thread_id,
    project: params.project,
    half_life_days: HALF_LIFE_PROCESS,
    created_by: params.agent,
  };

  // RULE 1: session_id -> "resolves_thread" (Session resolved this thread)
  if (params.session_id) {
    triples.push({
      ...base,
      subject: `Session: ${params.session_id}`,
      predicate: "resolves_thread",
      object: threadLabel,
    });
  }

  return triples;
}

/**
 * Generate and write triples for a newly created thread.
 * Fire-and-forget — call with .catch(() => {}).
 */
export function writeTriplesForThreadCreation(params: ThreadCreationTripleParams): Promise<number> {
  const triples = extractThreadCreationTriples(params);
  return writeTriples(triples);
}

/**
 * Generate and write triples for a resolved thread.
 * Fire-and-forget — call with .catch(() => {}).
 */
export function writeTriplesForThreadResolution(params: ThreadResolutionTripleParams): Promise<number> {
  const triples = extractThreadResolutionTriples(params);
  return writeTriples(triples);
}
