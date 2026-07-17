// Public /stocks hub — lists every covered ticker with its company name,
// linking to each /stocks/:ticker landing page. Server-rendered + indexable;
// builds the internal link graph and an ItemList for rich results.

const resolveTemplate = require('./_resolve-template');
const { buildTickerMeta, buildWebPageSchema } = require('../lib/seoHead');
const { isHidden: isHiddenTicker } = require('./_hidden-tickers');

const SITE = 'https://www.marketprism.co';

module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    let rows = [];
    if (supabaseUrl && supabaseAnon) {
      try {
        const r = await fetch(
          `${supabaseUrl}/rest/v1/v_ticker_universe_search?select=ticker,name,sector,industry&order=ticker.asc&limit=600`,
          { headers: { apikey: supabaseAnon, Authorization: `Bearer ${supabaseAnon}` } }
        );
        if (r.ok) rows = await r.json();
      } catch (_) {}
    }

    // Dedupe + drop hidden tickers
    const seen = new Set();
    const tickers = [];
    for (const row of rows) {
      const t = (row.ticker || '').toUpperCase();
      if (!t || seen.has(t) || isHiddenTicker(t)) continue;
      seen.add(t);
      tickers.push({ ticker: t, name: row.name || '', sector: row.sector || row.industry || '' });
    }

    const grid = tickers.map(t =>
      `<a class="tk-card" href="/stocks/${esc(t.ticker)}">`
      + `<div class="tk-sym">${esc(t.ticker)}</div>`
      + (t.name ? `<div class="tk-name">${esc(t.name)}</div>` : '')
      + (t.sector ? `<div class="tk-sector">${esc(titleCase(t.sector))}</div>` : '')
      + `</a>`
    ).join('\n      ')
      || '<div class="tk-name">Stock list is updating — check back shortly.</div>';

    const title = 'Stock Narrative Analysis — All Tickers | Market Prism';
    const desc = `Forensic narrative intelligence on ${tickers.length} stocks — what the market believes, how loud each story is, and how far it has drifted from fundamentals. Updated daily.`;
    const canonical = `${SITE}/stocks`;

    const metaTags = buildTickerMeta({ ticker: '', title, description: desc, url: canonical, imageUrl: `${SITE}/og-default.png` });
    const webPageSchema = buildWebPageSchema({ title, description: desc, url: canonical });
    const itemListSchema = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Market Prism stock coverage",
      "numberOfItems": tickers.length,
      "itemListElement": tickers.slice(0, 200).map((t, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": t.name ? `${t.name} (${t.ticker})` : t.ticker,
        "url": `${SITE}/stocks/${t.ticker}`
      }))
    });

    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    let html = resolveTemplate('_stocks_index.html');
    html = html
      .replace(/%%SEO_TITLE%%/g, esc(title))
      .replace('%%SEO_META%%', metaTags)
      .replace('%%SCHEMA_WEBPAGE%%', webPageSchema)
      .replace('%%SCHEMA_ITEMLIST%%', itemListSchema)
      .replace('%%COUNT%%', String(tickers.length || ''))
      .replace('%%TICKER_GRID%%', grid)
      .replace(/%%DATE%%/g, esc(today));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Stocks index error: ' + err.message);
  }
};

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
