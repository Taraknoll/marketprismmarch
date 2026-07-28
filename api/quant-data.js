// api/quant-data.js
// Data feed for the standalone /quant terminal (access-code gated).
//
// ⚠️ KEEP IN SYNC WITH api/universe-data.js — the data path below (columns,
// exhaustion composite, trail shape, sector roll-up, earnings resolution) is a
// deliberate verbatim mirror so the /quant terminal shows EXACTLY what the
// product's Universe + Market Physics tabs show. Only the gate differs:
// universe-data requires a product login (requireAuth); this endpoint requires
// the mq_session access-code cookie (api/_require-quant.js) and nothing else.
// If TODAY_COLS / HIST_COLS / shaping change there, change them here too.

const rateLimit = require('./_rate-limit');
const quant = require('./_require-quant');
const { isHidden } = require('./_hidden-tickers');

// Dashboard-wide exclusion: scorecard values for these foreign filers are
// wildly wrong (mirrors MP_EXCLUDED_TICKERS in _template.html).
const EXCLUDED = new Set(['SONY', 'HMC', 'TM', 'TSM', 'DJT']);
const dropTicker = (t) => isHidden(t) || EXCLUDED.has(String(t || '').toUpperCase());

const TODAY_COLS = [
  'ticker', 'verdict', 'verdict_confidence', 'narrative_mass', 'wks_score',
  'walsh_regime', 'drift_score', 'fvd_pct', 'coordination_score',
  'coordination_class', 'suspicion_score', 'suspicion_class', 'nrs', 'vms',
  'srs', 'ccp', 'npi', 'current_price', 'narrative_state', 'narrative_tone',
  'energy_remaining_dynamic', 'mass_streak_days', 'exhaustion_status',
  'exhaustion_confidence', 'synopsis', 'days_to_earnings'
].join(',');
const HIST_COLS = [
  'ticker', 'snapshot_date', 'wks_score', 'fvd_pct', 'exhaustion_status',
  'exhaustion_confidence', 'walsh_regime', 'verdict',
  'current_price', 'narrative_mass'   // per-day price + mass power the Market Physics view
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

// Exhaustion level 0..1 — composite of the engine's own exhaustion outputs.
// Mirrors universe-data.js exactly so the two surfaces agree.
function exhaustLevel(st, conf, regime, verdict) {
  let lv = st === 'NARRATIVE_EXHAUSTED' ? 0.60
         : st === 'EXHAUSTION_LIKELY'   ? 0.42
         : st === 'STILL_ACTIVE'        ? 0.15 : 0.35;
  if (conf != null) lv += 0.15 * (conf - 0.7) / 0.3;
  if (verdict === 'Exhausted Narrative') lv += 0.25;
  if (verdict === 'High Conviction Continuation') lv -= 0.15;
  if (regime === 'EXHAUSTING') lv += 0.15;
  if (regime && regime.indexOf('FRESH') >= 0) lv -= 0.20;
  return Math.round(Math.max(0.02, Math.min(0.98, lv)) * 100) / 100;
}

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
  if (!rateLimit(req, res, 'quant-data', 60)) return;
  // Access-code cookie only — minted by api/quant-session.js. 401 (not a
  // redirect): the /quant page reacts by re-showing its gate overlay.
  if (!quant.isAuthed(req)) {
    res.setHeader('Cache-Control', 'private, no-store');
    return sendJson(res, 401, { error: 'access_code_required' });
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '16', 10) || 16, 7), 30);

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return sendJson(res, 500, {
        error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'
      });
    }
    const headers = {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      Accept: 'application/json'
    };
    const rest = supabaseUrl + '/rest/v1/';

    // 1. latest scored day
    const dResp = await fetch(rest + 'narrative_scorecard?select=snapshot_date&order=snapshot_date.desc&limit=1', { headers });
    if (!dResp.ok) {
      const detail = await dResp.text().catch(() => '');
      return sendJson(res, 502, { error: 'narrative_scorecard query failed', status: dResp.status, detail: detail.slice(0, 300) });
    }
    const dRows = await dResp.json().catch(() => []);
    const date = dRows && dRows[0] && dRows[0].snapshot_date;
    if (!date) return sendJson(res, 502, { error: 'no scorecard rows found' });

    const cutoff = new Date(new Date(date + 'T00:00:00Z').getTime() - days * 86400000)
      .toISOString().slice(0, 10);

    // 2-5. latest day + trail history + sector map + earnings calendar
    const [today, hist, sectors, earnRows] = await Promise.all([
      fetchAll(rest + `narrative_scorecard?select=${TODAY_COLS}&snapshot_date=eq.${encodeURIComponent(date)}&order=ticker.asc`, headers, 2000),
      fetchAll(rest + `narrative_scorecard?select=${HIST_COLS}&snapshot_date=gte.${encodeURIComponent(cutoff)}&order=ticker.asc,snapshot_date.asc`, headers, 8000),
      fetchAll(rest + 'ticker_valuation_config?select=ticker,sector,primary_sector_override&active=eq.true&order=ticker.asc', headers, 1000),
      // Market Physics: freshest next_earnings_date per ticker. Same resolution
      // order as the retired 2D Prism — earnings_context first, scorecard
      // days_to_earnings as fallback. Non-fatal on failure.
      fetchAll(rest + `earnings_context?select=ticker,days_to_earnings,next_earnings_date,snapshot_date&next_earnings_date=gte.${encodeURIComponent(date)}&order=ticker.asc,snapshot_date.desc`, headers, 3000)
        .catch(() => [])
    ]);

    const earnByT = {};
    for (const e of earnRows) if (!earnByT[e.ticker]) earnByT[e.ticker] = e;   // desc order → first is freshest
    const dateMs = new Date(date + 'T00:00:00Z').getTime();
    const dteOf = (r) => {
      const e = earnByT[r.ticker];
      if (e && e.next_earnings_date) {
        const d = Math.round((new Date(e.next_earnings_date + 'T00:00:00Z').getTime() - dateMs) / 86400000);
        if (Number.isFinite(d) && d >= 0) return d;
      }
      if (e && e.days_to_earnings != null) return num(e.days_to_earnings, 0);
      if (r.days_to_earnings != null) return num(r.days_to_earnings, 0);
      return null;
    };

    // ticker_valuation_config mixes broad sectors with curated narrative themes
    // ("AI Infrastructure" = one ticker). Themes roll up to a canonical family;
    // the theme itself ships separately as `ind` for the dossier.
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
    const secOf = {}, indOf = {};
    for (const r of sectors) {
      const raw = r.primary_sector_override || r.sector || 'Other';
      const fam = SECTOR_FAMILY[raw] || raw;
      secOf[r.ticker] = fam;
      if (fam !== raw) indOf[r.ticker] = raw;
    }

    const trails = {};
    // last pre-today verdict per ticker — powers the client's "Today's shifts"
    // feed (verdict flips / new traps). hist is ordered by date asc, so the
    // final overwrite is the most recent day before `date`.
    const prevV = {};
    for (const r of hist) {
      if (dropTicker(r.ticker)) continue;
      if (r.snapshot_date !== date) prevV[r.ticker] = r.verdict || null;
      // [wks, exh, fvd, price, mass] — universe reads 0-2; Market Physics reads 3-4 too
      (trails[r.ticker] = trails[r.ticker] || []).push([
        num(r.wks_score, 1),
        exhaustLevel(r.exhaustion_status, num(r.exhaustion_confidence), r.walsh_regime, r.verdict),
        num(r.fvd_pct, 1),
        num(r.current_price, 2),
        num(r.narrative_mass, 2)
      ]);
    }

    const stocks = [];
    for (const r of today) {
      if (dropTicker(r.ticker)) continue;
      stocks.push({
        t: r.ticker,
        sec: secOf[r.ticker] || 'Other',
        ind: indOf[r.ticker] || null,
        edays: dteOf(r),
        edate: (earnByT[r.ticker] && earnByT[r.ticker].next_earnings_date) || null,
        v: r.verdict || 'Monitoring',
        pv: prevV[r.ticker] || null,
        conf: num(r.verdict_confidence, 0),
        mass: num(r.narrative_mass, 2),
        wks: num(r.wks_score, 1),
        regime: r.walsh_regime || null,
        drift: num(r.drift_score, 0),
        fvd: num(r.fvd_pct, 1),
        coord: num(r.coordination_score, 0),
        coordCls: r.coordination_class || null,
        susp: num(r.suspicion_score, 0),
        suspCls: r.suspicion_class || null,
        nrs: num(r.nrs, 0),
        vms: num(r.vms, 0),
        srs: num(r.srs, 0),
        ccp: num(r.ccp, 0),
        npi: num(r.npi, 0),
        price: num(r.current_price, 2),
        state: r.narrative_state || null,
        tone: r.narrative_tone || null,
        energy: num(r.energy_remaining_dynamic, 2),
        streak: num(r.mass_streak_days, 0),
        exst: r.exhaustion_status || null,
        exh: exhaustLevel(r.exhaustion_status, num(r.exhaustion_confidence), r.walsh_regime, r.verdict),
        syn: (r.synopsis || '').trim().slice(0, 200),
        trail: trails[r.ticker] || []
      });
    }

    // Gated response — never CDN-cache it.
    res.setHeader('Cache-Control', 'private, no-store');
    return sendJson(res, 200, { date, days, count: stocks.length, stocks });
  } catch (error) {
    if (error && error.detail !== undefined) {
      return sendJson(res, 502, { error: error.message, status: error.status, detail: error.detail });
    }
    return sendJson(res, 500, { error: (error && error.message) || 'Unknown error' });
  }
};
