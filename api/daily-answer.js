// Daily Answer engine — one cacheable payload that lets the dashboard answer
// "how am I going to make money today?" for any risk/horizon/style profile.
//
// The endpoint does NOT pick the trade itself. It assembles the full evidence-
// enriched candidate pool once (CDN-cached for every user), and the client
// applies the user's quiz profile to rank it. That keeps Supabase load at
// ~1 origin hit per 15 minutes regardless of user count, and lets a profile
// retake re-rank instantly with zero refetches.
//
// Sources (all anon-readable, verified against RLS policies 2026-07-11):
//   tracked_daily_plays      — today's OPEN engine plays (lane, rank, entry, plan)
//   strategy_signals         — classic-strategy fires (real entry/target/stop, R:R)
//   narrative_traps          — stories to trade against, with days-of-story-left
//   ticker_forecast          — prob_up / conviction / fvd / rolling 30d hit rate
//   lane_edge_status_learned — Bayesian learned edge per lane+direction (nightly)
//   track_record_stats       — realized win rates per lane (is_current)
//   market_regime_log        — market weather (regime, VIX)
//   daily_conviction_list    — AVOID list + earnings-imminent warnings
//   trade_cards_live         — card tier/story for presentation enrichment
//
// Known data quirks encoded here:
//   - ticker_forecast.target_price is a fair-value anchor, NOT a trade target —
//     it is intentionally not exposed as a plan price.
//   - daily_conviction_list.conviction_data is double-encoded JSON (array whose
//     first element is a JSON string).
//   - VALUE_PICK lane is FYI-only product-wide; excluded from the candidate pool.
//
// Cache: s-maxage=900 + stale-while-revalidate=3600 (same tier as daily-brief).

const rateLimit = require('./_rate-limit');

const TIMEOUT_MS = 8000;

function sb(path) {
  var url = process.env.SUPABASE_URL || '';
  var key = process.env.SUPABASE_ANON || '';
  if (!url || !key) return Promise.resolve(null);
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  return fetch(url + '/rest/v1/' + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
    signal: ctrl.signal
  }).then(function (res) {
    clearTimeout(t);
    if (!res.ok) return null;
    return res.json();
  }).catch(function () { clearTimeout(t); return null; });
}

function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
function round(v, d) { var n = num(v); if (n == null) return null; var m = Math.pow(10, d == null ? 2 : d); return Math.round(n * m) / m; }

// Next US-equity session relative to "now" in ET. No holiday calendar — the
// label degrades to the prior weekday name on holidays, which is cosmetic.
function nextSession(now) {
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var d = new Date(et);
  var mins = et.getHours() * 60 + et.getMinutes();
  if (et.getDay() >= 1 && et.getDay() <= 5 && mins < 16 * 60) {
    // weekday before close → today's session (pre-open still counts as today)
  } else {
    d.setDate(d.getDate() + 1);
  }
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return { iso: iso, label: days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() };
}

// daily_conviction_list.conviction_data arrives double-encoded.
function parseConviction(rows) {
  try {
    var row = rows && rows[0];
    if (!row || !row.conviction_data) return null;
    var raw = row.conviction_data;
    if (Array.isArray(raw)) raw = raw[0];
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!raw || typeof raw !== 'object') return null;
    var avoid = (raw.strong_conviction_avoid || []).map(function (a) {
      return { ticker: a.ticker, confidence: num(a.confidence), note: String(a.reasoning || '').split('.')[0].slice(0, 160) };
    }).filter(function (a) { return a.ticker; });
    var earnings = (raw.earnings_imminent || []).map(function (e) {
      return { ticker: e.ticker, dte: num(e.dte), note: String(e.note || '').split('.')[0].slice(0, 160) };
    }).filter(function (e) { return e.ticker; });
    return { date: row.conviction_date, avoid: avoid, earnings_imminent: earnings, summary: raw.summary || null };
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!rateLimit(req, res, 'daily-answer', 60)) return;

  var results = await Promise.allSettled([
    sb('tracked_daily_plays?select=ticker,lane,direction,lane_rank,entry_price,predicted_return_pct,predicted_hold_days,planned_exit_date,lane_reason,snapshot_date&status=eq.OPEN&order=snapshot_date.desc,lane_rank.asc&limit=250'),
    sb('strategy_signals?select=ticker,strategy_name,named_after,direction,horizon_days,conviction,entry_price,target_price,stop_price,reward_risk,atr_pct,trigger_detail,snapshot_date&fires=eq.true&order=snapshot_date.desc,conviction.desc&limit=150'),
    sb('narrative_traps?select=ticker,narrative,verdict,days_elapsed,predicted_exhaustion_days,half_life,fvd_pct,current_price,fair_value,snapshot_date&order=snapshot_date.desc&limit=48'),
    sb('ticker_forecast?select=ticker,bias,primary_horizon,predicted_1d_pct,predicted_5d_pct,predicted_10d_pct,prob_up_1d,prob_up_5d,prob_up_10d,conviction_1d,conviction_5d,conviction_10d,current_price,fvd_pct,invalidation_price,rolling_30_hit_rate,rolling_30_total,driving_signal,signal_regime'),
    sb('lane_edge_status_learned?select=lane,direction,status,p_positive,mu_post_pct,n_eff,live_n'),
    sb('track_record_stats?select=scope,signal_basis,closed_trades,win_rate,avg_return_pct,alpha_vs_spy_pct&is_current=eq.true&scope=like.lane:*'),
    sb('market_regime_log?select=date,market_regime,regime_class,vix_close,vix_regime,spy_trend_5d,rate_environment&order=date.desc&limit=1'),
    sb('daily_conviction_list?select=conviction_date,conviction_data&order=conviction_date.desc&limit=1'),
    sb('trade_cards_live?select=ticker,card_tier,direction,confidence,trade_score,story_claim,description,price,fair_value,pct_above_fair_value,sector,days_to_earnings&card_tier=in.(UNICORN,PLATINUM,GOLD,SURPRISE)&order=trade_score.desc.nullslast&limit=40')
  ]);

  var v = results.map(function (r) { return r.status === 'fulfilled' ? r.value : null; });
  var plays = v[0] || [], strats = v[1] || [], traps = v[2] || [], forecasts = v[3] || [];
  var laneEdge = v[4] || [], laneStats = v[5] || [], regimeRows = v[6] || [];
  var conviction = parseConviction(v[7]);
  var cards = v[8] || [];

  // ---- lane evidence: learned edge + realized track record, keyed LANE|DIR
  var lanes = {};
  laneEdge.forEach(function (e) {
    if (!e.lane || !e.direction) return;
    lanes[e.lane + '|' + e.direction] = {
      status: e.status, p_positive: round(e.p_positive, 3), mu_post_pct: round(e.mu_post_pct, 3),
      live_n: e.live_n, n_eff: round(e.n_eff, 0)
    };
  });
  laneStats.forEach(function (s) {
    // scope looks like "lane:SWING_TRADE_LONG:daily_plays"
    var m = /^lane:([A-Z_]+)_(LONG|SHORT)/.exec(s.scope || '');
    if (!m) return;
    var k = m[1] + '|' + m[2];
    lanes[k] = lanes[k] || {};
    lanes[k].win_rate = round(s.win_rate, 1);
    lanes[k].closed_trades = s.closed_trades;
    lanes[k].avg_return_pct = round(s.avg_return_pct, 2);
    lanes[k].alpha_vs_spy_pct = round(s.alpha_vs_spy_pct, 2);
  });

  var byTickerForecast = {};
  forecasts.forEach(function (f) { if (f.ticker) byTickerForecast[f.ticker] = f; });
  var byTickerCard = {};
  cards.forEach(function (c) { if (c.ticker && !byTickerCard[c.ticker]) byTickerCard[c.ticker] = c; });
  var avoidMap = {};
  (conviction && conviction.avoid || []).forEach(function (a) { avoidMap[a.ticker] = a.note || 'On today’s high-conviction avoid list'; });
  var earnMap = {};
  (conviction && conviction.earnings_imminent || []).forEach(function (e) { if (e.dte != null) earnMap[e.ticker] = e.dte; });

  function enrich(c) {
    var f = byTickerForecast[c.ticker];
    if (f) {
      c.f = {
        bias: f.bias, prob_up_1d: round(f.prob_up_1d, 3), prob_up_5d: round(f.prob_up_5d, 3), prob_up_10d: round(f.prob_up_10d, 3),
        conviction_1d: num(f.conviction_1d), conviction_5d: num(f.conviction_5d), conviction_10d: num(f.conviction_10d),
        fvd_pct: round(f.fvd_pct, 1), invalidation: round(f.invalidation_price, 2),
        hit_rate_30: round(f.rolling_30_hit_rate, 2), hit_n_30: f.rolling_30_total,
        driving_signal: f.driving_signal, signal_regime: f.signal_regime, price: round(f.current_price, 2)
      };
    }
    var card = byTickerCard[c.ticker];
    if (card) {
      c.card = {
        tier: card.card_tier, confidence: num(card.confidence), story: card.story_claim || null,
        sector: card.sector || null, pct_above_fv: round(card.pct_above_fair_value, 1)
      };
    }
    if (avoidMap[c.ticker]) c.avoid = avoidMap[c.ticker];
    var dte = earnMap[c.ticker];
    if (dte == null && card && card.days_to_earnings != null) dte = num(card.days_to_earnings);
    if (dte != null && dte >= 0 && dte <= 7) c.earnings_dte = dte;
    return c;
  }

  // ---- candidates: engine plays at the latest snapshot (VALUE_PICK is FYI-only)
  var playDate = plays.length ? plays[0].snapshot_date : null;
  var candidates = plays
    .filter(function (p) { return p.snapshot_date === playDate && p.lane !== 'VALUE_PICK'; })
    .map(function (p) {
      return enrich({
        src: 'play', ticker: p.ticker, lane: p.lane, direction: p.direction,
        rank: p.lane_rank, entry: round(p.entry_price, 2), pred_pct: round(p.predicted_return_pct, 2),
        hold_days: p.predicted_hold_days, exit_date: p.planned_exit_date, reason: p.lane_reason || null
      });
    });

  // ---- classic strategy fires at the latest strategy snapshot
  var stratDate = strats.length ? strats[0].snapshot_date : null;
  strats.filter(function (s) { return s.snapshot_date === stratDate; }).forEach(function (s) {
    candidates.push(enrich({
      src: 'strategy', ticker: s.ticker, lane: 'CLASSIC', direction: s.direction,
      strategy_name: s.strategy_name, named_after: s.named_after || null,
      horizon_days: s.horizon_days, conviction: round(s.conviction, 3),
      entry: round(s.entry_price, 2), target: round(s.target_price, 2), stop: round(s.stop_price, 2),
      reward_risk: round(s.reward_risk, 1), atr_pct: round(s.atr_pct, 4), reason: s.trigger_detail || null
    }));
  });

  // ---- fades: stories to trade against, deduped to freshest+widest gap per ticker
  var fadeMap = {};
  traps.forEach(function (t) {
    if (!t.ticker) return;
    var prev = fadeMap[t.ticker];
    if (!prev || (t.snapshot_date > prev.snapshot_date) ||
        (t.snapshot_date === prev.snapshot_date && num(t.fvd_pct) > num(prev.fvd_pct))) {
      fadeMap[t.ticker] = t;
    }
  });
  var fades = Object.keys(fadeMap).map(function (k) {
    var t = fadeMap[k];
    return {
      ticker: t.ticker, narrative: String(t.narrative || '').slice(0, 180), verdict: t.verdict,
      days_left: round(t.predicted_exhaustion_days, 1), days_elapsed: t.days_elapsed,
      fvd_pct: round(t.fvd_pct, 1), price: round(t.current_price, 2), fair_value: round(t.fair_value, 2),
      snapshot_date: t.snapshot_date
    };
  }).sort(function (a, b) { return (b.fvd_pct || 0) - (a.fvd_pct || 0); });

  var regime = regimeRows[0] ? {
    date: regimeRows[0].date, market_regime: regimeRows[0].market_regime, regime_class: regimeRows[0].regime_class,
    vix: round(regimeRows[0].vix_close, 1), vix_regime: regimeRows[0].vix_regime,
    spy_trend_5d: round(regimeRows[0].spy_trend_5d, 2), rate_environment: regimeRows[0].rate_environment
  } : null;

  var sess = nextSession(new Date());
  var payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    session: { data_date: playDate || stratDate || null, trade_date: sess.iso, trade_label: sess.label },
    regime: regime,
    lanes: lanes,
    candidates: candidates,
    fades: fades,
    avoid: conviction ? conviction.avoid : [],
    earnings_imminent: conviction ? conviction.earnings_imminent : [],
    meta: {
      counts: { plays: candidates.filter(function (c) { return c.src === 'play'; }).length, strategies: candidates.filter(function (c) { return c.src === 'strategy'; }).length, fades: fades.length },
      failed_sources: results.map(function (r, i) { return r.status !== 'fulfilled' || v[i] == null ? i : null; }).filter(function (x) { return x != null; })
    }
  };

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(payload);
};
