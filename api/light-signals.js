// Price Physics — LITE-MODE descriptive signals for ANY US ticker.
//
// Powers the "Price Physics · Limited Coverage" hero on /ticker/:ticker for
// symbols that have no forensic narrative coverage (empty v_dash_daily_story).
// Everything here is derived purely from Polygon daily OHLCV — no Supabase, no
// backtested signal (WKS proxy / Wyckoff classifier / sector tilt live in the
// Python engine and must NOT be forked into JS). These stats are transparent
// and descriptive only, clearly labelled as such in the UI.
//
// Structure mirrors api/price-history.js: same env key, same ticker sanitizer,
// same aggregate URL shape, same in-memory rate limiter.

const rateLimit = require('./_rate-limit');

// Sample standard deviation (n-1). Returns null for <2 points.
function stdev(arr) {
  const n = arr.length;
  if (n < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - mean; ss += d * d; }
  return Math.sqrt(ss / (n - 1));
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'light-signals', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const ticker = (url.searchParams.get('ticker') || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    const apiKey = process.env.MASSIVE_API_KEY || process.env.MASSIVE_API || process.env.POLYGON_API_KEY || '';

    if (!ticker) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing ticker' }));
      return;
    }

    if (!apiKey) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'MASSIVE_API_KEY not configured' }));
      return;
    }

    // ~400 calendar days → ~252 trading bars, enough for a full 52-week window.
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 400);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const upstream = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${encodeURIComponent(apiKey)}`;

    const upstreamRes = await fetch(upstream);
    const body = await upstreamRes.text();

    if (!upstreamRes.ok) {
      res.statusCode = upstreamRes.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: body.slice(0, 300) }));
      return;
    }

    const json = JSON.parse(body);
    const rows = Array.isArray(json.results)
      ? json.results.map((row) => ({
          date: row.t,
          o: Number(row.o),
          h: Number(row.h),
          l: Number(row.l),
          c: Number(row.c),
          v: Number(row.v),
        }))
      : [];
    // Polygon returns ascending already (sort=asc); re-sort defensively and drop
    // any bar without a usable close.
    rows.sort((a, b) => a.date - b.date);
    const bars = rows.filter((r) => Number.isFinite(r.c) && r.c > 0);
    const n = bars.length;

    if (n < 60) {
      // Too little history for descriptive stats to be meaningful. Signal the
      // frontend to fall back to renderTickerNotFound().
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
      res.statusCode = 200;
      res.end(JSON.stringify({ ticker, insufficient: true }));
      return;
    }

    const closes = bars.map((r) => r.c);
    const vols = bars.map((r) => (Number.isFinite(r.v) ? r.v : 0));
    const price = closes[n - 1];

    // Trailing simple return over k trading bars (decimal); null if not enough.
    const retK = (k) => {
      const i = n - 1 - k;
      return (i >= 0 && closes[i] > 0) ? (price / closes[i] - 1) : null;
    };
    const returns = {
      d5: retK(5),
      d21: retK(21),
      d63: retK(63),
      d126: retK(126),
      d252: retK(252),
    };

    // Annualized volatility from the last 21 daily LOG returns.
    const logRets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i - 1] > 0 && closes[i] > 0) logRets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const last21Log = logRets.slice(-21);
    const sd = stdev(last21Log);
    const vol_annual = sd != null ? sd * Math.sqrt(252) : null;

    // Amihud illiquidity + average dollar volume over the last 21 bars. Each bar
    // needs its prior close for the return, so start from index n-21 (>=1 here).
    const amihudTerms = [];
    const advTerms = [];
    const startIdx = Math.max(1, n - 21);
    for (let i = startIdx; i < n; i++) {
      const dollarVol = closes[i] * vols[i];
      advTerms.push(dollarVol);
      if (closes[i - 1] > 0 && dollarVol > 0) {
        const dailyRet = closes[i] / closes[i - 1] - 1;
        amihudTerms.push(Math.abs(dailyRet) / dollarVol);
      }
    }
    const amihud_21d = amihudTerms.length ? mean(amihudTerms) : null;
    const adv_usd_21d = advTerms.length ? mean(advTerms) : null;

    // 52-week (last 252 bars) high/low + positioning.
    const window52 = closes.slice(-252);
    const hi_52w = Math.max.apply(null, window52);
    const lo_52w = Math.min.apply(null, window52);
    const pct_from_hi = hi_52w > 0 ? (price / hi_52w - 1) : null;
    const pct_from_lo = lo_52w > 0 ? (price / lo_52w - 1) : null;
    const range_pos = (hi_52w > lo_52w) ? (price - lo_52w) / (hi_52w - lo_52w) : null;

    // Relative volume: last 5 vs last 60 bars.
    const v5 = mean(vols.slice(-5));
    const v60 = mean(vols.slice(-60));
    const rel_volume = (v60 && v60 > 0) ? v5 / v60 : null;

    // Descriptive trend bucket — evaluated in spec order (QUIET first).
    const d21 = returns.d21;
    const d63 = returns.d63;
    const absD21 = d21 == null ? null : Math.abs(d21);
    let trend = 'RANGE';
    if (rel_volume != null && rel_volume < 0.6 && absD21 != null && absD21 < 0.02) {
      trend = 'QUIET';
    } else if (d21 != null && d21 >= 0.03 && d63 != null && d63 >= 0) {
      trend = 'UPTREND';
    } else if (d21 != null && d21 <= -0.03 && d63 != null && d63 <= 0) {
      trend = 'DOWNTREND';
    } else {
      trend = 'RANGE';
    }

    const asOf = new Date(bars[n - 1].date).toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
    res.statusCode = 200;
    res.end(JSON.stringify({
      ticker,
      asOf,
      bars: n,
      price,
      returns,
      vol_annual,
      amihud_21d,
      adv_usd_21d,
      hi_52w,
      lo_52w,
      pct_from_hi,
      pct_from_lo,
      range_pos,
      rel_volume,
      trend,
    }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message || 'Unknown error' }));
  }
};
