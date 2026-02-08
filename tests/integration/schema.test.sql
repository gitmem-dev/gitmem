-- GitMem Schema Tests (pgTAP)
--
-- These tests verify the database schema is correctly set up.
-- Run via pgTAP in the Testcontainer.
--
-- Reference: docs/planning/gitmem-regression-testing-plan.md

-- Enable pgTAP extension (if available)
-- CREATE EXTENSION IF NOT EXISTS pgtap;

-- ============================================================================
-- Extension Tests
-- ============================================================================

-- Verify pgvector is installed
SELECT has_extension('vector', 'pgvector extension should be installed');

-- ============================================================================
-- Table Existence Tests
-- ============================================================================

SELECT has_table('gitmem_learnings', 'gitmem_learnings table should exist');
SELECT has_table('gitmem_sessions', 'gitmem_sessions table should exist');
SELECT has_table('gitmem_decisions', 'gitmem_decisions table should exist');
SELECT has_table('gitmem_scar_usage', 'gitmem_scar_usage table should exist');

-- ============================================================================
-- Column Tests: gitmem_learnings
-- ============================================================================

SELECT has_column('gitmem_learnings', 'id', 'learnings should have id column');
SELECT has_column('gitmem_learnings', 'learning_type', 'learnings should have learning_type column');
SELECT has_column('gitmem_learnings', 'title', 'learnings should have title column');
SELECT has_column('gitmem_learnings', 'description', 'learnings should have description column');
SELECT has_column('gitmem_learnings', 'severity', 'learnings should have severity column');
SELECT has_column('gitmem_learnings', 'counter_arguments', 'learnings should have counter_arguments column');
SELECT has_column('gitmem_learnings', 'embedding', 'learnings should have embedding column');
SELECT has_column('gitmem_learnings', 'project', 'learnings should have project column');
SELECT has_column('gitmem_learnings', 'created_at', 'learnings should have created_at column');

-- ============================================================================
-- Column Tests: gitmem_sessions
-- ============================================================================

SELECT has_column('gitmem_sessions', 'id', 'sessions should have id column');
SELECT has_column('gitmem_sessions', 'session_title', 'sessions should have session_title column');
SELECT has_column('gitmem_sessions', 'agent', 'sessions should have agent column');
SELECT has_column('gitmem_sessions', 'project', 'sessions should have project column');
SELECT has_column('gitmem_sessions', 'decisions', 'sessions should have decisions column');
SELECT has_column('gitmem_sessions', 'closing_reflection', 'sessions should have closing_reflection column');
SELECT has_column('gitmem_sessions', 'embedding', 'sessions should have embedding column');

-- ============================================================================
-- Column Tests: gitmem_decisions
-- ============================================================================

SELECT has_column('gitmem_decisions', 'id', 'decisions should have id column');
SELECT has_column('gitmem_decisions', 'title', 'decisions should have title column');
SELECT has_column('gitmem_decisions', 'decision', 'decisions should have decision column');
SELECT has_column('gitmem_decisions', 'rationale', 'decisions should have rationale column');
SELECT has_column('gitmem_decisions', 'session_id', 'decisions should have session_id column');
SELECT has_column('gitmem_decisions', 'embedding', 'decisions should have embedding column');

-- ============================================================================
-- Index Tests (CRITICAL for performance)
-- ============================================================================

-- Golden regression: Missing indexes caused 51s query
SELECT has_index('gitmem_learnings', 'idx_gitmem_learnings_embedding',
  'learnings should have embedding index for vector search');

SELECT has_index('gitmem_learnings', 'idx_gitmem_learnings_type',
  'learnings should have type index for filtered queries');

SELECT has_index('gitmem_learnings', 'idx_gitmem_learnings_project',
  'learnings should have project index for multi-tenant queries');

SELECT has_index('gitmem_sessions', 'idx_gitmem_sessions_agent',
  'sessions should have agent index');

SELECT has_index('gitmem_sessions', 'idx_gitmem_sessions_created',
  'sessions should have created_at index for recent queries');

SELECT has_index('gitmem_decisions', 'idx_gitmem_decisions_session',
  'decisions should have session_id index');

SELECT has_index('gitmem_scar_usage', 'idx_gitmem_scar_usage_scar',
  'scar_usage should have scar_id index');

SELECT has_index('gitmem_scar_usage', 'idx_gitmem_scar_usage_session',
  'scar_usage should have session_id index');

-- ============================================================================
-- Index Type Tests
-- ============================================================================

-- Verify embedding index uses IVFFlat for approximate nearest neighbor search
SELECT index_is_type('gitmem_learnings', 'idx_gitmem_learnings_embedding', 'ivfflat',
  'embedding index should use IVFFlat for vector search');

-- ============================================================================
-- Constraint Tests
-- ============================================================================

-- learning_type constraint
SELECT col_has_check('gitmem_learnings', 'learning_type',
  'learning_type should have CHECK constraint');

-- severity constraint
SELECT col_has_check('gitmem_learnings', 'severity',
  'severity should have CHECK constraint');

-- reference_type constraint
SELECT col_has_check('gitmem_scar_usage', 'reference_type',
  'reference_type should have CHECK constraint');

-- ============================================================================
-- Foreign Key Tests
-- ============================================================================

SELECT has_fk('gitmem_decisions', 'gitmem_decisions_session_id_fkey',
  'decisions should have FK to sessions');

SELECT has_fk('gitmem_scar_usage', 'gitmem_scar_usage_scar_id_fkey',
  'scar_usage should have FK to learnings');

SELECT has_fk('gitmem_scar_usage', 'gitmem_scar_usage_session_id_fkey',
  'scar_usage should have FK to sessions');

-- ============================================================================
-- Function Tests
-- ============================================================================

SELECT has_function('gitmem_semantic_search',
  'semantic search RPC function should exist');

SELECT has_function('gitmem_update_timestamp',
  'timestamp update trigger function should exist');

-- ============================================================================
-- Trigger Tests
-- ============================================================================

SELECT has_trigger('gitmem_learnings', 'gitmem_learnings_updated',
  'learnings should have update timestamp trigger');

SELECT has_trigger('gitmem_sessions', 'gitmem_sessions_updated',
  'sessions should have update timestamp trigger');

-- ============================================================================
-- RLS Tests (if RLS is enabled)
-- ============================================================================

-- Note: RLS tests depend on the authentication setup
-- These are placeholder assertions for when RLS is verified

-- SELECT has_policy('gitmem_learnings', 'Service role full access',
--   'learnings should have service role policy');

-- ============================================================================
-- End of tests
-- ============================================================================

-- SELECT * FROM finish();
