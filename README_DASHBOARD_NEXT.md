# /dashboard-next — Narrative Weather (passcode-gated NEXT version)

New dashboard version, built 2026-07-12 on branch `dashboard-next`. Lives
alongside the classic dashboard; nothing existing was modified except two
additive entries in `vercel.json`. (Note: the stale `_dashboard_v2.html` /
`api/dashboard-v2.js` from June were left untouched — this page deliberately
uses a fresh name to avoid colliding with them.)

## Files
- `_dashboard_next.html` — the page (single-file, house dark palette).
- `api/dashboard-next.js` — renders it, behind its OWN passcode gate
  (separate from `BETA_CODES`, so this preview unlocks only this page).
- `api/dashboard-next-data.js` — aggregated JSON (latest `narrative_scorecard`
  day + sectors from `ticker_valuation_config` + `earnings_context` proximity).
  Service-role key stays server-side; gated by the same passcode cookie.
- `vercel.json` — two rewrites + one `includeFiles` entry (additive).

## Setup (one step)
Add env var **`DASHBOARD_NEXT_CODE`** (the passcode, your choice) in Vercel →
Project Settings → Environment Variables (Preview + Production). The page
fails CLOSED (503) if unset. Cookie lasts 7 days; wrong code re-gates.

## What's on it (v1)
Hero narrative-field summary · sector Weather Map (mean-WKS fronts, labeled
as the validated sector-rotation signal) · Ember Storm Cells (EXHAUST_HIGHCONF
cohort, labeled validated) · Trap Watch (labeled forensic measurement, not a
trade signal) · sortable/filterable field grid with event-horizon chips ·
per-ticker dossier drawer (five pillars + FVD + coordination/suspicion with
the orthogonality footnote) · the honesty-ledger footer.

## Deploy flow
Work on `dashboard-next` branch → Vercel builds a preview URL per push
(page still passcode-gated there) → when approved, merge to `main`; the
route goes live on marketprism.co, still behind the passcode until you
choose to open it.

## Verified locally 2026-07-12
Full flow against live Supabase: gate → passcode → weather map (196 names,
14 sectors, Semis +32.1 front / Energy −9.5) → LRCX dossier drawer. No
console errors.

## Next iterations (per the Narrative Delivery Roadmap)
Event-horizon rings on the Universe tab · options chips (needs
`v_options_microstructure` fetch + key rotation first) · reliability dossier
pillars from `guidance_grade_events` once approved · contagion watch row.
