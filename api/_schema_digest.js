// ──────────────────────────────────────────────────────────────────────────
// _schema_digest.js — curated schema map for the text-to-SQL anomaly agent
//
// Two exports:
//   SCHEMA_DIGEST     — a concise plain-text map of the KEY queryable tables /
//                       columns the agent should target. Hand-curated from the
//                       LIVE-VERIFIED SCHEMA_FACTS (anon SELECT confirmed; the
//                       dedicated read-only role has the same SELECT grants).
//                       Includes the foreign-filer exclusion list and the
//                       honest data-gap notes INLINE so the agent never invents
//                       a column or fabricates a metric it cannot compute.
//   describeSchema(k) — async; runs a READ-ONLY information_schema.columns query
//                       (via ./_ro_sql.runReadOnlySql) to discover columns for
//                       tables NOT covered by the digest. Reads only.
//
// HARD RULES (enforced by ./_ro_sql + the RO role's zero write grants):
//   reads only · single SELECT/WITH · SET TRANSACTION READ ONLY · 5s timeout ·
//   LIMIT <= 50 · never echo connection strings or API keys to the client.
//
// Column names below are copied verbatim from the verified facts. Do NOT add
// columns that are not listed here; use describeSchema() to discover anything
// outside the digest rather than guessing.
// ──────────────────────────────────────────────────────────────────────────

'use strict';

// Tickers that produce VMS≈50 + drift=100 ARTIFACTS because they are foreign
// filers with no US 10-K/10-Q to anchor against. Exclude them from any
// scorecard cross-section / ranking (they are not real signal).
const FOREIGN_FILER_EXCLUDE = ['TSM', 'NIO', 'BHP', 'RIO', 'VALE', 'NVO', 'RACE', 'STN', 'SPOT', 'GOLD'];

const SCHEMA_DIGEST = `MARKETSCHOLAR FORENSIC DATA — KEY QUERYABLE TABLES (read-only)
Forensic, not alpha. Answer ONLY from rows you query. If the data below does not
cover a question, say "we don't track that" — never fabricate a column or metric.
All these surfaces are SELECT-confirmed. For anything NOT listed, call
describe_schema(keyword) to discover real columns before writing SQL.

GLOBAL EXCLUSION (foreign-filer artifacts — VMS≈50 / drift=100 are NOT real signal):
  Exclude from every narrative_scorecard cross-section / ranking:
  ${FOREIGN_FILER_EXCLUDE.join(', ')}
  e.g.  WHERE ticker NOT IN ('${FOREIGN_FILER_EXCLUDE.join("','")}')

═══ DOMAIN: FORENSIC SCORECARD ═══
narrative_scorecard  (1 row per ticker per snapshot_date; refreshed daily; INSERT-only)
  keys:    ticker, snapshot_date
  verdict        text   — forensic verdict label (e.g. 'Narrative Trap','Narrative Risk',
                          'Structurally Supported','Monitoring'). Valuation-anchored,
                          NOT a falsity label. Verdict edges collapse under sector control.
  vms            num    — Verification Match Score 0-100 (SEC filing alignment; higher=aligns)
  drift_score    num    — narrative drift 0-100; SATURATES at 100 and fires on selective
                          framing too — read drift_explanation before trusting it
  drift_explanation text — prose reason for the drift catch
  coordination_score num — cross-source timing/phrasing coordination strength
  coordination_class text — e.g. 'LIKELY_COORDINATED' (narrative-manipulation read)
  suspicion_score    num — TRADING-FOOTPRINT anomaly 0-100 (vol Z + 30d move + claim size).
                          NOT a coordination/narrative verdict; coordination never feeds it.
  suspicion_class    text — 'NORMAL'/'MODERATE'/'HIGH_MANIPULATION_RISK' (tape read only)
  energy_remaining     num — narrative energy left
  decay_rate           num — narrative decay rate
  composite_decay_rate num — blended decay channel (no standalone forward edge)
  lambda_decay         num — decay constant λ
  half_life            num — narrative half-life
  narrative_energy_regime text — energy/exhaustion regime tag
  mass_decay_class     text — mass-to-decay class
  narrative_state      text — Wyckoff-style state: DISTRIBUTION / RETAIL_PUMP /
                              WHALE_ACCUMULATION / DORMANT
  fvd_pct        num   — Fair-Value Divergence % (price vs daily_fair_value)
  fair_value     num   — modeled fair value (pure fundamentals)
  nrs            num    — Narrative Risk Score 0-100 (higher = more dangerous)
  ccp            num    — Composite Confidence Percentile 0-100
  srs            num    — Source Reliability Score 0-100
  macro_theme    text   — SPARSE tag (often NULL) — do not assume coverage
  sector_regime_class text — sector regime label
  days_to_earnings    int — days until next earnings
  earnings_credibility_score num — earnings credibility 0-100
  NOTE: for fraud/falsity screening use COMPONENTS (drift_score, coordination_*,
        suspicion is tape-only) — not the verdict label.

═══ DOMAIN: DARK POOL ═══
ticker_dark_pool  (keys: ticker, sample_date; ~1 day lag)
  dark_pool_pct_volume   num  — % of volume off-exchange
  dark_pool_pct_trades   num  — % of trades off-exchange
  dark_pool_signal       text — derived dark-pool signal label
  smart_money_direction  text — inferred smart-money direction

═══ DOMAIN: OPTIONS ═══
options_snapshot  (keys: ticker, snapshot_date; fresh)
  put_call_skew              num
  gex_estimate               num  — gamma-exposure estimate
  max_pain                   num
  distance_from_max_pain_pct num
  total_call_oi              num  — open interest (OI), NOT volume
  total_put_oi               num  — open interest (OI), NOT volume
  opex_exhaustion_ratio      num
  days_to_nearest_opex       int
  confluence_score           num
  GAP: there is NO retail-vs-institutional option *volume* — only OI + skew.

═══ DOMAIN: PRICES / VOLUME ═══
ticker_snapshots  (keys: ticker, snapshot_date)
  price_open, price_close, price_high, price_low  num
  volume_day        num
  volume_7d_avg     num
  volume_90d_avg    num   — may be NULL for new tickers
  fifty_two_week_high, fifty_two_week_low  num
  price_30d_before  num
  max_price_30d     num
  (market-cap fields present on this table)
  GAP: no precomputed sigma / volatility baselines — compute from rows if needed.

═══ DOMAIN: BUBBLE ═══
bubble_metrics  (keys: ticker, snapshot_date)
  bubble_active_idio  bool — idiosyncratic bubble flag
  bsadf_now           num  — current BSADF statistic
  crit_value          num  — critical value for the test
  regime              text — bubble regime label
  current_episode_start date — start of current bubble episode

═══ DOMAIN: FAIR VALUE ═══
daily_fair_value  (keys: ticker, snapshot_date)
  market_cap      num
  fvd_pct         num   — Fair-Value Divergence %
  fair_value      num
  industry_pe_avg num
  NOTE: pure-fundamentals anchor; ~9 pre-revenue names have no fair value (correct).

═══ DOMAIN: CLUSTERS ═══
narrative_ticker_clusters    — ticker→cluster membership
narrative_clusters           — cluster definitions
narrative_cluster_centroids  — (embedded) cluster centroids
  Use describe_schema('cluster') to confirm join columns before querying.

═══ DOMAIN: CONTAGION ═══
collision_events  (~179K rows)            — narrative-collision events
v_contagion_master  (VIEW)                — assembled contagion graph
  Use describe_schema('contagion') / describe_schema('collision') for columns.
  DO NOT use event_propagation_edges — that table is EMPTY.

═══ DOMAIN: CIRCULAR FINANCE ═══  (curated AI-capex money-flow loops)
circular_finance_entities
  entity_id   — entity identifier
  ticker      — nullable (many counterparties are private companies)
  role        — entity role in the graph
  is_public   bool
v_circular_finance_roundtrips  (VIEW)
  entity_a, entity_b
  a_to_b_relations  — count of A→B money-flow relations
  a_to_b_amount     — A→B committed amount
  b_to_a_relations  — count of B→A money-flow relations
  b_to_a_amount     — B→A committed amount
  latest            — latest observation timestamp
  GAP: AI-capex only; edges are TEXT-EXTRACTED COMMITMENTS, not XBRL/SEC cash.
       Commitments are not confirmed cashflows. Curated seed set, not exhaustive.

═══ DOMAIN: SEMANTIC DOT SEARCH ═══
narrative_dots.embedding  — pgvector(384), all-MiniLM-L6-v2
  RPC: search_dots_by_embedding(query_vector, k, filter_sector, ...) for
  similarity search. (Embedding generation happens outside SQL.)

═══ HONEST DATA GAPS (own these; never fabricate) ═══
- No retail-vs-institutional option VOLUME (only open interest + skew).
- No precomputed sigma / volatility baselines (derive from price rows).
- Circular-finance graph is AI-capex-only, text-extracted COMMITMENTS (not
  XBRL/SEC cash; commitments ≠ cashflows).
- macro_theme is a SPARSE tag — frequently NULL; don't treat absence as signal.
- Forensic system, NOT alpha: never predict prices or give trading advice.`;

// ──────────────────────────────────────────────────────────────────────────
// describeSchema(keyword) -> Promise<rows>
// Discover columns for tables NOT in the digest. READ-ONLY: a single SELECT
// against information_schema.columns, parameterized, capped at LIMIT 50, run
// through the same read-only guard (SET TRANSACTION READ ONLY + statement
// timeout) as every other agent query.
// ──────────────────────────────────────────────────────────────────────────
async function describeSchema(keyword) {
  // Lazy require so this module loads even if _ro_sql is initialized later.
  const { runReadOnlySql } = require('./_ro_sql');

  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return [];

  // Match against table OR column name in public schema (base tables + views),
  // skipping internal catalogs. ILIKE pattern is passed as a bound parameter so
  // the keyword can never break out of the literal — no string interpolation.
  const pattern = '%' + kw.replace(/[\\%_]/g, '\\$&') + '%';

  const sql = `
    SELECT c.table_name,
           c.column_name,
           c.data_type,
           c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type IN ('BASE TABLE', 'VIEW')
       AND (c.table_name ILIKE $1 ESCAPE '\\' OR c.column_name ILIKE $1 ESCAPE '\\')
     ORDER BY c.table_name, c.ordinal_position
     LIMIT 50
  `;

  // runReadOnlySql(sql, { params }) returns { ok, rows, error, ... } and never
  // throws. Bind the keyword as $1 so it can never break out of the literal.
  const result = await runReadOnlySql(sql, { params: [pattern] });
  return (result && Array.isArray(result.rows)) ? result.rows : [];
}

module.exports = { SCHEMA_DIGEST, describeSchema, FOREIGN_FILER_EXCLUDE };
