// api/signature-data.js
// Ticker Signature (TEST PAGE) — earnings-cycle phase data for one ticker.
// Returns everything the /signature page needs in one GET: the phase clock
// (earnings_context), historical earnings events (earnings_releases), the
// split-adjusted price history (gold_daily_bars), the ticker's scorecard
// history, a same-sector peer snapshot, learned sizing, and recent registry
// plays. Runs server-side with the service-role key because gold_daily_bars
// and ticker_sizing_learned are RLS-locked to service role; everything else
// here is anon-readable anyway. The browser hits this endpoint, never the
// tables.
//
// Env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (falls back to SUPABASE_KEY, then SUPABASE_ANON
//                               in a degraded narrative-only mode)
//
// Query params:
//   t   ticker (default PYPL)

const rateLimit = require('./_rate-limit');
const requireAuth = require('./_require-auth');
const { isHidden } = require('./_hidden-tickers');

// Dashboard-wide exclusion: scorecard values for these foreign filers are
// wildly wrong (mirrors MP_EXCLUDED_TICKERS in _template.html / universe-data).
const EXCLUDED = new Set(['SONY', 'HMC', 'TM', 'TSM', 'DJT']);

// Keep cohorts consistent with the Universe tab: curated narrative themes in
// ticker_valuation_config roll up to a canonical sector family.
const SECTOR_FAMILY = {
  'AI Infrastructure': 'Technology',
  'Cloud Computing': 'Technology',
  'Quantum Computing': 'Technology',
  'Defense Technology': 'Technology',
  'Software': 'Technology',
  'Cybersecurity': 'Technology',
  'Aerospace & Defense': 'Industrials',
  'Robotics & Automation': 'Industrials',
  'Electric Vehicles & Autonomous Transport': 'Consumer Discretionary',
  'Social Media & Digital Advertising': 'Communications',
  'Streaming & Entertainment': 'Communications',
  'REITs': 'Real Estate',
  'Fintech': 'Financials',
  'Crypto & Digital Assets': 'Financials',
  'Biotechnology': 'Healthcare'
};

const SC_COLS = [
  'snapshot_date', 'wks_score', 'narrative_mass', 'narrative_energy_t',
  'energy_remaining_dynamic', 'decay_rate', 'coordination_score', 'drift_score',
  'fvd_pct', 'nrs', 'vms', 'verdict', 'verdict_confidence', 'walsh_regime',
  'narrative_state', 'days_to_earnings', 'suspicion_score', 'suspicion_class',
  'mass_streak_days', 'current_price', 'exhaustion_status', 'narrative_tone'
].join(',');

const PEER_COLS = [
  'ticker', 'wks_score', 'fvd_pct', 'narrative_mass', 'verdict', 'walsh_regime',
  'current_price', 'days_to_earnings', 'narrative_state'
].join(',');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

const num = (v, dp) => {
  if (v == null) return null;
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  const m = Math.pow(10, dp == null ? 2 : dp);
  return Math.round(f * m) / m;
};

// PostgREST rows can be capped server-side regardless of ?limit= — page with
// Range headers until short page / hard cap.
async function fetchAll(url, headers, cap) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < cap; from += page) {
    const resp = await fetch(url, {
      headers: Object.assign({ Range: `${from}-${from + page - 1}`, 'Range-Unit': 'items' }, headers)
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      const err = new Error('upstream query failed');
      err.status = resp.status;
      err.detail = detail.slice(0, 300);
      throw err;
    }
    const rows = await resp.json().catch(() => []);
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'signature-data', 60)) return;
  const auth = await requireAuth(req, res, { jsonOnly: true });
  if (!auth) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const raw = url.searchParams.get('t') || url.searchParams.get('ticker') || 'PYPL';
    const ticker = String(raw).replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase() || 'PYPL';
    if (isHidden(ticker) || EXCLUDED.has(ticker)) {
      return sendJson(res, 404, { error: 'unsupported ticker' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    const anonKey = process.env.SUPABASE_ANON || '';
    if (!supabaseUrl || (!serviceKey && !anonKey)) {
      return sendJson(res, 500, { error: 'Supabase env not configured.' });
    }
    const rest = supabaseUrl + '/rest/v1/';
    const hdr = (key) => ({
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json'
    });

    // Probe the service key once; if it fails (e.g. mid-rotation), fall back
    // to the anon key — the page then renders in narrative-only mode because
    // gold_daily_bars / ticker_sizing_learned are RLS-hidden from anon.
    let key = serviceKey || anonKey;
    let keyMode = serviceKey ? 'service' : 'anon';
    if (serviceKey) {
      const probe = await fetch(rest + 'narrative_scorecard?select=ticker&limit=1', { headers: hdr(serviceKey) });
      if (!probe.ok && anonKey) { key = anonKey; keyMode = 'anon'; }
    }
    const headers = hdr(key);
    const enc = encodeURIComponent(ticker);

    // Latest scored day — peers snapshot keys off it.
    const dResp = await fetch(rest + 'narrative_scorecard?select=snapshot_date&order=snapshot_date.desc&limit=1', { headers });
    if (!dResp.ok) {
      const detail = await dResp.text().catch(() => '');
      return sendJson(res, 502, { error: 'scorecard query failed', status: dResp.status, detail: detail.slice(0, 300) });
    }
    const dRows = await dResp.json().catch(() => []);
    const date = dRows && dRows[0] && dRows[0].snapshot_date;
    if (!date) return sendJson(res, 502, { error: 'no scorecard rows found' });

    const [events, clockRows, bars, sc, valcfg, sizingRows, plays] = await Promise.all([
      fetchAll(rest + `earnings_releases?ticker=eq.${enc}&select=filing_date,eps_surprise_pct,revenue_surprise_pct&order=filing_date.asc`, headers, 1000),
      fetchAll(rest + `earnings_context?ticker=eq.${enc}&select=snapshot_date,days_to_earnings,next_earnings_date,last_earnings_date,earnings_position,earnings_window_flag&order=snapshot_date.desc&limit=1`, headers, 1000),
      fetchAll(rest + `gold_daily_bars?ticker=eq.${enc}&select=snapshot_date,price_open,price_high,price_low,price_close&order=snapshot_date.asc`, headers, 3000)
        .catch(() => []),
      fetchAll(rest + `narrative_scorecard?ticker=eq.${enc}&select=${SC_COLS}&order=snapshot_date.asc`, headers, 1000),
      fetchAll(rest + 'ticker_valuation_config?select=ticker,sector,primary_sector_override&active=eq.true&order=ticker.asc', headers, 1000),
      fetchAll(rest + `ticker_sizing_learned?ticker=eq.${enc}&select=ticker,multiplier,tier,n_trades,win_rate,mu_pct,sigma_pct,live_n,live_win_rate`, headers, 100)
        .catch(() => []),
      fetchAll(rest + `tracked_daily_plays?ticker=eq.${enc}&select=lane,direction,entry_date,entry_price,status,predicted_return_pct,predicted_hold_days,current_return_pct,exit_return_pct,hit,snapshot_date&order=created_at.desc&limit=8`, headers, 100)
        .catch(() => [])
    ]);

    // Peer cohort: same sector family, current-day scorecard snapshot.
    const secRaw = {}, famOf = {}, indOf = {};
    for (const r of valcfg) {
      const rawSec = r.primary_sector_override || r.sector || 'Other';
      const fam = SECTOR_FAMILY[rawSec] || rawSec;
      secRaw[r.ticker] = rawSec;
      famOf[r.ticker] = fam;
      if (fam !== rawSec) indOf[r.ticker] = rawSec;
    }
    const family = famOf[ticker] || null;
    let peers = [];
    let peerEarn = {};
    if (family) {
      const cohort = Object.keys(famOf)
        .filter((t) => famOf[t] === family && t !== ticker && !isHidden(t) && !EXCLUDED.has(t));
      if (cohort.length) {
        const inList = cohort.map(encodeURIComponent).join(',');
        const cutoff = new Date(new Date(date + 'T00:00:00Z').getTime() - 7 * 86400000)
          .toISOString().slice(0, 10);
        const [peerRows, peerEarnRows] = await Promise.all([
          fetchAll(rest + `narrative_scorecard?select=${PEER_COLS}&snapshot_date=eq.${encodeURIComponent(date)}&ticker=in.(${inList})&order=ticker.asc`, headers, 1000),
          fetchAll(rest + `earnings_context?select=ticker,days_to_earnings,next_earnings_date,snapshot_date&ticker=in.(${inList})&snapshot_date=gte.${cutoff}&order=ticker.asc,snapshot_date.desc`, headers, 3000)
            .catch(() => [])
        ]);
        for (const e of peerEarnRows) if (!peerEarn[e.ticker]) peerEarn[e.ticker] = e;
        // Upcoming events only — a peer whose next_earnings_date already passed
        // (stale calendar row) must not surface as "reports in −7 days".
        const dateMs = new Date(date + 'T00:00:00Z').getTime();
        const upcomingDte = (r) => {
          const e = peerEarn[r.ticker];
          if (e && e.next_earnings_date) {
            const d = Math.round((new Date(e.next_earnings_date + 'T00:00:00Z').getTime() - dateMs) / 86400000);
            if (Number.isFinite(d) && d >= 0) return { dte: d, edate: e.next_earnings_date };
          }
          if (r.days_to_earnings != null && r.days_to_earnings >= 0) {
            return { dte: num(r.days_to_earnings, 0), edate: null };
          }
          return { dte: null, edate: null };
        };
        peers = peerRows
          .map((r) => {
            const up = upcomingDte(r);
            return {
              t: r.ticker,
              ind: indOf[r.ticker] || null,
              wks: num(r.wks_score, 1),
              fvd: num(r.fvd_pct, 1),
              mass: num(r.narrative_mass, 2),
              v: r.verdict || null,
              regime: r.walsh_regime || null,
              state: r.narrative_state || null,
              price: num(r.current_price, 2),
              dte: up.dte,
              edate: up.edate
            };
          })
          .sort((a, b) => (b.mass || 0) - (a.mass || 0))
          .slice(0, 18);
      }
    }

    const payload = {
      ticker,
      date,
      keyMode,
      family,
      theme: indOf[ticker] || null,
      clock: clockRows[0] || null,
      events: events.map((e) => ({
        date: e.filing_date,
        eps_s: num(e.eps_surprise_pct, 4),
        rev_s: num(e.revenue_surprise_pct, 4)
      })),
      // [date, open, high, low, close] — compact array form
      bars: bars.map((b) => [
        b.snapshot_date,
        num(b.price_open, 4), num(b.price_high, 4), num(b.price_low, 4), num(b.price_close, 4)
      ]),
      sc: sc.map((r) => ({
        d: r.snapshot_date,
        wks: num(r.wks_score, 1),
        mass: num(r.narrative_mass, 2),
        energy: num(r.narrative_energy_t, 1),
        energy_dyn: num(r.energy_remaining_dynamic, 2),
        decay: num(r.decay_rate, 3),
        coord: num(r.coordination_score, 1),
        drift: num(r.drift_score, 1),
        fvd: num(r.fvd_pct, 1),
        nrs: num(r.nrs, 1),
        vms: num(r.vms, 1),
        v: r.verdict || null,
        conf: num(r.verdict_confidence, 0),
        regime: r.walsh_regime || null,
        state: r.narrative_state || null,
        dte: num(r.days_to_earnings, 0),
        streak: num(r.mass_streak_days, 0),
        price: num(r.current_price, 2),
        exst: r.exhaustion_status || null,
        tone: r.narrative_tone || null
      })),
      peers,
      sizing: sizingRows[0]
        ? {
            multiplier: num(sizingRows[0].multiplier, 2),
            tier: sizingRows[0].tier || null,
            n_trades: num(sizingRows[0].n_trades, 0),
            win_rate: num(sizingRows[0].win_rate, 3),
            mu_pct: num(sizingRows[0].mu_pct, 2),
            sigma_pct: num(sizingRows[0].sigma_pct, 2),
            live_n: num(sizingRows[0].live_n, 0),
            live_win_rate: num(sizingRows[0].live_win_rate, 3)
          }
        : null,
      plays: plays.map((p) => ({
        lane: p.lane || null,
        dir: p.direction || null,
        entry_date: p.entry_date || null,
        entry: num(p.entry_price, 2),
        status: p.status || null,
        pred: num(p.predicted_return_pct, 2),
        hold: num(p.predicted_hold_days, 0),
        cur: num(p.current_return_pct, 2),
        exit_ret: num(p.exit_return_pct, 2),
        hit: p.hit == null ? null : !!p.hit,
        snapshot_date: p.snapshot_date || null
      }))
    };

    // Auth-gated response — never CDN-cache it.
    res.setHeader('Cache-Control', 'private, no-store');
    return sendJson(res, 200, payload);
  } catch (error) {
    if (error && error.detail !== undefined) {
      return sendJson(res, 502, { error: error.message, status: error.status, detail: error.detail });
    }
    return sendJson(res, 500, { error: (error && error.message) || 'Unknown error' });
  }
};
