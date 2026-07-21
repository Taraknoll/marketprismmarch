// Tickers that ARE in the tracked universe (ticker_valuation_config, active) and
// render on the site, but for which the article scraper has ZERO rows in the
// `articles` table. Their article-derived sections (trending narratives, the
// story feed, forensic timeline, claim integrity, scholarly refs) have nothing
// to show, so the /ticker app page swaps those sections for a "coverage in
// progress" banner instead of leaving empty / stuck-skeleton panels.
//
// Everything else on the page (price chart, valuation, forecast, earnings,
// sector, fundamentals) is scorecard/price-derived and renders normally — the
// public /stocks/:ticker pages already prove those sections work for these
// tickers — so only the article-derived blocks are suppressed.
//
// MAINTAINED BY HAND. The gap can't be detected in the browser (the `articles`
// table is RLS-blocked for the anon client, and the visible proxies —
// narrative energy, wks_score, story rows — do NOT separate these tickers).
// Regenerate the list from the engine DB (kugf) with:
//
//   select t.ticker
//   from ticker_valuation_config t
//   where t.active
//     and not exists (select 1 from articles a
//                     where upper(a.ticker) = upper(t.ticker))
//   order by t.ticker;
//
// Remove a ticker from this list once the scraper is backfilling `articles`
// for it — the full page then renders on its own. (Snapshot: 2026-07-21.)
const PROCESSING_TICKERS = [
  'AFRM', 'AIBZ', 'ALAB', 'APLD', 'BABA', 'BE', 'BIDU', 'BSP', 'CELH', 'CIEN',
  'CIFR', 'CLS', 'COHR', 'CRDO', 'CRS', 'CRWV', 'CVE', 'DINO', 'DKNG', 'DLR',
  'ECO', 'EQIX', 'ERIC', 'ETN', 'FERG', 'FIX', 'GEV', 'HWM', 'INSW', 'IONQ',
  'IRDM', 'IRM', 'ISRG', 'KLAR', 'LITE', 'LUNR', 'MOD', 'NOK', 'PATH', 'PDD',
  'PSTG', 'PSX', 'RGTI', 'RKLB', 'RUM', 'SKHY', 'SOUN', 'SU', 'TEM', 'TNK',
  'WULF', 'XPO',
];

const PROCESSING_SET = new Set(PROCESSING_TICKERS.map(function (t) { return String(t).toUpperCase(); }));

function isProcessing(ticker) {
  if (!ticker) return false;
  return PROCESSING_SET.has(String(ticker).toUpperCase());
}

module.exports = { PROCESSING_TICKERS: PROCESSING_TICKERS, isProcessing: isProcessing };
