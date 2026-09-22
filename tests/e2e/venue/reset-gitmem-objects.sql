-- GIT-83: return the DISPOSABLE venue to a blank slate so a setup.sql lands
-- exactly as it would on a new customer project. Drops only the objects
-- schema/setup.sql creates. Run only through scripts/venue-schema.sh, which
-- refuses production and any database that is not the configured venue.
DROP TABLE IF EXISTS
  gitmem_license_activations, gitmem_licenses,
  gitmem_scar_usage, gitmem_decisions, gitmem_threads, knowledge_triples,
  gitmem_query_metrics, scar_enforcement_variants,
  gitmem_learnings, gitmem_sessions
  CASCADE;  -- also removes the *_lite views, triggers and policies
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN
             ('gitmem_semantic_search','gitmem_scar_search','refresh_scar_behavioral_scores',
              'gitmem_update_timestamp','gitmem_validate_license','gitmem_deactivate_device')
  LOOP EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE'; END LOOP;
END $$;
-- PostgREST must see the new shape before the driver's first request.
NOTIFY pgrst, 'reload schema';
