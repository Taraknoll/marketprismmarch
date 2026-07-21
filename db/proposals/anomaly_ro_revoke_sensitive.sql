-- =============================================================================
-- anomaly_ro_revoke_sensitive.sql  —  PROPOSAL ONLY. DO NOT let an automated
-- agent run this. The USER runs it by hand (Supabase SQL editor or psql), once.
-- =============================================================================
--
-- WHAT THIS IS
--   The `anomaly_search_ro` role (created by anomaly_ro_role.sql) currently holds
--   SELECT on ALL tables/views in schema public — that is how the Market Prism
--   agent's run_sql / describe_schema tools (api/anomaly-agent.js) reach the data.
--   "All of public" also includes customer PII, billing, per-user, and brokerage
--   tables that must NEVER be reachable through the public-facing agent.
--
--   The application already hard-blocks these at the SQL guard
--   (api/_ro_sql.js -> BLOCKED_RELATION_PATTERNS) and hides them from
--   describe_schema. THIS script is the database-level backstop: it REVOKEs the
--   role's SELECT on the same set, so even if the app guard were ever bypassed,
--   the database itself refuses to read them. Defense in depth, same philosophy
--   as anomaly_ro_role.sql.
--
-- WHAT IS AND IS NOT REVOKED
--   REVOKED (out of scope for the agent): billing (stripe_customers,
--   subscriptions), signup PII (email_signups, beta_signups, beta_activations,
--   "Beta User Sign Up"), per-user (user_watchlists, user_calendar_*), and the
--   brokerage layer (alpaca_trades*, alpaca_executions*, alpaca_account_daily).
--
--   NOT revoked, on purpose: service_account_keys and internal_api_keys are
--   CANARY / honeypot views (SELECT ... FROM _canary_trip('...')) — they hold no
--   real secrets and exist to trip an alarm on exfiltration attempts. Leaving the
--   role able to hit them preserves that tripwire for NON-agent vectors; the app
--   guard already stops the agent from surfacing their decoy rows.
--
-- HOW TO RUN (the USER runs this, manually)
--   1. Paste the whole file into the Supabase SQL editor and Run (pure SQL; no
--      psql meta-commands). It is idempotent — safe to re-run.
--   2. Confirm section 2's verification returns ZERO rows.
--
-- LIMITATION — FUTURE TABLES
--   anomaly_ro_role.sql set ALTER DEFAULT PRIVILEGES so FUTURE tables created by
--   `postgres` auto-grant SELECT to anomaly_search_ro. A NEW sensitive table
--   added later will therefore be readable until you re-run this REVOKE for it.
--   The app guard's family prefixes (stripe_, subscription, user_watchlists/
--   user_calendar_, beta_signups/activations, email_signups, alpaca_*) cover the
--   obvious future names on the app side, but the durable fix is to re-run this
--   (add the new relname to the list) whenever you add a PII/billing/brokerage
--   table — or house such tables in a separate schema the role has no USAGE on.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Revoke SELECT on the sensitive set (idempotent; skips any that don't exist).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  rel  text;
  sensitive text[] := ARRAY[
    -- billing / subscriptions
    'stripe_customers',
    'subscriptions',
    -- signup / email PII
    'email_signups',
    'beta_signups',
    'beta_activations',
    'Beta User Sign Up',
    -- per-user personal data
    'user_watchlists',
    'user_calendar_custom_events',
    'user_calendar_global_overrides',
    -- brokerage account / real order + execution log
    'alpaca_account_daily',
    'alpaca_trades',
    'alpaca_trades_daily_plays',
    'alpaca_trades_paper_v5',
    'alpaca_trades_paper_v6',
    'alpaca_executions',
    'alpaca_executions_daily_plays',
    'alpaca_executions_paper_v5',
    'alpaca_executions_paper_v6'
  ];
BEGIN
  FOREACH rel IN ARRAY sensitive LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = rel
    ) THEN
      -- %I safely double-quotes identifiers, including the space-named table.
      EXECUTE format('REVOKE SELECT ON public.%I FROM anomaly_search_ro', rel);
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- =============================================================================
-- 2. VERIFICATION — must return ZERO rows. Any row = the role can still read a
--    sensitive relation; investigate before relying on the boundary.
-- =============================================================================
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anomaly_search_ro'
  AND table_schema = 'public'
  AND table_name IN (
    'stripe_customers','subscriptions','email_signups','beta_signups',
    'beta_activations','Beta User Sign Up','user_watchlists',
    'user_calendar_custom_events','user_calendar_global_overrides',
    'alpaca_account_daily','alpaca_trades','alpaca_trades_daily_plays',
    'alpaca_trades_paper_v5','alpaca_trades_paper_v6','alpaca_executions',
    'alpaca_executions_daily_plays','alpaca_executions_paper_v5',
    'alpaca_executions_paper_v6'
  )
ORDER BY table_name, privilege_type;
-- ^ Expected: (0 rows).
-- =============================================================================
