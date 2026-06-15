// api/ticker-day-narratives.js
// Signal Lab — for each calendar day, the ticker's single MOST-AUTHORITATIVE
// narrative (from narrative_dots) plus the count of narratives that day.
//
// A Signal Lab mass dot is a whole DAY's aggregate narrative mass, which maps to
// many narrative_dots rows. We bind the dot's card to the day's strongest single
// voice (most authoritative) and note "1 of N" — we do NOT imply one verdict for
// the whole day.
//
// narrative_dots is RLS-enabled with NO anon policies, so this MUST run
// server-side with the service-role key.
//
// Selection per day: speaker_authority DESC (nulls last) → prefer is_chain_tip,
// then dot_kind='genesis' on ties → most recent observed_at.
//
// Data gotchas (baked in, not assumed):
//   - return_5d is a DECIMAL FRACTION (0.032 = 3.2%); client ×100.
//   - bullshit_probability is SPARSE; null => "Not scored".
//   - ground_truth_label is boolean|null; null => unresolved (omit verdict).
//
// Query params: ticker (required), days (default 400)

const rateLimit = require('./_rate-limit');

const MAX_ROWS = 2000;
const COLS = [
  'observed_at', 'narrative_text', 'speaker_type', 'speaker_authority',
  'narrative_direction', 'bullshit_probability', 'return_5d',
  'ground_truth_label', 'resolved_at', 'is_chain_tip', 'dot_kind'
].join(',');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'ticker-day-narratives', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const ticker = (url.searchParams.get('ticker') || '')
      .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    const daysRaw = (url.searchParams.get('days') || '400').toLowerCase();
    if (!ticker) return sendJson(res, 400, { error: 'Missing ticker' });

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return sendJson(res, 500, { error: 'Supabase env not configured.' });
    }

    let cutoffIso;
    if (daysRaw === 'all') {
      cutoffIso = '2023-01-01T00:00:00.000Z';
    } else {
      const days = Math.min(Math.max(parseInt(daysRaw, 10) || 400, 1), 3650);
      cutoffIso = new Date(Date.now() - days * 86400000).toISOString();
    }

    const headers = {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      Accept: 'application/json'
    };
    const rowsUrl =
      `${supabaseUrl}/rest/v1/narrative_dots` +
      `?select=${COLS}` +
      `&ticker=eq.${encodeURIComponent(ticker)}` +
      `&observed_at=gte.${encodeURIComponent(cutoffIso)}` +
      `&order=observed_at.desc&limit=${MAX_ROWS}`;

    const resp = await fetch(rowsUrl, { headers });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return sendJson(res, 502, {
        error: 'narrative_dots query failed', status: resp.status, detail: detail.slice(0, 300)
      });
    }
    const rows = await resp.json().catch(() => []);

    // Rank within a day: authority desc (nulls last) → chain tip → genesis → recency.
    const authOf = (r) => (r.speaker_authority == null ? -1 : Number(r.speaker_authority));
    const better = (a, b) => {
      const aa = authOf(a), ab = authOf(b);
      if (aa !== ab) return aa > ab ? a : b;
      if (!!a.is_chain_tip !== !!b.is_chain_tip) return a.is_chain_tip ? a : b;
      const ag = a.dot_kind === 'genesis', bg = b.dot_kind === 'genesis';
      if (ag !== bg) return ag ? a : b;
      return (a.observed_at || '') >= (b.observed_at || '') ? a : b;
    };

    const byDay = new Map(); // day -> { winner, count }
    for (const r of rows) {
      const day = (r.observed_at || '').slice(0, 10);
      if (!day) continue;
      const e = byDay.get(day);
      if (!e) { byDay.set(day, { winner: r, count: 1 }); }
      else { e.count += 1; e.winner = better(e.winner, r); }
    }

    const byDate = {};
    for (const [day, e] of byDay) {
      const w = e.winner;
      byDate[day] = {
        count: e.count,
        narrative_text: w.narrative_text || '',
        speaker_type: w.speaker_type || null,
        speaker_authority: w.speaker_authority != null ? Number(w.speaker_authority) : null,
        narrative_direction: w.narrative_direction || null,
        bullshit_probability: w.bullshit_probability != null ? Number(w.bullshit_probability) : null,
        return_5d: w.return_5d != null ? Number(w.return_5d) : null,
        ground_truth_label: typeof w.ground_truth_label === 'boolean' ? w.ground_truth_label : null,
        resolved_at: w.resolved_at || null
      };
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return sendJson(res, 200, { ticker, days: daysRaw, days_count: Object.keys(byDate).length, byDate });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unknown error' });
  }
};
