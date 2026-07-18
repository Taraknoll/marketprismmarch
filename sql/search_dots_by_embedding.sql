-- search_dots_by_embedding
--
-- Backs POST /api/dots-predict (the narrative-validation search at /search).
--
-- Given a 384-dim query vector (from sentence-transformers/all-MiniLM-L6-v2,
-- the same model used to embed the corpus), returns the top-k nearest
-- chain-tip dots by cosine similarity, with optional sector / cycle-phase /
-- cluster / recency filters.
--
-- Read-only; SECURITY DEFINER not used (RLS applies to caller's role).
--
-- Apply with:
--   psql "$DATABASE_URL" -f sql/search_dots_by_embedding.sql
-- or via the Supabase SQL editor.
--
-- Required: pgvector >= 0.5 (HNSW), narrative_dots.embedding column
-- exists (vector(384)), is_chain_tip column exists (boolean).
--
-- ============================================================================
-- PERFORMANCE NOTES — why this is shaped the way it is (the /search timeout fix)
-- ============================================================================
-- Symptom: /search returned
--   search_dots_by_embedding RPC failed (500):
--   {"code":"57014", ... "message":"canceling statement due to statement timeout"}
-- i.e. Postgres killed the query at the API role's statement_timeout (8s).
--
-- Root cause: PostgREST executes the RPC as a prepared statement, so Postgres
-- builds a GENERIC plan. In a generic plan the predicate
--   observed_at >= NOW() - ($n || ' days')::interval
-- can't be estimated (parameterized interval) and is guessed at rows=1. With
-- that bogus estimate, an exact "btree index + top-N heapsort" over every
-- chain-tip row looks cheaper than the approximate vector index, so the planner
-- sorts all ~21k chain-tip rows by distance on every call. Warm that's ~0.5s;
-- cold (or under load) it sails past the 8s timeout -> 57014 -> the /search UI
-- shows "failed to produce results".
--
-- Two-part fix:
--   1. A PARTIAL HNSW index covering exactly the searchable subset
--      (is_chain_tip = TRUE AND embedding IS NOT NULL — only ~21k of ~660k
--      rows). Small, high-recall, and the natural pick for ORDER BY <=> LIMIT.
--   2. The function pins plan_cache_mode = force_custom_plan so each call is
--      re-planned with the actual argument values. With real values the
--      observed_at selectivity is estimated correctly and the HNSW index wins.
--      (A SET clause on the function also makes it non-inlinable, which is what
--      lets the pin take effect.) It also raises hnsw.ef_search at runtime so a
--      k=200 search returns a full neighborhood instead of ~40.
--
-- Result: ~25ms vs. >8s, well inside the API timeout.
-- ============================================================================
-- MIS-TAG FILTER (2026-07-18)
-- ============================================================================
-- ~21.5% of the searchable corpus (4,001 of 18,572 chain-tip dots at last
-- count) traces to an article whose Gemini relabel says it is NOT about the
-- tagged ticker (articles.is_about_ticker_gemini = FALSE) — the scraper's
-- substring-match tagging bug. Those dots carry the WRONG ticker's forward
-- returns, so they polluted both the analogue cards and the aggregated
-- hit-rate/predicted-return numbers (e.g. a Tesla valuation story indexed
-- under UPS, "resolved" with UPS's -9.5% 10d return).
--
-- Fix: anti-join articles inside the RPC. Shape matters for the plan — the
-- inner KNN subquery is byte-identical to the previous proven-fast query
-- (constant vector -> partial HNSW index) and its LIMIT makes it a fence the
-- planner can't flatten, so the index plan is preserved; the anti-join then
-- runs as cheap articles-PK lookups over at most k*2 ordered candidates.
-- Verified by EXPLAIN ANALYZE: HNSW index scan, 270 candidates fetched to
-- fill k=200, ~215ms cold.
--
-- Only is_about_ticker_gemini IS FALSE is excluded: unlabeled articles
-- (label lands ~13h after scrape) and dots without a source article pass.
-- ============================================================================

-- 1. Partial HNSW index over the searchable subset. Build CONCURRENTLY so it
--    doesn't block the ingestion writers. IF NOT EXISTS makes re-runs safe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dots_embedding_hnsw_chaintip
  ON public.narrative_dots
  USING hnsw (embedding vector_cosine_ops)
  WHERE is_chain_tip = TRUE AND embedding IS NOT NULL;

-- 2. The RPC.
CREATE OR REPLACE FUNCTION public.search_dots_by_embedding(
  query_vector vector,
  k integer DEFAULT 200,
  filter_sector text DEFAULT NULL,
  filter_cycle_phase text DEFAULT NULL,
  filter_max_age_days integer DEFAULT 540,
  filter_cluster_id integer DEFAULT NULL,
  filter_observed_before timestamptz DEFAULT now()
)
RETURNS TABLE (
  dot_hash text,
  ticker text,
  narrative_text text,
  observed_at timestamptz,
  speaker_id text,
  speaker_authority numeric,
  sector text,
  cycle_phase text,
  market_regime text,
  narrative_direction text,
  embedding_cluster_id integer,
  return_5d numeric,
  return_10d numeric,
  return_20d numeric,
  return_5d_narrative numeric,
  bullshit_probability numeric,
  ground_truth_label boolean,
  similarity numeric
)
LANGUAGE plpgsql
STABLE
-- Force a custom (per-call) plan so the parameterized observed_at filter is
-- estimated from real values and the HNSW index is chosen. See notes above.
SET plan_cache_mode = 'force_custom_plan'
AS $$
BEGIN
  -- Raise the HNSW candidate list so a k=200 search returns a full
  -- neighborhood (default hnsw.ef_search = 40 caps results at ~40-50).
  -- Transaction-local (is_local = true); cannot be pinned as a function SET
  -- clause because the API role lacks privilege on the extension GUC.
  PERFORM set_config('hnsw.ef_search', '500', true);

  RETURN QUERY
  SELECT
    c.dot_hash,
    c.ticker,
    c.narrative_text,
    c.observed_at,
    c.speaker_id,
    c.speaker_authority,
    c.sector,
    c.cycle_phase,
    c.market_regime,
    c.narrative_direction,
    c.embedding_cluster_id,
    c.return_5d,
    c.return_10d,
    c.return_20d,
    c.return_5d_narrative,
    c.bullshit_probability,
    c.ground_truth_label,
    -- <=> returns double precision; the result column is numeric.
    (1 - c.dist)::numeric AS similarity
  FROM (
    -- Inner KNN: identical to the pre-2026-07-18 query (see perf notes above)
    -- except it overfetches k*2 so the mis-tag anti-join below can drop up to
    -- half the neighborhood and still fill k. The LIMIT keeps it a planner
    -- fence, so the partial-HNSW plan is unchanged.
    SELECT
      d.dot_hash,
      d.ticker,
      d.narrative_text,
      d.observed_at,
      d.speaker_id,
      d.speaker_authority,
      d.sector,
      d.cycle_phase,
      d.market_regime,
      d.narrative_direction,
      d.embedding_cluster_id,
      d.return_5d,
      d.return_10d,
      d.return_20d,
      d.return_5d_narrative,
      d.bullshit_probability,
      d.ground_truth_label,
      d.source_article_id,
      d.embedding <=> query_vector AS dist
    FROM public.narrative_dots d
    WHERE d.is_chain_tip = TRUE
      AND d.embedding IS NOT NULL
      AND (filter_sector IS NULL OR d.sector = filter_sector)
      AND (filter_cycle_phase IS NULL OR d.cycle_phase = filter_cycle_phase)
      AND (filter_cluster_id IS NULL OR d.embedding_cluster_id = filter_cluster_id)
      AND d.observed_at >= NOW() - (filter_max_age_days || ' days')::interval
      AND d.observed_at <= filter_observed_before
    ORDER BY d.embedding <=> query_vector
    LIMIT k * 2
  ) c
  -- Mis-tag filter: exclude dots whose source article is Gemini-labeled as
  -- not actually about the tagged ticker (wrong ticker -> wrong returns).
  WHERE NOT EXISTS (
    SELECT 1 FROM public.articles a
    WHERE a.id = c.source_article_id
      AND a.is_about_ticker_gemini IS FALSE
  )
  ORDER BY c.dist
  LIMIT k;
END;
$$;

-- Allow the API role(s) to call the RPC. Service role inherits this; the
-- anon grant is included so the function can be called even when a project
-- only exposes the anon key — it still goes through RLS on narrative_dots.
GRANT EXECUTE ON FUNCTION public.search_dots_by_embedding(
  vector, int, text, text, int, int, timestamptz
) TO anon, authenticated, service_role;
