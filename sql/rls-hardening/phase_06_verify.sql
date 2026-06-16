-- Phase 6 verification.
-- Expected: both functions show security_definer=true and a search_path config.

SELECT
  p.oid::regprocedure                                   AS function_sig,
  p.prosecdef                                           AS security_definer,
  (SELECT array_agg(c) FROM unnest(p.proconfig) c
     WHERE c LIKE 'search_path=%')                      AS search_path_config,
  has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('strategy_pub_breakdown', 'strategy_theme_breakdown')
ORDER BY p.proname;

-- Expected per row:
--   security_definer   = true
--   search_path_config = {search_path=public, pg_temp}
--   anon_can_execute   = true
--   auth_can_execute   = true

-- Functional check (runs as the current SQL-editor role = service_role, so it
-- returns rows regardless of the fix — the REAL test is the anon REST curl in
-- the forward migration's footer).
-- SELECT * FROM public.strategy_pub_breakdown('MSFT') LIMIT 5;
