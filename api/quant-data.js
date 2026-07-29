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

// YYYY-MM-DD for "now" in America/New_York (the earnings calendar runs on ET).
function etDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

// Quant-only divergence from the universe-data mirror: the terminal's dossier
// renders the synopsis as prose (and swaps in the ticker page's hero summary
// async), so cut at a sentence boundary within 600 chars instead of the tab's
// hard mid-word 200-char slice.
const cleanSyn = (v) => {
  const t = String(v || '').trim();
  if (t.length <= 600) return t;
  const cut = t.slice(0, 600);
  const i = cut.lastIndexOf('. ');
  return i > 250 ? cut.slice(0, i + 1) : cut + '…';
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
    // earnings_context lookback — one row per ticker PER DAY, so the read below
    // is windowed (see the query's note) rather than scanning the whole table.
    const earnCutoff = new Date(new Date(date + 'T00:00:00Z').getTime() - 30 * 86400000)
      .toISOString().slice(0, 10);
    // Company-name lookback — every scored ticker reports quarterly, so ~13
    // months back names all but the handful with no Benzinga row at all.
    const nameCutoff = new Date(new Date(date + 'T00:00:00Z').getTime() - 400 * 86400000)
      .toISOString().slice(0, 10);

    // 2-6. latest day + trail history + sector map + earnings calendar + names
    const [today, hist, sectors, earnRows, nameRows] = await Promise.all([
      fetchAll(rest + `narrative_scorecard?select=${TODAY_COLS}&snapshot_date=eq.${encodeURIComponent(date)}&order=ticker.asc`, headers, 2000),
      fetchAll(rest + `narrative_scorecard?select=${HIST_COLS}&snapshot_date=gte.${encodeURIComponent(cutoff)}&order=ticker.asc,snapshot_date.asc`, headers, 8000),
      fetchAll(rest + 'ticker_valuation_config?select=ticker,sector,primary_sector_override&active=eq.true&order=ticker.asc', headers, 1000),
      // Market Physics: freshest next_earnings_date per ticker. Same resolution
      // order as the retired 2D Prism — earnings_context first, scorecard
      // days_to_earnings as fallback. Non-fatal on failure.
      //
      // Sort DATE-major, not ticker-major. earnings_context holds a row per
      // ticker per day (~16k rows match the future-date filter), so a
      // ticker-major sort spent the whole row cap on the first ~37 tickers'
      // history and every ticker past the Cs came back with no earnings row at
      // all — the field drew them as "no report scheduled" while their ticker
      // pages showed the real countdown. Date-major puts the freshest row for
      // EVERY ticker on the first page; the cap now only trims history depth.
      fetchAll(rest + `earnings_context?select=ticker,days_to_earnings,next_earnings_date,snapshot_date&next_earnings_date=gte.${encodeURIComponent(date)}&snapshot_date=gte.${encodeURIComponent(earnCutoff)}&order=snapshot_date.desc,ticker.asc`, headers, 4000)
        .catch(() => []),
      // Company name per ticker, for the ticker picker. benzinga_earnings is the
      // only table carrying a short human name for the whole scored universe
      // (ticker_industry_lookup names barely a third of it, and pads what it has
      // with "… Common Stock" boilerplate). One row per report, so sort
      // DATE-major — a ticker-major sort would spend the row cap on the first
      // few tickers' report history and leave the rest of the alphabet nameless.
      // Non-fatal: a nameless ticker just shows its symbol, as before.
      fetchAll(rest + `benzinga_earnings?select=ticker,company_name,date&company_name=not.is.null&date=gte.${encodeURIComponent(nameCutoff)}&order=date.desc,ticker.asc`, headers, 4000)
        .catch(() => [])
    ]);

    // date-desc order → first row per ticker is the freshest spelling of the name
    const nameOf = {};
    for (const r of nameRows) {
      if (!r.ticker || nameOf[r.ticker]) continue;
      // "Nebius Group N.V. - Class A Ordinary Shares" → "Nebius Group N.V."
      const n = String(r.company_name || '').split(' - ')[0].trim().slice(0, 44);
      if (n && n.toUpperCase() !== String(r.ticker).toUpperCase()) nameOf[r.ticker] = n;
    }

    const earnByT = {};
    for (const e of earnRows) if (!earnByT[e.ticker]) earnByT[e.ticker] = e;   // date-desc order → first per ticker is freshest
    // Count down from TODAY (ET), not from the snapshot date. narrative_scorecard
    // skips weekends, so anchoring to `date` hands a Monday visitor a 3-day-stale
    // countdown while the ticker page — which recomputes against today — shows
    // the real one. Same basis as _ticker.html's earnings pill.
    const todayET = etDateStr(new Date());
    const anchor = todayET > date ? todayET : date;
    const dateMs = new Date(anchor + 'T00:00:00Z').getTime();
    const dteOf = (r) => {
      const e = earnByT[r.ticker];
      if (e && e.next_earnings_date) {
        const d = Math.round((new Date(e.next_earnings_date + 'T00:00:00Z').getTime() - dateMs) / 86400000);
        if (Number.isFinite(d) && d >= 0) return d;
      }
      if (e && e.days_to_earnings != null) return num(e.days_to_earnings, 0);
      // Dateless fallback — a bare integer with no calendar row behind it, so it
      // goes stale silently. Trust it only inside the quarter-ish window
      // _ticker.html uses for the same reason. Negative = just reported; the
      // client phrases that as elapsed, never as a countdown.
      if (r.days_to_earnings != null) {
        const d = num(r.days_to_earnings, 0);
        if (d != null && d >= -14 && d <= 95) return d;
      }
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

    // ── quant-only extension (NOT part of the universe-data mirror): the
    // Narrative Map theme rollup (v_narrative_map_daily — narrative_clusters
    // per theme/day) powers the terminal's mindmap section. Non-fatal.
    let nmap = [];
    try {
      const nmapRows = await fetchAll(
        rest + 'v_narrative_map_daily?select=snapshot_date,theme_key,clusters,max_strength,avg_strength,top_chain,tickers,ticker_count&order=snapshot_date.desc,ticker_count.desc&limit=40',
        headers, 1000);
      if (nmapRows.length) {
        const nday = nmapRows[0].snapshot_date;
        const parseTks = (v) => {
          let a = v;
          if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_e) { a = []; } }
          if (!Array.isArray(a)) return [];
          return a.map((t) => String(t || '').toUpperCase().trim())
            .filter((t) => t && !dropTicker(t)).slice(0, 40);
        };
        nmap = nmapRows
          .filter((r) => r.snapshot_date === nday && Number(r.ticker_count) > 0)
          .map((r) => ({
            k: String(r.theme_key || ''),
            n: Number(r.ticker_count) || 0,
            c: Number(r.clusters) || 0,
            s: num(r.max_strength, 1),
            sa: num(r.avg_strength, 1),
            chain: String(r.top_chain || '').slice(0, 500),
            tks: parseTks(r.tickers)
          }))
          .filter((r) => r.k);
      }
    } catch (_e) { nmap = []; }

    const stocks = [];
    for (const r of today) {
      if (dropTicker(r.ticker)) continue;
      stocks.push({
        t: r.ticker,
        nm: nameOf[r.ticker] || null,
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
        syn: cleanSyn(r.synopsis),
        trail: trails[r.ticker] || []
      });
    }

    // Gated response — never CDN-cache it.
    res.setHeader('Cache-Control', 'private, no-store');
    return sendJson(res, 200, { date, days, count: stocks.length, stocks, nmap });
  } catch (error) {
    if (error && error.detail !== undefined) {
      return sendJson(res, 502, { error: error.message, status: error.status, detail: error.detail });
    }
    return sendJson(res, 500, { error: (error && error.message) || 'Unknown error' });
  }
};
