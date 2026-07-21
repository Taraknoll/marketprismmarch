'use strict';

/**
 * api/_ro_sql.js — read-only SQL guard + executor for the anomaly-search agent.
 *
 * CommonJS port of the adversarially-reviewed TypeScript layer in the
 * Market-Scholar-Full repo:
 *   - frontend/lib/anomaly-search/sqlGuard.ts   -> validateReadOnly()
 *   - frontend/lib/anomaly-search/dbReadonly.ts -> runReadOnlySql() / isConfigured()
 *   - frontend/db/proposals/anomaly_ro_role.sql -> the SELECT-only DB role (the
 *     real sandbox; this module is defense-in-depth)
 *
 * SERVER-ONLY (Vercel serverless function helper). Never import from client HTML.
 *
 * Defense-in-depth, in order of trust:
 *   1. The DB role (ANOMALY_RO_DATABASE_URL) has ZERO write grants — the real
 *      sandbox. Even if the guard is bypassed, the database refuses every write.
 *   2. validateReadOnly() fails closed: single SELECT/WITH only, comment-stripped,
 *      whole-word DML/DDL/privilege/session denylist, dangerous-phrase denylist,
 *      LIMIT injected/clamped to <= MAX_LIMIT.
 *   3. Every statement runs inside `BEGIN; SET TRANSACTION READ ONLY;
 *      SET LOCAL statement_timeout='5000ms'; <sql>; ROLLBACK;` — always rolled
 *      back (reads need no commit).
 *
 * Never echoes ANOMALY_RO_DATABASE_URL / ANTHROPIC_KEY / Supabase creds to the
 * caller; runReadOnlySql() never throws — it returns { ok:false, error } instead.
 *
 * Lazy module-scoped Pool (max 2) so the connection survives across warm
 * serverless invocations without exhausting the read-only role's slots.
 */

// =============================================================================
// Guard (ported from sqlGuard.ts — logic preserved, types dropped)
// =============================================================================

/** Maximum number of rows any anomaly-search query may return. */
const MAX_LIMIT = 50;

/** Wall-clock cap for any single read transaction. */
const STATEMENT_TIMEOUT_MS = 5000;

/**
 * Tokens that must NEVER appear in a read-only query. Matched as whole words
 * (case-insensitive) so identifier substrings like `created_at`, `update_count`,
 * or `do_not_call` are not false-positives.
 */
const DENYLISTED_TOKENS = [
  // DML
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  // DDL
  'create',
  'alter',
  'drop',
  'truncate',
  'rename',
  'comment',
  // privileges / security
  'grant',
  'revoke',
  // procedural / side-effecting
  'call',
  'do',
  'copy',
  'vacuum',
  'analyze',
  'cluster',
  'reindex',
  'refresh',
  'lock',
  'listen',
  'notify',
  'unlisten',
  'prepare',
  'execute',
  'deallocate',
  'discard',
  'load',
  'import',
  'security',
  'definer',
  // transaction control (executor owns the txn; queries must not touch it)
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'start',
];

/**
 * Phrase-level denials for multi-word constructs and dangerous identifiers that
 * a single-token denylist would miss. Matched against the comment-stripped query.
 */
const DENYLISTED_PATTERNS = [
  { label: 'set-role / set-session / set-local / set-transaction-write', re: /\bset\s+(role|session|local|transaction)\b/i },
  { label: 'reset (session reset)', re: /\breset\b/i },
  { label: 'pg_catalog access', re: /\bpg_catalog\b/i },
  { label: 'pg_sleep / sleep functions', re: /\bpg_sleep\w*\s*\(/i },
  { label: 'dblink / fdw exfiltration', re: /\bdblink\w*\s*\(/i },
  { label: 'lo_* large-object functions', re: /\blo_(import|export|create|unlink)\s*\(/i },
  { label: 'pg_read_file / server-file access', re: /\bpg_(read|ls|stat)_(file|dir|server)\w*\s*\(/i },
  { label: 'set_config session mutation', re: /\bset_config\s*\(/i },
  { label: 'into (SELECT ... INTO new table)', re: /\bselect\b[\s\S]*\binto\b/i },
  { label: 'for update / for share locking', re: /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i },
];

/**
 * Sensitive-relation blocklist — a DATA-SCOPE boundary on top of read-only.
 *
 * The `anomaly_search_ro` role can technically SELECT every table in `public`,
 * which includes customer PII, billing, per-user, and brokerage tables that must
 * NEVER be reachable through the public-facing agent — no matter how the prompt
 * is phrased. This is defense-in-depth in front of revoking the role's SELECT on
 * these relations at the DB level (db/proposals/anomaly_ro_revoke_sensitive.sql).
 *
 * Matched against the comment-stripped query. Patterns are written as whole
 * identifiers (or safe family prefixes) so `public.stripe_customers`,
 * `"stripe_customers"`, and a bare reference all trip, while legitimate names or
 * COLUMNS that merely share a substring do NOT — e.g. a `user_id` column, a
 * `beta`/`beta_adjusted` factor, `keyword_*` tables, and `narrative_family_key_stats`
 * are all left alone. The two `*_keys` entries are canary/honeypot views; hiding
 * them keeps the agent from surfacing decoy rows during broad analytics.
 */
const BLOCKED_RELATION_PATTERNS = [
  // Billing / subscriptions
  { label: 'stripe_customers', re: /(^|[^a-z0-9_])stripe_customers([^a-z0-9_]|$)/i },
  { label: 'subscriptions',    re: /(^|[^a-z0-9_])subscriptions([^a-z0-9_]|$)/i },
  // Signup / email PII
  { label: 'email_signups',    re: /(^|[^a-z0-9_])email_signups([^a-z0-9_]|$)/i },
  { label: 'beta_signups',     re: /(^|[^a-z0-9_])beta_signups([^a-z0-9_]|$)/i },
  { label: 'beta_activations', re: /(^|[^a-z0-9_])beta_activations([^a-z0-9_]|$)/i },
  { label: 'Beta User Sign Up', re: /beta\s+user\s+sign\s+up/i },
  // Per-user personal data
  { label: 'user_watchlists',              re: /(^|[^a-z0-9_])user_watchlists([^a-z0-9_]|$)/i },
  { label: 'user_calendar_custom_events',  re: /(^|[^a-z0-9_])user_calendar_custom_events([^a-z0-9_]|$)/i },
  { label: 'user_calendar_global_overrides', re: /(^|[^a-z0-9_])user_calendar_global_overrides([^a-z0-9_]|$)/i },
  // Brokerage account / real order + execution log (aggregated sim book lives in paper_* instead)
  { label: 'alpaca_trades*',     re: /(^|[^a-z0-9_])alpaca_trades/i },
  { label: 'alpaca_executions*', re: /(^|[^a-z0-9_])alpaca_executions/i },
  { label: 'alpaca_account*',    re: /(^|[^a-z0-9_])alpaca_account/i },
  // Credential canary/honeypot views (decoys, not real secrets)
  { label: 'service_account_keys (canary)', re: /(^|[^a-z0-9_])service_account_keys([^a-z0-9_]|$)/i },
  { label: 'internal_api_keys (canary)',    re: /(^|[^a-z0-9_])internal_api_keys([^a-z0-9_]|$)/i },
];

/** Return the label of the first blocked relation referenced in `sql`, else null. */
function blockedRelationHit(sql) {
  const s = String(sql == null ? '' : sql);
  for (const { label, re } of BLOCKED_RELATION_PATTERNS) {
    if (re.test(s)) return label;
  }
  return null;
}

/**
 * True if a bare relation name is on the sensitive blocklist. Used to hide these
 * relations from the schema-discovery catalog (describe_schema) so the agent
 * never even advertises them. Padded so whole-identifier patterns apply.
 */
function isBlockedRelation(name) {
  return blockedRelationHit(' ' + String(name == null ? '' : name) + ' ') !== null;
}

/**
 * Strip SQL comments so a denylisted token cannot hide behind `--` or a block
 * comment, and so a comment-smuggled second statement cannot pass. String and
 * dollar-quoted literals are preserved verbatim.
 */
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // Single-quoted string literal — copy through, honoring '' escapes.
    if (c === "'") {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted string ($tag$ ... $tag$) — copy through untouched.
    if (c === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          out += sql.slice(i);
          i = n;
          continue;
        }
        out += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    // Line comment: -- ... \n
    if (c === '-' && c2 === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) {
        i = n;
      } else {
        out += ' '; // collapse comment to a single space (preserve token boundaries)
        i = nl;
      }
      continue;
    }

    // Block comment: /* ... */
    if (c === '/' && c2 === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        i = n;
      } else {
        out += ' ';
        i = end + 2;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Count statement-terminating semicolons that sit OUTSIDE of string/dollar
 * literals. Used to enforce the single-statement rule.
 */
function countTopLevelSemicolons(sql) {
  let count = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          i = n;
          continue;
        }
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') count++;
    i++;
  }
  return count;
}

/**
 * Whether the query already ends with a top-level LIMIT clause (optionally
 * followed by an OFFSET).
 */
const TRAILING_LIMIT_RE = /\blimit\s+(\d+)\s*(?:offset\s+\d+\s*)?$/i;

/**
 * Validate that `sql` is a single, read-only statement, then return a
 * normalized, LIMIT-bounded version safe to execute. Fail-closed: on ANY
 * concern, returns { ok: false } and never produces an executable normalizedSql.
 *
 * @param {string} sql
 * @returns {{ ok: boolean, reason?: string, checks: string[], normalizedSql: string }}
 */
function validateReadOnly(sql) {
  const checks = [];

  // 0) Basic shape.
  if (typeof sql !== 'string') {
    return { ok: false, reason: 'SQL must be a string', checks, normalizedSql: '' };
  }
  const rawTrimmed = sql.trim();
  if (rawTrimmed.length === 0) {
    return { ok: false, reason: 'Empty SQL', checks, normalizedSql: '' };
  }
  checks.push('non-empty');

  // 1) Strip comments first so nothing can hide behind them.
  let work = stripComments(rawTrimmed).trim();
  if (work.length === 0) {
    return { ok: false, reason: 'SQL is only comments', checks, normalizedSql: rawTrimmed };
  }
  checks.push('comments-stripped');

  // 2) Single statement: tolerate at most one trailing semicolon.
  let trailingSemi = false;
  while (work.endsWith(';')) {
    work = work.slice(0, -1).trimEnd();
    trailingSemi = true;
  }
  if (work.length === 0) {
    return { ok: false, reason: 'SQL is only a statement terminator', checks, normalizedSql: rawTrimmed };
  }
  const interiorSemis = countTopLevelSemicolons(work);
  if (interiorSemis > 0) {
    return {
      ok: false,
      reason: 'Multiple statements are not allowed (statement chaining detected)',
      checks,
      normalizedSql: rawTrimmed,
    };
  }
  checks.push(trailingSemi ? 'single-statement (trailing ; stripped)' : 'single-statement');

  // 3) Must begin with SELECT or WITH (CTE). Anything else fails closed.
  const leading = /^([a-zA-Z_]+)/.exec(work);
  const firstKeyword = leading ? leading[1].toLowerCase() : '';
  if (firstKeyword !== 'select' && firstKeyword !== 'with') {
    return {
      ok: false,
      reason: `Query must start with SELECT or WITH (got "${firstKeyword || work.slice(0, 12)}")`,
      checks,
      normalizedSql: rawTrimmed,
    };
  }
  checks.push(`leading-keyword:${firstKeyword}`);

  // A WITH CTE could still be a data-modifying CTE (WITH x AS (DELETE ...)).
  // Belt to the token-denylist suspenders below.
  if (firstKeyword === 'with' && /\bas\s*\(\s*(insert|update|delete|merge)\b/i.test(work)) {
    return {
      ok: false,
      reason: 'Data-modifying CTE detected in WITH clause',
      checks,
      normalizedSql: rawTrimmed,
    };
  }

  // 4) Exhaustive whole-word token denylist.
  const lowered = work.toLowerCase();
  for (const token of DENYLISTED_TOKENS) {
    const re = new RegExp(`(^|[^a-z0-9_])${token}([^a-z0-9_]|$)`, 'i');
    if (re.test(lowered)) {
      return {
        ok: false,
        reason: `Denylisted token "${token}" present`,
        checks,
        normalizedSql: rawTrimmed,
      };
    }
  }
  checks.push('token-denylist-clear');

  // 5) Phrase / dangerous-function denylist.
  for (const { label, re } of DENYLISTED_PATTERNS) {
    if (re.test(work)) {
      return {
        ok: false,
        reason: `Disallowed construct: ${label}`,
        checks,
        normalizedSql: rawTrimmed,
      };
    }
  }
  checks.push('phrase-denylist-clear');

  // 5b) Sensitive-relation blocklist — hard data-scope boundary (PII / billing /
  //      per-user / brokerage / credential-canary tables are out of scope).
  const blockedRel = blockedRelationHit(work);
  if (blockedRel) {
    return {
      ok: false,
      reason: `Query references an out-of-scope sensitive relation (${blockedRel}). Customer, billing, brokerage, and signup tables are not available to this agent.`,
      checks,
      normalizedSql: rawTrimmed,
    };
  }
  checks.push('relation-blocklist-clear');

  // 6) LIMIT injection / clamping.
  let normalizedSql = work;
  const limitMatch = TRAILING_LIMIT_RE.exec(work);
  if (limitMatch) {
    const requested = parseInt(limitMatch[1], 10);
    if (Number.isFinite(requested) && requested > MAX_LIMIT) {
      normalizedSql = work.replace(TRAILING_LIMIT_RE, (full) => {
        const offsetTail = /offset\s+\d+\s*$/i.exec(full);
        return offsetTail ? `LIMIT ${MAX_LIMIT} ${offsetTail[0]}`.trim() : `LIMIT ${MAX_LIMIT}`;
      });
      checks.push(`limit-clamped:${requested}->${MAX_LIMIT}`);
    } else {
      checks.push(`limit-present:${requested}`);
    }
  } else {
    normalizedSql = `${work} LIMIT ${MAX_LIMIT}`;
    checks.push(`limit-injected:${MAX_LIMIT}`);
  }

  return { ok: true, checks, normalizedSql };
}

// =============================================================================
// Executor (ported from dbReadonly.ts — pg Pool, read-only txn envelope)
// =============================================================================

const POOL_MAX = Number(process.env.ANOMALY_RO_POOL_MAX || 2);
const POOL_IDLE_TIMEOUT_MS = Number(process.env.ANOMALY_RO_POOL_IDLE_MS || 30000);
const POOL_CONNECTION_TIMEOUT_MS = Number(process.env.ANOMALY_RO_POOL_CONN_MS || 8000);

/**
 * Returns true if a read-only connection string is configured.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(process.env.ANOMALY_RO_DATABASE_URL);
}

/**
 * Module-scoped singleton Pool. Lazily created on first use so importing this
 * module never throws when the env var is absent. `pg` is required lazily so a
 * deployment without the dependency can still load the guard.
 */
let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.ANOMALY_RO_DATABASE_URL;
  if (!connectionString) {
    // Caller guards via isConfigured(); this is a defensive sentinel.
    throw new Error('ANOMALY_RO_DATABASE_URL is not set');
  }

  // Lazy require so the guard half of this module is usable even if `pg` is not
  // installed in a given environment.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');

  // Supabase pooler (pgbouncer) requires SSL. rejectUnauthorized:false matches
  // the rest of the stack's pooled-connection posture (avoids cert-chain breaks
  // on Vercel). Disable via ANOMALY_RO_DISABLE_SSL=true for local plaintext PG.
  const useSsl = process.env.ANOMALY_RO_DISABLE_SSL !== 'true';

  pool = new Pool({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    application_name: 'anomaly_search_ro',
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  // A pool-level 'error' handler is mandatory: without it, an idle-client
  // backend error crashes the Node process. Log without leaking creds.
  pool.on('error', (err) => {
    try {
      console.error('[ro_sql] pool error:', err && err.message ? err.message : String(err));
    } catch (_) {
      /* never throw from the error handler */
    }
  });

  return pool;
}

/**
 * Guard, then execute a single read-only statement inside a rolled-back,
 * read-only, time-bounded transaction. NEVER throws to the caller and NEVER
 * echoes credentials — failures are returned as { ok:false, error }.
 *
 * @param {string} sql
 * @param {{ params?: any[] }} [opts]
 * @returns {Promise<{ ok:boolean, rows:object[], rowCount:number, ms:number, checks:string[], error?:string }>}
 */
async function runReadOnlySql(sql, opts) {
  const started = Date.now();
  const params = (opts && Array.isArray(opts.params)) ? opts.params : [];

  // 1) Guard first — fail closed.
  const guard = validateReadOnly(sql);
  if (!guard.ok) {
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      ms: Date.now() - started,
      checks: guard.checks,
      error: guard.reason || 'SQL rejected by read-only guard',
    };
  }

  // 2) Config check — no creds, no execution.
  if (!isConfigured()) {
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      ms: Date.now() - started,
      checks: guard.checks,
      error: 'Read-only database is not configured',
    };
  }

  let client = null;
  try {
    client = await getPool().connect();

    // Read-only transaction envelope — always rolled back.
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

    const result = await client.query(guard.normalizedSql, params);
    const allRows = Array.isArray(result.rows) ? result.rows : [];

    await client.query('ROLLBACK');

    // Belt-and-suspenders row cap (guard already injected/clamped LIMIT).
    const rows = allRows.slice(0, MAX_LIMIT);

    return {
      ok: true,
      rows,
      rowCount: rows.length,
      ms: Date.now() - started,
      checks: guard.checks,
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* connection likely dead; release() discards it */
      }
    }

    // Sanitize: surface only the DB error message, never the connection string
    // or any env value. pg error messages do not contain the DSN.
    const message = (err && err.message) ? String(err.message) : 'Read-only query failed';
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      ms: Date.now() - started,
      checks: guard.checks,
      error: message,
    };
  } finally {
    if (client) {
      try {
        client.release();
      } catch (_) {
        /* ignore release errors */
      }
    }
  }
}

module.exports = {
  MAX_LIMIT,
  validateReadOnly,
  runReadOnlySql,
  isConfigured,
  isBlockedRelation,
  blockedRelationHit,
};
