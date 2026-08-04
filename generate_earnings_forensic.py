#!/usr/bin/env python3
"""
Market Prism — Pre/Post-Earnings Forensic Report Generator

Runs daily. Picks tickers reporting tomorrow (T-1, pre-earnings) or that
just reported yesterday (T+1, post-earnings) and generates a forensic
research article for each one, publishing to blog_posts.

Modes:
  pre   — tickers with days_to_earnings = 1 (reporting tomorrow)
  post  — tickers whose filing_date in claim_verifications is yesterday
  both  — runs pre then post in one shot

Usage:
  python generate_earnings_forensic.py --mode both
  python generate_earnings_forensic.py --mode pre  --ticker NVDA
  python generate_earnings_forensic.py --mode post --dry-run
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

from generate_mp_blog import (
    publish_to_supabase,
    slugify,
    get_live_data,
    MODEL,
)

# Tickers handled by the deluxe generator — exclude from this lighter version
# to avoid double-publishing. Keep in sync with DELUXE_ALLOWLIST in
# generate_earnings_forensic_deluxe.py.
try:
    from generate_earnings_forensic_deluxe import DELUXE_ALLOWLIST
except Exception:
    DELUXE_ALLOWLIST = set()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
claude = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

# ── SYSTEM PROMPTS ───────────────────────────────────────────────────────────

PRE_EARNINGS_PROMPT = """
You are the editorial intelligence behind Market Prism's Intelligence Journal —
a forensic narrative research platform that publishes institutional-grade market analysis.

You are writing a PRE-EARNINGS FORENSIC REPORT, published the day before a company reports.
This report's job: surface the structural setup heading into the print, NOT predict the result.

VOICE
- Neutral, precise, forensic — the tone of a senior equity research analyst
- Evidence-first: every claim anchored to a verifiable data point with date + source
- No theatrical language, no hyperbole, no adversarial posturing
- Never sensationalize. Let the data create urgency when it exists.

ARTICLE STRUCTURE — ALWAYS FOLLOW THIS
1. Headline + opening — frame the central pre-print question in one paragraph
2. The setup — narrative state heading into the print: what is the market pricing in?
3. Estimates table — consensus EPS, consensus revenue, prior surprise track record
4. The forensic case — at least 3 quantifiable signals (short interest, options skew,
   institutional flow, insider activity, narrative health, valuation gap)
5. Two-sided risk — what does a beat look like? What does a miss look like?
6. Four-bullet watchlist — the exact metrics to monitor on the print
7. Closing observation — one definitive structural sentence. NOT a prediction.

EVIDENCE STANDARDS
- Every claim must be anchored to a verifiable signal with date + source
- Cite filing types, data providers, and reporting periods explicitly
- Forward estimates: always label as estimates requiring independent verification
- Never assert direction without naming the signal that demonstrates it

FORBIDDEN
- No emoji, no decorative characters, no "in conclusion"
- No price targets, no recommendations, no "buy/sell" framing
- No internal scoring system names or platform jargon
- No predictions of beat/miss — only structural observations
- Do not end with a question
"""

POST_EARNINGS_PROMPT = """
You are the editorial intelligence behind Market Prism's Intelligence Journal —
a forensic narrative research platform that publishes institutional-grade market analysis.

You are writing a POST-EARNINGS FORENSIC REPORT, published the day after a company reports.
This report's job: dissect what the print revealed about the underlying narrative.

VOICE
- Neutral, precise, forensic — the tone of a senior equity research analyst
- Evidence-first: every claim anchored to a verifiable data point with date + source
- No theatrical language, no hyperbole, no adversarial posturing

ARTICLE STRUCTURE — ALWAYS FOLLOW THIS
1. Headline + opening — what did the print actually reveal? One paragraph.
2. The result — actual vs. estimate for EPS and revenue, with surprise %
3. Print scorecard table — actual / estimate / surprise % for at least EPS, revenue,
   and one operational metric, with sources and dates
4. Narrative test — was the prevailing narrative confirmed, broken, or complicated?
   Reference the narrative state coming in vs. what the print revealed.
5. Forensic dissection — pick apart the line items: margins, guidance, mix, one-time items
6. Four-bullet watchlist — what to monitor next quarter / next 30 days
7. Closing observation — one definitive structural sentence about narrative durability.

EVIDENCE STANDARDS
- Use the EXACT figures from the SEC filing and Benzinga estimates provided
- Cite the filing date and form type (10-Q, 8-K) explicitly
- Compute surprise % from the figures provided; never invent numbers
- If management guidance is provided, cite it with direction and magnitude

FORBIDDEN
- No emoji, no decorative characters, no "in conclusion"
- No price targets, no recommendations, no "buy/sell" framing
- No internal scoring system names or platform jargon
- Do not end with a question
"""


# ── DATA FETCHERS ────────────────────────────────────────────────────────────

def fetch_pre_earnings_tickers(target_date: str, ticker_filter: str = None) -> list[dict]:
    """
    Tickers reporting on `target_date` (i.e. days_to_earnings = 1 when run T-1).
    Restricted to tickers with a recent narrative_scorecard entry so we only
    write about names the pipeline knows.
    """
    q = supabase.table("earnings_context") \
        .select("ticker, next_earnings_date, days_to_earnings, earnings_surprise_pct, snapshot_date") \
        .eq("next_earnings_date", target_date) \
        .order("snapshot_date", desc=True)
    if ticker_filter:
        q = q.eq("ticker", ticker_filter.upper())
    rows = q.limit(500).execute().data or []

    # Dedupe by ticker (latest snapshot only) AND exclude deluxe-allowlist tickers
    seen, out = set(), []
    for r in rows:
        if r["ticker"] in seen or r["ticker"] in DELUXE_ALLOWLIST:
            continue
        seen.add(r["ticker"])
        out.append(r)

    # Gate to tickers with a recent scorecard (last 7 days)
    cutoff = (date.today() - timedelta(days=7)).isoformat()
    tickers = [r["ticker"] for r in out]
    if not tickers:
        return []
    sc = supabase.table("narrative_scorecard") \
        .select("ticker") \
        .in_("ticker", tickers) \
        .gte("snapshot_date", cutoff) \
        .execute().data or []
    valid = {r["ticker"] for r in sc}
    return [r for r in out if r["ticker"] in valid]


def fetch_post_earnings_tickers(filing_date: str, ticker_filter: str = None) -> list[dict]:
    """
    Tickers whose latest filing_date in claim_verifications matches `filing_date`
    (typically yesterday when run T+1).
    """
    q = supabase.table("claim_verifications") \
        .select("ticker, filing_date, form_type, benzinga_fiscal_period, snapshot_date") \
        .eq("filing_date", filing_date) \
        .order("snapshot_date", desc=True)
    if ticker_filter:
        q = q.eq("ticker", ticker_filter.upper())
    rows = q.limit(500).execute().data or []

    seen, out = set(), []
    for r in rows:
        if r["ticker"] in seen or r["ticker"] in DELUXE_ALLOWLIST:
            continue
        seen.add(r["ticker"])
        out.append(r)
    return out


def fetch_ticker_forensic_context(ticker: str) -> dict:
    """Pull all forensic data needed for an earnings article."""
    def _one(table, cols, ticker_col="ticker"):
        try:
            r = supabase.table(table).select(cols) \
                .eq(ticker_col, ticker) \
                .order("snapshot_date", desc=True) \
                .limit(1).execute().data or []
            return r[0] if r else {}
        except Exception as e:
            print(f"  ⚠ {table} fetch failed: {e}")
            return {}

    story = _one("v_dash_daily_story", "*")
    cv = _one("claim_verifications",
              "sec_revenue,sec_eps,sec_gross_margin,sec_net_margin,sec_operating_margin,"
              "benzinga_eps_actual,benzinga_eps_estimate,benzinga_eps_surprise_pct,"
              "benzinga_revenue_actual,benzinga_revenue_surprise_pct,benzinga_fiscal_period,"
              "form_type,filing_date,period_of_report")
    sc = _one("narrative_scorecard",
              "ticker,fvd_pct,vms,coordination_score,decay_rate,suspicion_score,"
              "energy_remaining,verdict,narrative,nrs,current_sentiment,narrative_state")
    ec = _one("earnings_context",
              "ticker,days_to_earnings,earnings_surprise_pct,next_earnings_date")

    return {
        "ticker": ticker,
        "story": story,
        "claim_verifications": cv,
        "scorecard": sc,
        "earnings_context": ec,
    }


# ── PROMPT BUILDERS ──────────────────────────────────────────────────────────

def _fmt_money(v, suffix=""):
    if v is None or v == "":
        return "N/A"
    try:
        v = float(v)
    except (ValueError, TypeError):
        return str(v)
    return f"${v:,.2f}{suffix}"


def _fmt_pct(v):
    if v is None or v == "":
        return "N/A"
    try:
        return f"{float(v):+.2f}%"
    except (ValueError, TypeError):
        return str(v)


def _fmt(v, default="N/A"):
    if v is None or v == "":
        return default
    return str(v)


def _fiscal_label(period: str) -> str:
    """Convert '2026Q1' / 'Q1 2026' / etc. to a clean 'Q1 2026' string."""
    if not period:
        return "Latest Quarter"
    s = str(period).strip().upper()
    m = re.match(r"^(\d{4})Q([1-4])$", s)
    if m:
        return f"Q{m.group(2)} {m.group(1)}"
    return period


def build_pre_earnings_prompt(ctx: dict, live: dict, target_date: str) -> tuple[str, str]:
    """Returns (slug_suffix, user_prompt)."""
    ticker = ctx["ticker"]
    story = ctx["story"] or {}
    sc = ctx["scorecard"] or {}
    ec = ctx["earnings_context"] or {}
    cv = ctx["claim_verifications"] or {}

    fiscal = _fiscal_label(cv.get("benzinga_fiscal_period"))
    # Pre-earnings: the upcoming print is the NEXT quarter after the most recent CV.
    # If we have last quarter as Q1 2026, the print being previewed is likely Q2 2026.
    # Safer: just use "upcoming earnings" wording and let the model infer.

    headlines = ""
    for h in (live.get("headlines") or [])[:5]:
        pub = f" [{h['publisher']}]" if h.get("publisher") else ""
        headlines += f"  - {h.get('title','')}{pub}\n"

    prompt = f"""
PRE-EARNINGS FORENSIC REPORT — GENERATION REQUEST
==================================================
TICKER: {ticker}
EARNINGS DATE: {target_date}
PUBLICATION DATE: {datetime.now().strftime('%B %d, %Y')} (T-1 ahead of the print)

NARRATIVE INTELLIGENCE (do not name these as scores in the article)
-------------------------------------------------------------------
Prevailing narrative: {_fmt(sc.get('narrative'))}
Narrative state: {_fmt(sc.get('narrative_state'))}
Current sentiment: {_fmt(sc.get('current_sentiment'))}
Verdict (internal): {_fmt(sc.get('verdict'))}
Story claim: {_fmt(story.get('story_claim'))}
Forensic rebuttal: {_fmt(story.get('forensic_rebuttal'))}
Institutional positioning: {_fmt(story.get('institutional_positioning'))}
Fundamental value gap: {_fmt_pct(sc.get('fvd_pct'))}
Energy remaining: {_fmt(sc.get('energy_remaining'))}

LAST REPORTED QUARTER (for surprise track record)
-------------------------------------------------
Fiscal period: {fiscal}
Form: {_fmt(cv.get('form_type'))} filed {_fmt(cv.get('filing_date'))}
Reported EPS: {_fmt(cv.get('sec_eps'))} (Benzinga actual: {_fmt(cv.get('benzinga_eps_actual'))})
Estimate then: {_fmt(cv.get('benzinga_eps_estimate'))}
Surprise: {_fmt_pct(cv.get('benzinga_eps_surprise_pct'))}
Revenue actual: {_fmt(cv.get('benzinga_revenue_actual'))}
Revenue surprise: {_fmt_pct(cv.get('benzinga_revenue_surprise_pct'))}
Gross margin: {_fmt(cv.get('sec_gross_margin'))}
Net margin: {_fmt(cv.get('sec_net_margin'))}

LIVE MARKET DATA (use these exact figures)
-------------------------------------------
Price:           {_fmt_money(live.get('price'))}
Today's change:  {_fmt_pct(live.get('change_pct'))}
Market cap:      ${live.get('market_cap_bn') or 'N/A'}B
P/E (trailing):  {live.get('pe_trailing') or 'N/A'}
Short % float:   {_fmt_pct(live.get('short_pct_float'))}
52-week return:  {_fmt_pct(live.get('return_52w_pct'))}
Revenue (TTM):   ${live.get('revenue_ttm_bn') or 'N/A'}B

RECENT HEADLINES
----------------
{headlines if headlines else '  None retrieved.'}

INSTRUCTIONS
------------
Write a pre-earnings forensic report on {ticker} ahead of its {target_date} print.
Follow your 7-part structure. 900-1100 words.

Required:
- Open with the central pre-print question (one paragraph)
- Frame the narrative state heading into the print (what is the market pricing in?)
- Include an Estimates Table with consensus EPS, consensus revenue, prior surprise (use last quarter's data above)
- Surface at least 3 quantifiable evidence signals using the data above (short %, 52w return, fundamental value gap, prior surprise, narrative state)
- Show two-sided risk (beat scenario / miss scenario) without predicting either
- End with exactly 4 watchlist bullets and one definitive structural closing sentence

Do NOT predict beat/miss. Do NOT cite internal scores or platform names.
Translate signal intelligence into plain analytical language.
Do NOT use emoji or decorative characters.

Output format:
## [Title — should include "{ticker}" and the upcoming earnings frame]
[blank line]
[article body]
""".strip()

    slug_suffix = f"{ticker.lower()}-pre-earnings-forensic"
    return slug_suffix, prompt


def build_post_earnings_prompt(ctx: dict, live: dict, filing_date: str) -> tuple[str, str]:
    ticker = ctx["ticker"]
    story = ctx["story"] or {}
    sc = ctx["scorecard"] or {}
    cv = ctx["claim_verifications"] or {}

    fiscal = _fiscal_label(cv.get("benzinga_fiscal_period"))

    headlines = ""
    for h in (live.get("headlines") or [])[:5]:
        pub = f" [{h['publisher']}]" if h.get("publisher") else ""
        headlines += f"  - {h.get('title','')}{pub}\n"

    prompt = f"""
POST-EARNINGS FORENSIC REPORT — GENERATION REQUEST
===================================================
TICKER: {ticker}
PRINT DATE: {filing_date}
PUBLICATION DATE: {datetime.now().strftime('%B %d, %Y')} (T+1 after the print)
FISCAL PERIOD: {fiscal}

THE PRINT (use these exact figures)
------------------------------------
Form filed: {_fmt(cv.get('form_type'))} on {_fmt(cv.get('filing_date'))}
Period reported: {_fmt(cv.get('period_of_report'))}

EPS — Actual: {_fmt(cv.get('benzinga_eps_actual'))} | Estimate: {_fmt(cv.get('benzinga_eps_estimate'))} | Surprise: {_fmt_pct(cv.get('benzinga_eps_surprise_pct'))}
Revenue — Actual: {_fmt(cv.get('benzinga_revenue_actual'))} | Surprise: {_fmt_pct(cv.get('benzinga_revenue_surprise_pct'))}
SEC EPS: {_fmt(cv.get('sec_eps'))}
SEC Revenue: {_fmt(cv.get('sec_revenue'))}
Gross margin: {_fmt(cv.get('sec_gross_margin'))}
Operating margin: {_fmt(cv.get('sec_operating_margin'))}
Net margin: {_fmt(cv.get('sec_net_margin'))}

NARRATIVE STATE (coming in vs. now)
-----------------------------------
Prevailing narrative coming in: {_fmt(sc.get('narrative'))}
Narrative state: {_fmt(sc.get('narrative_state'))}
Sentiment: {_fmt(sc.get('current_sentiment'))}
Internal verdict: {_fmt(sc.get('verdict'))}
Story claim: {_fmt(story.get('story_claim'))}
Forensic rebuttal: {_fmt(story.get('forensic_rebuttal'))}
Fundamental value gap: {_fmt_pct(sc.get('fvd_pct'))}

LIVE MARKET DATA (T+1 — post-print reaction)
--------------------------------------------
Price:           {_fmt_money(live.get('price'))}
Today's change:  {_fmt_pct(live.get('change_pct'))}
Market cap:      ${live.get('market_cap_bn') or 'N/A'}B
P/E (trailing):  {live.get('pe_trailing') or 'N/A'}
Short % float:   {_fmt_pct(live.get('short_pct_float'))}
52-week return:  {_fmt_pct(live.get('return_52w_pct'))}

RECENT HEADLINES
----------------
{headlines if headlines else '  None retrieved.'}

INSTRUCTIONS
------------
Write a post-earnings forensic report on {ticker}'s {fiscal} print.
Follow your 7-part structure. 900-1100 words.

Required:
- Open with what the print actually revealed (one paragraph)
- Print Scorecard table: actual / estimate / surprise % for at least EPS, revenue, and one margin metric, with sources and dates
- Narrative test: was the coming-in narrative confirmed, broken, or complicated? Reference both states.
- Forensic dissection of the line items
- End with exactly 4 watchlist bullets and one definitive structural closing sentence

Do NOT invent numbers. Use the figures above exactly.
Do NOT cite internal scores or platform names.
Do NOT use emoji or decorative characters.

Output format:
## [Title — should include "{ticker}" and the {fiscal} earnings frame]
[blank line]
[article body]
""".strip()

    quarter_slug = re.sub(r'\s+', '-', fiscal.lower()) if fiscal else 'earnings'
    slug_suffix = f"{ticker.lower()}-{quarter_slug}-earnings-forensic"
    return slug_suffix, prompt


# ── ARTICLE GENERATION ───────────────────────────────────────────────────────

def call_claude(system_prompt: str, user_prompt: str) -> tuple[str, str]:
    response = claude.messages.create(
        model=MODEL,
        max_tokens=3500,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    full = response.content[0].text.strip()
    title = ""
    for line in full.split("\n"):
        if line.startswith("## "):
            title = line.lstrip("# ").strip()
            break
    body_lines = [l for l in full.split("\n") if not l.strip().startswith("## ")]
    body = "\n".join(body_lines).strip()
    return title, body


# ── MAIN ─────────────────────────────────────────────────────────────────────

def run_pre(target_date: str, ticker_filter: str = None, dry_run: bool = False, limit: int = None) -> int:
    print(f"\n[Pre-earnings] Target earnings date: {target_date}")
    rows = fetch_pre_earnings_tickers(target_date, ticker_filter=ticker_filter)
    if not rows:
        print(f"  → No qualifying tickers reporting on {target_date}.")
        return 0
    if limit:
        rows = rows[:limit]
    print(f"  → {len(rows)} ticker(s) qualified: {[r['ticker'] for r in rows]}")

    written = 0
    for r in rows:
        ticker = r["ticker"]
        try:
            print(f"\n  ── {ticker} ──")
            ctx = fetch_ticker_forensic_context(ticker)
            live = get_live_data(ticker)
            slug_suffix, user_prompt = build_pre_earnings_prompt(ctx, live, target_date)

            print(f"    → Generating with Claude...")
            title, body = call_claude(PRE_EARNINGS_PROMPT, user_prompt)
            if not title:
                title = f"{ticker} — Pre-Earnings Forensic Report"
            print(f"    → Title: {title}")
            print(f"    → Body: {len(body)} chars")

            slug = f"{datetime.now().strftime('%Y-%m-%d')}-{slug_suffix}"
            result = publish_to_supabase(
                ticker=ticker,
                title=title,
                body=body,
                ctx={"verdict": "Earnings"},
                dry_run=dry_run,
                slug_override=slug,
                tag_override="Earnings",
                author="Reed Calloway",
            )
            if result.get("success"):
                written += 1
        except Exception as e:
            print(f"    ✗ {ticker} failed: {e}")
    return written


def run_post(filing_date: str, ticker_filter: str = None, dry_run: bool = False, limit: int = None) -> int:
    print(f"\n[Post-earnings] Filing date: {filing_date}")
    rows = fetch_post_earnings_tickers(filing_date, ticker_filter=ticker_filter)
    if not rows:
        print(f"  → No qualifying tickers reporting on {filing_date}.")
        return 0
    if limit:
        rows = rows[:limit]
    print(f"  → {len(rows)} ticker(s) qualified: {[r['ticker'] for r in rows]}")

    written = 0
    for r in rows:
        ticker = r["ticker"]
        try:
            print(f"\n  ── {ticker} ──")
            ctx = fetch_ticker_forensic_context(ticker)
            live = get_live_data(ticker)
            slug_suffix, user_prompt = build_post_earnings_prompt(ctx, live, filing_date)

            print(f"    → Generating with Claude...")
            title, body = call_claude(POST_EARNINGS_PROMPT, user_prompt)
            if not title:
                title = f"{ticker} — Post-Earnings Forensic Report"
            print(f"    → Title: {title}")
            print(f"    → Body: {len(body)} chars")

            slug = f"{datetime.now().strftime('%Y-%m-%d')}-{slug_suffix}"
            result = publish_to_supabase(
                ticker=ticker,
                title=title,
                body=body,
                ctx={"verdict": "Post-Earnings"},
                dry_run=dry_run,
                slug_override=slug,
                tag_override="Post-Earnings",
                author="Reed Calloway",
            )
            if result.get("success"):
                written += 1
        except Exception as e:
            print(f"    ✗ {ticker} failed: {e}")
    return written


def main():
    p = argparse.ArgumentParser(description="Pre/Post-earnings forensic generator")
    p.add_argument("--mode", choices=["pre", "post", "both"], default="both")
    p.add_argument("--ticker", help="Restrict to a single ticker (for backfill / testing)")
    p.add_argument("--target-date", help="Override target earnings date (YYYY-MM-DD). Default: tomorrow for pre, yesterday for post")
    p.add_argument("--limit", type=int, help="Cap how many tickers to process per mode")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    print(f"\n[Earnings Forensic Generator] {datetime.now().strftime('%Y-%m-%d %H:%M ET')}")

    today = date.today()
    pre_target = args.target_date or (today + timedelta(days=1)).isoformat()
    post_target = args.target_date or (today - timedelta(days=1)).isoformat()

    pre_written = post_written = 0
    if args.mode in ("pre", "both"):
        pre_written = run_pre(pre_target, ticker_filter=args.ticker, dry_run=args.dry_run, limit=args.limit)
    if args.mode in ("post", "both"):
        post_written = run_post(post_target, ticker_filter=args.ticker, dry_run=args.dry_run, limit=args.limit)

    total = pre_written + post_written
    print(f"\n✓ Done. Wrote {pre_written} pre-earnings + {post_written} post-earnings = {total} total.\n")

    # Surface counts to GitHub Actions
    out = os.environ.get("GITHUB_OUTPUT", "")
    if out:
        with open(out, "a") as f:
            f.write(f"pre_count={pre_written}\n")
            f.write(f"post_count={post_written}\n")
            f.write(f"total_count={total}\n")


if __name__ == "__main__":
    main()
