-- ============================================================================
-- GIT-84 — nTEG production only: rename the usage table to match the prefix
-- ============================================================================
--
-- ⚠️  HUMAN REVIEW REQUIRED. NOT EXECUTED ANYWHERE. NOT FOR CUSTOMER STORES.
--
-- WHO NEEDS THIS
--   Only nTEG's own install, which runs with GITMEM_TABLE_PREFIX=orchestra_ but
--   whose usage table is named plain `scar_usage`. Customer stores created from
--   schema/setup.sql already have `gitmem_scar_usage` and need nothing.
--
-- WHY
--   Before GIT-84 the code wrote and read the literal table "scar_usage". After
--   GIT-84 it uses getTableName("scar_usage"), which on nTEG's install resolves
--   to `orchestra_scar_usage`. Upgrading nTEG's install without this migration
--   makes every usage write and read 404 there — the same silent loss GIT-84
--   fixes for customers.
--
-- WHAT IT DOES (one transaction; aborts on any surprise)
--   1. Asserts public.scar_usage is a table and public.orchestra_scar_usage does
--      not exist yet.
--   2. Renames scar_usage -> orchestra_scar_usage. Indexes, constraints, RLS
--      policies, grants and triggers move with the table.
--   3. Creates a compatibility VIEW named scar_usage over the renamed table, so
--      anything still using the old name (older gitmem clients, SQL functions,
--      edge functions, dashboards) keeps working unchanged. security_invoker
--      makes the view enforce the underlying table's RLS for the caller; without
--      it the view would run as its owner and bypass RLS.
--   4. Lists (RAISE NOTICE) every function in public whose body mentions
--      scar_usage, for the reviewer to update at leisure. PL/pgSQL resolves
--      table names at execution time, so those functions keep working through
--      the view in the meantime.
--
-- WHAT IT DOES NOT DO
--   - It does not rewrite nTEG's refresh_scar_behavioral_scores(). setup.sql's
--     copy gained an `IS DISTINCT FROM` guard in GIT-84 so unchanged rows are not
--     rewritten (which invalidated GIT-98's disk cache on every session_start).
--     nTEG's copy reads orchestra_* tables and was not inspected; apply the same
--     guard there by hand after reviewing its current definition (section 5).
--
-- BEFORE RUNNING
--   - Take a backup / confirm PITR.
--   - Run against a branch or staging copy first.
--   - Check the NOTICE output from step 4 and any edge functions that query
--     /rest/v1/scar_usage (they will keep working through the view).
--
-- ROLLBACK
--   BEGIN;
--   DROP VIEW public.scar_usage;
--   ALTER TABLE public.orchestra_scar_usage RENAME TO scar_usage;
--   COMMIT;
-- ============================================================================

BEGIN;

-- 1. Preconditions
DO $$
BEGIN
  IF to_regclass('public.scar_usage') IS NULL THEN
    RAISE EXCEPTION 'GIT-84: public.scar_usage not found — wrong database, or already migrated';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.scar_usage'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'GIT-84: public.scar_usage is not a plain table (already migrated to a view?)';
  END IF;
  IF to_regclass('public.orchestra_scar_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'GIT-84: public.orchestra_scar_usage already exists — refusing to overwrite';
  END IF;
END $$;

-- 2. Rename (policies, indexes, constraints, grants, triggers follow the table)
ALTER TABLE public.scar_usage RENAME TO orchestra_scar_usage;

-- 3. Compatibility alias under the old name. A single-table SELECT * view is
--    auto-updatable, so INSERT/UPDATE/DELETE through it still work.
CREATE VIEW public.scar_usage
  WITH (security_invoker = true)
  AS SELECT * FROM public.orchestra_scar_usage;

COMMENT ON VIEW public.scar_usage IS
  'GIT-84 compatibility alias for orchestra_scar_usage. Drop once nothing reads the old name.';

-- Match the table's grants for the Supabase API roles (RLS still applies via security_invoker).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scar_usage TO service_role;

-- 4. Report functions that still name the old table (informational)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc ~ '\mscar_usage\M'
  LOOP
    RAISE NOTICE 'GIT-84: function % mentions scar_usage (works via the view; update when convenient)', r.fn;
  END LOOP;
END $$;

-- 5. (Manual, after review) Apply the GIT-84 guard to nTEG's
--    refresh_scar_behavioral_scores(): add to its UPDATE ... WHERE clause
--      AND l.decay_multiplier IS DISTINCT FROM <the same GREATEST(...) expression>
--    so rows whose multiplier does not change are not rewritten.

COMMIT;
