// api/constellation.js
// Forensic Timeline — per-ticker narrative scatter for the ticker pages.
// Reads narrative_dots (RLS-enabled, NO anon policies) so this MUST run
// server-side with the service-role key. The browser hits this endpoint, never
// the table directly.
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
  'return_5d', 'ground_truth_label', 'chain_root_hash'
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

    const base = supabaseUrl + '/rest/v1/narrative_dots';
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

    const [totalResp, bsResp, falseResp, rowsResp] = await Promise.all([
      countReq(''),
      countReq('&bullshit_probability=gt.0.7'),
      countReq('&ground_truth_label=is.false'),
      fetch(rowsUrl, { headers: Object.assign({ Prefer: 'count=exact' }, headers) })
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

    const summary = {
      genesis_total: totalFromRange(totalResp),
      high_bullshit: totalFromRange(bsResp),
      resolved_false: totalFromRange(falseResp)
    };

    // Oldest-first for the timeline; client charts on x=time anyway.
    rows.reverse();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return sendJson(res, 200, {
      ticker,
      days: daysRaw,
      scored,
      summary,
      matched,                 // rows matching the (scored) display filter in-window
      returned: rows.length,   // rows actually sent (<= MAX_ROWS)
      capped: matched != null && matched > rows.length,
      max_rows: MAX_ROWS,
      dots: rows
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unknown error' });
  }
};
