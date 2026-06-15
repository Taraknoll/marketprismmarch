// api/ticker-clusters.js
// "Narrative Clusters" — companion chart to the Forensic Timeline. Shows which
// narrative THEMES cluster around a ticker over time (theme lanes × time, bubble
// = how many stories in that cluster that day).
//
// Reads the per-ticker view narrative_ticker_clusters (over narrative_clusters,
// RLS-enabled) so this MUST run server-side with the service-role key.
//
// Query params: ticker (required), days (30|90|180|all, default 90)

const rateLimit = require('./_rate-limit');

const MAX_ROWS = 2000;
const COLS = [
  'snapshot_date', 'theme_label', 'theme_key',
  'cluster_size', 'chain_strength', 'anchor_event', 'contagion_direction'
].join(',');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'ticker-clusters', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const ticker = (url.searchParams.get('ticker') || '')
      .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    const daysRaw = (url.searchParams.get('days') || '90').toLowerCase();
    if (!ticker) return sendJson(res, 400, { error: 'Missing ticker' });

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return sendJson(res, 500, { error: 'Supabase env not configured.' });
    }

    // snapshot_date is a DATE; build a YYYY-MM-DD cutoff.
    let cutoff;
    if (daysRaw === 'all') {
      cutoff = '2026-01-01';
    } else {
      const days = Math.min(Math.max(parseInt(daysRaw, 10) || 90, 1), 3650);
      cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    }

    const headers = {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      Accept: 'application/json'
    };
    const rowsUrl =
      `${supabaseUrl}/rest/v1/narrative_ticker_clusters` +
      `?select=${COLS}` +
      `&ticker=eq.${encodeURIComponent(ticker)}` +
      `&snapshot_date=gte.${cutoff}` +
      `&order=snapshot_date.desc&limit=${MAX_ROWS}`;

    const resp = await fetch(rowsUrl, { headers });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return sendJson(res, 502, {
        error: 'narrative_ticker_clusters query failed',
        status: resp.status, detail: detail.slice(0, 300)
      });
    }
    const rows = await resp.json().catch(() => []);

    // Collapse to one bubble per (day, theme): sum cluster sizes, keep the
    // strongest chain's anchor as the representative event.
    const map = new Map();
    for (const r of rows) {
      const key = r.snapshot_date + '|' + r.theme_label;
      let e = map.get(key);
      if (!e) {
        e = { date: r.snapshot_date, theme: r.theme_label || 'Other',
              size: 0, strength: 0, n: 0, anchor: '', contagion: '' };
        map.set(key, e);
      }
      e.size += Number(r.cluster_size) || 0;
      e.n += 1;
      const st = Number(r.chain_strength) || 0;
      if (st >= e.strength) {
        e.strength = st;
        e.anchor = r.anchor_event || e.anchor;
        e.contagion = r.contagion_direction || e.contagion;
      }
    }
    const dots = Array.from(map.values());

    // Theme lanes ordered by total activity (busiest first).
    const totals = {};
    for (const d of dots) totals[d.theme] = (totals[d.theme] || 0) + d.size;
    const themes = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return sendJson(res, 200, {
      ticker,
      days: daysRaw,
      themes,
      summary: {
        theme_count: themes.length,
        cluster_total: rows.length,
        top_theme: themes[0] || null
      },
      dots
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unknown error' });
  }
};
