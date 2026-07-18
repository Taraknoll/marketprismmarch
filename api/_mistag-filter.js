// api/_mistag-filter.js
// Shared server-side guard for the scraper's ticker mis-tagging bug: some
// articles are tagged to a ticker they merely substring-match ("race" ->
// RACE), and dots bootstrapped from them carry the WRONG ticker's forward
// returns. The Gemini relabel (articles.is_about_ticker_gemini = FALSE) is
// the authoritative flag; search_dots_by_embedding v4 and
// get_recent_narratives filter on it in SQL. Endpoints that read
// narrative_dots via PostgREST can't join articles (no FK), so they filter
// here instead: fetch the flagged article ids for the ticker/window, then
// drop dots sourced from them.
//
// Underscore prefix = not deployed as a serverless function by Vercel.

const PAGE = 1000; // PostgREST caps reads at 1000 rows per request

// Max pages of flagged ids to pull (20k ids). NVDA, the worst ticker, has
// ~10.7k flagged articles ALL-TIME, so this only truncates if the corpus
// grows ~2x — and truncation just means a few stale mis-tags slip through.
const MAX_PAGES = 20;

// Set of articles.id (uuid) flagged not-about-this-ticker, published on/after
// sinceIso. Pass a cutoff ~3 days before the dot window start: dots observe
// up to ~48h after the article publishes. Fails OPEN (returns what it has) —
// an unfiltered card list beats a 502 on a transient articles hiccup.
async function fetchMistaggedArticleIds(supabaseUrl, supabaseKey, ticker, sinceIso) {
  const ids = new Set();
  const base = supabaseUrl + '/rest/v1/articles'
    + '?select=id'
    + '&ticker=eq.' + encodeURIComponent(ticker)
    + '&is_about_ticker_gemini=is.false'
    + (sinceIso ? '&published_at=gte.' + encodeURIComponent(sinceIso) : '');
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await fetch(base + '&limit=' + PAGE + '&offset=' + (page * PAGE), {
        headers: {
          apikey: supabaseKey,
          Authorization: 'Bearer ' + supabaseKey,
          Accept: 'application/json'
        }
      });
      if (!r.ok) break;
      const batch = await r.json().catch(function () { return []; });
      if (!Array.isArray(batch) || !batch.length) break;
      for (const row of batch) if (row && row.id) ids.add(row.id);
      if (batch.length < PAGE) break;
    }
  } catch (e) {
    console.warn('[_mistag-filter] articles fetch failed:', (e && e.message) || e);
  }
  return ids;
}

// Drop dots sourced from a flagged article. Dots with no source_article_id
// (non-article bootstrap sources) always pass.
function dropMistagged(rows, badIds) {
  if (!Array.isArray(rows) || !badIds || !badIds.size) return rows || [];
  return rows.filter(function (r) {
    return !r || !r.source_article_id || !badIds.has(r.source_article_id);
  });
}

module.exports = { fetchMistaggedArticleIds, dropMistagged };
