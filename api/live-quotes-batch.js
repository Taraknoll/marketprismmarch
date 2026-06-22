// Batch live quotes via Polygon snapshot endpoint.
// Accepts ?tickers=AAPL,NVDA,TSM and returns a map of
// {AAPL: {price, change, changePct, source}, ...}.
// Uses Polygon's filtered snapshot call so one HTTP request covers
// every ticker on the Daily Brief page.

// YYYY-MM-DD for "now" in America/New_York (markets run on ET).
function etDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + day;
}

// True when ET "today" is Sat or Sun. Holidays on weekdays are not detected
// here — they're rare enough that the (zero-change) fallback is acceptable
// until we wire up a calendar.
function isMarketClosedNow() {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short'
  }).format(new Date());
  return wd === 'Sat' || wd === 'Sun';
}

// Step backward one calendar day at a time, skipping Sat/Sun. Treats input as
// a UTC date string to avoid TZ drift in the arithmetic.
function previousTradingDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 7; i++) {
    date = new Date(date.getTime() - 86400000);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) break;
  }
  return date.toISOString().slice(0, 10);
}

const rateLimit = require('./_rate-limit');

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'live-quotes-batch', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const raw = (url.searchParams.get('tickers') || '').trim();
    const apiKey = process.env.MASSIVE_API_KEY || process.env.MASSIVE_API || process.env.POLYGON_API_KEY || '';

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!raw) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing tickers query param (comma-separated)' }));
      return;
    }

    if (!apiKey) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'API key not configured' }));
      return;
    }

    // Sanitize + dedupe tickers
    const tickers = Array.from(new Set(
      raw.split(',')
        .map(t => t.replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase())
        .filter(Boolean)
    ));

    if (!tickers.length) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'No valid tickers after sanitization' }));
      return;
    }

    // Polygon caps the tickers query param; chunk to 100 per request to be safe.
    const chunks = [];
    for (let i = 0; i < tickers.length; i += 100) {
      chunks.push(tickers.slice(i, i + 100));
    }

    const quotes = {};
    let anySuccess = false;

    for (const chunk of chunks) {
      try {
        const snapUrl = 'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers'
          + '?tickers=' + encodeURIComponent(chunk.join(','))
          + '&apiKey=' + encodeURIComponent(apiKey);
        const snapRes = await fetch(snapUrl);
        if (!snapRes.ok) continue;
        const json = JSON.parse(await snapRes.text());
        const rows = json.tickers || [];
        for (const t of rows) {
          const ticker = t.ticker;
          if (!ticker) continue;
          const day = t.day || {};
          const prevDay = t.prevDay || {};
          const lastTrade = t.lastTrade || {};
          const price = lastTrade.p || day.c || prevDay.c;
          if (!price) continue;
          const prevClose = prevDay.c || null;
          const dayVol = day.v != null ? Number(day.v) : null;
          const prevVol = prevDay.v != null ? Number(prevDay.v) : null;
          quotes[ticker] = {
            price: Number(price),
            change: prevClose ? Number((price - prevClose).toFixed(2)) : null,
            changePct: prevClose ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : null,
            prevClose: prevClose ? Number(prevClose) : null,
            dayHigh: day.h ? Number(day.h) : null,
            dayLow: day.l ? Number(day.l) : null,
            // Intraday volume + relative-volume (today vs prior session) so the
            // Top Stories panel can rank by price AND volume movement. Additive
            // fields — existing live-price callers ignore them.
            volume: dayVol,
            prevVolume: prevVol,
            relVolume: (dayVol != null && prevVol) ? Number((dayVol / prevVol).toFixed(2)) : null,
            source: lastTrade.p ? 'snapshot_live' : 'snapshot_close'
          };
          anySuccess = true;
        }
      } catch (_) {
        // Swallow per-chunk errors so a single bad chunk doesn't block the rest.
      }
    }

    // Weekend / closed-market baseline shift.
    // On Sat/Sun (and likely holidays where day data is empty), Polygon's
    // snapshot returns Friday's close as BOTH lastTrade.p and prevDay.c — so
    // the % change above collapses to 0.00% and every ticker renders flat
    // green. Detect that state and fetch the previous trading day's grouped
    // daily aggregates (one HTTP call covers every US stock), then rewrite
    // change / changePct so the displayed delta reflects the most recent
    // real session move (Fri vs Thu). Price stays Friday's close.
    if (isMarketClosedNow() && Object.keys(quotes).length) {
      try {
        const todayET = etDateStr(new Date());
        const lastTrading = previousTradingDay(todayET);     // typically Friday
        const baselineDate = previousTradingDay(lastTrading); // typically Thursday
        const grpUrl = 'https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/' + baselineDate
          + '?adjusted=true&apiKey=' + encodeURIComponent(apiKey);
        const grpRes = await fetch(grpUrl);
        if (grpRes.ok) {
          const grpJson = JSON.parse(await grpRes.text());
          const baseline = {};
          (grpJson.results || []).forEach(r => { if (r.T && r.c != null) baseline[r.T] = r.c; });
          for (const tk of Object.keys(quotes)) {
            const earlierClose = baseline[tk];
            if (!earlierClose) continue;
            const lastClose = quotes[tk].price;
            quotes[tk].prevClose = Number(earlierClose);
            quotes[tk].change = Number((lastClose - earlierClose).toFixed(2));
            quotes[tk].changePct = Number(((lastClose - earlierClose) / earlierClose * 100).toFixed(2));
            quotes[tk].source = 'snapshot_closed_baseline_shifted';
          }
        }
      } catch (_) {
        // Swallow — leave the (zeroed) snapshot values rather than failing the call.
      }
    }

    // Short edge cache so concurrent viewers share one upstream call.
    // 15s fresh + 60s stale-while-revalidate keeps Polygon load sane while
    // still giving every viewer near-live prices.
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    res.statusCode = 200;
    res.end(JSON.stringify({
      quotes,
      count: Object.keys(quotes).length,
      requested: tickers.length,
      ok: anySuccess,
      updated: new Date().toISOString()
    }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message || 'Unknown error' }));
  }
};
