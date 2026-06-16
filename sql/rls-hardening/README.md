# RLS Hardening — Migration Package

Five phased migrations that lock down the public schema against
anon-key data harvesting. **Apply in order.** Each phase has a forward
migration, a verification query, and a rollback. Each is independently
reversible if a phase introduces a regression.

## Why this exists

Audit found:
- **30 tables with RLS disabled** — anon key reads them freely
- **37 tables with `rls_policy_always_true`** — RLS *on*, policy returns `true`
  for everyone (looks protected, isn't). Includes `narrative_scorecard`
  (3.5M rows), `narrative_dots`, `narrative_analyses`, `figure_calls`,
  `ticker_snapshots`, `analyst_ticker_scores`, `prediction_scores`.
- **10 SECURITY DEFINER views** that bypass underlying-table RLS

Without this work, anyone with the anon key (visible in any client-side
HTML) can curl Supabase REST and dump all 3.5M scorecard rows in one
call. RLS hardening + the rate limiting already shipped to `/api/*`
together close the bot/scraper bulk-extraction surface.

## How to apply

1. Open the Supabase SQL Editor for project `kugfvlagaetiqtdwdfmk`
   (the marketscholar-scraper / Market Prism prod database).
2. Run each `phase_NN_*.sql` file in order. After each phase:
   - Run `phase_NN_verify.sql` and confirm expected output
   - Open the live dashboard (https://marketprism.co/dashboard) as a
     logged-in user, click through Daily Plays, a ticker page,
     Signal Lab, Leaderboard. **Anything 401/403 in the network tab =
     stop and run the rollback for that phase.**
3. If anything looks off, run `phase_NN_rollback.sql` immediately.
4. Phases are not atomic across files — committing Phase 1 and rolling
   back Phase 2 is fine. Don't skip phases.

## Recommended timing

- Phases 1–2: anytime, near-zero risk (backup + internal-only tables).
- Phase 3: low-traffic hour. Tightens reference tables.
- **Phase 4: weekend evening, US markets closed.** This is the crown
  jewels (`narrative_scorecard`, `ticker_snapshots`, etc.) — the highest-
  risk phase. If something breaks, less user impact.
- Phase 5: same window as Phase 4 (views need the underlying-table RLS
  in place to be effective).

## Phase summary

| Phase | What it does | Risk to live app | Time |
|-------|--------------|------------------|------|
| 1 | Locks 17 old purge backup tables (no policies = service-role only) | Zero | 1 min |
| 2 | Locks 4 internal/backend-only tables | Very low | 1 min |
| 3 | Tightens 9 reference/scoring tables: drop wide-open policies, replace with `authenticated`-only read | Low | 2 min |
| 4 | **Crown jewels** — drops the wide-open policies on `narrative_scorecard`, `narrative_analyses`, `figure_calls`, `ticker_snapshots`, replaces with `authenticated`-only. Drops misleading "Service role full access" policies that were actually wide-open on `narrative_dots`, `analyst_ticker_scores`, `prediction_scores`, `search_query_log`, `source_registry` (service_role bypasses RLS by default; no policy needed) | **Medium-high** | 5 min |
| 5 | Converts 10 SECURITY DEFINER views to `security_invoker` so they respect underlying-table RLS instead of bypassing it | Medium | 1 min |
| 6 | Re-enables two read-path RPCs (`strategy_pub_breakdown`, `strategy_theme_breakdown`) that broke when `articles` was locked: makes them `SECURITY DEFINER` w/ pinned `search_path` so they read `articles` internally and return only aggregates — without exposing the table to anon | Low | 1 min |

## What this does NOT cover

- The remaining SECURITY DEFINER **functions** flagged as anon/authenticated-
  executable (Phase 6 handled only the two strategy RPCs that needed to read
  the now-locked `articles`). Lower-risk than the views and the tables; defer
  the rest to a follow-up audit.
- The 8 materialized views exposed via the API. Same — defer.
- Public storage buckets (2) — separate concern.

## Files

```
phase_01_lock_backup_tables.sql            ← run 1st
phase_01_verify.sql
phase_01_rollback.sql

phase_02_lock_internal_tables.sql          ← run 2nd
phase_02_verify.sql
phase_02_rollback.sql

phase_03_tighten_reference_tables.sql      ← run 3rd
phase_03_verify.sql
phase_03_rollback.sql

phase_04_lock_crown_jewels.sql             ← run 4th  ← weekend evening
phase_04_verify.sql
phase_04_rollback.sql

phase_05_convert_views_to_invoker.sql      ← run 5th
phase_05_verify.sql
phase_05_rollback.sql

phase_06_definer_strategy_rpcs.sql         ← run 6th  (independent follow-up)
phase_06_verify.sql
phase_06_rollback.sql
```
