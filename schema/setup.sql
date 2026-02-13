-- GitMem Schema Setup
-- Run this SQL in your Supabase SQL Editor to create the required tables.
-- Dashboard → SQL Editor → New query → Paste → Run

-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Learnings table (scars, wins, patterns)
-- ============================================================================
CREATE TABLE IF NOT EXISTS gitmem_learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_type TEXT NOT NULL CHECK (learning_type IN ('scar', 'win', 'pattern', 'anti_pattern')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  scar_type TEXT DEFAULT 'operational',
  counter_arguments TEXT[] DEFAULT '{}',
  problem_context TEXT DEFAULT '',
  solution_approach TEXT DEFAULT '',
  applies_when TEXT[] DEFAULT '{}',
  keywords TEXT[] DEFAULT '{}',
  domain TEXT[] DEFAULT '{}',
  embedding vector(1536),
  project TEXT DEFAULT 'default',
  source_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster vector search
CREATE INDEX IF NOT EXISTS idx_gitmem_learnings_embedding
  ON gitmem_learnings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

CREATE INDEX IF NOT EXISTS idx_gitmem_learnings_type
  ON gitmem_learnings (learning_type);

CREATE INDEX IF NOT EXISTS idx_gitmem_learnings_project
  ON gitmem_learnings (project);

-- ============================================================================
-- Sessions table
-- ============================================================================
CREATE TABLE IF NOT EXISTS gitmem_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_title TEXT DEFAULT 'Interactive Session',
  session_date DATE DEFAULT CURRENT_DATE,
  agent TEXT DEFAULT 'Unknown',
  project TEXT DEFAULT 'default',
  decisions TEXT[] DEFAULT '{}',
  open_threads TEXT[] DEFAULT '{}',
  closing_reflection JSONB,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gitmem_sessions_agent
  ON gitmem_sessions (agent);

CREATE INDEX IF NOT EXISTS idx_gitmem_sessions_created
  ON gitmem_sessions (created_at DESC);

-- ============================================================================
-- Decisions table
-- ============================================================================
CREATE TABLE IF NOT EXISTS gitmem_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_date DATE DEFAULT CURRENT_DATE,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  alternatives_considered TEXT[] DEFAULT '{}',
  session_id UUID REFERENCES gitmem_sessions(id),
  project TEXT DEFAULT 'default',
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gitmem_decisions_session
  ON gitmem_decisions (session_id);

-- ============================================================================
-- Scar usage tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS gitmem_scar_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scar_id UUID REFERENCES gitmem_learnings(id),
  session_id UUID REFERENCES gitmem_sessions(id),
  agent TEXT DEFAULT 'Unknown',
  reference_type TEXT CHECK (reference_type IN ('explicit', 'implicit', 'acknowledged', 'refuted', 'none')),
  reference_context TEXT,
  surfaced_at TIMESTAMPTZ,
  execution_successful BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gitmem_scar_usage_scar
  ON gitmem_scar_usage (scar_id);

CREATE INDEX IF NOT EXISTS idx_gitmem_scar_usage_session
  ON gitmem_scar_usage (session_id);

-- ============================================================================
-- Semantic search RPC function
-- ============================================================================
CREATE OR REPLACE FUNCTION gitmem_semantic_search(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  severity TEXT,
  counter_arguments TEXT[],
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    l.id,
    l.title,
    l.description,
    l.severity,
    l.counter_arguments,
    1 - (l.embedding <=> query_embedding) AS similarity
  FROM gitmem_learnings l
  WHERE l.embedding IS NOT NULL
    AND 1 - (l.embedding <=> query_embedding) > similarity_threshold
  ORDER BY l.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Row Level Security
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE gitmem_learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gitmem_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gitmem_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gitmem_scar_usage ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by the MCP server)
CREATE POLICY "Service role full access" ON gitmem_learnings
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON gitmem_sessions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON gitmem_decisions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON gitmem_scar_usage
  FOR ALL USING (auth.role() = 'service_role');

-- Block anonymous access
CREATE POLICY "Block anonymous access" ON gitmem_learnings
  FOR ALL USING (auth.role() != 'anon');

CREATE POLICY "Block anonymous access" ON gitmem_sessions
  FOR ALL USING (auth.role() != 'anon');

CREATE POLICY "Block anonymous access" ON gitmem_decisions
  FOR ALL USING (auth.role() != 'anon');

CREATE POLICY "Block anonymous access" ON gitmem_scar_usage
  FOR ALL USING (auth.role() != 'anon');

-- ============================================================================
-- Auto-update timestamps
-- ============================================================================
CREATE OR REPLACE FUNCTION gitmem_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gitmem_learnings_updated
  BEFORE UPDATE ON gitmem_learnings
  FOR EACH ROW EXECUTE FUNCTION gitmem_update_timestamp();

CREATE TRIGGER gitmem_sessions_updated
  BEFORE UPDATE ON gitmem_sessions
  FOR EACH ROW EXECUTE FUNCTION gitmem_update_timestamp();
