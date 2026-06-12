const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    const auth = await requireAuth(req, res, { next: '/api/ticker-dev' });
    if (!auth) return;

    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    // Extract ticker — try multiple sources because Vercel rewrites may
    // change req.url to the destination path (/api/ticker-dev instead of /ticker-dev/NVDA)
    let ticker = '';

    // 1. Vercel populates req.query with named rewrite params (:ticker)
    if (req.query && req.query.ticker) {
      ticker = req.query.ticker;
    }

    // 2. Try the original URL path (works when req.url preserves the source)
    if (!ticker) {
      const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      if (last !== 'ticker-dev' && last !== 'api') {
        ticker = last;
      }
    }

    // 3. Try x-now-route-matches header (Vercel internal routing metadata)
    if (!ticker && req.headers && req.headers['x-now-route-matches']) {
      try {
        const matches = decodeURIComponent(req.headers['x-now-route-matches']);
        const m = matches.match(/ticker=([^&]+)/);
        if (m) ticker = decodeURIComponent(m[1]);
      } catch (_) {}
    }

    // 4. Try query string ?t=NVDA as last resort
    if (!ticker && req.query && req.query.t) {
      ticker = req.query.t;
    }

    // Sanitise — only allow alphanumeric + dot + hyphen
    const safeTicker = ticker.replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();

    let html = resolveTemplate('_ticker_dev.html');

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', TICKER: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', TICKER: '${safeTicker}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Ticker-dev error: ' + err.message);
  }
};
