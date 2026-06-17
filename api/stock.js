// Public stock landing page — /stocks/:ticker
// Server-rendered, indexable, shareable. NO requireAuth: this is the free
// teaser that funnels to the gated /ticker app. Premium fields are gated
// inside the renderer (blurred placeholder, real numbers never sent to anon).

const { renderStockPage } = require('../lib/stockPageRenderer');

module.exports = async (req, res) => {
  try {
    const ticker = extractTicker(req);
    if (!ticker) {
      res.status(404).send('Ticker not found in URL');
      return;
    }
    await renderStockPage({ ticker }, req, res);
  } catch (err) {
    res.status(500).send('Stock page error: ' + err.message);
  }
};

function extractTicker(req) {
  // 1. Vercel rewrite param (:ticker)
  if (req.query && req.query.ticker) {
    return clean(req.query.ticker);
  }
  // 2. x-now-route-matches internal routing metadata
  if (req.headers && req.headers['x-now-route-matches']) {
    try {
      const matches = decodeURIComponent(req.headers['x-now-route-matches']);
      const m = matches.match(/ticker=([^&]+)/);
      if (m) return clean(decodeURIComponent(m[1]));
    } catch (_) {}
  }
  // 3. Last path segment (/stocks/NVDA)
  const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (last && last !== 'stocks' && last !== 'stock' && last !== 'api') {
    return clean(last);
  }
  return '';
}

function clean(s) {
  return String(s || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
}
