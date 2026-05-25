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
  is_active BOOLEAN DEFAULT true,
  decay_multiplier FLOAT DEFAULT 1.0,
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
-- Scar search with temporal + behavioral decay weighting
-- ============================================================================
CREATE OR REPLACE FUNCTION gitmem_scar_search(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  severity TEXT,
  scar_type TEXT,
  counter_arguments TEXT[],
  decay_multiplier FLOAT,
  similarity FLOAT,
  weighted_similarity FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  decay_days INT;
  temporal_weight FLOAT;
BEGIN
  RETURN QUERY
  SELECT
    l.id,
    l.title,
    l.description,
    l.severity,
    l.scar_type,
    l.counter_arguments,
    COALESCE(l.decay_multiplier, 1.0) AS decay_multiplier,
    (1 - (l.embedding <=> query_embedding))::FLOAT AS similarity,
    -- Weighted similarity: raw * temporal_decay * behavioral_decay
    (
      (1 - (l.embedding <=> query_embedding)) *
      -- Temporal decay based on scar_type
      CASE
        WHEN l.scar_type = 'process' THEN 1.0  -- permanent
        WHEN l.scar_type = 'incident' THEN
          GREATEST(0.1, 1.0 - 0.9 * (EXTRACT(EPOCH FROM (NOW() - l.created_at)) / (180.0 * 86400)))
        WHEN l.scar_type = 'context' THEN
          GREATEST(0.1, 1.0 - 0.9 * (EXTRACT(EPOCH FROM (NOW() - l.created_at)) / (30.0 * 86400)))
        ELSE 1.0  -- default: no decay
      END *
      -- Behavioral decay multiplier
      COALESCE(l.decay_multiplier, 1.0)
    )::FLOAT AS weighted_similarity
  FROM gitmem_learnings l
  WHERE l.embedding IS NOT NULL
    AND COALESCE(l.is_active, true) = true
    AND (1 - (l.embedding <=> query_embedding)) > similarity_threshold
  ORDER BY weighted_similarity DESC
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Refresh behavioral decay scores from scar_usage patterns
-- Aggregates last 90 days of usage, computes dismiss rate,
-- updates decay_multiplier on learnings (minimum 3 surfacings required)
-- ============================================================================
CREATE OR REPLACE FUNCTION refresh_scar_behavioral_scores()
RETURNS TABLE (scars_updated INT, scars_scanned INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_scanned INT := 0;
  v_updated INT := 0;
BEGIN
  -- Aggregate scar_usage from last 90 days, compute dismiss rate
  WITH usage_stats AS (
    SELECT
      su.scar_id,
      COUNT(*) AS times_surfaced,
      COUNT(*) FILTER (WHERE su.reference_type IN ('none', 'refuted')) AS times_dismissed
    FROM gitmem_scar_usage su
    WHERE su.surfaced_at >= NOW() - INTERVAL '90 days'
    GROUP BY su.scar_id
    HAVING COUNT(*) >= 3  -- minimum surfacings for meaningful signal
  )
  UPDATE gitmem_learnings l
  SET decay_multiplier = GREATEST(0.1, 1.0 - (us.times_dismissed::FLOAT / us.times_surfaced::FLOAT) * 0.8),
      updated_at = NOW()
  FROM usage_stats us
  WHERE l.id = us.scar_id
    AND COALESCE(l.is_active, true) = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT COUNT(DISTINCT scar_id) INTO v_scanned
  FROM gitmem_scar_usage
  WHERE surfaced_at >= NOW() - INTERVAL '90 days';

  RETURN QUERY SELECT v_updated, v_scanned;
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

-- ============================================================================
-- License Management Tables (deployed on GitMem's infrastructure, not user's)
-- These tables are included here for reference and for our own deployment.
-- Users do NOT need to run these — they exist on gitmem-api.supabase.co
-- ============================================================================

CREATE TABLE IF NOT EXISTS gitmem_licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'pro' CHECK (tier IN ('pro', 'dev')),
  owner_email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  max_activations INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_validated_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS gitmem_license_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id UUID NOT NULL REFERENCES gitmem_licenses(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_info JSONB DEFAULT '{}',
  UNIQUE(license_id, install_id)
);

-- RLS: service role only (these are admin tables on our infrastructure)
ALTER TABLE gitmem_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE gitmem_license_activations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON gitmem_licenses
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON gitmem_license_activations
  FOR ALL USING (auth.role() = 'service_role');

-- Index for fast key lookup
CREATE INDEX IF NOT EXISTS idx_gitmem_licenses_api_key
  ON gitmem_licenses (api_key);

CREATE INDEX IF NOT EXISTS idx_gitmem_license_activations_license
  ON gitmem_license_activations (license_id);

-- ============================================================================
-- License Validation RPC
-- Checks key validity, device limit, registers/updates activation
-- ============================================================================
CREATE OR REPLACE FUNCTION gitmem_validate_license(p_api_key TEXT, p_install_id TEXT)
RETURNS TABLE(tier TEXT, valid BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_license_id UUID;
  v_tier TEXT;
  v_is_active BOOLEAN;
  v_max_activations INTEGER;
  v_expires_at TIMESTAMPTZ;
  v_current_activations INTEGER;
BEGIN
  -- Look up the license
  SELECT l.id, l.tier, l.is_active, l.max_activations, l.expires_at
  INTO v_license_id, v_tier, v_is_active, v_max_activations, v_expires_at
  FROM gitmem_licenses l
  WHERE l.api_key = p_api_key;

  -- Key not found
  IF v_license_id IS NULL THEN
    RETURN QUERY SELECT NULL::TEXT, false, 'Invalid license key'::TEXT;
    RETURN;
  END IF;

  -- Key deactivated
  IF NOT v_is_active THEN
    RETURN QUERY SELECT NULL::TEXT, false, 'License has been deactivated'::TEXT;
    RETURN;
  END IF;

  -- Key expired
  IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
    RETURN QUERY SELECT NULL::TEXT, false, 'License has expired'::TEXT;
    RETURN;
  END IF;

  -- Count current activations (excluding this install_id if already registered)
  SELECT COUNT(*)
  INTO v_current_activations
  FROM gitmem_license_activations a
  WHERE a.license_id = v_license_id
    AND a.install_id != p_install_id;

  -- Check device limit (if this is a new device)
  IF v_current_activations >= v_max_activations THEN
    -- Check if this install_id already exists (re-validation)
    IF NOT EXISTS (
      SELECT 1 FROM gitmem_license_activations a
      WHERE a.license_id = v_license_id AND a.install_id = p_install_id
    ) THEN
      RETURN QUERY SELECT NULL::TEXT, false,
        format('Device limit reached (%s/%s). Deactivate another device or contact support.', v_current_activations, v_max_activations)::TEXT;
      RETURN;
    END IF;
  END IF;

  -- Register or update activation
  INSERT INTO gitmem_license_activations (license_id, install_id, last_seen_at)
  VALUES (v_license_id, p_install_id, NOW())
  ON CONFLICT (license_id, install_id)
  DO UPDATE SET last_seen_at = NOW();

  -- Update last_validated_at on the license
  UPDATE gitmem_licenses SET last_validated_at = NOW() WHERE id = v_license_id;

  -- Success
  RETURN QUERY SELECT v_tier, true, 'Valid'::TEXT;
END;
$$;
