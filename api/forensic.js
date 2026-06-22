// api/forensic.js
// Page handler for the per-ticker Forensic Dossier (/forensic?ticker=SYM).
// Thin: gate + resolve template + inject window.__env, exactly like api/ticker.js.
// All forensic data is fetched client-side from /api/forensic-data (service-role).

const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');
const { isHidden: isHiddenTicker } = require('./_hidden-tickers');

module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    // Ticker arrives as ?ticker= (Vercel query) — fall back to ?t= and URL parse.
    let ticker = '';
    if (req.query && req.query.ticker) ticker = req.query.ticker;
    if (!ticker && req.query && req.query.t) ticker = req.query.t;
    if (!ticker) {
      try {
        const u = new URL(req.url, 'http://localhost');
        ticker = u.searchParams.get('ticker') || u.searchParams.get('t') || '';
      } catch (_) {}
    }

    const safeTicker = String(ticker || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();

    // Hidden tickers (fair-value issues etc.) never render.
    if (isHiddenTicker(safeTicker)) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.statusCode = 302;
      res.setHeader('Location', '/dashboard');
      res.end();
      return;
    }

    // Same access gate as the per-ticker pages.
    const nextPath = safeTicker ? ('/forensic?ticker=' + safeTicker) : '/dashboard';
    const auth = await requireAuth(req, res, { next: nextPath });
    if (!auth) return;

    let html = resolveTemplate('_forensic.html');
    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', TICKER: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', TICKER: '${safeTicker}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Forensic error: ' + err.message);
  }
};
