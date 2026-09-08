// api/present-data.js
// Read-only data feed for /present — the Institutional Presentation Mode.
//
// Every number the presentation shows comes from here, and everything here is
// a plain SELECT over production views/tables. Nothing is written, no scoring
// is recomputed, no research statistic is derived in this file beyond simple
// counts (rows, tickers, null cells in a window).
//
// Sources (all read-only):
//   FEED (institutional feed view v5)     — the institutional feed itself
//                                             (service-role only; carries
//                                             first_written_at + decay_provenance)
//   LINEAGE (its lineage companion)       — revision companion (values_as_of,
//                                             revision_at, is_restatement)
//   institutional_validation_runs           — latest finished validation run
//   institutional_feature_scorecard         — per-feature IC panel for that run
//   institutional_validation_results        — cohort coverage + incremental battery
//   benzinga_earnings                       — company names for the picker
//
// Gate: the presentation password cookie (api/_require-present.js) — separate
// from the /quant terminal's cookie; neither unlocks the other.
// A 401 here tells the page to re-show its gate overlay.
//
// Modes:
//   GET /api/present-data                 → { meta, universe, defaultTicker, evidence }
//   GET /api/present-data?ticker=DIS      → { ticker, rows, lineage, window }
//   GET /api/present-data?part=paper      → the four paper-book tables (no max_drawdown)
//   GET /api/present-data?part=engine&ticker=DIS → signature, calibration, forecast, dots sample

const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');
const { isHidden } = require('./_hidden-tickers');

// Mirrors the dashboard-wide exclusion used by quant-data / universe-data.
const EXCLUDED = new Set(['SONY', 'HMC', 'TM', 'TSM', 'DJT']);
const dropTicker = (t) => isHidden(t) || EXCLUDED.has(String(t || '').toUpperCase());

// The strict live point-in-time regime. The feed's own decay_provenance flag
// keys on snapshot_date >= 2026-03-01 (a Sunday); the first live session — and
// the first live first_written_at — is 2026-03-02. Presented as March 2.
const PIT_START = '2026-03-02';

// Physical database view name — the one place it appears. It is never sent to
// the client; the page and API label it "institutional feed v5".
const FEED = 'v_market_prism_citadel_feed_v5';
const LINEAGE = FEED + '_lineage';
const FEED_LABEL = 'institutional feed v5';

// Feed columns the presentation reads for one security through time. Names are
// the delivered feed names — the page shows them verbatim on Screen 3.
const SERIES_COLS = [
  'ticker', 'snapshot_date', 'first_written_at', 'updated_at', 'is_trading_session',
  'narrative_hash', 'genesis_date', 'days_elapsed', 'macro_theme',
  'decay_provenance', 'decay_is_pit', 'data_quality_flags',
  'narrative_energy_t', 'narrative_energy_absolute', 'energy_remaining_dynamic',
  'narrative_velocity_score', 'narrative_pressure', 'narrative_mass',
  'half_life', 'fitted_half_life', 'lambda_decay', 'fitted_lambda', 'decay_state', 'fit_status',
  'vms', 'srs', 'nrs', 'npi', 'suspicion_score', 'suspicion_class', 'verdict', 'verdict_confidence', 'advanced_verdict',
  'fvd_pct', 'distance_from_max_pain_pct', 'put_call_skew', 'wks_score', 'fomo_score', 'fomo_band',
  'doubling_time', 'effective_narrative_horizon', 'horizon_source',
  'exhaustion_days_dynamic', 'walsh_regime', 'signal_regime', 'regime_direction',
  'coordination_score', 'coordination_class', 'mass_streak_days',
  'current_price'
];

// Scorecard features surfaced on Screen 5 / the drawer — the same measurement
// families the deck talks about. Only rows that exist for the latest run are
// returned; nothing is filled in.
const EVIDENCE_FEATURES = [
  'narrative_energy_t', 'narrative_velocity_score', 'narrative_pressure',
  'energy_remaining_dynamic', 'fitted_half_life', 'fitted_lambda',
  'vms', 'srs', 'coordination_score', 'mass_streak_days', 'suspicion_score', 'wks_score'
];

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(obj));
}

const num = (v, dp) => {
  if (v == null) return null;
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  const m = Math.pow(10, dp == null ? 4 : dp);
  return Math.round(f * m) / m;
};

function isoDaysAgo(dateStr, days) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() - days * 86400000)
    .toISOString().slice(0, 10);
}

async function getJson(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const err = new Error('upstream query failed');
    err.status = resp.status;
    err.detail = detail.slice(0, 300);
    err.url = url.replace(/apikey=[^&]+/, 'apikey=***');
    throw err;
  }
  return resp.json().catch(() => []);
}

// PostgREST caps rows server-side regardless of ?limit= — page with Range
// headers until a short page or the cap.
async function fetchAll(url, headers, cap) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < cap; from += page) {
    const rows = await getJson(url, Object.assign({
      Range: `${from}-${from + page - 1}`, 'Range-Unit': 'items'
    }, headers));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// Exact row count via PostgREST's Content-Range, without pulling rows.
async function countRows(url, headers) {
  const resp = await fetch(url, {
    headers: Object.assign({ Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' }, headers)
  });
  if (!resp.ok) return null;
  const cr = resp.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

const parsePayload = (p) => {
  if (p == null) return null;
  if (typeof p === 'string') { try { return JSON.parse(p); } catch (_e) { return null; } }
  return p;
};

// ── in-memory cache (per function instance) for the expensive meta call ──
let META_CACHE = { at: 0, body: null };
const META_TTL_MS = 15 * 60 * 1000;

async function buildMeta(rest, headers) {
  // 1. Feed extent + latest scored session.
  const [lastRows, firstRows, firstPitRows] = await Promise.all([
    getJson(rest + `${FEED}?select=snapshot_date&order=snapshot_date.desc&limit=1`, headers),
    getJson(rest + `${FEED}?select=snapshot_date&order=snapshot_date.asc&limit=1`, headers),
    getJson(rest + `${FEED}?select=ticker,snapshot_date,first_written_at&snapshot_date=gte.${PIT_START}&order=first_written_at.asc&limit=1`, headers)
  ]);
  const lastDate = lastRows[0] && lastRows[0].snapshot_date;
  const firstDate = firstRows[0] && firstRows[0].snapshot_date;
  if (!lastDate) throw new Error('feed has no rows');

  // 2. Regime counts (exact, no row transfer).
  const [rowsTotal, rowsPit, rowsBackfill] = await Promise.all([
    countRows(rest + `${FEED}?select=ticker`, headers),
    countRows(rest + `${FEED}?select=ticker&snapshot_date=gte.${PIT_START}`, headers),
    countRows(rest + `${FEED}?select=ticker&snapshot_date=lt.${PIT_START}`, headers)
  ]);

  // 3. Recent-window slim scan: universe list, per-ticker row counts, and the
  //    number of decay_state transitions (used only to pick a default security
  //    with a visibly evolving lifecycle — a selection heuristic, not a score).
  const cutoff = isoDaysAgo(lastDate, 62);
  const slim = await fetchAll(
    rest + `${FEED}?select=ticker,snapshot_date,decay_state&snapshot_date=gte.${cutoff}&is_trading_session=is.true&order=ticker.asc,snapshot_date.asc`,
    headers, 20000
  );
  const per = {};
  for (const r of slim) {
    if (!r.ticker || dropTicker(r.ticker)) continue;
    const p = per[r.ticker] || (per[r.ticker] = { n: 0, transitions: 0, prev: null, last: null });
    p.n += 1;
    if (p.prev != null && r.decay_state && r.decay_state !== p.prev) p.transitions += 1;
    if (r.decay_state) p.prev = r.decay_state;
    p.last = r.snapshot_date;
  }

  // 4. Company names — same source as the quant terminal's picker.
  const nameOf = {};
  try {
    const nameCutoff = isoDaysAgo(lastDate, 400);
    const nameRows = await fetchAll(
      rest + `benzinga_earnings?select=ticker,company_name,date&company_name=not.is.null&date=gte.${nameCutoff}&order=date.desc,ticker.asc`,
      headers, 4000);
    for (const r of nameRows) {
      if (!r.ticker || nameOf[r.ticker]) continue;
      const n = String(r.company_name || '').split(' - ')[0].trim().slice(0, 44);
      if (n && n.toUpperCase() !== String(r.ticker).toUpperCase()) nameOf[r.ticker] = n;
    }
  } catch (_e) { /* names are cosmetic */ }

  const universe = Object.keys(per).sort().map((t) => ({
    t, nm: nameOf[t] || null, n: per[t].n, transitions: per[t].transitions, last: per[t].last
  }));
  const distinctTickers = universe.length;

  // Default security: full recent coverage, most lifecycle transitions.
  const maxN = universe.reduce((m, u) => Math.max(m, u.n), 0);
  const eligible = universe.filter((u) => u.n >= Math.max(30, maxN - 3) && u.last === lastDate);
  const pool = eligible.length ? eligible : universe;
  const defaultTicker = pool.slice().sort((a, b) => b.transitions - a.transitions || a.t.localeCompare(b.t))[0];

  return {
    meta: {
      feed: FEED_LABEL,
      lineage: FEED_LABEL + ' · lineage view',
      pit_start: PIT_START,
      first_snapshot_date: firstDate || null,
      last_snapshot_date: lastDate,
      rows_total: rowsTotal,
      rows_pit: rowsPit,
      rows_backfill: rowsBackfill,
      tickers_recent: distinctTickers,
      first_pit_written: firstPitRows[0] ? {
        ticker: firstPitRows[0].ticker,
        snapshot_date: firstPitRows[0].snapshot_date,
        first_written_at: firstPitRows[0].first_written_at
      } : null,
      generated_at: new Date().toISOString()
    },
    universe,
    defaultTicker: defaultTicker ? defaultTicker.t : null
  };
}

async function buildEvidence(rest, headers) {
  // Latest finished, non-aborted validation run.
  const runs = await getJson(
    rest + 'institutional_validation_runs?select=run_id,run_date,mode,finished_at,aborted,config_version,n_features_scored,git_commit_sha&aborted=is.false&finished_at=not.is.null&order=run_date.desc,finished_at.desc&limit=1',
    headers);
  const run = runs[0];
  if (!run) return { run: null, scorecard: [], cohorts: [], incremental: [] };

  const feats = EVIDENCE_FEATURES.join(',');
  const [scorecard, results] = await Promise.all([
    getJson(rest + `institutional_feature_scorecard?select=feature,family,horizon,n_rows,n_dates,target,expected_direction,direction_alignment,mean_ic,median_ic,ic_ir,ic_positive_pct,ic_hac_t,residual_ic,residual_ic_t,q5_q1,q5_q1_t,monotonicity_score,walk_forward_ic,pit_quality,backfill_pct,feature_version,classification,composite_score&run_id=eq.${run.run_id}&feature=in.(${feats})&order=feature.asc,horizon.asc`, headers),
    getJson(rest + `institutional_validation_results?select=battery,result_key,horizon,payload&run_id=eq.${run.run_id}&battery=in.(version_cohort_coverage,incremental_battery)&order=battery.asc,result_key.asc,horizon.asc`, headers)
  ]);

  const cohorts = [], incremental = [];
  for (const r of results) {
    const p = parsePayload(r.payload);
    if (!p) continue;
    if (r.battery === 'version_cohort_coverage') {
      cohorts.push({
        generation: p.generation || r.result_key, start: p.start || null, end: p.end || null,
        description: p.description || null, n_rows: p.n_rows == null ? null : Number(p.n_rows),
        n_dates: p.n_dates == null ? null : Number(p.n_dates), n_tickers: p.n_tickers == null ? null : Number(p.n_tickers),
        pct_pit_clean: num(p.pct_pit_clean, 2)
      });
    } else if (r.battery === 'incremental_battery' && EVIDENCE_FEATURES.indexOf(r.result_key) >= 0) {
      incremental.push({
        feature: r.result_key, horizon: r.horizon, target: p.target || null,
        raw_ic: num(p.raw_ic), raw_ic_hac_t: num(p.raw_ic_hac_t, 2), raw_ic_n_dates: p.raw_ic_n_dates == null ? null : Number(p.raw_ic_n_dates),
        residual_ic: num(p.residual_ic), residual_ic_hac_t: num(p.residual_ic_hac_t, 2), residual_ic_n_dates: p.residual_ic_n_dates == null ? null : Number(p.residual_ic_n_dates),
        n_baseline_cols_used: p.n_baseline_cols_used == null ? null : Number(p.n_baseline_cols_used),
        sector_fe: p.sector_fe == null ? null : !!p.sector_fe
      });
    }
  }

  return {
    run: {
      run_id: run.run_id, run_date: run.run_date, mode: run.mode, finished_at: run.finished_at,
      config_version: run.config_version, n_features_scored: run.n_features_scored,
      git_commit_sha: run.git_commit_sha ? String(run.git_commit_sha).slice(0, 12) : null
    },
    scorecard: scorecard.map((s) => ({
      feature: s.feature, family: s.family, horizon: s.horizon, n_rows: s.n_rows, n_dates: s.n_dates,
      target: s.target, expected_direction: s.expected_direction, direction_alignment: s.direction_alignment,
      mean_ic: num(s.mean_ic), median_ic: num(s.median_ic), ic_ir: num(s.ic_ir, 3), ic_positive_pct: num(s.ic_positive_pct, 1),
      ic_hac_t: num(s.ic_hac_t, 2), residual_ic: num(s.residual_ic), residual_ic_t: num(s.residual_ic_t, 2),
      q5_q1: num(s.q5_q1), q5_q1_t: num(s.q5_q1_t, 2), monotonicity_score: num(s.monotonicity_score, 3),
      walk_forward_ic: num(s.walk_forward_ic), pit_quality: s.pit_quality, backfill_pct: num(s.backfill_pct, 3),
      feature_version: s.feature_version, classification: s.classification, composite_score: num(s.composite_score, 2)
    })),
    cohorts,
    incremental
  };
}

async function buildSeries(rest, headers, ticker, days) {
  const cols = SERIES_COLS.join(',');
  const [rows, lineage] = await Promise.all([
    getJson(rest + `${FEED}?select=${cols}&ticker=eq.${encodeURIComponent(ticker)}&is_trading_session=is.true&order=snapshot_date.desc&limit=${days}`, headers),
    getJson(rest + `${LINEAGE}?select=ticker,snapshot_date,values_as_of,revision_at,is_restatement&ticker=eq.${encodeURIComponent(ticker)}&order=snapshot_date.desc&limit=${days}`, headers)
      .catch(() => [])
  ]);
  rows.reverse();
  const lin = {};
  for (const l of lineage) lin[l.snapshot_date] = l;

  const out = rows.map((r) => ({
    ticker: r.ticker,
    snapshot_date: r.snapshot_date,
    first_written_at: r.first_written_at || null,
    updated_at: r.updated_at || null,
    is_trading_session: r.is_trading_session == null ? null : !!r.is_trading_session,
    decay_provenance: r.decay_provenance || null,
    decay_is_pit: r.decay_is_pit == null ? null : !!r.decay_is_pit,
    data_quality_flags: r.data_quality_flags || null,
    narrative_energy_t: num(r.narrative_energy_t),
    narrative_energy_absolute: num(r.narrative_energy_absolute),
    energy_remaining_dynamic: num(r.energy_remaining_dynamic),
    narrative_velocity_score: num(r.narrative_velocity_score),
    narrative_pressure: num(r.narrative_pressure),
    narrative_mass: num(r.narrative_mass),
    half_life: num(r.half_life),
    fitted_half_life: num(r.fitted_half_life),
    lambda_decay: num(r.lambda_decay, 6),
    fitted_lambda: num(r.fitted_lambda, 6),
    decay_state: r.decay_state || null,
    fit_status: r.fit_status || null,
    narrative_hash: r.narrative_hash || null,
    genesis_date: r.genesis_date || null,
    days_elapsed: r.days_elapsed == null ? null : Number(r.days_elapsed),
    vms: num(r.vms),
    srs: num(r.srs),
    nrs: num(r.nrs),
    npi: num(r.npi),
    suspicion_score: num(r.suspicion_score),
    suspicion_class: r.suspicion_class || null,
    verdict: r.verdict || null,
    verdict_confidence: num(r.verdict_confidence),
    advanced_verdict: r.advanced_verdict || null,
    fvd_pct: num(r.fvd_pct),
    distance_from_max_pain_pct: num(r.distance_from_max_pain_pct),
    put_call_skew: num(r.put_call_skew),
    wks_score: num(r.wks_score),
    fomo_score: num(r.fomo_score),
    fomo_band: r.fomo_band || null,
    doubling_time: num(r.doubling_time),
    effective_narrative_horizon: num(r.effective_narrative_horizon),
    horizon_source: r.horizon_source || null,
    exhaustion_days_dynamic: num(r.exhaustion_days_dynamic),
    walsh_regime: r.walsh_regime || null,
    signal_regime: r.signal_regime || null,
    regime_direction: r.regime_direction || null,
    coordination_score: num(r.coordination_score),
    coordination_class: r.coordination_class || null,
    mass_streak_days: r.mass_streak_days == null ? null : Number(r.mass_streak_days),
    current_price: num(r.current_price),
    macro_theme: r.macro_theme || null,
    lineage: lin[r.snapshot_date] ? {
      values_as_of: lin[r.snapshot_date].values_as_of || null,
      revision_at: lin[r.snapshot_date].revision_at || null,
      is_restatement: lin[r.snapshot_date].is_restatement == null ? null : !!lin[r.snapshot_date].is_restatement
    } : null
  }));

  return {
    ticker,
    window: { requested_sessions: days, returned_sessions: out.length,
      from: out.length ? out[0].snapshot_date : null, to: out.length ? out[out.length - 1].snapshot_date : null },
    rows: out
  };
}


// ── Simulated books (paper portfolios) ─────────────────────────────────────
// Four operational tables, read as-is. Display baseline 2026-04-30 follows the
// Track Record convention (pre-baseline rows reflect the pre-rewrite
// simulator). max_drawdown is deliberately not selected.
const PAPER_BASELINE = '2026-04-30';
const PAPER_DAILY_COLS = 'snapshot_date,cash,open_count,open_exposure,mtm_value,unrealized_pnl,realized_pnl_cumulative,portfolio_value,daily_pnl,daily_return_pct,created_at,updated_at';
const PAPER_STATS_COLS = 'stat_date,total_trades,win_rate,avg_return_pct,total_pnl,sharpe_ratio,profit_factor,short_win_rate,long_win_rate,created_at';

function shapeDaily(rows) {
  return rows.map((r) => ({
    snapshot_date: r.snapshot_date, cash: num(r.cash, 2), open_count: r.open_count == null ? null : Number(r.open_count),
    open_exposure: num(r.open_exposure, 2), mtm_value: num(r.mtm_value, 2), unrealized_pnl: num(r.unrealized_pnl, 2),
    realized_pnl_cumulative: num(r.realized_pnl_cumulative, 2), portfolio_value: num(r.portfolio_value, 2),
    daily_pnl: num(r.daily_pnl, 2), daily_return_pct: num(r.daily_return_pct, 4), created_at: r.created_at || null, updated_at: r.updated_at || null
  }));
}
function shapeStats(rows) {
  return rows.map((r) => ({
    stat_date: r.stat_date, total_trades: r.total_trades == null ? null : Number(r.total_trades), win_rate: num(r.win_rate, 2),
    avg_return_pct: num(r.avg_return_pct, 3), total_pnl: num(r.total_pnl, 2), sharpe_ratio: num(r.sharpe_ratio, 3), profit_factor: num(r.profit_factor, 3),
    short_win_rate: num(r.short_win_rate, 2), long_win_rate: num(r.long_win_rate, 2), created_at: r.created_at || null
  }));
}

let PAPER_CACHE = { at: 0, body: null };
async function buildPaper(rest, headers) {
  if (PAPER_CACHE.body && Date.now() - PAPER_CACHE.at < 5 * 60 * 1000) return PAPER_CACHE.body;
  const q = (t, cols, order) => fetchAll(rest + `${t}?select=${cols}&order=${order}`, headers, 3000);
  const [v6, v5, stV6, st] = await Promise.all([
    q('paper_portfolio_daily_v6', PAPER_DAILY_COLS, 'snapshot_date.asc'),
    q('paper_portfolio_daily', PAPER_DAILY_COLS, 'snapshot_date.asc'),
    q('paper_portfolio_stats_v6', PAPER_STATS_COLS, 'stat_date.asc'),
    q('paper_portfolio_stats', PAPER_STATS_COLS, 'stat_date.asc')
  ]);
  const body = {
    baseline: PAPER_BASELINE,
    books: [
      { key: 'v6', table: 'paper_portfolio_daily_v6', title: 'Daily plays · v6 book', kind: 'daily', base: 300000,
        note: 'USD 300k paper book driven by the daily plays engine. Rebuilt every 15 minutes in market hours and hourly overnight; each row is a mark-to-market snapshot.',
        rows: shapeDaily(v6.filter((r) => r.snapshot_date >= PAPER_BASELINE)) },
      { key: 'v5', table: 'paper_portfolio_daily', title: 'Daily plays · v5 book', kind: 'daily', base: 50000,
        note: 'USD 50k paper book (v5.0), daily mark-to-market snapshots from 2026-04-14. Shown from the 2026-04-30 launch baseline.',
        rows: shapeDaily(v5.filter((r) => r.snapshot_date >= PAPER_BASELINE)) },
      { key: 'stats_v6', table: 'paper_portfolio_stats_v6', title: 'Trade statistics · v6', kind: 'stats',
        note: 'Cumulative trade statistics for the v6 book, one row per statistics run. Gross, modeled fills.',
        rows: shapeStats(stV6) },
      { key: 'stats', table: 'paper_portfolio_stats', title: 'Trade statistics · all paper trades', kind: 'stats',
        note: 'Cumulative statistics over the full paper-trade ledger, one row per statistics run. Gross, modeled fills.',
        rows: shapeStats(st) }
    ],
    generated_at: new Date().toISOString()
  };
  PAPER_CACHE = { at: Date.now(), body };
  return body;
}

// ── Under the hood: per-ticker learning ────────────────────────────────────
const SIG_COLS = 'ticker,sector,industry,fuel_octane_rating,decay_speed_multiplier,noise_tolerance,price_sensitivity_multiplier,gap_fill_tendency,catalyst_avg_move,catalyst_avg_duration,headwind_avg_move,headwind_avg_duration,brier_score_overall,brier_score_30d,current_accuracy_rate,total_predictions,accurate_predictions,confidence_score,calibration_bias,max_simultaneous_narratives,last_calibration_date,updated_at';
const CAL_COLS = 'cell_dim,cell_value,horizon_days,n_resolved,bias_signed,mae,rmse,median_signed_error,in_iqr_rate,predicted_hit_rate_mean,actual_hit_rate,hit_rate_scaling,calibration_confidence,aggregation_window_days,computed_at,aggregator_version';
const FC_COLS = 'ticker,directional_verdict,bias,primary_horizon,severity_label,classification_label,driving_signal,one_line_headline,predicted_1d_pct,predicted_3d_pct,predicted_5d_pct,predicted_10d_pct,predicted_1d_price,predicted_3d_price,predicted_5d_price,predicted_10d_price,predicted_5d_low,predicted_5d_high,predicted_10d_low,predicted_10d_high,conviction_1d,conviction_3d,conviction_5d,conviction_10d,predicted_alpha_5d_vs_spy,predicted_alpha_10d_vs_spy,current_price,fair_value,fvd_pct,invalidation_price,rolling_30_directional,rolling_30_total,rolling_30_hit_rate,rolling_30_avg_edge_pct,scorecard_snapshot_date,forecast_snapshot_date,fair_value_snapshot_date,refresh_mode,heavy_refreshed_at,light_refreshed_at,updated_at';
const DOT_COLS = 'dot_hash,dot_kind,observed_at,cycle_phase,speaker_type,speaker_authority,narrative_text,narrative_direction,market_regime,price_at_observation,return_5d,return_10d,bullshit_probability,ground_truth_label,resolved_at,is_chain_tip,embedding_model,computed_at';

// Universe distribution of the three headline signature traits (min / median /
// max over all tickers) so one ticker's values can be placed. Descriptive only.
let SIG_UNIVERSE_CACHE = { at: 0, body: null };
async function sigUniverse(rest, headers) {
  if (SIG_UNIVERSE_CACHE.body && Date.now() - SIG_UNIVERSE_CACHE.at < 30 * 60 * 1000) return SIG_UNIVERSE_CACHE.body;
  const rows = await fetchAll(rest + 'ticker_signatures?select=fuel_octane_rating,decay_speed_multiplier,noise_tolerance,price_sensitivity_multiplier,brier_score_overall,current_accuracy_rate', headers, 2000);
  const dist = (k) => {
    const v = rows.map((r) => Number(r[k])).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    return { n: v.length, min: num(v[0], 3), p50: num(v[Math.floor(v.length / 2)], 3), max: num(v[v.length - 1], 3) };
  };
  const body = { tickers: rows.length, fuel_octane_rating: dist('fuel_octane_rating'), decay_speed_multiplier: dist('decay_speed_multiplier'), noise_tolerance: dist('noise_tolerance'), price_sensitivity_multiplier: dist('price_sensitivity_multiplier'), brier_score_overall: dist('brier_score_overall'), current_accuracy_rate: dist('current_accuracy_rate') };
  SIG_UNIVERSE_CACHE = { at: Date.now(), body };
  return body;
}

async function buildEngine(rest, headers, ticker) {
  const t = encodeURIComponent(ticker);
  const [sig, cal, fc, dotsRecent, dotsResolved, uni] = await Promise.all([
    getJson(rest + `ticker_signatures?select=${SIG_COLS}&ticker=eq.${t}&limit=1`, headers).catch(() => []),
    getJson(rest + `dot_prediction_calibration?select=${CAL_COLS}&or=(cell_dim.eq.global,and(cell_dim.eq.ticker,cell_value.eq.${t}))&order=computed_at.desc,cell_dim.asc,horizon_days.asc&limit=40`, headers).catch(() => []),
    getJson(rest + `ticker_forecast?select=${FC_COLS}&ticker=eq.${t}&limit=1`, headers).catch(() => []),
    getJson(rest + `narrative_dots?select=${DOT_COLS}&ticker=eq.${t}&narrative_text=not.is.null&order=observed_at.desc&limit=4`, headers).catch(() => []),
    getJson(rest + `narrative_dots?select=${DOT_COLS}&ticker=eq.${t}&narrative_text=not.is.null&resolved_at=not.is.null&order=observed_at.desc&limit=4`, headers).catch(() => []),
    sigUniverse(rest, headers).catch(() => null)
  ]);
  // Keep only the latest computed_at batch of calibration rows.
  const latestCal = cal.length ? cal[0].computed_at : null;
  const calRows = cal.filter((r) => r.computed_at === latestCal).map((r) => ({
    cell_dim: r.cell_dim, cell_value: r.cell_value, horizon_days: r.horizon_days, n_resolved: r.n_resolved == null ? null : Number(r.n_resolved),
    bias_signed: num(r.bias_signed), mae: num(r.mae), rmse: num(r.rmse), median_signed_error: num(r.median_signed_error), in_iqr_rate: num(r.in_iqr_rate),
    predicted_hit_rate_mean: num(r.predicted_hit_rate_mean), actual_hit_rate: num(r.actual_hit_rate), hit_rate_scaling: num(r.hit_rate_scaling),
    calibration_confidence: num(r.calibration_confidence), aggregation_window_days: r.aggregation_window_days, computed_at: r.computed_at, aggregator_version: r.aggregator_version
  }));
  const s = sig[0] || null;
  const f = fc[0] || null;
  const shapeDot = (d) => ({
    dot_hash: d.dot_hash ? String(d.dot_hash).slice(0, 20) : null, dot_kind: d.dot_kind, observed_at: d.observed_at, cycle_phase: d.cycle_phase,
    speaker_type: d.speaker_type, speaker_authority: num(d.speaker_authority, 1), narrative_text: d.narrative_text ? String(d.narrative_text).slice(0, 220) : null,
    narrative_direction: d.narrative_direction, market_regime: d.market_regime, price_at_observation: num(d.price_at_observation, 2),
    return_5d: num(d.return_5d), return_10d: num(d.return_10d), bullshit_probability: num(d.bullshit_probability, 3),
    ground_truth_label: d.ground_truth_label == null ? null : !!d.ground_truth_label, resolved_at: d.resolved_at || null,
    is_chain_tip: d.is_chain_tip == null ? null : !!d.is_chain_tip, embedding_model: d.embedding_model || null, computed_at: d.computed_at || null
  });
  return {
    ticker,
    signature: s ? {
      ticker: s.ticker, sector: s.sector, industry: s.industry,
      fuel_octane_rating: num(s.fuel_octane_rating, 3), decay_speed_multiplier: num(s.decay_speed_multiplier, 3), noise_tolerance: num(s.noise_tolerance, 3),
      price_sensitivity_multiplier: num(s.price_sensitivity_multiplier, 3), gap_fill_tendency: num(s.gap_fill_tendency, 3),
      catalyst_avg_move: num(s.catalyst_avg_move, 2), catalyst_avg_duration: num(s.catalyst_avg_duration, 2), headwind_avg_move: num(s.headwind_avg_move, 2), headwind_avg_duration: num(s.headwind_avg_duration, 2),
      brier_score_overall: num(s.brier_score_overall, 3), brier_score_30d: num(s.brier_score_30d, 3), current_accuracy_rate: num(s.current_accuracy_rate, 3),
      total_predictions: s.total_predictions == null ? null : Number(s.total_predictions), accurate_predictions: s.accurate_predictions == null ? null : Number(s.accurate_predictions),
      confidence_score: num(s.confidence_score, 3), calibration_bias: num(s.calibration_bias, 3), max_simultaneous_narratives: s.max_simultaneous_narratives == null ? null : Number(s.max_simultaneous_narratives),
      last_calibration_date: s.last_calibration_date || null, updated_at: s.updated_at || null
    } : null,
    signature_universe: uni,
    calibration: calRows,
    forecast: f ? {
      ticker: f.ticker, directional_verdict: f.directional_verdict, bias: f.bias, primary_horizon: f.primary_horizon, severity_label: f.severity_label, classification_label: f.classification_label,
      driving_signal: f.driving_signal, one_line_headline: f.one_line_headline ? String(f.one_line_headline).slice(0, 400) : null,
      predicted_1d_pct: num(f.predicted_1d_pct, 3), predicted_3d_pct: num(f.predicted_3d_pct, 3), predicted_5d_pct: num(f.predicted_5d_pct, 3), predicted_10d_pct: num(f.predicted_10d_pct, 3),
      predicted_1d_price: num(f.predicted_1d_price, 2), predicted_3d_price: num(f.predicted_3d_price, 2), predicted_5d_price: num(f.predicted_5d_price, 2), predicted_10d_price: num(f.predicted_10d_price, 2),
      predicted_5d_low: num(f.predicted_5d_low, 2), predicted_5d_high: num(f.predicted_5d_high, 2), predicted_10d_low: num(f.predicted_10d_low, 2), predicted_10d_high: num(f.predicted_10d_high, 2),
      conviction_1d: num(f.conviction_1d, 0), conviction_3d: num(f.conviction_3d, 0), conviction_5d: num(f.conviction_5d, 0), conviction_10d: num(f.conviction_10d, 0),
      predicted_alpha_5d_vs_spy: num(f.predicted_alpha_5d_vs_spy, 3), predicted_alpha_10d_vs_spy: num(f.predicted_alpha_10d_vs_spy, 3),
      current_price: num(f.current_price, 2), fair_value: num(f.fair_value, 2), fvd_pct: num(f.fvd_pct, 2), invalidation_price: num(f.invalidation_price, 2),
      rolling_30_directional: f.rolling_30_directional == null ? null : Number(f.rolling_30_directional), rolling_30_total: f.rolling_30_total == null ? null : Number(f.rolling_30_total),
      rolling_30_hit_rate: num(f.rolling_30_hit_rate, 3), rolling_30_avg_edge_pct: num(f.rolling_30_avg_edge_pct, 3),
      scorecard_snapshot_date: f.scorecard_snapshot_date || null, forecast_snapshot_date: f.forecast_snapshot_date || null, fair_value_snapshot_date: f.fair_value_snapshot_date || null,
      refresh_mode: f.refresh_mode || null, heavy_refreshed_at: f.heavy_refreshed_at || null, light_refreshed_at: f.light_refreshed_at || null, updated_at: f.updated_at || null
    } : null,
    dots: { recent: dotsRecent.map(shapeDot), resolved: dotsResolved.map(shapeDot) },
    generated_at: new Date().toISOString()
  };
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'present-data', 60)) return;
  if (!gate.isAuthed(req)) return sendJson(res, 401, { error: 'access_code_required' });

  try {
    const url = new URL(req.url, 'http://localhost');
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return sendJson(res, 500, { error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).' });
    }
    const headers = { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, Accept: 'application/json' };
    const rest = supabaseUrl + '/rest/v1/';

    const ticker = (url.searchParams.get('ticker') || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase().slice(0, 12);
    const part = url.searchParams.get('part') || '';
    if (part === 'paper') return sendJson(res, 200, await buildPaper(rest, headers));
    if (part === 'engine') {
      if (!ticker || dropTicker(ticker)) return sendJson(res, 404, { error: 'ticker_not_available' });
      return sendJson(res, 200, await buildEngine(rest, headers, ticker));
    }
    if (ticker) {
      if (dropTicker(ticker)) return sendJson(res, 404, { error: 'ticker_not_available' });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '40', 10) || 40, 20), 60);
      const series = await buildSeries(rest, headers, ticker, days);
      return sendJson(res, 200, series);
    }

    let body = META_CACHE.body;
    if (!body || Date.now() - META_CACHE.at > META_TTL_MS) {
      const [metaPart, evidence] = await Promise.all([
        buildMeta(rest, headers),
        buildEvidence(rest, headers).catch((e) => ({ run: null, scorecard: [], cohorts: [], incremental: [], error: e.message }))
      ]);
      body = Object.assign({}, metaPart, { evidence });
      META_CACHE = { at: Date.now(), body };
    }
    return sendJson(res, 200, body);
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : (err.status ? 502 : 500);
    return sendJson(res, status, { error: err.message, status: err.status || null, detail: err.detail || null, url: err.url || null });
  }
};

module.exports._internals = { buildMeta, buildEvidence, buildSeries, SERIES_COLS, EVIDENCE_FEATURES, PIT_START };
