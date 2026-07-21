# Supabase Runtime Dependency Audit — Outage-Resilience Baseline

> Generated 2026-07-06 on branch `claude/ticker-price-physics-lite` (working tree, includes uncommitted `_ticker.html` + `api/light-signals.js`).
> Purpose: complete dependency map before adding an outage-resilience layer. **No code was changed.**
> Supersedes `SUPABASE_INTEGRATION_REPORT.md` (2026-03-18, covered only 4 pages).
>
> Method: 7 parallel file-level audits + global grep sweeps + Supabase project cross-check. Items marked ⚠ are single-sourced from one audit pass and worth re-verifying before building on them. Everything else was confirmed by at least two independent passes (grep + file read).

---

## 0. Executive summary

- **Single point of failure:** one Supabase project, `https://kugfvlagaetiqtdwdfmk.supabase.co` (the kugf engine DB). Every page, API route, auth check, and billing flow goes through it. There is no second project, no replica, no cached snapshot.
- **Five access channels:** (1) browser → REST with injected anon key (per-page helper fns), (2) browser → supabase-js SDK for auth/subscriptions, (3) browser → 4 Edge Functions (+1 called server-side), (4) Vercel functions → REST with anon or service-role key, (5) one direct Postgres pool (read-only role, anomaly agent). Plus 3 GitHub-Actions content writers.
- **Nothing is baked at build time.** No Vercel crons, no SSG data. A snapshot layer is greenfield.
- **The worst failure mode is not data panels — it's auth.** `api/_require-auth.js` verifies `auth/v1/user` and reads `subscriptions` with **no timeout** and **fails closed**: during a Supabase outage every paying subscriber is hung and then bounced to `/pricing`. Data panels mostly degrade to blanks; the auth gate takes down `/dashboard` and `/ticker/*` entirely.
- **Resilience is uneven by page generation.** Newer surfaces (ticker page, heatmap, signal lab, forensic-data API, SEO/stock renderers) have 15s AbortControllers, `Promise.allSettled`, per-call `.catch(()=>[])`, static fallbacks, and CDN `s-maxage` + `stale-while-revalidate`. The oldest and most-used surface — the dashboard — has **zero client-side timeouts** and blocking `Promise.all` chains.
- **Live prices are not Supabase.** `live-quote`, `live-quotes-batch`, `price-history`, `ticker-snapshot`, `ticker-trades`, `light-signals` are Polygon/Massive proxies. Ticker tape, price charts, and the new ticker lite-mode survive a Supabase outage.

---

## 1. Architecture — how the app reaches Supabase

```
Browser ── window.__env (SUPABASE_URL + SUPABASE_ANON injected by api/*.js handler)
   ├─ raw fetch → /rest/v1/<table|view|rpc>        (per-page helper: sbFetch / rest / get / sq …)
   ├─ supabase-js SDK → /auth/v1/*  + subscriptions (login, pricing, ticker gate, topbar)
   └─ fetch → /functions/v1/<edge fn>               (dashboard-data, score-stock, checkout, portal)

Vercel fn ── process.env SUPABASE_ANON or SUPABASE_SERVICE_ROLE
   ├─ REST reads for SSR/meta/data endpoints (some with s-maxage + SWR CDN caching)
   ├─ /auth/v1/user verification (session + require-auth)
   └─ pg.Pool via ANOMALY_RO_DATABASE_URL (read-only role, 5s stmt timeout) — anomaly agent only

GitHub Actions (cron) ── SUPABASE_SERVICE_KEY / SUPABASE_ANON → INSERT blog_posts
```

Env-injection detail: handlers string-replace a `<script id="__env_script">` block. Root `*.html` files are also deployed as static files, so they are reachable directly (e.g. `/_template.html`) with **un-injected** placeholders — those loads fail their config check; a side-door, not a user path.

Not-Supabase (survive an outage): Polygon proxies (above), Anthropic proxies (`daily-brief`, `interpret-chart`, `anomaly-agent`'s LLM loop, `hero-summary`'s LLM step), GA4, Stripe itself (but checkout is *initiated* through a Supabase Edge Function).

---

## 2. Client-side call map (browser, per routed page)

Legend — **Load**: fires automatically at page load. **Lazy**: tab click / user action. **Poll**: interval. Failure column = what the user sees today on 500s / on hang.

### 2.1 `/dashboard` + `/dashboard-black` (`_template.html`, `_template_black.html`, tabs `_signal_lab_tab.html`, `_ticker_tab.html`) — subscriber home

Server gate first: `requireAuth` (see §3.1) — during an outage users never reach the page.

| Trigger | Endpoint(s) | Purpose | Failure behavior |
|---|---|---|---|
| Load (blocking) | **Edge fn `functions/v1/dashboard-data`** → bundles `v_dash_daily_story`, `trade_cards_live`, `v_trade_cards`, `narrative_scorecard`, narrative analyses/quality flags, `ticker_snapshots`, `ticker_industry_lookup` | Entire boot dataset | Error banner on Daily Plays + static demo cards; **no timeout** — spinner + tip carousel until browser gives up |
| Load (blocking `Promise.all` after edge fn) | `active_supported`, `narrative_traps`, `coordination_alerts` | Daily Plays panels | One hang delays first data paint; on !ok each returns early (panel hidden) |
| Poll 60s | `sim_stats`, `tracked_daily_plays`, `paper_trades` | Live portfolio cards | "Could not load" text in grid; keeps retrying |
| Lazy: Leaderboard tab | `narrative_scorecard` (×2 over/under-valued), `v_dash_daily_story` (earnings ≤21d), `v_growth_at_discount`, `v_momentum_leaders`, `v_strategy_plays`, `v_strategy_lane_summary`, `/api/top-ai-picks` | Leaderboard panels + strategy lanes | `.catch(→null)` — sections silently blank |
| Lazy + 10-min refresh: Market Insights tab | `daily_summaries`, `sector_news`, `v_momentum_leaders` (was `momentum_signals` — RLS-no-policy, anon read returned `[]`; repointed 2026-07-10), `v_loudest_stories` (`Promise.all`) | MI panels | One hang blocks all MI panels; on !ok empty/collapsed panels |
| Lazy: Discover / Sector / Earnings | `daily_summaries`, `ticker_pulse`, `ticker_valuation_config`, `ticker_snapshots`, `benzinga_earnings`, `daily_trade_labels`, `ticker_dark_pool` | drill-downs | Silent `.catch` → dashes / hidden |
| Lazy: Forensic tab (⚠ `_template.html` only, absent in black) | `v_ticker_universe_search`, `v_xbrl_redflag_latest_plus`, `xbrl_forensic_factors`, `v_xbrl_factor_timeline` | XBRL red flags | Silent → panels hidden |
| Lazy: Signal Lab tab | `narrative_analyses`, `decay_metrics`, `narrative_scorecard`, `mv_energy_t_normalized`, `mv_physics_energy_normalized`, `ticker_snapshots`, `keyword_price_impact` + `/api/price-history`, `/api/ticker-clusters`, `/api/ticker-day-narratives`, `/api/interpret-chart` | SL chart + overlays | Partial chart; missing overlays skipped |
| Lazy: on demand | Edge fns `score-stock`, `create-portal-session`; `/api/session`, `/api/watchlist`, `/api/live-quotes-batch`, `/api/live-quote`, `/api/anomaly-agent`, `/api/daily-brief` | scoring, billing portal, hearts, prices | Generic error text or silent |
| Ticker tab | iframe → `/ticker/:t?embed=1` | delegates everything to `_ticker.html` | see below |

**No AbortController / timeout anywhere in this file.** 500s → banner + mostly-silent blanks. Hang → page effectively unusable until browser-level timeout. `_template_black.html` is a styling clone with identical wiring (minus Forensic tab).

### 2.2 `/ticker/:ticker` (`_ticker.html`) — the best-defended client page

Helper `sbFetch(table, params, timeoutMs=15000)` with AbortController; throws on !ok; every call site adds `.catch(()=>[])`. Boot = `Promise.allSettled(loadHero, loadPulse)` then `allSettled` over lazy loaders — no single call can block the page.

| Trigger | Endpoint(s) |
|---|---|
| Load: `loadHero()` (12 parallel, 15s each) | `v_dash_daily_story` (**gating row**), `v_dash_narrative_health`, `trade_classifications`, `narrative_scorecard`, `claim_verifications`, `earnings_context`, `ticker_forecast`, `v_ticker_forecast_horizons`, `benzinga_earnings`, `daily_fair_value`, `ticker_strategy_summary`, + `/api/price-history` |
| Load: `loadPulse()` | `ticker_pulse` |
| Load: search dropdown | `v_ticker_universe_search` (500 rows) — **no timeout**, silent fail |
| Load: access gate | supabase-js `auth.getUser()` + `from('subscriptions')` (line ~12712–12724) — **no timeout; can stall gating** |
| Lazy loaders (each 15s + catch→[]) | `narrative_analyses` (several), `decay_metrics`, `mv_physics_energy_normalized`, `mv_energy_t_normalized`, `v_dash_move_drivers`, `sector_intelligence`, `v_ticker_pe`, `sector_pe_benchmarks`, `scholarly_references` (×3 scopes), `v_claim_trap_screen`, `v_claim_research_verdicts`, `article_signal_price_index`, `keyword_price_impact`, `keyword_industry_signal_modifiers`, `source_scores`, RPCs `get_keyword_signal_stats`, `strategy_pub_breakdown` |
| Poll | full `refreshAll()` every 5 min + on tab re-focus |
| Fallback chain | `v_dash_daily_story` empty → `/api/light-signals` (Polygon-only "price physics lite") → `renderTickerNotFound()` |

Server side `api/ticker.js`: `requireAuth`, then SEO/AEO meta injection — `Promise.all` over `narrative_scorecard`, `v_trade_cards`, `ticker_reality_belief` with a **5s AbortController**, non-fatal (page renders with default meta).

**500s:** partial hero + hidden panels, lite mode if the gating row is missing. **Hang:** hero settles within ~15s; only the auth gate and search dropdown lack timeouts.

### 2.3 `/` homepage (`_home_v4.html` via `api/index.js` catch-all; `/home-v2`, `/home-v3` rollbacks are same-pattern)

| Trigger | Endpoint(s) | Failure behavior |
|---|---|---|
| Load | `/api/live-quotes-batch` (Polygon) — ticker tape | tape blank; **not Supabase** |
| Load | `ticker_forecast` (strongest-pick query for demo) | falls back to hardcoded NVDA demo |
| Lazy (demo interaction / `?ticker=`) | `v_dash_daily_story`, `ticker_snapshots`, `ticker_forecast`, `daily_fair_value`, `sector_pe_benchmarks`, `/api/dots-predict` | per-call `.catch(()=>[])` → blank demo sections, no error UI |
| Load (shared `public/lib/mp-topbar.js`, on most pages) | `ticker_industry_lookup` (300 rows) for search | silent — search dropdown dead ("Loading tickers…") |

Page shell, marketing copy, and video are static — the homepage **survives** an outage cosmetically; no timeout anywhere.

### 2.4 Auth & billing surface

| Page/file | Endpoints | Timeout / behavior today |
|---|---|---|
| `_login.html` | `auth/v1/health` probe; SDK `getSession`, `signInWithPassword`, `signUp`, `resetPasswordForEmail`; POST `/api/session` | **Best outage UX in the app**: 6s health probe → maintenance banner; 5s getSession race. Sign-in itself relies on SDK default (~30s); forms stay clickable under the banner |
| `pricing.html` (+ `public/billing-ui.js`, `billing-config.js`) | `auth.getUser`, `from('subscriptions')`, Edge fns `create-checkout-session`, `create-portal-session` | No timeouts. Sub-state silently wrong on failure; checkout button can hang indefinitely (revenue path) |
| `api/session.js` | `auth/v1/user` verify (server) | **No timeout** — login cookie minting hangs |
| `api/_require-auth.js` (gates `/dashboard`, `/ticker/*`, watchlist, others) | `auth/v1/user`; `subscriptions` read (30s in-memory cache per user); Edge fn `repair-subscription` (8s AbortController) | **No timeout on the two critical calls; fails closed** → hang, then 302 `/pricing`. Paying users locked out during outage |
| `api/watchlist.js` | `user_watchlists` GET/POST/DELETE (login-gated, `subscriptionOptional`) | No timeout; 500 `supabase_*_failed` to client |

### 2.5 Secondary routed pages

| Route (file) | Supabase surface | Defenses today |
|---|---|---|
| `/daily` (`_daily.html`) | Load `allSettled`: `v_dash_daily_story`, `ticker_pulse`, `active_traps`, `v_dash_historical_analogs`, `sector_risk_summary`, `narrative_scorecard`; lazy `macro_narrative_events`, `coordination_alerts`; POST `/api/daily-brief` (headline — static fallback string on failure) | allSettled + silent fails, **no timeouts**; hang = indefinite "Loading…" |
| `/heatmap` (`_heatmap.html`) | `ticker_pulse` (1000 rows), 5-min refresh | **15s AbortController + hardcoded `FALLBACK_TICKERS` grid** — most resilient page |
| `/narrative-heatmap` (`_narrative_heatmap.html`) | `ticker_industry_lookup`, `v_narrative_map_daily` per-ticker | 15s aborts; blanks on failure |
| `/signal-charts` (`_signal_charts.html`) | `ticker_snapshots`, `decay_metrics`, `mv_physics_energy_normalized`, `narrative_scorecard` (+ ⚠ `bubble_metrics`); 30s price refresh | helper returns `[]` on any error — silent, no timeout |
| `/search` (`_search.html`, Narrative Lab) | none direct — POST `/api/dots-predict` | stuck spinner if backend hangs (backend has 12s guards) |
| `/ask`, `/anomaly-search` (`_anomaly_search.html`) | none direct — POST `/api/anomaly-agent` | error bubble on 500; spinner on hang |
| `/traps`, `/herb` (`_traps.html`) | `narrative_traps` (stats strip only, 300 rows) + `/api/live-quotes-batch` | **cards are hardcoded editorial** — page survives; stats show "—" |
| `/herbtraps` (`_herbtraps.html`) | none (client-side pw gate + canvas) | immune |
| `/forensic` (`_forensic.html`) | none direct — `/api/forensic-data` (+ lazy `&section=claims`) | server has 7s/section + `[]`; client spinner has **no timeout** |
| `/blog`, `/blog/:slug`, `/author/:slug` | `blog_posts` client-side; POST `beta_signups` (newsletter/beta forms, also on blog posts) | spinner → "No posts"; forms error inline; no timeout |
| `/stocks/:t`, 3 SEO routes (`why-is-*-down`, `is-*-overvalued`, `should-i-buy-*`) | SSR (see §3.2); client only `/api/live-quote` poll (5s market / 2m off) | SSR shell always renders; client price poll is Polygon |
| `/growth-calculator`, `/position-size-calculator`, `/calculators`, casestudies, about/faq/terms/privacy/methodology/features | none, or `/api/price-history` only (+ topbar search) | effectively static |
| `/daily-v2` | `api/daily-plays-v2.js` = 308 redirect to `/dashboard` (retired) | n/a |

Unrouted/dev surfaces with Supabase code (kept out of the prod map, listed for completeness): `_template_dev`, `_dev_dashboard`, `_dev_ticker`, `_ticker_dev`, `_ticker_rddt`, `_dashboard_v2`, `_scorer_dev` (hardcoded `score-stock` edge fn), `_home_dev`, `_home_staging`, `_dev_home`, `_signal_lab.html` (standalone twin of the tab), root `daily.html` (stray legacy copy), `*_backup*`, `archive/`. Dev pages additionally reference `theme_performance`, `source_leaderboard`, `v_dot_bullshit_alerts`, `ticker_subcategory`, RPC `get_all_tickers`.

---

## 3. Server-side call map (Vercel functions + lib)

### 3.1 Auth infrastructure — see §2.4. The one cross-cutting, fail-closed, untimed dependency.

### 3.2 SSR renderers (`lib/`)

| File | Used by | Tables | Defenses |
|---|---|---|---|
| `seoPageRenderer.js` | `api/seo-why-down.js`, `seo-overvalued.js`, `seo-should-buy.js` | `narrative_scorecard` (×2), `v_trade_cards`, `v_ticker_universe_search`, `ticker_reality_belief`, `v_loudest_stories` | AbortController signal + per-fetch `.catch(()=>null)` — page renders with whatever arrived |
| `stockPageRenderer.js` | `api/stock.js` (`/stocks/:t`), `api/stocks-index.js` | `narrative_scorecard` (×2), `v_loudest_stories`, `v_ticker_universe_search`, `ticker_reality_belief` | same pattern |
| `narrativeEngine.js`, `answerFirst.js`, `aeoBlock.js`, `seoHead.js`, `mod-*.js`, `mp-core.js` | copy/markup builders + browser helper | no server-side Supabase of their own | deterministic |

### 3.3 Data endpoints (XHR targets)

| Endpoint | Key | Tables/RPCs | Timeout | CDN cache | On failure |
|---|---|---|---|---|---|
| `api/forensic-data.js` | **service-role** | `v_xbrl_redflag_latest_plus`, `xbrl_forensic_factors`, `v_xbrl_factor_timeline`, `fdq_outcome_labels`, `v_forensic_peers`, `narrative_scorecard`, `daily_fair_value`, `earnings_context`, `scholarly_references`; lazy `mv_claim_evidence_match`; Polygon profile (4s) | **7s/section** (8s claims) | 300/900 SWR; claims 86400/604800 | per-section `[]`; 404 if not screened |
| `api/constellation.js` | **service-role** (`narrative_dots` is RLS-no-policy) | `narrative_dots`, `ticker_snapshots` | none explicit | 300/900 SWR | 502 |
| `api/ticker-day-narratives.js` | **service-role** | `narrative_dots` | none explicit | 300/900 SWR | 502 |
| `api/hero-summary.js` | anon | `v_dash_daily_story`, `narrative_scorecard`, `v_dash_narrative_health`, `v_narrative_scorecard_deduped`, `daily_fair_value`, `narrative_analyses` + Anthropic | 12s | **1800/86400 SWR** | 404/502 |
| `api/dots-predict.js` | service-role (fallback anon) | RPCs `search_dots_by_embedding`, `get_ticker_context`, `get_recent_narratives`, `find_nearest_cluster`; **WRITE** `search_query_log` (fire-and-forget `waitUntil`) | 12s on vector search | no-store | 500/502 |
| `api/top-ai-picks.js` | **service-role** | `ai_daily_picks` read + **upsert** (persistent cache) + Anthropic | model-chain retry | in-memory + DB cache | serves cached picks if LLM down |
| `api/anomaly-agent.js` (+ `_ro_sql.js`, `_schema_digest.js`) | anon REST **+ direct Postgres** `ANOMALY_RO_DATABASE_URL` (pg.Pool max 2, conn 8s) | `narrative_scorecard`, `bubble_metrics`, `narrative_ticker_clusters`, `narrative_cluster_centroids`, `v_circular_finance_roundtrips`, `circular_finance_entities`, `scholarly_references`, `articles`, `coordination_flags`, `claim_verifications`, `v_contagion_master`; arbitrary read-only SQL (guarded) | **12s per REST call; 5s statement_timeout on SQL** | no-store | `{ok:false}` JSON |
| `api/ticker-details.js` | anon (service for sync) | `ticker_industry_lookup`, `ticker_sector_inference` (+ Polygon; optional **upsert** sync-back) | none explicit | 86400/604800 | 400/500 |
| `api/ticker-clusters.js` | anon ⚠ | `narrative_ticker_clusters` | none explicit | ⚠ | error JSON |
| `api/blog.js`, `blog-post.js`, `author.js` | anon | `blog_posts` (server meta + client list) | none | — | template still serves |
| `api/feed.js` | anon | `blog_posts` | none | 1800/3600 | empty channel |
| `api/sitemap.js`, `news-sitemap.js`, `llms-txt.js` | anon | `blog_posts`, `narrative_scorecard` (ticker URLs) | none | — | static-pages-only sitemap (silent catch) |
| `api/og-image.js`, `stock-og.js`, `ticker-meme-card.js` | anon ⚠ | story/scorecard reads for share images | ⚠ | — | default image |
| Polygon proxies: `live-quote`, `live-quotes-batch`, `price-history`, `ticker-snapshot`, `ticker-trades`, `ticker-fundamentals`, `light-signals` | — | **no Supabase** | — | some SWR | unaffected by SB outage |
| Anthropic proxies: `daily-brief`, `interpret-chart` (context arrives in POST body); `scholar` ⚠ (has some SB reads) | — / anon | — | — | some SWR | unaffected except scholar reads |

### 3.4 Edge Functions on the project (12 active)

Called from this codebase: `dashboard-data` (dashboard boot bundle), `score-stock`, `create-checkout-session`, `create-portal-session` (browser), `repair-subscription` (server, 8s timeout). Engine-side only (not called by site code, but produce the tables the site reads): `stripe-webhook`, `track-daily-plays`, `compute-track-record-stats`, `refresh-ticker-forecast`, `coordination-escalation-detector`, `article-outcomes-resolver`, `generate-narrative-image`.

### 3.5 Build-time / scheduled writers (GitHub Actions — no Vercel crons, no build-time reads)

| Job | Cron (UTC) | Key | Reads | Writes | State |
|---|---|---|---|---|---|
| `generate_mp_blog.py` | 12:00 wkdays | **service** (validated, fails loud) | `narrative_scorecard`, `v_trade_cards` | `blog_posts` | working |
| `generate_earnings_forensic.py` | 10:00 wkdays | **anon** | `earnings_context`, `claim_verifications`, `narrative_scorecard`, `v_dash_daily_story` | `blog_posts` | **broken — silent 403 since 2026-06-10 RLS lockdown** |
| `generate_earnings_forensic_deluxe.py` | 09:00 wkdays | **anon** | above + `benzinga_earnings`, `benzinga_guidance`, `ticker_short_data`, `ticker_dark_pool`, `article_outcomes`, `card_predictions`, `ticker_prices` | `blog_posts` | **broken — same silent 403** |

`scripts/*.js` are local dev harnesses (preview servers proxy prod APIs; no writes). `db/proposals/anomaly_ro_role.sql` defines the read-only Postgres role for §3.3 (deploy state env-dependent).

---

## 4. Snapshot candidates vs. must-stay-live

### 4.1 SNAPSHOT-SAFE — read-only display data, written by engine crons, no user input in the query shape

These are the overwhelming majority of runtime reads. All are candidates for a cached/snapshot tier; suggested grouping by natural refresh cadence:

- **Intraday (15 min–hourly upstream):** `ticker_pulse`, `tracked_daily_plays`, `paper_trades`, `sim_stats`, `narrative_analyses` (intraday fill), `v_loudest_stories`, `trade_cards_live`, `v_trade_cards`, `ticker_forecast`, `v_ticker_forecast_horizons`
- **Daily post-scoring:** `v_dash_daily_story`, `narrative_scorecard`, `v_narrative_scorecard_deduped`, `v_dash_narrative_health`, `active_supported`, `active_traps`, `narrative_traps`, `coordination_alerts`, `daily_summaries`, `sector_news`, `momentum_signals`, `v_growth_at_discount`, `v_strategy_plays`, `v_strategy_lane_summary`, `daily_fair_value`, `daily_trade_labels`, `trade_classifications`, `ticker_dark_pool`, `sector_risk_summary`, `v_dash_historical_analogs`, `v_dash_move_drivers`, `macro_narrative_events`, `ticker_reality_belief`, `decay_metrics`, `mv_physics_energy_normalized`, `mv_energy_t_normalized`, `article_signal_price_index`, `keyword_price_impact`, `keyword_industry_signal_modifiers`, `source_scores`, `ticker_strategy_summary`, `benzinga_earnings`, `earnings_context`, `claim_verifications`, `v_claim_trap_screen`, `v_claim_research_verdicts`, `ticker_snapshots`, `bubble_metrics`, `v_narrative_map_daily`, `narrative_ticker_clusters`
- **Slow-moving reference (daily–weekly):** `ticker_industry_lookup`, `ticker_sector_inference`, `v_ticker_universe_search`, `sector_pe_benchmarks`, `v_ticker_pe`, `sector_intelligence`, `scholarly_references`, `ticker_valuation_config`, XBRL set (`xbrl_forensic_factors`, `v_xbrl_redflag_latest_plus`, `v_xbrl_factor_timeline`, `fdq_outcome_labels`, `v_forensic_peers`, `mv_claim_evidence_match`), `blog_posts`
- **Highest-leverage single snapshot:** the **`dashboard-data` edge-function response** — one JSON bundle is the entire dashboard boot. Snapshotting that one payload (plus `ticker_pulse` and the ticker-page hero set) covers most of the user-facing blast radius.

### 4.2 MUST STAY LIVE

| Category | Endpoints | Notes |
|---|---|---|
| Auth/session | `auth/v1/*` (token, user, health), SDK sign-in/up/reset | Cannot snapshot; needs timeouts + a fail-open grace policy for already-authenticated users |
| Billing | `subscriptions` reads, `create-checkout-session`, `create-portal-session`, `repair-subscription`, `stripe-webhook` | Revenue path; the *gate* could honor a stale "was subscribed recently" cache during outages |
| User data writes | `user_watchlists` CRUD, `beta_signups`, `email_signups` | Small; queueable client-side if desired |
| Interactive compute | `dots-predict` RPCs (embedding search), `score-stock`, `anomaly-agent` (REST + RO SQL), RPCs `get_keyword_signal_stats`, `strategy_pub_breakdown` | Parameterized per user input; per-ticker caching possible but not snapshot-able wholesale |
| Best-effort writes (safe to drop in outage) | `search_query_log`, `ai_daily_picks` cache upsert, `ticker_industry_lookup` sync-back | Already fire-and-forget or cache-shaped |
| Known-broken/quirks | `articles` (RLS-on, zero policies → always empty under anon), forensic generators' anon `blog_posts` inserts (403) | Don't build resilience on these until fixed |

---

## 5. Blast-radius ranking (outage = Supabase 500s or hangs)

| # | Surface | Why it ranks here | 500s today | Hang today |
|---|---|---|---|---|
| **1** | **Auth/subscription gate** (`_require-auth`, `session.js`, supabase-js on ticker/pricing/login) | Cross-cutting: fronts `/dashboard`, `/ticker/*`, watchlist, login, checkout. Fails **closed**, no timeout, 30s cache only | Paying users 302'd to `/pricing`; logins fail | Requests hang to Vercel 502/504; login spinner |
| **2** | **`/dashboard` (+black)** | Subscriber home; 100% Supabase (edge-fn boot + ~30 tables); zero client timeouts; blocking `Promise.all` chains | Banner + static demo cards; most tabs silently empty | Spinner/tip-carousel indefinitely |
| **3** | **`/ticker/:t`** | Highest-traffic product page + SEO entry; behind gate (#1). Client itself degrades well (15s, allSettled, lite mode) | Partial hero, hidden panels, lite fallback | Settles in ≤15s except auth gate + search dropdown |
| **4** | **`/` homepage** | Top-of-funnel; shell static + tape is Polygon, but demo/search silently die; conversion demo degraded | Blank widgets, dead search, NVDA fallback demo | Same (no timeouts, but nothing blocks shell) |
| **5** | **Login + Pricing/checkout** | New sessions + revenue. Login has the only good outage UX (6s probe + banner); checkout can hang at Stripe-session creation | Login banner; checkout generic error / wrong sub state | Checkout button spins indefinitely |
| **6** | **Blog + feeds/sitemaps** (`/blog*`, `/author/*`, `feed.xml`, `sitemap.xml`) | Organic/SEO surface; blog list+post are client-rendered from `blog_posts` → truly empty page for crawlers during outage | "No posts"; thin feeds/sitemaps | Spinner indefinitely |
| **7** | **`/stocks/:t` + 3 SEO landing routes** | Organic funnel; SSR with catch→null renders a valid (thinner) page — best server-side degradation | Shell + partial data | Bounded by renderer signal |
| **8** | **`/daily`, `/forensic`, `/search`, `/ask`** | Mid-traffic tools; mostly server-proxied with server-side guards; client spinners lack timeouts | Skeletons / error bubbles / "not screened" | Spinners (server 7–12s guards limit some) |
| **9** | **`/heatmap`, `/traps`+`/herb`, `/signal-charts`, `/narrative-heatmap`** | Static fallback grid, editorial cards, silent-empty helpers, 15s aborts | Degrade gracefully | Bounded (15s) or silent |

---

## 6. Existing resilience assets to build on (and the gaps)

**Assets already in the codebase — extend rather than reinvent:**
1. `sbFetch(table, params, timeoutMs)` 15s-AbortController pattern (`_ticker.html`, `_heatmap.html`, `_signal_lab*`, `_narrative_heatmap.html`) — the obvious primitive to port to `_template.html`, `_daily.html`, `pricing.html`, topbar.
2. `Promise.allSettled` boot pattern (ticker, daily) vs. the dashboard's blocking `Promise.all`.
3. Static fallbacks: heatmap `FALLBACK_TICKERS`, traps editorial slate, homepage NVDA demo, dashboard static demo cards, `/api/light-signals` lite mode.
4. CDN `s-maxage` + `stale-while-revalidate` on `forensic-data`, `constellation`, `hero-summary`, `ticker-day-narratives`, `feed` — Vercel's CDN already serves stale on these during short outages; most other data endpoints just need the same headers.
5. `_login.html`'s `auth/v1/health` probe + maintenance banner — a ready-made outage-detection idiom.
6. `_require-auth`'s 30s subscription cache + 8s-timeout repair call — the hooks exist; the policy (fail-closed, no timeout on the two critical fetches) is the problem.
7. `ai_daily_picks` persistent-cache pattern (DB-backed response cache surviving cold starts).

**Gaps the resilience layer must close (ranked):**
1. No timeout + fail-closed on `auth/v1/user` and `subscriptions` in `_require-auth.js`/`session.js` (locks out paying users).
2. Zero client timeouts and blocking boot chain in `_template.html`/`_template_black.html` (+ single-point `dashboard-data` edge fn with no fallback).
3. No fallback/caching for `blog_posts` rendering (SEO-visible emptiness).
4. Checkout (`create-checkout-session`) unbounded hang.
5. Untimed one-offs: ticker auth gate, ticker/topbar search dropdowns, `_daily.html` loaders, `/forensic` client spinner.
6. No global "Supabase degraded" signal — every page discovers failure independently and mostly silently.

---

*Verification notes: endpoint lists were grep-confirmed against the working tree; per-line behavior (trigger grouping, fallback UI) comes from targeted file reads by the audit passes. ⚠-flagged rows and third-party-labelled endpoints (`scholar`, OG image generators, `ticker-clusters` caching) deserve a quick re-read before you code against them. Prior doc `SUPABASE_INTEGRATION_REPORT.md` (2026-03) is stale — 4 pages, pre-RLS-hardening, pre-Edge-functions.*
