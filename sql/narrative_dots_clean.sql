-- narrative_dots_clean
--
-- narrative_dots minus mis-tagged dots. A dot is "mis-tagged" when its source
-- article's Gemini relabel says the article is NOT about the tagged ticker
-- (articles.is_about_ticker_gemini IS FALSE — the scraper's substring-match
-- tagging bug, e.g. a Tesla valuation story tagged UPS). Those dots carry the
-- WRONG ticker's forward returns, so serving surfaces must never read them.
--
-- Consumers (display rows AND summary counts):
--   marketprismmarch  api/constellation.js          (Forensic Timeline)
--   marketprismmarch  api/ticker-day-narratives.js  (Signal Lab day cards)
--   marketscholar2026 app/api/narrative-dots        (dots scatter)
-- The RPCs (search_dots_by_embedding v4, get_recent_narratives v2) apply the
-- same predicate inline — keep all of them in sync if the rule ever changes.
--
-- security_invoker: the caller's rights apply to the underlying tables, so
-- narrative_dots' RLS posture (service-role only, no anon policies) carries
-- through unchanged — the view adds ZERO new anon exposure. The explicit
-- revoke is belt-and-suspenders on top of that.
--
-- Applied to Supabase 2026-07-18 (migration narrative_dots_clean_view).

CREATE VIEW public.narrative_dots_clean
WITH (security_invoker = true)
AS
SELECT d.*
FROM public.narrative_dots d
WHERE NOT EXISTS (
  SELECT 1 FROM public.articles a
  WHERE a.id = d.source_article_id
    AND a.is_about_ticker_gemini IS FALSE
);

COMMENT ON VIEW public.narrative_dots_clean IS
  'narrative_dots excluding dots whose source article is Gemini-labeled as not about the tagged ticker (mis-tag bug). Serving surfaces read this instead of the base table. security_invoker: base-table RLS applies.';

REVOKE ALL ON public.narrative_dots_clean FROM anon, authenticated;
