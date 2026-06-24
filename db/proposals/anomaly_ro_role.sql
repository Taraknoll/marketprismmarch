-- =============================================================================
-- anomaly_ro_role.sql  —  PROPOSAL ONLY. DO NOT let an automated agent run this.
-- =============================================================================
--
-- WHAT THIS IS
--   The dedicated, SELECT-only Postgres login role that backs the anomaly-search
--   read-only executor used by the marketprismmarch agent endpoint
--   (api/anomaly-agent.js). That endpoint runs a Claude tool-calling loop and the
--   read-only DB tools connect with the `pg` package via env
--   ANOMALY_RO_DATABASE_URL using THIS role. Every generated query is a single
--   SELECT/WITH wrapped in `SET TRANSACTION READ ONLY; SET LOCAL
--   statement_timeout='5000ms'; <sql>` with a hard LIMIT <= 50.
--
--   This role is the REAL sandbox: even if the application-layer SQL guard is ever
--   bypassed, the database itself refuses any write because the role has been
--   granted ZERO write privileges. The READ ONLY transaction + statement_timeout +
--   single-statement guard in the endpoint are defense-in-depth on top of it.
--
-- WHY A SEPARATE ROLE (deviation rationale)
--   The rest of the site talks to Supabase with the anon or service-role key.
--   Free-form / LLM-proposed SQL must NEVER run with those credentials. A purpose-
--   built role with SELECT-only grants + a hard statement_timeout is defense in
--   depth: application guard (single-SELECT only, reject DDL/DML tokens) AND a
--   read-only transaction AND a role that physically cannot write. Three
--   independent layers.
--
-- HOW TO RUN (the USER runs this, manually, once — Supabase SQL editor or psql)
--   1. Set a strong password: replace REPLACE_WITH_A_STRONG_PASSWORD in the
--      CREATE ROLE statement (section 1 below). This file is PURE SQL — paste the
--      whole thing into the Supabase SQL editor and Run. (No psql \backslash
--      meta-commands; those only work in the psql CLI.)
--   2. Build ANOMALY_RO_DATABASE_URL from this role's credentials and add it to
--      the Vercel server env (server-only — NEVER a client-exposed var).
--
--      IMPORTANT — USE THE SUPABASE POOLER (TRANSACTION MODE) CONNECTION STRING.
--      marketprismmarch runs as Vercel CommonJS serverless functions. Each cold
--      start would otherwise open a fresh direct Postgres connection and exhaust
--      the database's connection slots. Connect through the Supabase connection
--      POOLER in TRANSACTION mode (PgBouncer, port 6543), e.g.:
--
--        ANOMALY_RO_DATABASE_URL=postgresql://anomaly_search_ro:<password>@<project-ref>.pooler.supabase.com:6543/postgres?sslmode=require
--
--      Notes for the pooler:
--        * Port 6543 = transaction-mode pooler. Do NOT use 5432 (direct/session)
--          for serverless — that is for long-lived processes only.
--        * The `pg` Pool in api/anomaly-agent.js should be module-scoped and tiny
--          (max 1-2) so a warm function reuses one pooled connection.
--        * Transaction-mode pooling does not support session-level features like
--          prepared statements across statements; the executor's single
--          SELECT-per-transaction pattern is compatible.
--        * The role's ALTER ROLE ... SET defaults below (statement_timeout,
--          default_transaction_read_only) are applied per session by the pooler.
--
-- SAFETY CONTRACT (enforced below)
--   * NO INSERT / UPDATE / DELETE / TRUNCATE grants — anywhere, ever.
--   * NO DDL privileges (no CREATE on schema public => cannot create objects).
--   * NO superuser, NO createdb, NO createrole, NO replication, NO bypassrls.
--   * Connection-scoped statement_timeout so a pathological query self-aborts.
--   * default_transaction_read_only = on so every session is read-only by default.
--   * Idempotent: safe to re-run; uses guards / IF NOT EXISTS where possible.
--
-- This file emits NO DML against application tables. It only manages the role and
-- its privileges. We (the assistant) never execute it — the USER runs it by hand.
-- =============================================================================

-- Pure SQL only — runs in the Supabase SQL editor. Set the role password in the
-- CREATE ROLE statement below (replace REPLACE_WITH_A_STRONG_PASSWORD) before running.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Create the login role (idempotent). LOGIN + a password; nothing else.
--    Explicitly NO write/admin capabilities at the role-attribute level.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anomaly_search_ro') THEN
    EXECUTE format(
      'CREATE ROLE anomaly_search_ro LOGIN PASSWORD %L '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '
      || 'CONNECTION LIMIT 8',
      'REPLACE_WITH_A_STRONG_PASSWORD'   -- <<< EDIT: set a strong password before running
    );
  ELSE
    -- Role already exists — re-assert the safe attributes (never widens them).
    EXECUTE 'ALTER ROLE anomaly_search_ro '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '
      || 'CONNECTION LIMIT 8';
  END IF;
END
$$;

COMMENT ON ROLE anomaly_search_ro IS
  'Read-only sandbox role for anomaly-search NL->SQL (marketprismmarch api/anomaly-agent.js). SELECT-only on schema public. NO write/DDL grants by design. Backs ANOMALY_RO_DATABASE_URL (Supabase pooler, transaction mode). Proposal: db/proposals/anomaly_ro_role.sql';

-- -----------------------------------------------------------------------------
-- 2. Connection-scoped statement_timeout (hard server-side cap).
--    The executor also sets `SET LOCAL statement_timeout='5000ms'` per txn; this
--    role default is a backstop in case a connection skips the per-txn SET.
-- -----------------------------------------------------------------------------
ALTER ROLE anomaly_search_ro SET statement_timeout = '5000ms';
ALTER ROLE anomaly_search_ro SET idle_in_transaction_session_timeout = '10000ms';
-- Belt-and-suspenders: every session this role opens defaults to read-only.
ALTER ROLE anomaly_search_ro SET default_transaction_read_only = on;

-- -----------------------------------------------------------------------------
-- 3. Schema usage + SELECT-only grants on existing objects in `public`.
--    USAGE lets the role resolve object names; it does NOT grant CREATE, so the
--    role cannot make new objects. SELECT is the ONLY data privilege granted.
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anomaly_search_ro;

-- Read all current base tables AND views in public.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anomaly_search_ro;

-- Sequences: allow SELECT (read) but NOT USAGE/UPDATE so the role cannot advance
-- a sequence. Comment out if even read access is unwanted.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO anomaly_search_ro;

-- -----------------------------------------------------------------------------
-- 4. Default privileges for FUTURE objects created in `public`.
--    New tables/views created later by the object owner(s) automatically grant
--    SELECT to this role, so the catalog keeps working as the schema grows —
--    WITHOUT ever conferring write access.
--
--    NOTE: ALTER DEFAULT PRIVILEGES only applies to objects created by the role
--    that runs this statement (or the role named via FOR ROLE). On Supabase the
--    common owners are `postgres` and `supabase_admin`. Run the matching blocks
--    as appropriate; the FOR ROLE postgres block is the typical case.
-- -----------------------------------------------------------------------------

-- Objects created by whoever runs this script:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anomaly_search_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO anomaly_search_ro;

-- Objects created by the `postgres` owner (Supabase default for app tables):
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO anomaly_search_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO anomaly_search_ro;

-- -----------------------------------------------------------------------------
-- 5. Explicitly DO NOT grant anything that could write. Listed here as an
--    auditable statement of intent. These are the privileges we deliberately
--    withhold (NONE of the following are granted anywhere in this file):
--      INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER  (table privs)
--      CREATE, TEMP/TEMPORARY                                  (schema/db privs)
--      USAGE on sequences (would allow nextval)                (sequence privs)
--      EXECUTE on functions (avoid side-effecting funcs)        (function privs)
--    No `GRANT ... TO anomaly_search_ro` above references any of them.
-- -----------------------------------------------------------------------------

COMMIT;

-- =============================================================================
-- 6. VERIFICATION  —  confirm the role has ZERO write privileges.
--    Run these AFTER commit. The zero-write assertions must return ZERO rows
--    before the operator wires ANOMALY_RO_DATABASE_URL. Any row is a finding
--    that must be revoked first.
-- =============================================================================

-- 6a. Role attributes must be the locked-down set (expect superuser/createdb/
--     createrole/replication/bypassrls all FALSE; canlogin TRUE).
SELECT
  rolname,
  rolsuper      AS is_superuser,
  rolcreatedb   AS can_create_db,
  rolcreaterole AS can_create_role,
  rolreplication AS can_replicate,
  rolbypassrls  AS bypasses_rls,
  rolcanlogin   AS can_login,
  rolconnlimit  AS connection_limit
FROM pg_roles
WHERE rolname = 'anomaly_search_ro';

-- 6b. ZERO-WRITE ASSERTION (the important one): list any non-SELECT privilege
--     held by the role on any table/view/sequence in public. MUST return 0 rows.
SELECT
  table_schema,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anomaly_search_ro'
  AND table_schema = 'public'
  AND privilege_type <> 'SELECT'
ORDER BY table_name, privilege_type;
-- ^ Expected: (0 rows). Any INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
--   row here means a write privilege leaked in — REVOKE it before using the role.

-- 6c. The role must NOT hold CREATE on schema public (cannot make objects).
--     has_schema_privilege returns FALSE for both create paths.
SELECT
  'public'                                                       AS schema_name,
  has_schema_privilege('anomaly_search_ro', 'public', 'CREATE') AS has_create,
  has_schema_privilege('anomaly_search_ro', 'public', 'USAGE')  AS has_usage;
-- ^ Expected: has_create = FALSE, has_usage = TRUE.

-- 6d. Spot-check the canonical anomaly tables grant SELECT (and only SELECT).
--     Each `has_table_privilege(..., 'SELECT')` should be TRUE; the write checks
--     should all be FALSE.
SELECT
  t.relname AS table_name,
  has_table_privilege('anomaly_search_ro', 'public.' || t.relname, 'SELECT') AS can_select,
  has_table_privilege('anomaly_search_ro', 'public.' || t.relname, 'INSERT') AS can_insert,
  has_table_privilege('anomaly_search_ro', 'public.' || t.relname, 'UPDATE') AS can_update,
  has_table_privilege('anomaly_search_ro', 'public.' || t.relname, 'DELETE') AS can_delete,
  has_table_privilege('anomaly_search_ro', 'public.' || t.relname, 'TRUNCATE') AS can_truncate
FROM (
  VALUES
    ('narrative_scorecard'),
    ('options_snapshot'),
    ('decay_metrics'),
    ('ticker_snapshots'),
    ('narrative_analyses')
) AS t(relname)
WHERE EXISTS (
  SELECT 1 FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = t.relname
);
-- ^ Expected per row: can_select = TRUE; can_insert/update/delete/truncate = FALSE.

-- =============================================================================
-- END. If 6b returns 0 rows and 6c shows has_create=FALSE, the role is a clean
-- SELECT-only sandbox. THEN build ANOMALY_RO_DATABASE_URL from the Supabase
-- POOLER (transaction-mode, port 6543) connection string and set it as a
-- server-only env var in Vercel. Never log or echo that value to the client.
-- =============================================================================
