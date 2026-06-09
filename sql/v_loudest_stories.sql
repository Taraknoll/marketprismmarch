-- v_loudest_stories
--
-- Backs the LOUDEST STORIES board on the Leaderboard ("Who the world won't
-- shut up about today").
--
-- Aggregates the article-level narrative_analyses table for the latest
-- available day into one row per ticker. Ranks by VOLUME x IMPACT: the sum of
-- positive price_impact_score across all of a ticker's distinct stories, so a
-- ticker needs BOTH many stories AND stories that move price to rise.
--
-- Why narrative_analyses (not narrative_scorecard / _deep): the once-daily
-- narrative_scorecard mass/coordination scores are written incrementally and
-- stay thin until the afternoon run completes, and narrative_scorecard_deep
-- lags a full day. narrative_analyses is written intraday, so this board stays
-- populated all morning. (Previously the board gated on
-- narrative_scorecard.narrative_mass_score > 0.35 and starved to 2-3 rows on a
-- partial morning snapshot.)
--
-- min 2 distinct narratives per ticker (a single article isn't a "story
-- everyone's talking about"); system tickers only (drops macro/theme rows).
--
-- Read-only; no triggers; safe to drop and recreate.
-- Applied via Supabase migration: create_v_loudest_stories.

CREATE OR REPLACE VIEW public.v_loudest_stories AS
WITH latest AS (
  SELECT max(COALESCE(snapshot_date_day, snapshot_date)) AS d
  FROM public.narrative_analyses
)
SELECT
  na.ticker,
  (SELECT d FROM latest)                                              AS snapshot_day,
  count(DISTINCT na.narrative_hash)                                   AS story_count,
  round(sum(GREATEST(COALESCE(na.price_impact_score,0),0))::numeric,1) AS sum_impact,
  round(avg(na.price_impact_score)::numeric,1)                        AS avg_impact,
  count(DISTINCT na.source_outlet)                                    AS outlets,
  round(max(na.coordination_score)::numeric,0)                        AS max_coord,
  round(avg(na.sentiment_score)::numeric,1)                           AS avg_sentiment
FROM public.narrative_analyses na, latest
WHERE COALESCE(na.snapshot_date_day, na.snapshot_date) = latest.d
  AND na.ticker IS NOT NULL
  AND na.ticker ~ '^[A-Z][A-Z.]{0,5}$'
GROUP BY na.ticker
HAVING count(DISTINCT na.narrative_hash) >= 2
ORDER BY sum_impact DESC;

GRANT SELECT ON public.v_loudest_stories TO anon, authenticated;
