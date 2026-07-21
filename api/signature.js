// api/signature.js
// Ticker Signature — TEST PAGE. Serves _signature.html for /signature and
// /signature/:ticker. Auth-gated like the dashboard; the page itself pulls all
// data from /api/signature-data (service-role, server-side), so no Supabase
// keys are strictly required client-side — __env is injected anyway to match
// the house template contract.

const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');
const { isHidden } = require('./_hidden-tickers');

module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    // Extract ticker — same multi-source dance as api/ticker.js because
    // Vercel rewrites may change req.url to the destination path.
    let ticker = '';
    if (req.query && req.query.ticker) ticker = req.query.ticker;
    if (!ticker) {
      const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      if (last !== 'signature' && last !== 'api') ticker = last;
    }
    if (!ticker && req.headers && req.headers['x-now-route-matches']) {
      try {
        const matches = decodeURIComponent(req.headers['x-now-route-matches']);
        const m = matches.match(/ticker=([^&]+)/);
        if (m) ticker = decodeURIComponent(m[1]);
      } catch (_) {}
    }
    if (!ticker && req.query && req.query.t) ticker = req.query.t;

    const safeTicker = String(ticker || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();

    if (isHidden(safeTicker)) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.statusCode = 302;
      res.setHeader('Location', '/dashboard');
      res.end();
      return;
    }

    const nextPath = safeTicker ? `/signature/${safeTicker}` : '/signature';
    const auth = await requireAuth(req, res, { next: nextPath });
    if (!auth) return;

    let html = resolveTemplate('_signature.html');
    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', TICKER: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', TICKER: '${safeTicker}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Signature error: ' + err.message);
  }
};
