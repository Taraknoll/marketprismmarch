// api/present-os-data.js
// Read-only data feed for /present-os — the Founder Briefing: a five-slide,
// read-only sibling of /present prepared for a data-sourcing evaluation
// meeting. Same password cookie as /present (api/_require-present.js); a 401
// tells the page to re-show its gate overlay.
//
// Everything here is a plain SELECT over the institutional feed view. Nothing
// is written, no score is recomputed, and the only derivation is a stated,
// deterministic selection rule for the default example (see EXAMPLE_RULE).
// The page reads everything else it shows from the unchanged /api/present-data
// (feed rows per security, paper books, PIT counts) and /api/price-history.
//
// Modes:
//   GET /api/present-os-data?part=universe
//       → the latest scored session, one row per security: the fields the
//         slide-3 field draws on the dashboard's own Narrative Universe axes
//         (valuation fvd_pct × tape energy wks_score; mass; regime; state).
//   GET /api/present-os-data?part=example
//       → the default example security + observation date, chosen by the rule
//         in the response (and shown on the slide) — never by outcome.

const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');
const { isHidden } = require('./_hidden-tickers');

// Mirrors the dashboard-wide exclusion used by quant-data / universe-data / present-data.
const EXCLUDED = new Set(['SONY', 'HMC', 'TM', 'TSM', 'DJT']);
const dropTicker = (t) => isHidden(t) || EXCLUDED.has(String(t || '').toUpperCase());

// Physical database view name (the same constant api/present-data.js keeps). It
// is never sent to the client; the page labels it "institutional feed v5".
const FEED = 'v_market_prism_citadel_feed_v5';
const PIT_START = '2026-03-02';

const UNIVERSE_COLS = [
  'ticker', 'snapshot_date', 'first_written_at', 'decay_state', 'walsh_regime', 'verdict',
  'narrative_energy_t', 'narrative_velocity_score', 'narrative_mass', 'vms', 'wks_score', 'fvd_pct',
  'current_price', 'exhaustion_days_dynamic', 'fitted_half_life', 'coordination_score', 'macro_theme'
];

// The default-example rule. Stated here, returned to the page, and shown in the
// research drawer. It selects on bookkeeping cleanliness, never on returns.
const EXAMPLE_RULE = {
  window_sessions: 45,
  min_later_sessions: 11,
  min_coverage: 30,
  criteria: [
    'decay_provenance = LIVE_PIT (sessions from March 2, 2026 onward)',
    'fit_status = OK: a significant decay fit, so fitted_half_life is delivered',
    'data_quality_flags carries neither ROW_RESTATED_AFTER_24H nor HALF_LIFE_SENTINEL',
    'first_written_at falls on the observation\'s own session date, before the 09:30 ET open',
    'at least 11 later sessions exist in the feed, so the +5 and +10 session outcomes are complete'
  ],
  ranking: 'the security with the most qualifying observations in the window (ties: more decay_state transitions, then alphabetical); its most recent qualifying observation'
};

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

// The stored timestamp rendered on the America/New_York calendar: the date it
// falls on and the minute of that day. A rendering, not a different value.
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function etParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = {};
  for (const part of ET_FMT.formatToParts(d)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;   // "24" appears for midnight in some ICU builds
  return { date: p.year + '-' + p.month + '-' + p.day, minutes: hour * 60 + Number(p.minute) };
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

async function latestSession(rest, headers) {
  const rows = await getJson(rest + `${FEED}?select=snapshot_date&order=snapshot_date.desc&limit=1`, headers);
  const d = rows[0] && rows[0].snapshot_date;
  if (!d) throw new Error('feed has no rows');
  return d;
}

// ── universe: the latest scored session, one row per security ──────────────
let UNIVERSE_CACHE = { at: 0, body: null };
async function buildUniverse(rest, headers) {
  if (UNIVERSE_CACHE.body && Date.now() - UNIVERSE_CACHE.at < 5 * 60 * 1000) return UNIVERSE_CACHE.body;
  const date = await latestSession(rest, headers);
  const rows = await fetchAll(
    rest + `${FEED}?select=${UNIVERSE_COLS.join(',')}&snapshot_date=eq.${date}&is_trading_session=is.true&order=ticker.asc`,
    headers, 3000);
  const out = [];
  let firstWrite = null, lastWrite = null, fvdMissing = 0;
  for (const r of rows) {
    if (!r.ticker || dropTicker(r.ticker)) continue;
    if (r.first_written_at) {
      if (!firstWrite || r.first_written_at < firstWrite) firstWrite = r.first_written_at;
      if (!lastWrite || r.first_written_at > lastWrite) lastWrite = r.first_written_at;
    }
    if (r.fvd_pct == null) fvdMissing += 1;
    out.push({
      ticker: r.ticker,
      snapshot_date: r.snapshot_date,
      first_written_at: r.first_written_at || null,
      decay_state: r.decay_state || null,
      walsh_regime: r.walsh_regime || null,
      verdict: r.verdict || null,
      narrative_energy_t: num(r.narrative_energy_t, 2),
      narrative_velocity_score: num(r.narrative_velocity_score, 4),
      narrative_mass: num(r.narrative_mass, 3),
      vms: num(r.vms, 1),
      wks_score: num(r.wks_score, 1),
      fvd_pct: num(r.fvd_pct, 1),
      current_price: num(r.current_price, 2),
      exhaustion_days_dynamic: num(r.exhaustion_days_dynamic, 1),
      fitted_half_life: num(r.fitted_half_life, 2),
      coordination_score: num(r.coordination_score, 1),
      macro_theme: r.macro_theme || null
    });
  }
  const body = {
    feed: 'institutional feed v5',
    snapshot_date: date,
    n: out.length,
    first_write: firstWrite,
    last_write: lastWrite,
    fvd_missing: fvdMissing,
    axes: {
      x: 'fvd_pct · valuation: price versus the fundamental anchor, clamped to ±100%',
      y: 'wks_score · tape energy: signed directional evidence, −100 to +100',
      size: 'narrative_mass',
      color: 'walsh_regime'
    },
    rows: out,
    generated_at: new Date().toISOString()
  };
  UNIVERSE_CACHE = { at: Date.now(), body };
  return body;
}

// ── example: the default observation, by rule ──────────────────────────────
let EXAMPLE_CACHE = { at: 0, body: null };
async function buildExample(rest, headers) {
  if (EXAMPLE_CACHE.body && Date.now() - EXAMPLE_CACHE.at < 15 * 60 * 1000) return EXAMPLE_CACHE.body;
  const last = await latestSession(rest, headers);
  // ~70 calendar days covers 45 sessions with room for holidays.
  const cutoff = isoDaysAgo(last, 70);
  const rows = await fetchAll(
    rest + `${FEED}?select=ticker,snapshot_date,decay_state,fit_status,data_quality_flags,first_written_at&decay_provenance=eq.LIVE_PIT&is_trading_session=is.true&snapshot_date=gte.${cutoff}&order=ticker.asc,snapshot_date.asc`,
    headers, 30000);

  const dateSet = new Set();
  for (const r of rows) if (r.snapshot_date) dateSet.add(r.snapshot_date);
  const dates = Array.from(dateSet).sort().slice(-EXAMPLE_RULE.window_sessions);
  const inWindow = new Set(dates);
  // An observation qualifies only if at least `min_later_sessions` sessions follow it.
  const dcut = dates.length > EXAMPLE_RULE.min_later_sessions ? dates[dates.length - 1 - EXAMPLE_RULE.min_later_sessions] : null;

  const per = {};
  for (const r of rows) {
    if (!r.ticker || !inWindow.has(r.snapshot_date) || dropTicker(r.ticker)) continue;
    const p = per[r.ticker] || (per[r.ticker] = { n: 0, ok: 0, transitions: 0, prev: null, latestOk: null });
    p.n += 1;
    if (p.prev != null && r.decay_state && r.decay_state !== p.prev) p.transitions += 1;
    if (r.decay_state) p.prev = r.decay_state;
    const flags = String(r.data_quality_flags || '');
    const et = etParts(r.first_written_at);
    const clean = r.fit_status === 'OK'
      && flags.indexOf('ROW_RESTATED') < 0
      && flags.indexOf('HALF_LIFE_SENTINEL') < 0
      && et && et.date === r.snapshot_date && et.minutes < 9 * 60 + 30
      && dcut != null && r.snapshot_date <= dcut;
    if (clean) { p.ok += 1; if (!p.latestOk || r.snapshot_date > p.latestOk) p.latestOk = r.snapshot_date; }
  }

  const ranked = Object.keys(per)
    .filter((t) => per[t].n >= EXAMPLE_RULE.min_coverage && per[t].ok > 0)
    .map((t) => ({ ticker: t, sessions: per[t].n, qualifying: per[t].ok, transitions: per[t].transitions, latest_qualifying: per[t].latestOk }))
    .sort((a, b) => b.qualifying - a.qualifying || b.transitions - a.transitions || a.ticker.localeCompare(b.ticker));

  const pick = ranked[0] || null;
  const body = {
    ticker: pick ? pick.ticker : null,
    snapshot_date: pick ? pick.latest_qualifying : null,
    rule: EXAMPLE_RULE,
    window: { from: dates[0] || null, to: dates[dates.length - 1] || null, sessions: dates.length, latest_qualifying_session: dcut },
    considered: { rows: rows.length, securities: Object.keys(per).length, eligible: ranked.length },
    ranked: ranked.slice(0, 8),
    pit_start: PIT_START,
    generated_at: new Date().toISOString()
  };
  EXAMPLE_CACHE = { at: Date.now(), body };
  return body;
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'present-os-data', 60)) return;
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

    const part = url.searchParams.get('part') || '';
    if (part === 'universe') return sendJson(res, 200, await buildUniverse(rest, headers));
    if (part === 'example') return sendJson(res, 200, await buildExample(rest, headers));
    return sendJson(res, 400, { error: 'unknown_part', parts: ['universe', 'example'] });
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : (err.status ? 502 : 500);
    return sendJson(res, status, { error: err.message, status: err.status || null, detail: err.detail || null, url: err.url || null });
  }
};

module.exports._internals = { buildUniverse, buildExample, EXAMPLE_RULE, UNIVERSE_COLS, etParts };
