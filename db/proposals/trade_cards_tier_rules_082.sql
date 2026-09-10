-- ============================================================================
-- PROPOSAL — NOT APPLIED.  Trade-card tier rules: stop the GOLD flood at the source.
--
-- Target object  : public.v_trade_cards   (engine DB kugf)
-- Owner of record: Market-Scholar-Full/forensic_memory/schemas/  (081 is the
--                  latest file there).  Land this as
--                  082_trade_cards_tier_rules.sql in that repo so the next
--                  schema apply does not silently overwrite it.
-- Written        : 2026-09-10 from marketprismmarch.  The display-side fix
--                  (gallery deck cap + MOMENTUM_CONFIRMED exclusion) shipped in
--                  marketprismmarch d0e3c42; this is the durable upstream half.
--
-- Why
--   trade_cards_live grew from ~9 collectible cards a day in June to 35-70 in
--   September.  Two rules compound:
--     1. v_trade_decision_engine labels a ticker MOMENTUM_CONFIRMED whenever
--        the market regime is BULL/CHOPPY and vms>=70, ccp>=60, energy>=60,
--        fvd_pct<50, coord<30, nrs<35 -- most of the 254-ticker universe in a
--        bull tape.
--     2. The tier CASE in v_trade_cards grants GOLD to any card in a
--        YELLOW_COLLAPSE/HOLLOW regime with keyword-adjusted confidence >= 0.55,
--        the loosest GOLD rule in the list.
--   MOMENTUM_CONFIRMED resolved 608 card_predictions in the 120 days to
--   2026-09-09 at a 19.9% logged hit rate; every other label sits at 31-38%.
--
-- Measured on 2026-09-10 (v_trade_cards, snapshot_date >= current_date - 1):
--
--   rule                                GOLD  PLAT  SURP  STD | collectible | momentum
--   current                               31     2     6   23 |     39      |   31
--   A   shortcut kw >= 0.85               17     2    14   29 |     33      |   25
--   A'  shortcut kw >= 0.90               10     2    18   32 |     30      |   22
--   B   MOMENTUM_CONFIRMED -> STANDARD     5     0     3   54 |      8      |    0
--
--   A alone is weak: the SURPRISE fallbacks (dark_pool HEAVY at >= 0.50,
--   short_squeeze at >= 0.50, drawdown_pressure >= 40 at >= 0.60) re-absorb
--   most of what the GOLD rule rejects.  B is the lever that matches the
--   evidence.  A on top of B is harmless (same 8 cards on 2026-09-10) and is
--   left commented out below.
--
-- Effects of B
--   STANDARD rows are already invisible everywhere: the gallery and
--   dashboard_bundle() read collectible tiers only, api/daily-answer.js the
--   same, and snapshot_card_predictions() the same -- so the Track Record log
--   stops accumulating 19.9%-hit momentum cards.  Momentum cards can still
--   reach UNICORN (Coiled for Breakout): the new WHEN sits after both UNICORN
--   rules.  refresh_trade_cards_live() (pg_cron job 2, 11:30 UTC) picks the
--   change up the next morning; `SELECT refresh_trade_cards_live();` applies
--   it immediately.  v_trade_cards has no reloptions, and CREATE OR REPLACE
--   keeps its grants (SELECT for anon, authenticated, service_role,
--   anomaly_search_ro).
--
-- Both blocks are self-verifying: they locate the exact line in the live view
-- definition and refuse to run if the view has drifted.
-- ============================================================================


-- ── B: MOMENTUM_CONFIRMED is never a collectible tier ───────────────────────
DO $$
DECLARE
  def            text := pg_get_viewdef('public.v_trade_cards'::regclass, true);
  applied_marker CONSTANT text := 'WHEN d.primary_label = ''MOMENTUM_CONFIRMED''::text THEN ''STANDARD''::text';
  tier_anchor    CONSTANT text := 'WHEN d.primary_label = ''NARRATIVE_RISK''::text THEN ''STANDARD''::text';
  tier_insert    CONSTANT text := E'\n                    WHEN d.primary_label = ''MOMENTUM_CONFIRMED''::text THEN ''STANDARD''::text';
  label_anchor   CONSTANT text := 'WHEN d.primary_label = ''NARRATIVE_RISK''::text THEN ''Watch — Narrative risk detected (unconfirmed signal)''::text';
  label_insert   CONSTANT text := E'\n                    WHEN d.primary_label = ''MOMENTUM_CONFIRMED''::text THEN ''Standard — Momentum long (not a collectible tier)''::text';
BEGIN
  IF position(applied_marker IN def) > 0 THEN
    RAISE NOTICE 'B already applied -- nothing to do';
    RETURN;
  END IF;
  IF position(tier_anchor IN def) = 0 OR position(label_anchor IN def) = 0 THEN
    RAISE EXCEPTION 'v_trade_cards has drifted (anchor not found) -- re-derive this proposal';
  END IF;
  def := replace(def, tier_anchor,  tier_anchor  || tier_insert);
  def := replace(def, label_anchor, label_anchor || label_insert);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_cards AS ' || def;
  RAISE NOTICE 'B applied';
END $$;


-- ── A (optional, on top of B): raise the regime shortcut from 0.55 to 0.85 ──
-- Uncomment to apply.
/*
DO $$
DECLARE
  def      text := pg_get_viewdef('public.v_trade_cards'::regclass, true);
  old_line CONSTANT text := '''YELLOW_COLLAPSE''::text])) AND COALESCE(k.keyword_adjusted_confidence, d.confidence) >= 0.55 THEN ''GOLD''::text';
BEGIN
  IF position(old_line IN def) = 0 THEN
    RAISE EXCEPTION 'shortcut line not found (already raised, or the view has drifted)';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_cards AS '
       || replace(def, old_line, replace(old_line, '>= 0.55', '>= 0.85'));
  RAISE NOTICE 'A applied';
END $$;
*/


-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expected on 2026-09-10 after B: GOLD 5, SURPRISE 3, STANDARD 54, momentum 0
-- in every collectible tier.
SELECT card_tier,
       count(*) AS n,
       count(*) FILTER (WHERE primary_label = 'MOMENTUM_CONFIRMED') AS momentum
FROM public.v_trade_cards
WHERE snapshot_date >= current_date - 1
GROUP BY 1 ORDER BY 1;

-- Then either wait for the 11:30 UTC refresh or run:
--   SELECT refresh_trade_cards_live();


-- ── Rollback B ───────────────────────────────────────────────────────────────
/*
DO $$
DECLARE
  def text := pg_get_viewdef('public.v_trade_cards'::regclass, true);
BEGIN
  IF position('''MOMENTUM_CONFIRMED''::text THEN ''STANDARD''::text' IN def) = 0 THEN
    RAISE EXCEPTION 'B is not applied';
  END IF;
  def := regexp_replace(def, '\n\s*WHEN d\.primary_label = ''MOMENTUM_CONFIRMED''::text THEN ''STANDARD''::text', '');
  def := regexp_replace(def, '\n\s*WHEN d\.primary_label = ''MOMENTUM_CONFIRMED''::text THEN ''Standard — Momentum long \(not a collectible tier\)''::text', '');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_cards AS ' || def;
  RAISE NOTICE 'B rolled back';
END $$;
*/

-- ── Rollback A ───────────────────────────────────────────────────────────────
/*
DO $$
DECLARE
  def      text := pg_get_viewdef('public.v_trade_cards'::regclass, true);
  new_line CONSTANT text := '''YELLOW_COLLAPSE''::text])) AND COALESCE(k.keyword_adjusted_confidence, d.confidence) >= 0.85 THEN ''GOLD''::text';
BEGIN
  IF position(new_line IN def) = 0 THEN
    RAISE EXCEPTION 'A is not applied';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_cards AS '
       || replace(def, new_line, replace(new_line, '>= 0.85', '>= 0.55'));
  RAISE NOTICE 'A rolled back';
END $$;
*/
