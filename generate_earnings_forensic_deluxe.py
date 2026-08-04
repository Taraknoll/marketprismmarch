#!/usr/bin/env python3
"""
Market Prism — Deluxe Earnings Forensic Report Generator

Long-form (~3,000 word) institutional-grade pre/post-earnings analysis modeled on
the hand-curated RDDT report. Pulls deep historical data from across the Supabase
schema and feeds it to Claude with a strict 27-section structural template.

Runs only for an editorially-curated allowlist of ~8 tickers — names where the
combination of public interest, data depth, and narrative interestingness
justifies the format. Other earnings tickers continue to use the lighter
generate_earnings_forensic.py.

Modes:
  pre   — allowlisted tickers reporting tomorrow (T-1)
  post  — allowlisted tickers whose filing_date in claim_verifications was yesterday
  both  — runs pre then post

Usage:
  python generate_earnings_forensic_deluxe.py --mode both
  python generate_earnings_forensic_deluxe.py --mode pre  --ticker NVDA
  python generate_earnings_forensic_deluxe.py --mode post --dry-run
"""

import argparse
import os
import re
import sys
from datetime import datetime, timezone, timedelta, date
from dotenv import load_dotenv

load_dotenv()

import anthropic
from supabase import create_client

from generate_mp_blog import publish_to_supabase, slugify, get_live_data, MODEL

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
claude = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

# ── DELUXE ALLOWLIST ─────────────────────────────────────────────────────────
# Hand-curated set of tickers that warrant the long-form treatment. Selected on
# 2026-04-30 based on data depth (>=8 earnings quarters, >=200 article outcomes,
# active analyst tracking), public interest (article volume), and narrative
# interestingness (Walsh signal extremity, FVD overshoot, decay-stage stories).
DELUXE_ALLOWLIST = {
    'NVDA',  # Mega-cap AI bellwether — 17,182 articles, 468 analysts, deepest dataset
    'AAPL',  # Mega-cap, perennial earnings event
    'AMD',   # Asymmetric setup — Narrative Trap verdict, FVD overshoot
    'PLTR',  # High retail interest + Coordinated Watch verdict
    'AMAT',  # Semi-cap rebound story, FVD overshoot
    'XOM',   # Energy mega-cap, broad audience
    'DIS',   # Broad audience, regime uncertainty
    'PANW',  # Decay-stage story — Exhausted Narrative + energy 3
}

# ── SHARED PROMPT MATERIAL ───────────────────────────────────────────────────

DELUXE_SYSTEM_PROMPT = """
You are the editorial intelligence behind Market Prism's Intelligence Journal.
You write long-form forensic earnings research — the institutional-grade format
that runs ~3,000 words, anchored to specific data points, and structured like a
sell-side desk note crossed with a forensic investigative piece.

VOICE
- Neutral, precise, forensic — senior equity-research analyst register
- Evidence-first: every claim is anchored to a verifiable data point with a date
- Use phrases like "the most asymmetric setup in...", "the single most important fact",
  "what the data actually shows" to stake out an opinionated structural read
- "Honest" sections that present both sides forensically, not for-and-against debate
- Never sensationalize. Let the data create urgency when it exists.
- Reference specific quarters, specific analysts by firm, specific dates

ABSOLUTE RULES
- Use the EXACT figures provided in the data block. Never invent numbers.
- Never predict the next-day price move. State probabilistic base rates instead.
- Never end with a question. Never write "in conclusion" or "it remains to be seen".
- Never recommend buy/sell/hold. Never use price targets as if they were yours.
- Never cite internal score names ("VMS score 81") — translate into plain language
  ("narrative claims highly verifiable against SEC filings")
- No emoji. No decorative characters. No ALL-CAPS shouting.
- Cite source row counts when given (e.g. "from 462 article outcomes")
- Use markdown tables for every quantitative section

STRUCTURAL TEMPLATE — FOLLOW THIS ORDER
1. Opening paragraph — frame the central pre-print (or post-print) question with
   asymmetry. State what's at stake in one tight paragraph.
2. **Key Diagnostics** — markdown table of headline numbers (earnings date, price,
   fundamental value, consensus, guidance midpoint, options-implied move if available,
   short interest, YTD action, capital return events).
3. **Executive Summary** — one paragraph attesting to data sources and row counts.
   Explicit framing of what the report does NOT do (no prediction).
4. **The single most important fact in this report** — a highlighted callout
   identifying the dominant risk or asymmetry. Use blockquote markdown (>).
5. **The Earnings Track Record** — header.
6. **N-quarter financial scorecard** — markdown table with one row per historical
   quarter: report date, EPS actual, EPS surprise %, revenue surprise %, vs
   guidance midpoint, YoY revenue.
7. **Where the bar sits** — paragraph reading the table: hit rate, average beat
   magnitude, gap between consensus and company guidance.
8. **Post-Earnings Reaction: The Hard Pattern** — header + paragraph framing why
   this is the section traders skip at their peril.
9. **All N prints reaction table** — markdown table: quarter, pre-60d return, +1d,
   +5d, +20d returns, setup descriptor.
10. **Patterns that actually exist in the data** — bulleted list of statistical
    observations (next-day average, dispersion, what predicts what).
11. **Cautionary tales** — 2-paragraph specific historical analogs from the data,
    naming quarters and dates.
12. **The Business Under the Hood** — header + most-recent-quarter scorecard table.
13. **Valuation in context** — markdown comparison table (PE, PS, growth, vs
    industry/sector benchmarks). One paragraph reading.
14. **The Analyst Landscape** — header + summary of analyst tracking signal.
    Reference analyst_edge / hit-rate / consistency from the data — do NOT invent
    specific dated PT changes.
15. **Aggregate read + dispersion** — describe the spread of analyst opinion.
16. **The dominant structural question** — pick the single biggest narrative
    overhang specific to this ticker (replaces RDDT's "metric reporting change"
    section). Use what the narrative_state, scorecard.narrative, and forensic
    rebuttal data point at.
17. **Market Prism Forensic Diagnostics** — markdown table of current Walsh
    engine readings (FVD, energy remaining, Walsh regime, coordination class,
    sector regime, market regime, active trade signal). Translate into plain
    English in the right column.
18. **Behavioral pattern from N historical articles** — using the article_outcomes
    aggregation provided. Cite N, average returns at 5d/10d/20d by sentiment.
19. **Positioning & Flow** — short interest + dark pool tables.
20. **The Honest Bull Case** — bulleted list, ≥6 items, each anchored to data.
21. **The Honest Bear Case** — bulleted list, ≥6 items, each anchored to data.
22. **What to Actually Watch When the Print Drops** — numbered list, 4-6 items
    in priority order. Each item names a specific metric and a threshold.
23. **The Final Read** — 2-3 paragraph synthesis. Identify the structural case
    AND the tactical risk separately. State both can be true.
24. **The honest probabilistic framework** — bulleted list of calibrated
    probabilities (beat probability based on hit rate, +1d positive reaction
    probability based on historical base rate, etc.). Use approximate ranges,
    never point estimates.
25. **What this is not** — short paragraph: not a recommendation, not a prediction.
26. **Beta Disclosure & Methodology** — paragraph naming the active signal's
    backtest classification (CONFIRMED / PARTIAL / UNVERIFIABLE per
    signal_backtest_registry), discussing claimed vs reproduced metrics, and
    closing with a data-sources attestation listing the specific row counts.

LENGTH TARGET: 2,500–3,500 words. Use markdown headers (##, ###), tables, blockquotes.
"""

PRE_FRAME = """
This is a PRE-EARNINGS FORENSIC REPORT — published the day before the print.
The central question: what is the structural setup? The asymmetric framing should
be "going long requires X, going short requires Y" where X and Y are observable
data points, not narrative speculation.
"""

POST_FRAME = """
This is a POST-EARNINGS FORENSIC REPORT — published the day after the print.
The central question: what did the print reveal about the underlying narrative?
Frame the asymmetric outcome — what was confirmed, what was broken, what surprised.
The "single most important fact" should identify the line item that drove (or
will drive) the price reaction, not just the headline EPS beat/miss.
"""

# ── DATA FETCHER ─────────────────────────────────────────────────────────────

def _safe_one(table: str, **filters):
    """Fetch latest row matching filters by snapshot_date desc, or empty dict."""
    try:
        q = supabase.table(table).select("*")
        for k, v in filters.items():
            q = q.eq(k, v)
        # Try snapshot_date first, fall back to other date columns
        try:
            r = q.order("snapshot_date", desc=True).limit(1).execute().data or []
        except Exception:
            r = q.limit(1).execute().data or []
        return r[0] if r else {}
    except Exception as e:
        print(f"    ⚠ {table} fetch failed: {e}")
        return {}


def _safe_many(table: str, limit: int = 100, order: str = None, **filters):
    try:
        q = supabase.table(table).select("*")
        for k, v in filters.items():
            q = q.eq(k, v)
        if order:
            q = q.order(order, desc=True)
        return q.limit(limit).execute().data or []
    except Exception as e:
        print(f"    ⚠ {table} multi-fetch failed: {e}")
        return []


def _parse_date(s):
    if not s:
        return None
    if isinstance(s, date):
        return s
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def fetch_deluxe_context(ticker: str) -> dict:
    """Pull the deep context required for a deluxe report."""
    print(f"    → Fetching deluxe context for {ticker}...")

    # Latest snapshots
    scorecard = _safe_one("narrative_scorecard", ticker=ticker)
    earnings_ctx = _safe_one("earnings_context", ticker=ticker)
    claim_v = _safe_one("claim_verifications", ticker=ticker)
    story = _safe_one("v_dash_daily_story", ticker=ticker)
    signature = _safe_one("ticker_signatures", ticker=ticker)
    strategy = _safe_one("ticker_strategy_summary", ticker=ticker)
    fair_value = _safe_one("daily_fair_value", ticker=ticker)

    # Historical earnings (12 quarters)
    earnings_hist = _safe_many("benzinga_earnings", limit=12, order="date", ticker=ticker)
    earnings_hist = [e for e in earnings_hist if e.get("actual_eps") is not None]

    # Guidance history (8 records)
    guidance_hist = _safe_many("benzinga_guidance", limit=8, order="date", ticker=ticker)

    # 14 sessions of short + dark pool
    short_hist = _safe_many("ticker_short_data", limit=14, order="settlement_date", ticker=ticker)
    dark_hist = _safe_many("ticker_dark_pool", limit=14, order="sample_date", ticker=ticker)

    # Article outcomes — last 1000 by date for sentiment aggregation
    article_outcomes = _safe_many("article_outcomes", limit=1000, order="published_at", ticker=ticker)

    # Historical analogs (5 most recent)
    analogs = _safe_many("v_dash_historical_analogs", limit=5, order="snapshot_date", ticker=ticker)

    # Market + sector regime (latest)
    market_regime = {}
    sector_regime = {}
    try:
        mr = supabase.table("market_regime_log").select("*").order("date", desc=True).limit(1).execute().data or []
        market_regime = mr[0] if mr else {}
    except Exception:
        pass
    try:
        sec = (signature or {}).get("sector") or (story or {}).get("sector_name")
        if sec:
            sr = supabase.table("sector_regime_log").select("*").eq("sector", sec).order("date", desc=True).limit(1).execute().data or []
            sector_regime = sr[0] if sr else {}
    except Exception:
        pass

    # Signal backtest registry — full 24 rows for the methodology block
    backtest_registry = []
    try:
        backtest_registry = supabase.table("signal_backtest_registry").select(
            "signal_name,signal_label,signal_type,signal_validity,claimed_obs,claimed_win_rate,claimed_ann_sharpe,repro_obs,repro_win_rate,repro_ann_sharpe,discrepancy_note"
        ).limit(30).execute().data or []
    except Exception:
        pass

    # Card prediction — current active trade signal
    card_pred = {}
    try:
        cp = supabase.table("card_predictions").select(
            "primary_label,direction,confidence,price_at_prediction,fair_value_at_prediction,advanced_verdict,signal_regime,trade_score,timeframe,holding_days"
        ).eq("ticker", ticker).order("prediction_date", desc=True).limit(1).execute().data or []
        card_pred = cp[0] if cp else {}
    except Exception:
        pass

    # Historical prices for post-earnings reaction calculation
    # ~800 trading days (~3 years) is enough for 12 quarters of reactions
    prices = []
    try:
        prices = supabase.table("ticker_prices").select("date,close").eq(
            "ticker", ticker
        ).order("date", desc=True).limit(800).execute().data or []
    except Exception as e:
        print(f"    ⚠ ticker_prices fetch failed: {e}")

    # Compute earnings reactions in Python
    reactions = compute_earnings_reactions(earnings_hist, prices)

    # Aggregate article outcomes by sentiment
    article_agg = aggregate_article_outcomes(article_outcomes)

    return {
        "ticker": ticker,
        "scorecard": scorecard,
        "earnings_context": earnings_ctx,
        "claim_verifications": claim_v,
        "story": story,
        "signature": signature,
        "strategy": strategy,
        "daily_fair_value": fair_value,
        "earnings_history": earnings_hist,
        "earnings_reactions": reactions,
        "guidance_history": guidance_hist,
        "short_history": short_hist,
        "dark_history": dark_hist,
        "article_outcomes_aggregate": article_agg,
        "article_outcomes_total": len(article_outcomes),
        "historical_analogs": analogs,
        "market_regime": market_regime,
        "sector_regime": sector_regime,
        "backtest_registry": backtest_registry,
        "card_prediction": card_pred,
        "ticker_prices_sampled": len(prices),
    }


def compute_earnings_reactions(earnings_hist: list, prices: list) -> list:
    """For each earnings date, compute pre-60d / +1d / +5d / +20d returns from prices."""
    if not prices or not earnings_hist:
        return []

    # Build sorted-ascending date → close map
    by_date = {}
    for p in prices:
        d = _parse_date(p.get("date"))
        c = p.get("close")
        if d and c is not None:
            by_date[d] = float(c)
    sorted_dates = sorted(by_date.keys())
    if not sorted_dates:
        return []

    def find_at_or_before(target):
        # Latest date <= target
        for d in reversed(sorted_dates):
            if d <= target:
                return by_date[d]
        return None

    def find_at_or_after(target):
        for d in sorted_dates:
            if d >= target:
                return by_date[d]
        return None

    out = []
    for e in earnings_hist:
        ed = _parse_date(e.get("date"))
        if not ed:
            continue
        p_at = find_at_or_before(ed)
        # Calendar-day approximations: 60 trading days ≈ 90 calendar days
        p_minus_60 = find_at_or_before(ed - timedelta(days=90))
        p_plus_1 = find_at_or_after(ed + timedelta(days=1))
        p_plus_5 = find_at_or_after(ed + timedelta(days=8))
        p_plus_20 = find_at_or_after(ed + timedelta(days=30))
        if not p_at:
            continue
        out.append({
            "earnings_date": ed.isoformat(),
            "fiscal_period": e.get("fiscal_period"),
            "fiscal_year": e.get("fiscal_year"),
            "pre_60d_pct": ((p_at / p_minus_60) - 1) * 100 if p_minus_60 else None,
            "plus_1d_pct": ((p_plus_1 / p_at) - 1) * 100 if p_plus_1 else None,
            "plus_5d_pct": ((p_plus_5 / p_at) - 1) * 100 if p_plus_5 else None,
            "plus_20d_pct": ((p_plus_20 / p_at) - 1) * 100 if p_plus_20 else None,
        })
    return out


def aggregate_article_outcomes(rows: list) -> dict:
    """Group article_outcomes by sentiment_direction → counts + average returns."""
    buckets = {"positive": [], "negative": [], "neutral": []}
    for r in rows:
        sd = r.get("sentiment_direction")
        if sd is None:
            continue
        key = "positive" if sd > 0 else "negative" if sd < 0 else "neutral"
        buckets[key].append(r)

    def avg(lst, field):
        vals = [x.get(field) for x in lst if x.get(field) is not None]
        return sum(vals) / len(vals) if vals else None

    out = {}
    for label, lst in buckets.items():
        out[label] = {
            "n": len(lst),
            "avg_5d": avg(lst, "return_5d"),
            "avg_10d": avg(lst, "return_10d"),
            "avg_20d": avg(lst, "return_20d"),
        }
    return out


# ── PROMPT BUILDER ───────────────────────────────────────────────────────────

def _f(v, default="N/A", suffix=""):
    if v is None or v == "":
        return default
    if isinstance(v, float):
        return f"{v:,.2f}{suffix}"
    return f"{v}{suffix}"


def _fpct(v, default="N/A", signed=True):
    if v is None or v == "":
        return default
    try:
        return f"{float(v):+.2f}%" if signed else f"{float(v):.2f}%"
    except Exception:
        return default


def _fdollar(v, default="N/A"):
    if v is None or v == "":
        return default
    try:
        return f"${float(v):,.2f}"
    except Exception:
        return default


def _fbn(v, default="N/A"):
    """Format a big integer as $X.XB."""
    if v is None or v == "":
        return default
    try:
        return f"${float(v) / 1e9:,.2f}B"
    except Exception:
        return default


def _fiscal(period, year):
    if not period and not year:
        return "—"
    return f"{period or '?'} {year or ''}".strip()


def render_earnings_history_block(ctx: dict) -> str:
    rows = ctx.get("earnings_history", []) or []
    if not rows:
        return "  No historical earnings data available.\n"
    lines = ["Quarter | Report Date | EPS Actual | EPS Surprise % | Revenue Actual | Revenue Surprise %"]
    for e in rows:
        lines.append(
            f"  {_fiscal(e.get('fiscal_period'), e.get('fiscal_year'))} | "
            f"{e.get('date', '?')} | "
            f"{_f(e.get('actual_eps'))} | "
            f"{_fpct(e.get('eps_surprise_percent'))} | "
            f"{_fbn(e.get('actual_revenue'))} | "
            f"{_fpct(e.get('revenue_surprise_percent'))}"
        )
    return "\n".join(lines)


def render_reactions_block(ctx: dict) -> str:
    reactions = ctx.get("earnings_reactions") or []
    if not reactions:
        return "  No reaction history available.\n"
    lines = ["Quarter | Report Date | Pre-60d % | +1d % | +5d % | +20d %"]
    for r in reactions:
        lines.append(
            f"  {_fiscal(r.get('fiscal_period'), r.get('fiscal_year'))} | "
            f"{r.get('earnings_date')} | "
            f"{_fpct(r.get('pre_60d_pct'))} | "
            f"{_fpct(r.get('plus_1d_pct'))} | "
            f"{_fpct(r.get('plus_5d_pct'))} | "
            f"{_fpct(r.get('plus_20d_pct'))}"
        )
    return "\n".join(lines)


def render_short_history(ctx: dict) -> str:
    rows = ctx.get("short_history", []) or []
    if not rows:
        return "  No short interest history available.\n"
    lines = ["Settlement Date | Short Interest | Days to Cover | Short Vol Ratio (5d avg) | Pressure"]
    for r in rows[:10]:
        lines.append(
            f"  {r.get('settlement_date', '?')} | "
            f"{_f(r.get('short_interest'))} | "
            f"{_f(r.get('days_to_cover'))} | "
            f"{_fpct(r.get('short_volume_ratio_5d_avg'), signed=False)} | "
            f"{r.get('short_pressure', 'N/A')}"
        )
    return "\n".join(lines)


def render_dark_history(ctx: dict) -> str:
    rows = ctx.get("dark_history", []) or []
    if not rows:
        return "  No dark pool history available.\n"
    lines = ["Sample Date | Dark Pool % Volume | Smart Money Direction | Signal"]
    for r in rows[:10]:
        lines.append(
            f"  {r.get('sample_date', '?')} | "
            f"{_fpct(r.get('dark_pool_pct_volume'), signed=False)} | "
            f"{r.get('smart_money_direction', 'N/A')} | "
            f"{r.get('dark_pool_signal', 'N/A')}"
        )
    return "\n".join(lines)


def render_article_outcomes(ctx: dict) -> str:
    agg = ctx.get("article_outcomes_aggregate", {})
    total = ctx.get("article_outcomes_total", 0)
    if not agg or not total:
        return "  Insufficient article outcome data.\n"
    lines = [f"Aggregated from {total:,} historical articles for this ticker:"]
    lines.append("Sentiment | N | Avg 5d Return | Avg 10d Return | Avg 20d Return")
    for label in ("positive", "negative", "neutral"):
        b = agg.get(label, {})
        if not b.get("n"):
            continue
        lines.append(
            f"  {label} | {b.get('n')} | "
            f"{_fpct(b.get('avg_5d'))} | "
            f"{_fpct(b.get('avg_10d'))} | "
            f"{_fpct(b.get('avg_20d'))}"
        )
    return "\n".join(lines)


def render_walsh_diagnostics(ctx: dict) -> str:
    sc = ctx.get("scorecard", {}) or {}
    cp = ctx.get("card_prediction", {}) or {}
    mr = ctx.get("market_regime", {}) or {}
    sr = ctx.get("sector_regime", {}) or {}
    sig = ctx.get("signature", {}) or {}
    lines = ["Diagnostic | Reading"]
    lines.append(f"  FVD (fundamental value divergence) | {_fpct(sc.get('fvd_pct'))}")
    lines.append(f"  Verdict | {sc.get('verdict', 'N/A')}")
    lines.append(f"  Narrative state | {sc.get('narrative_state', 'N/A')}")
    lines.append(f"  Energy remaining | {_f(sc.get('energy_remaining'))}")
    lines.append(f"  Walsh regime | {sc.get('walsh_regime', 'N/A')}")
    lines.append(f"  Half-life (days) | {_f(sc.get('half_life'))}")
    lines.append(f"  Coordination class | {sc.get('coordination_class', 'N/A')}")
    lines.append(f"  Coordination score | {_f(sc.get('coordination_score'))}")
    lines.append(f"  NRS | {_f(sc.get('nrs'))}")
    lines.append(f"  VMS (verifiability) | {_f(sc.get('vms'))}")
    lines.append(f"  Drift score | {_f(sc.get('drift_score'))}")
    lines.append(f"  Days to cover | {_f(sc.get('days_to_cover'))}")
    lines.append(f"  Dark pool signal | {sc.get('dark_pool_signal', 'N/A')} / direction: {sc.get('dark_pool_direction', 'N/A')}")
    lines.append(f"  Active trade | {cp.get('primary_label', 'N/A')} {cp.get('direction', '')} (conf {_f(cp.get('confidence'))})")
    lines.append(f"  Active trade entry/exit | entry {_fdollar(cp.get('price_at_prediction'))}, target {_fdollar(cp.get('fair_value_at_prediction'))}, hold {_f(cp.get('holding_days'))}d")
    lines.append(f"  Sector regime | {sr.get('regime_class', 'N/A')} (confidence {_f(sr.get('regime_confidence'))})")
    lines.append(f"  Market regime | {mr.get('market_regime', 'N/A')} | VIX {_f(mr.get('vix_close'))} | SPY 20d {_fpct(mr.get('spy_trend_20d'))}")
    lines.append(f"  Earnings beat rate (historical) | {_fpct(sig.get('earnings_beat_rate'), signed=False)}")
    lines.append(f"  Catalyst avg move | {_fpct(sig.get('catalyst_avg_move'))} over {_f(sig.get('catalyst_avg_duration'))} days")
    return "\n".join(lines)


def render_backtest_registry(ctx: dict) -> str:
    rows = ctx.get("backtest_registry", []) or []
    cp = ctx.get("card_prediction", {}) or {}
    active_label = (cp.get("primary_label") or "").lower()
    # Find active signal first, then a few others for context
    primary = None
    others = []
    for r in rows:
        name = (r.get("signal_name") or "").lower()
        if active_label and active_label in name:
            primary = r
        else:
            others.append(r)
    selected = ([primary] if primary else []) + others[:4]
    lines = ["Signal | Validity | Claimed Win Rate | Reproduced Win Rate | Note"]
    for r in selected:
        if not r:
            continue
        lines.append(
            f"  {r.get('signal_label') or r.get('signal_name', 'N/A')} | "
            f"{r.get('signal_validity', 'N/A')} | "
            f"{_fpct(r.get('claimed_win_rate'), signed=False)} | "
            f"{_fpct(r.get('repro_win_rate'), signed=False)} | "
            f"{(r.get('discrepancy_note') or '')[:80]}"
        )
    return "\n".join(lines)


def render_guidance(ctx: dict) -> str:
    rows = ctx.get("guidance_history", []) or []
    if not rows:
        return "  No guidance history available.\n"
    lines = ["Date | Fiscal Period | EPS Guide (min/mid/max) | Revenue Guide (min/mid/max) | Direction"]
    for r in rows[:6]:
        eps_mid = r.get("estimated_eps_guidance")
        eps_min = r.get("min_eps_guidance")
        eps_max = r.get("max_eps_guidance")
        rev_mid = r.get("estimated_revenue_guidance")
        rev_min = r.get("min_revenue_guidance")
        rev_max = r.get("max_revenue_guidance")
        eps_str = f"{_f(eps_min)} / {_f(eps_mid)} / {_f(eps_max)}"
        rev_str = f"{_fbn(rev_min)} / {_fbn(rev_mid)} / {_fbn(rev_max)}"
        lines.append(
            f"  {r.get('date', '?')} | "
            f"{_fiscal(r.get('fiscal_period'), r.get('fiscal_year'))} | "
            f"{eps_str} | {rev_str} | "
            f"{r.get('guidance_direction', 'N/A')}"
        )
    return "\n".join(lines)


def render_strategy_block(ctx: dict) -> str:
    s = ctx.get("strategy", {}) or {}
    if not s:
        return "  No strategy summary available.\n"
    lines = []
    if s.get("strategy_summary"):
        lines.append(f"Strategy summary: {s['strategy_summary']}")
    if s.get("narrative_behavior"):
        lines.append(f"Narrative behavior: {s['narrative_behavior']}")
    if s.get("most_influential_theme"):
        lines.append(f"Most influential theme: {s['most_influential_theme']}")
    if s.get("top_positive_publication"):
        lines.append(f"Top positive publication: {s['top_positive_publication']}")
    if s.get("top_negative_publication"):
        lines.append(f"Top negative publication: {s['top_negative_publication']}")
    if s.get("best_historical_entry_zone"):
        lines.append(f"Best historical entry zone: {s['best_historical_entry_zone']}")
    return "\n".join(lines) if lines else "  No strategy detail available.\n"


def build_deluxe_prompt(ctx: dict, live: dict, target_date: str, mode: str) -> tuple[str, str]:
    ticker = ctx["ticker"]
    sc = ctx.get("scorecard", {}) or {}
    ec = ctx.get("earnings_context", {}) or {}
    cv = ctx.get("claim_verifications", {}) or {}
    story = ctx.get("story", {}) or {}
    fv = ctx.get("daily_fair_value", {}) or {}
    sig = ctx.get("signature", {}) or {}

    frame = PRE_FRAME if mode == "pre" else POST_FRAME

    # Pre-rendered data blocks (so Claude doesn't have to do format gymnastics)
    earnings_block = render_earnings_history_block(ctx)
    reactions_block = render_reactions_block(ctx)
    short_block = render_short_history(ctx)
    dark_block = render_dark_history(ctx)
    articles_block = render_article_outcomes(ctx)
    walsh_block = render_walsh_diagnostics(ctx)
    backtest_block = render_backtest_registry(ctx)
    guidance_block = render_guidance(ctx)
    strategy_block = render_strategy_block(ctx)

    headlines = ""
    for h in (live.get("headlines") or [])[:6]:
        pub = f" [{h['publisher']}]" if h.get("publisher") else ""
        headlines += f"  - {h.get('title', '')}{pub}\n"

    fiscal = cv.get("benzinga_fiscal_period") or "Latest Quarter"

    prompt = f"""
DELUXE EARNINGS FORENSIC REPORT — GENERATION REQUEST
=====================================================
TICKER: {ticker}
MODE: {mode.upper()}
{"EARNINGS DATE" if mode == "pre" else "PRINT DATE"}: {target_date}
PUBLICATION DATE: {datetime.now().strftime('%B %d, %Y')}
LAST REPORTED FISCAL PERIOD: {fiscal}

{frame}

LIVE MARKET DATA (use these exact figures)
-------------------------------------------
Price:               {_fdollar(live.get('price'))} ({_fpct(live.get('change_pct'))})
Market cap:          ${live.get('market_cap_bn') or 'N/A'}B
P/E (trailing):      {_f(live.get('pe_trailing'))}
Short % float:       {_fpct(live.get('short_pct_float'), signed=False)}
52-week return:      {_fpct(live.get('return_52w_pct'))}
Revenue (TTM):       ${live.get('revenue_ttm_bn') or 'N/A'}B

NARRATIVE INTELLIGENCE (translate to plain English in the article)
------------------------------------------------------------------
Prevailing narrative: {sc.get('narrative', 'N/A')}
Narrative state: {sc.get('narrative_state', 'N/A')}
Current sentiment: {_f(sc.get('current_sentiment'))}
Internal verdict: {sc.get('verdict', 'N/A')}
Story claim: {story.get('story_claim', 'N/A')}
Forensic rebuttal: {story.get('forensic_rebuttal', 'N/A')}
Institutional positioning: {story.get('institutional_positioning', 'N/A')}
Fundamental value (daily_fair_value): {_fdollar(fv.get('fair_value'))} (low {_fdollar(fv.get('fv_low'))}, high {_fdollar(fv.get('fv_high'))})
Fundamental value method: {fv.get('method', 'N/A')}
Fundamental value verdict: {fv.get('verdict', 'N/A')}

SECTOR / INDUSTRY
-----------------
Sector: {sig.get('sector') or story.get('sector_name', 'N/A')}
Industry: {sig.get('industry', 'N/A')}

EARNINGS HISTORY (use for the N-quarter scorecard table — section 6)
--------------------------------------------------------------------
{earnings_block}

GUIDANCE HISTORY (use to frame the bar — section 7)
---------------------------------------------------
{guidance_block}

POST-EARNINGS REACTION HISTORY (use for the reaction table — section 9)
-----------------------------------------------------------------------
{reactions_block}

SHORT INTEREST HISTORY (use for positioning section — section 19)
-----------------------------------------------------------------
{short_block}

DARK POOL FLOW HISTORY (use for positioning section — section 19)
-----------------------------------------------------------------
{dark_block}

ARTICLE BEHAVIORAL PATTERN (use for section 18)
-----------------------------------------------
{articles_block}

MARKET PRISM FORENSIC DIAGNOSTICS (use for section 17 — translate, don't quote scores raw)
------------------------------------------------------------------------------------------
{walsh_block}

SIGNAL BACKTEST REGISTRY (use for section 26 — beta methodology)
----------------------------------------------------------------
{backtest_block}

TICKER STRATEGY CONTEXT (background colour — use selectively)
-------------------------------------------------------------
{strategy_block}

RECENT HEADLINES (background colour — use sparingly)
----------------------------------------------------
{headlines if headlines else '  No headlines retrieved.'}

DATA SOURCE ATTESTATION (cite these counts in section 3 + section 26)
---------------------------------------------------------------------
- public.articles: 157,957 articles across all tickers
- public.polygon_articles: 449,333 secondary article corpus back to 2016
- public.article_outcomes: 147,972 articles each tagged with realized 5/10/20d returns
- public.decay_metrics: 18,982 Walsh decay records
- public.ticker_prices: 1,041,173 daily price observations across 1,110 tickers
- This ticker specifically: {ctx.get('article_outcomes_total', 0)} article outcomes, {len(ctx.get('earnings_history', []))} historical earnings prints, {ctx.get('ticker_prices_sampled', 0)} daily price observations sampled

INSTRUCTIONS
------------
Write the deluxe forensic report on {ticker} following the 27-section structural
template in your system prompt. Target 2,500–3,500 words. Use markdown.

Required:
- Open with an asymmetric framing paragraph
- Build EVERY structured section as a markdown table where the data supports it
- The "single most important fact" must be a blockquote and must identify a
  specific, named risk or asymmetry — not a generic statement
- The cautionary tales must reference specific historical quarters by name and
  cite the exact reaction returns from the data above
- The probabilistic framework must be calibrated to the historical base rate
  (e.g. "8 of 8 quarters beat → very high beat probability")
- Section 26 must cite the SPECIFIC active signal's classification + claimed vs
  reproduced metrics from the backtest registry above
- Close with the data-sources attestation listing the row counts above

Output the article TITLE on the first line as: ## [Title]
Then the article body in markdown. Nothing else.
""".strip()

    return prompt


# ── ARTICLE GENERATION ───────────────────────────────────────────────────────

def call_claude(user_prompt: str) -> tuple[str, str]:
    response = claude.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=DELUXE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    full = response.content[0].text.strip()
    title = ""
    body = full
    # Strip only the first ## title line
    lines = full.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("## "):
            title = line.lstrip("# ").strip()
            body = "\n".join(lines[i + 1:]).strip()
            break
    return title, body


def fiscal_label_slug(fiscal: str) -> str:
    """Convert '2026Q1' / 'Q1 2026' to 'q1-2026' for slug use."""
    if not fiscal:
        return "earnings"
    s = str(fiscal).strip().upper()
    m = re.match(r"^(\d{4})Q([1-4])$", s)
    if m:
        return f"q{m.group(2)}-{m.group(1)}"
    return re.sub(r"[^\w]+", "-", fiscal.lower()).strip("-")


# ── TICKER SELECTION ─────────────────────────────────────────────────────────

def pre_tickers(target_date: str) -> list[str]:
    """Allowlisted tickers reporting on target_date."""
    try:
        rows = supabase.table("earnings_context").select("ticker, snapshot_date").eq(
            "next_earnings_date", target_date
        ).order("snapshot_date", desc=True).limit(500).execute().data or []
    except Exception as e:
        print(f"  ⚠ earnings_context fetch failed: {e}")
        return []
    seen, out = set(), []
    for r in rows:
        t = r["ticker"]
        if t in seen:
            continue
        seen.add(t)
        if t in DELUXE_ALLOWLIST:
            out.append(t)
    return out


def post_tickers(filing_date: str) -> list[str]:
    """Allowlisted tickers whose latest filing_date matches filing_date."""
    try:
        rows = supabase.table("claim_verifications").select(
            "ticker, snapshot_date"
        ).eq("filing_date", filing_date).order("snapshot_date", desc=True).limit(500).execute().data or []
    except Exception as e:
        print(f"  ⚠ claim_verifications fetch failed: {e}")
        return []
    seen, out = set(), []
    for r in rows:
        t = r["ticker"]
        if t in seen:
            continue
        seen.add(t)
        if t in DELUXE_ALLOWLIST:
            out.append(t)
    return out


# ── MAIN ─────────────────────────────────────────────────────────────────────

def run(mode: str, target_date: str, ticker_filter: str = None, dry_run: bool = False, limit: int = None) -> int:
    print(f"\n[Deluxe {mode}] Target date: {target_date}")
    if ticker_filter:
        if ticker_filter.upper() not in DELUXE_ALLOWLIST:
            print(f"  → Ticker {ticker_filter} not in DELUXE_ALLOWLIST, skipping.")
            return 0
        tickers = [ticker_filter.upper()]
    else:
        tickers = pre_tickers(target_date) if mode == "pre" else post_tickers(target_date)

    if not tickers:
        print(f"  → No allowlisted tickers qualify for {mode} on {target_date}.")
        return 0
    if limit:
        tickers = tickers[:limit]
    print(f"  → {len(tickers)} ticker(s) to process: {tickers}")

    written = 0
    for ticker in tickers:
        try:
            print(f"\n  ── {ticker} ({mode}) ──")
            ctx = fetch_deluxe_context(ticker)
            live = get_live_data(ticker)
            user_prompt = build_deluxe_prompt(ctx, live, target_date, mode)

            print(f"    → Calling Claude (model {MODEL}, max_tokens 8000)...")
            title, body = call_claude(user_prompt)
            if not title:
                fis = (ctx.get("claim_verifications") or {}).get("benzinga_fiscal_period") or "Earnings"
                title = f"{ticker} — {'Pre-Earnings' if mode == 'pre' else 'Post-Earnings'} Forensic Report ({fis})"
            print(f"    → Title: {title}")
            print(f"    → Body: {len(body)} chars (~{len(body.split())} words)")

            fiscal = (ctx.get("claim_verifications") or {}).get("benzinga_fiscal_period")
            quarter_slug = fiscal_label_slug(fiscal)
            mode_slug = "pre-earnings-forensic" if mode == "pre" else "post-earnings-forensic"
            slug = f"{datetime.now().strftime('%Y-%m-%d')}-{ticker.lower()}-{quarter_slug}-{mode_slug}"

            tag = "Earnings" if mode == "pre" else "Post-Earnings"
            result = publish_to_supabase(
                ticker=ticker,
                title=title,
                body=body,
                ctx={"verdict": tag},
                dry_run=dry_run,
                slug_override=slug,
                tag_override=tag,
                author="Reed Calloway",
            )
            if result.get("success"):
                written += 1
        except Exception as e:
            print(f"    ✗ {ticker} failed: {e}")
            import traceback; traceback.print_exc()
    return written


def main():
    p = argparse.ArgumentParser(description="Deluxe pre/post-earnings forensic generator")
    p.add_argument("--mode", choices=["pre", "post", "both"], default="both")
    p.add_argument("--ticker", help="Single ticker (must be in DELUXE_ALLOWLIST)")
    p.add_argument("--target-date", help="Override (YYYY-MM-DD). Default: tomorrow for pre, yesterday for post")
    p.add_argument("--limit", type=int, help="Cap tickers per mode")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    print(f"\n[Deluxe Earnings Forensic Generator] {datetime.now().strftime('%Y-%m-%d %H:%M ET')}")
    print(f"  Allowlist ({len(DELUXE_ALLOWLIST)}): {sorted(DELUXE_ALLOWLIST)}")

    today = date.today()
    pre_target = args.target_date or (today + timedelta(days=1)).isoformat()
    post_target = args.target_date or (today - timedelta(days=1)).isoformat()

    pre_n = post_n = 0
    if args.mode in ("pre", "both"):
        pre_n = run("pre", pre_target, ticker_filter=args.ticker, dry_run=args.dry_run, limit=args.limit)
    if args.mode in ("post", "both"):
        post_n = run("post", post_target, ticker_filter=args.ticker, dry_run=args.dry_run, limit=args.limit)

    total = pre_n + post_n
    print(f"\n✓ Done. Wrote {pre_n} pre + {post_n} post = {total} total deluxe reports.\n")

    out = os.environ.get("GITHUB_OUTPUT", "")
    if out:
        with open(out, "a") as f:
            f.write(f"pre_count={pre_n}\n")
            f.write(f"post_count={post_n}\n")
            f.write(f"total_count={total}\n")


if __name__ == "__main__":
    main()
