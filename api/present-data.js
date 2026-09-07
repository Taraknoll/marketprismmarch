// api/present-data.js
// Read-only data feed for /present — the Institutional Presentation Mode.
//
// Every number the presentation shows comes from here, and everything here is
// a plain SELECT over production views/tables. Nothing is written, no scoring
// is recomputed, no research statistic is derived in this file beyond simple
// counts (rows, tickers, null cells in a window).
//
// Sources (all read-only):
//   v_market_prism_citadel_feed_v5          — the institutional feed itself
//                                             (service-role only; carries
//                                             first_written_at + decay_provenance)
//   v_market_prism_citadel_feed_v5_lineage  — revision companion (values_as_of,
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

const FEED = 'v_market_prism_citadel_feed_v5';
const LINEAGE = 'v_market_prism_citadel_feed_v5_lineage';

// Feed columns the presentation reads for one security through time. Names are
// the delivered feed names — the page shows them verbatim on Screen 3.
const SERIES_COLS = [
  'ticker', 'snapshot_date', 'first_written_at', 'updated_at', 'is_trading_session',
  'decay_provenance', 'decay_is_pit', 'data_quality_flags',
  'narrative_energy_t', 'narrative_energy_absolute', 'energy_remaining_dynamic',
  'narrative_velocity_score', 'narrative_pressure', 'narrative_mass',
  'half_life', 'fitted_half_life', 'lambda_decay', 'fitted_lambda', 'decay_state', 'fit_status',
  'srs', 'exhaustion_days_dynamic', 'walsh_regime', 'signal_regime', 'regime_direction',
  'coordination_score', 'coordination_class', 'mass_streak_days',
  'current_price', 'macro_theme'
];

// Scorecard features surfaced on Screen 5 / the drawer — the same measurement
// families the deck talks about. Only rows that exist for the latest run are
// returned; nothing is filled in.
const EVIDENCE_FEATURES = [
  'narrative_energy_t', 'narrative_velocity_score', 'narrative_pressure',
  'energy_remaining_dynamic', 'fitted_half_life', 'fitted_lambda',
  'srs', 'coordination_score', 'mass_streak_days'
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
      feed: FEED,
      lineage: LINEAGE,
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
    srs: num(r.srs),
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
