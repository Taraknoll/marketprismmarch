-- get_recent_narratives
--
-- Backs the "Recent narratives about this ticker" panel rendered below
-- the prediction grid on /search.
--
-- Returns the most recent N chain-tip dots for the ticker, with their
-- realized return outcomes when available. The frontend uses these to
-- show what the corpus actually thinks about THIS ticker right now,
-- separate from the embedding-similarity hits against the broader
-- universe of historical analogues.
--
-- Read-only; safe to drop and recreate.

CREATE OR REPLACE FUNCTION public.get_recent_narratives(ticker_in text, n int DEFAULT 8)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'dot_hash',            dot_hash,
      'narrative_text',      CASE WHEN length(narrative_text) > 240
                                  THEN left(narrative_text, 240) || '…'
                                  ELSE narrative_text END,
      'observed_at',         observed_at,
      'speaker',             speaker_id,
      'return_5d',           return_5d,
      'return_10d',          return_10d,
      'return_20d',          return_20d,
      'return_5d_narrative', return_5d_narrative,
      'sector',              sector
    ) ORDER BY observed_at DESC),
    '[]'::jsonb
  )
  FROM (
    SELECT *
    FROM public.narrative_dots d
    WHERE d.ticker = UPPER(ticker_in)
      AND d.is_chain_tip = TRUE
      AND d.narrative_text IS NOT NULL
      -- Mis-tag filter (2026-07-18): skip dots whose source article is
      -- Gemini-labeled as not actually about this ticker — the scraper's
      -- substring-match tagging bug otherwise surfaces e.g. a Tesla story as
      -- a "recent UPS narrative" with UPS's returns. Mirrors
      -- search_dots_by_embedding v4.
      AND NOT EXISTS (
        SELECT 1 FROM public.articles a
        WHERE a.id = d.source_article_id
          AND a.is_about_ticker_gemini IS FALSE
      )
    ORDER BY d.observed_at DESC
    LIMIT GREATEST(LEAST(n, 30), 1)
  ) d;
$$;

GRANT EXECUTE ON FUNCTION public.get_recent_narratives(text, int) TO anon, authenticated, service_role;
