// api/constellation.js
// Forensic Timeline — per-ticker narrative scatter for the ticker pages.
// Reads narrative_dots_clean — the mis-tag-filtered view over narrative_dots
// (drops dots whose source article is Gemini-labeled as not about the tagged
// ticker; see sql/narrative_dots_clean.sql). security_invoker view over an
// RLS-enabled table with NO anon policies, so this MUST run server-side with
// the service-role key. The browser hits this endpoint, never the table.
//
// Env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (falls back to SUPABASE_KEY) — service role read
//
// Query params:
//   ticker   required, e.g. NVDA
//   days     30 | 90 | 180 | all   (default 90)
//   scored   1 (default) = only dots with a credibility score; 0 = include
//            unscored dots too (rendered gray/"not scored" on the client)
//
// Notes baked in from the data (not the spec):
//   - return_5d is a DECIMAL FRACTION (0.032 = 3.2%) — client multiplies by 100.
//   - speaker_type is ~always "journalist"; speaker_authority (0–96) is the
//     real source-strength signal, so that drives bubble size.
//   - narrative_direction is bullish | bearish | neutral | null.
//   - bullshit_probability is SPARSE, not date-bounded — gate on NULL, not date.

const rateLimit = require('./_rate-limit');

const MAX_ROWS = 1500;
const COLS = [
  'dot_hash', 'observed_at', 'narrative_text', 'speaker_type',
  'speaker_authority', 'narrative_direction', 'bullshit_probability',
  'return_5d', 'ground_truth_label', 'chain_root_hash', 'price_at_observation'
].join(',');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// Pull the total off a PostgREST `content-range: 0-24/1234` header.
function totalFromRange(resp) {
  const cr = resp.headers.get('content-range') || '';
  const n = parseInt((cr.split('/')[1] || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'constellation', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const ticker = (url.searchParams.get('ticker') || '')
      .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    const daysRaw = (url.searchParams.get('days') || '90').toLowerCase();
    const scored = url.searchParams.get('scored') !== '0'; // default: scored-only
    // Max dots to return (most-recent-first). The client spreads them on a
    // price-impact axis, so we no longer need to pre-filter by impact.
    const top = Math.min(Math.max(parseInt(url.searchParams.get('top') || '400', 10) || 400, 10), 1000);
    // Per-day density cap: keep only the most authoritative N voices per day so
    // busy event-days don't pile into an unreadable clump.
    const perDay = Math.min(Math.max(parseInt(url.searchParams.get('per_day') || '4', 10) || 4, 1), 50);

    if (!ticker) return sendJson(res, 400, { error: 'Missing ticker' });

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return sendJson(res, 500, {
        error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'
      });
    }

    // Window cutoff. "all" reaches back before the dataset's Feb-2023 origin.
    let cutoffIso;
    if (daysRaw === 'all') {
      cutoffIso = '2023-01-01T00:00:00.000Z';
    } else {
      const days = Math.min(Math.max(parseInt(daysRaw, 10) || 90, 1), 3650);
      cutoffIso = new Date(Date.now() - days * 86400000).toISOString();
    }

    const headers = {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      Accept: 'application/json'
    };

    // narrative_dots_clean = narrative_dots minus mis-tagged dots, so display
    // rows AND the summary counts below are both mis-tag-free.
    const base = supabaseUrl + '/rest/v1/narrative_dots_clean';
    const windowFilter =
      `ticker=eq.${encodeURIComponent(ticker)}` +
      `&dot_kind=eq.genesis` +
      `&observed_at=gte.${encodeURIComponent(cutoffIso)}`;

    // ── Summary counts over the FULL window (honest regardless of row cap) ──
    // Each is a count-only request; we read the total off content-range.
    const countReq = (extra) =>
      fetch(`${base}?select=dot_hash&${windowFilter}${extra}&limit=1`, {
        headers: Object.assign({ Prefer: 'count=exact' }, headers)
      });

    // ── Display rows: most-recent-first so the cap keeps recent dots ──
    let rowsUrl =
      `${base}?select=${COLS}&${windowFilter}` +
      `&order=observed_at.desc&limit=${MAX_ROWS}`;
    if (scored) rowsUrl += `&bullshit_probability=not.is.null`;

    // Latest close, to compute a provisional "return since the claim" for dots
    // whose final 5-day move hasn't been written yet.
    const priceUrl = `${supabaseUrl}/rest/v1/ticker_snapshots` +
      `?select=price_close,snapshot_date&ticker=eq.${encodeURIComponent(ticker)}` +
      `&price_close=not.is.null&order=snapshot_date.desc&limit=1`;

    const [totalResp, bsResp, falseResp, rowsResp, priceResp] = await Promise.all([
      countReq(''),
      countReq('&bullshit_probability=gt.0.7'),
      countReq('&ground_truth_label=is.false'),
      fetch(rowsUrl, { headers: Object.assign({ Prefer: 'count=exact' }, headers) }),
      fetch(priceUrl, { headers })
    ]);

    if (!rowsResp.ok) {
      const detail = await rowsResp.text().catch(() => '');
      return sendJson(res, 502, {
        error: 'narrative_dots query failed',
        status: rowsResp.status,
        detail: detail.slice(0, 300)
      });
    }

    const rows = await rowsResp.json().catch(() => []);
    const matched = totalFromRange(rowsResp); // total matching display filter

    // Provisional "return since the claim" for dots missing a final 5-day move.
    let currentPrice = null;
    try {
      const pj = await priceResp.json().catch(() => []);
      if (Array.isArray(pj) && pj.length && pj[0].price_close != null) currentPrice = Number(pj[0].price_close);
    } catch (e) { /* ignore — provisional fill is best-effort */ }
    if (currentPrice) {
      for (const r of rows) {
        if (r.return_5d == null && r.price_at_observation != null) {
          const obs = Number(r.price_at_observation);
          if (obs > 0) r.live_return = (currentPrice - obs) / obs; // decimal fraction like return_5d
        }
      }
    }

    const summary = {
      genesis_total: totalFromRange(totalResp),
      high_bullshit: totalFromRange(bsResp),
      resolved_false: totalFromRange(falseResp)
    };

    // ── Per-day density cap ──
    // Within each calendar day keep the `perDay` most authoritative voices
    // (ties → bigger 5-day move), so dense event-days stop overlapping while
    // the timeline stays covered. Then cap to the most-recent `top` overall.
    const byDay = new Map();
    for (const r of rows) {
      const day = (r.observed_at || '').slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }
    const authOf = (r) => (r.speaker_authority == null ? -1 : Number(r.speaker_authority));
    const moveOf = (r) => Math.abs(Number(r.return_5d) || 0);
    let kept = [];
    for (const arr of byDay.values()) {
      if (arr.length > perDay) {
        arr.sort((a, b) => (authOf(b) - authOf(a)) || (moveOf(b) - moveOf(a)));
        kept.push(...arr.slice(0, perDay));
      } else {
        kept.push(...arr);
      }
    }
    // Most-recent-first, then overall cap, then oldest-first for the timeline.
    kept.sort((a, b) => (b.observed_at < a.observed_at ? -1 : b.observed_at > a.observed_at ? 1 : 0));
    let selected = (kept.length > top ? kept.slice(0, top) : kept).slice().reverse();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return sendJson(res, 200, {
      ticker,
      days: daysRaw,
      scored,
      top,                       // overall cap
      per_day: perDay,           // per-day density cap
      current_price: currentPrice, // for provisional "return since claim"
      summary,
      matched,                   // rows matching the (scored) display filter in-window
      fetched: rows.length,      // rows pulled before density caps (<= MAX_ROWS)
      returned: selected.length, // rows actually sent
      filtered: matched != null ? selected.length < matched : selected.length < rows.length,
      capped: matched != null && matched > rows.length,
      max_rows: MAX_ROWS,
      dots: selected
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unknown error' });
  }
};
