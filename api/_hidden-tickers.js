// Tickers hidden from the entire frontend (lists, dashboards, ticker pages,
// SEO routes, sitemap). Used by server-side route guards AND injected into
// every served HTML page so the client-side fetch wrapper strips them from
// Supabase REST responses.
//
// To unhide a ticker, remove it from the array and redeploy.
const HIDDEN_TICKERS = ['GOLD'];

const HIDDEN_SET = new Set(HIDDEN_TICKERS.map(function (t) { return String(t).toUpperCase(); }));

function isHidden(ticker) {
  if (!ticker) return false;
  return HIDDEN_SET.has(String(ticker).toUpperCase());
}

module.exports = { HIDDEN_TICKERS: HIDDEN_TICKERS, isHidden: isHidden };
