-- Phase 6 — Re-enable two read-path RPCs that broke when `articles` was
-- locked down. Follow-up to the "SECURITY DEFINER functions" item the
-- README defers under "What this does NOT cover".
--
-- THE PROBLEM:
-- public.articles has RLS ENABLED with ZERO policies (crown-jewel / licensed
-- third-party news content — see the reuters_purge_* / marketbeat_purge_*
-- backups). So anon-key callers read 0 rows from it. Both of these RPCs are
-- LANGUAGE sql with INVOKER rights and read `articles`, so under the anon key
-- they silently return EMPTY even though they return rows under service_role
-- (verified in SQL: MSFT 46, BUD 14, AAPL 43, NVDA 54).
--
-- Impact: the Stock Forensics → Trading Strategy "Publication Signal Quality"
-- panel (_ticker.html / _dev_ticker.html) never gets the per-ticker live
-- hit-rate view in the browser — it always falls through to the global
-- source_scores fallback.
--
-- THE FIX (option 2 of 2 — the safe one):
-- Make the two functions SECURITY DEFINER with a locked search_path. They then
-- read `articles` with the function OWNER's privileges (postgres, which has
-- BYPASSRLS) WITHOUT granting anon any direct access to the table. The
-- functions only return AGGREGATED stats (publication_name, hit_rate,
-- article_count, bearish/bullish counts / theme rollups) — never raw article
-- text — so exposing the aggregate to anon is acceptable. `articles` stays
-- locked.
--
-- We deliberately did NOT take option 1 (a public-read policy on `articles`):
-- that would re-open a licensed-content crown jewel to anon-key harvesting,
-- directly contradicting Phase 4.
--
-- search_path is pinned to (public, pg_temp) — the standard hardening for any
-- SECURITY DEFINER function, so a caller cannot shadow a referenced object via
-- a hostile search_path.
--
-- The dynamic loop resolves each function's full signature from pg_proc, so it
-- works regardless of the exact argument type/overloads (the public REST param
-- is `ticker_param`). EXECUTE is already granted to anon (the calls return
-- empty, not 403, today) but we re-grant explicitly to be safe + idempotent.
--
-- Risk: low. Read-only aggregate functions; no table policies change.
-- Reversible: yes — phase_06_rollback.sql flips them back to SECURITY INVOKER.

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
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', fn.sig);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn.sig);
    RAISE NOTICE 'Hardened % → SECURITY DEFINER, search_path pinned', fn.sig;
  END LOOP;
END $$;

COMMIT;

-- After COMMIT, verify through the ANON REST endpoint (not just SQL):
--
--   curl -s "https://kugfvlagaetiqtdwdfmk.supabase.co/rest/v1/rpc/strategy_pub_breakdown?ticker_param=MSFT" \
--     -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
--
-- Expect a non-empty JSON array. Note hit_rate comes back on a 0-100 scale
-- (NOT a 0-1 fraction) — both _ticker.html and _dev_ticker.html handle this.
