-- v_influential_movers
--
-- Backs the MOST INFLUENTIAL MARKET MOVERS board on the Leaderboard.
--
-- Collapses the per-(analyst, ticker) rows of analyst_ticker_scores into one
-- row per person, ranked by bullish hit rate. The aggregate hit rate is
-- weighted by bullish_articles (bullish_hit_rate is measured over a row's
-- bullish articles, so that's the correct weight); avg_return_5d is weighted
-- by total article_count.
--
-- Guardrails (rule-based, no per-name overrides — same philosophy as the
-- other leaderboard boards):
--   * >= 30 bullish articles total: a 3-call analyst at 100% is noise.
--   * >= 2 distinct tickers: single-ticker "analysts" are usually PR feeds.
--   * name must contain whitespace (people have first + last names) and must
--     not contain corporate/desk tokens or "&" — drops entries like
--     "Verified Market Research" and "Bragar Eagel & Squire, P.C." that the
--     extraction pipeline files under analyst_name.
--
-- Read-only; no triggers; safe to drop and recreate.
-- Applied via Supabase migration: create_v_influential_movers.

CREATE OR REPLACE VIEW public.v_influential_movers AS
SELECT
  ats.analyst_name,
  count(DISTINCT ats.ticker)::int                                   AS tickers_covered,
  sum(ats.article_count)::int                                       AS total_articles,
  sum(ats.bullish_articles)::int                                    AS bullish_articles,
  round((sum(ats.bullish_hit_rate * ats.bullish_articles)
         / NULLIF(sum(ats.bullish_articles), 0))::numeric, 4)       AS hit_rate,
  round((sum(ats.avg_return_5d * ats.article_count)
         / NULLIF(sum(ats.article_count), 0))::numeric, 2)          AS avg_return_5d,
  (array_agg(ats.ticker ORDER BY ats.article_count DESC))[1]        AS top_ticker,
  (array_agg(ats.publication_name ORDER BY ats.article_count DESC)
     FILTER (WHERE ats.publication_name IS NOT NULL))[1]            AS top_publication,
  max(ats.computed_at)                                              AS computed_at
FROM public.analyst_ticker_scores ats
WHERE ats.analyst_name IS NOT NULL
  AND ats.analyst_name ~ '\s'
  AND ats.analyst_name !~* '(\m(inc|llc|llp|ltd|corp|corporation|research|capital|partners|group|holdings|securities|associates|advisors|analytics|consulting|management|institute|fund|funds|bank|media|staff|team|desk|newsdesk|editorial|editors?|contributors?)\M)|&'
GROUP BY ats.analyst_name
HAVING sum(ats.bullish_articles) >= 30
   AND count(DISTINCT ats.ticker) >= 2
ORDER BY hit_rate DESC;

GRANT SELECT ON public.v_influential_movers TO anon, authenticated;
