// Tickers that just graduated out of PROCESSING_TICKERS (_processing-tickers.js) —
// the article scraper backfilled all of them on the same day, COVERAGE_START_DATE.
// Their narrative/story sections are real and render normally now, but the history
// behind them is only as old as the backfill, so the ticker page shows a small
// "new coverage" note instead of implying the same depth as a long-tracked ticker.
//
// Unlike PROCESSING_TICKERS, this list does not need manual removal as coverage
// matures: isNewCoverage() also checks COVERAGE_START_DATE against
// NEW_COVERAGE_WINDOW_DAYS, so the note stops appearing on its own once the cohort
// ages out. Safe to leave the array as-is; it just goes inert.
//
// Regenerate for a future onboarding batch the same way _processing-tickers.js
// documents (engine DB / Supabase MCP `15b5d603`):
//   select ticker, min(created_at)::date as first_article
//   from articles group by ticker having min(created_at)::date = '<batch date>';
const COVERAGE_START_DATE = '2026-07-21';
const NEW_COVERAGE_WINDOW_DAYS = 60;

const NEW_COVERAGE_TICKERS = [
  'AFRM', 'AIBZ', 'ALAB', 'APLD', 'BABA', 'BE', 'BIDU', 'BSP', 'CELH', 'CIEN',
  'CIFR', 'CLS', 'COHR', 'CRDO', 'CRS', 'CRWV', 'CVE', 'DINO', 'DKNG', 'DLR',
  'ECO', 'EQIX', 'ERIC', 'ETN', 'FERG', 'FIX', 'GEV', 'HWM', 'INSW',
  'IRDM', 'IRM', 'ISRG', 'KLAR', 'LITE', 'LUNR', 'MOD', 'NOK', 'PATH', 'PDD',
  'PSTG', 'PSX', 'RGTI', 'RKLB', 'RUM', 'SKHY', 'SOUN', 'SU', 'TEM', 'TNK',
  'WULF', 'XPO',
];

const NEW_COVERAGE_SET = new Set(NEW_COVERAGE_TICKERS.map(function (t) { return String(t).toUpperCase(); }));

function isNewCoverage(ticker) {
  if (!ticker || !NEW_COVERAGE_SET.has(String(ticker).toUpperCase())) return false;
  const ageDays = (Date.now() - Date.parse(COVERAGE_START_DATE + 'T00:00:00Z')) / 86400000;
  return ageDays <= NEW_COVERAGE_WINDOW_DAYS;
}

module.exports = {
  NEW_COVERAGE_TICKERS: NEW_COVERAGE_TICKERS,
  COVERAGE_START_DATE: COVERAGE_START_DATE,
  isNewCoverage: isNewCoverage,
};
