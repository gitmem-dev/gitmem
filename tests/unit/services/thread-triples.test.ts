/**
 * Unit tests for Thread Knowledge Graph Triples (Phase 4)
 *
 * Pure function tests — no mocks, no filesystem, no network.
 * Tests extractThreadCreationTriples and extractThreadResolutionTriples.
 */

import { describe, it, expect } from "vitest";
import {
  extractThreadCreationTriples,
  extractThreadResolutionTriples,
} from "../../../src/services/triple-writer.js";
import type {
  ThreadCreationTripleParams,
  ThreadResolutionTripleParams,
} from "../../../src/services/triple-writer.js";

// ---------- Helpers ----------

// GIT-105: source_id is the thread's row id (gitmem_threads.id, a UUID), not
// its "t-" thread_id — knowledge_triples.source_id is a UUID column.
const THREAD_ROW_ID = "7d1c9a52-3f4e-4b8a-9c21-5e6f7a8b9c0d";

const BASE_CREATION_PARAMS: ThreadCreationTripleParams = {
  thread_id: "t-abc12345",
  thread_row_id: THREAD_ROW_ID,
  text: "Fix auth timeout in production",
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  linear_issue: "PROJ-123",
  project: "test-project",
  agent: "CLI",
};

const BASE_RESOLUTION_PARAMS: ThreadResolutionTripleParams = {
  thread_id: "t-abc12345",
  thread_row_id: THREAD_ROW_ID,
  text: "Fix auth timeout in production",
  resolution_note: "Fixed by increasing timeout to 30s",
  session_id: "660e8400-e29b-41d4-a716-446655440000",
  project: "test-project",
  agent: "CLI",
};

// ===========================================================================
// 1. extractThreadCreationTriples
// ===========================================================================

describe("extractThreadCreationTriples", () => {
  it("creates created_thread triple when session_id is provided", () => {
    const triples = extractThreadCreationTriples(BASE_CREATION_PARAMS);

    const createdTriple = triples.find((t) => t.predicate === "created_thread");
    expect(createdTriple).toBeDefined();
    expect(createdTriple!.subject).toBe(
      `Session: ${BASE_CREATION_PARAMS.session_id}`
    );
    expect(createdTriple!.object).toBe(
      "Thread: Fix auth timeout in production"
    );
  });

  it("creates relates_to_thread triple when linear_issue is provided", () => {
    const triples = extractThreadCreationTriples(BASE_CREATION_PARAMS);

    const relatesTriple = triples.find(
      (t) => t.predicate === "relates_to_thread"
    );
    expect(relatesTriple).toBeDefined();
    expect(relatesTriple!.subject).toBe(
      "Thread: Fix auth timeout in production"
    );
    expect(relatesTriple!.object).toBe("Issue: PROJ-123");
  });

  it("creates 2 triples when both session_id and linear_issue present", () => {
    const triples = extractThreadCreationTriples(BASE_CREATION_PARAMS);
    expect(triples).toHaveLength(2);

    const predicates = triples.map((t) => t.predicate).sort();
    expect(predicates).toEqual(["created_thread", "relates_to_thread"]);
  });

  it("returns empty array when session_id is absent and no linear_issue", () => {
    const triples = extractThreadCreationTriples({
      ...BASE_CREATION_PARAMS,
      session_id: undefined,
      linear_issue: undefined,
    });
    expect(triples).toHaveLength(0);
  });

  it("sets correct source_type and half_life on all triples", () => {
    const triples = extractThreadCreationTriples(BASE_CREATION_PARAMS);

    for (const triple of triples) {
      expect(triple.source_type).toBe("thread");
      // GIT-105: was "t-abc12345", which the UUID column rejects (22P02).
      expect(triple.source_id).toBe(THREAD_ROW_ID);
      expect(triple.half_life_days).toBe(9999);
      expect(triple.project).toBe("test-project");
      expect(triple.created_by).toBe("CLI");
    }
  });
});

// ===========================================================================
// 2. extractThreadResolutionTriples
// ===========================================================================

describe("extractThreadResolutionTriples", () => {
  it("creates resolves_thread triple when session_id is provided", () => {
    const triples = extractThreadResolutionTriples(BASE_RESOLUTION_PARAMS);

    expect(triples).toHaveLength(1);
    expect(triples[0].predicate).toBe("resolves_thread");
    expect(triples[0].subject).toBe(
      `Session: ${BASE_RESOLUTION_PARAMS.session_id}`
    );
    expect(triples[0].object).toBe(
      "Thread: Fix auth timeout in production"
    );
  });

  it("returns empty array when session_id is absent", () => {
    const triples = extractThreadResolutionTriples({
      ...BASE_RESOLUTION_PARAMS,
      session_id: undefined,
    });
    expect(triples).toHaveLength(0);
  });

  it("has correct subject/object labels", () => {
    const triples = extractThreadResolutionTriples(BASE_RESOLUTION_PARAMS);

    const triple = triples[0];
    expect(triple.subject).toMatch(/^Session: /);
    expect(triple.object).toMatch(/^Thread: /);
    expect(triple.source_type).toBe("thread");
    // GIT-105: was "t-abc12345", which the UUID column rejects (22P02).
    expect(triple.source_id).toBe(THREAD_ROW_ID);
  });

  it("without a row id, source_id is null — never the thread_id (GIT-105)", () => {
    for (const t of [
      ...extractThreadCreationTriples({ ...BASE_CREATION_PARAMS, thread_row_id: null }),
      ...extractThreadResolutionTriples({ ...BASE_RESOLUTION_PARAMS, thread_row_id: undefined }),
    ]) {
      expect(t.source_id).toBeNull();
    }
  });
});

// ===========================================================================
// 3. buildSubjectLabel — thread type
// ===========================================================================

describe("buildSubjectLabel for threads", () => {
  it("uses Thread prefix for thread labels", () => {
    // extractThreadCreationTriples uses buildSubjectLabel("thread", text) internally
    const triples = extractThreadCreationTriples({
      ...BASE_CREATION_PARAMS,
      linear_issue: undefined, // only creation triple
    });

    expect(triples).toHaveLength(1);
    expect(triples[0].object).toBe("Thread: Fix auth timeout in production");
  });
});

// ===========================================================================
// 4. Integration sanity
// ===========================================================================

describe("Thread triple integration", () => {
  it("creation and resolution triples reference the same Thread label", () => {
    const creationTriples = extractThreadCreationTriples(BASE_CREATION_PARAMS);
    const resolutionTriples = extractThreadResolutionTriples(
      BASE_RESOLUTION_PARAMS
    );

    // The created_thread triple's object should match the resolves_thread triple's object
    const createdObject = creationTriples.find(
      (t) => t.predicate === "created_thread"
    )!.object;
    const resolvedObject = resolutionTriples.find(
      (t) => t.predicate === "resolves_thread"
    )!.object;

    expect(createdObject).toBe(resolvedObject);
    expect(createdObject).toBe("Thread: Fix auth timeout in production");
  });
});
