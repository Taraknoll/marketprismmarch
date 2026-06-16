-- Phase 6 rollback — revert the two strategy RPCs to SECURITY INVOKER and
-- drop the pinned search_path. After this, they once again return EMPTY under
-- the anon key (because `articles` stays RLS-locked) and the panel falls back
-- to global source_scores. Run only if the DEFINER change causes a regression.

BEGIN;

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('strategy_pub_breakdown', 'strategy_theme_breakdown')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', fn.sig);
    EXECUTE format('ALTER FUNCTION %s RESET search_path', fn.sig);
    RAISE NOTICE 'Reverted % → SECURITY INVOKER', fn.sig;
  END LOOP;
END $$;

COMMIT;
