// Ticker hero summary — Claude Haiku 4.5 synthesis describing the narrative.
// Produces a 2-3 sentence editorial paragraph that lives directly below the
// deterministic deriveState() label in the ticker page narrative strip.
//
// Inputs include recent narrative_analyses article text (last 3 days), the
// full narrative_scorecard signals (state, coordination, regime, sentiment),
// daily_fair_value, and earnings context. The synthesized state label is
// passed in explicitly so the LLM can avoid restating it. Fair-value
// percentages are now allowed (and expected) in output — the second sentence
// is supposed to quantify the narrative/fundamentals disconnect.
//
// Cached at the edge: s-maxage=1800 (30 min fresh) + stale-while-revalidate=86400
// (serve stale up to a day while revalidating in background). Ticker state shifts
// intraday as new articles land, but the 30-min fresh window keeps the displayed
// narrative close to reality while collapsing per-visit LLM cost — the second
// visitor in any 30-min window gets the cached summary instantly.

const SYSTEM_PROMPT = `You are writing a 2-3 sentence editorial summary for a stock ticker page. The reader is a retail trader who wants to understand what's happening to this stock right now and whether they should care.

Sentence 1 — Lead with what's dominating discourse. If multiple articles share a theme, name it specifically (use proper nouns from the articles). If they conflict, describe the conflict.

Sentence 2 — Quantify the disconnect between narrative and fundamentals. If a fair value gap is provided in the input, reference it; if it is not provided, do NOT mention fair value, valuation, premium, discount, over/undervalued, or any "X% above/below fair value" phrasing. Always reference narrative health in plain market English - use the "Story momentum" read in the input to say whether the story is building, holding steady, fading, or losing momentum - and reference recent earnings when applicable.

Valuation lens consistency — CRITICAL: A "P/E vs sector" badge sits visually adjacent to this paragraph. If the input provides P/E context (current P/E, 5-yr median, implied-at-fair-value, industry average) AND those signals disagree with the fair-value premium (e.g. fair-value model says +16% overvalued but P/E is below sector or below the stock's own 5-yr median), you MUST acknowledge both lenses rather than lead with just one. Example phrasing: "trades at 42x vs a 5-yr median of 34x even as the multiple sits below sector peers, with the fair-value model still flagging X% of stretch on narrative-adjusted fundamentals". Never write a sentence that contradicts what the adjacent badge shows.

Sentence 3 (optional) — If the institutional signal is meaningful (narrative_state = WHALE_ACCUMULATION or DISTRIBUTION, or strong coordination), add the institutional read in plain English.

Hard rules:
- Never use em dashes. Use commas, periods, or " - " (hyphen with spaces) instead.
- Maximum 3 sentences. Tighter is better.
- Use specifics from the articles when possible (proper nouns, numbers, themes). Avoid abstract phrases like "competing narratives" if you can name what's competing.
- Never invent facts not in the inputs. No rumors, no quotes, no analyst names unless they're in the article text.
- A synthesized state label is shown directly above this paragraph (e.g. "Smart money behind a story"). Do NOT restate or paraphrase it — show what is happening, do not declare it.
- Do not say "this stock", "this ticker", or restate the ticker symbol — they are shown adjacent to the paragraph.
- Read like a Bloomberg analyst wrote it. Not breathless, not robotic.
- Banned words (always): crash, guaranteed, certain, always, never, explosion, manipulation. Use "stretched", "diverging", or "outpacing fundamentals" instead.
- NO narrative-physics or scientific-metaphor vocabulary in the output, ever. Specifically banned: half-life, decay, decaying, energy (including "narrative energy", "sentiment energy", "temporal energy"), velocity, mass, friction, fuel, radioactive, critical, subcritical, supercritical, exhaustion, exhausting. Never cite a number of days of "half-life". Describe the story in plain market English instead: "the story is losing momentum", "fresh coverage is thinning", "the narrative is fading", "conviction is slipping", "coverage is still consensus-long". The plain word "momentum" on its own is allowed - only the physics/energy metaphors are banned. Keep the paragraph focused on the narrative and the stock price.
- Conditional banned words: when the input contains "Valuation flag: TEMPERATE", these additional words become banned in the paragraph: hype, hyped, frothy, froth, mania, manic, euphoria, euphoric, bubble, parabolic, blow-off. A TEMPERATE flag means the stock is within 20% of fair value AND the multiple is below sector peers, so any "hype" framing would contradict the multiple math. Use "extended", "consensus-long", "well-owned", or "crowded" instead. The synthesized state label above the paragraph may still contain "hype" - that is fine, the label is separate; but the paragraph itself must avoid those words. When the flag is "ELEVATED" or absent, normal valuation language is allowed.

Output ONLY the paragraph. No headers, no quotes around it, no preamble.`;

async function fetchSupabase(path) {
  var url = process.env.SUPABASE_URL || '';
  var key = process.env.SUPABASE_ANON || '';
  if (!url || !key) return null;
  try {
    var res = await fetch(url + '/rest/v1/' + path, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Derive a coordination-class enum from the numeric coordination_score so the
// LLM input vocabulary matches the deriveState() rules on the frontend.
function coordinationClass(score) {
  if (score == null) return null;
  if (score >= 60) return 'LIKELY_COORDINATED';
  if (score >= 30) return 'SUSPICIOUS_PATTERN';
  if (score >= 10) return 'ORGANIC_SPREAD';
  return 'ORGANIC';
}

// Translate the narrative-physics regime enums (narrative_energy_regime values
// are nuclear-reactor terms: 'Sub-Critical' / 'Critical' / 'Supercritical', and
// walsh_regime adds 'EXHAUSTING' etc.) into a single plain-English read of story
// momentum. Keeps the physics vocabulary out of the LLM input entirely so the
// generated paragraph can't echo "half-life", "energy", "subcritical", etc.
function plainMomentum(energyRegime, walshRegime) {
  var ner = (energyRegime || '').toString().toLowerCase();
  var wr = (walshRegime || '').toString().toLowerCase();
  if (/exhaust/.test(wr)) return 'the story is losing momentum and fresh coverage is thinning';
  if (/super.?critical/.test(ner)) return 'the story is still gaining attention and fresh coverage is building';
  if (/sub.?critical/.test(ner)) return 'the story is fading and drawing less fresh coverage';
  if (/critical/.test(ner)) return 'the story is at peak attention with coverage broadly consensus';
  if (/build|accel|expand|emerg/.test(wr)) return 'the story is building momentum';
  if (/stable|mature|sustain|hold/.test(wr)) return 'the story is holding steady with sustained coverage';
  return null;
}

// Mirror the frontend's deriveState() so we can pass the synthesized state
// label to the LLM and instruct it not to restate.
// priceChangePct: today's % change. Used to gate the "Quiet" label so a
// large-cap with sparse news but a +3% tape doesn't get labeled Quiet.
function synthesizedStateLabel(sc, priceChangePct) {
  // Universal fallback — never returns "Insufficient signal" so the LLM hint
  // stays in lockstep with the frontend deriveState() catch-all.
  if (!sc) return 'Mixed signals';
  var ns = sc.narrative_state || null;
  var cc = coordinationClass(sc.coordination_score);
  var wr = sc.walsh_regime || null;
  var ner = (sc.narrative_energy_regime || '').toString();
  var freshEnergy = /critical/i.test(ner) && !/sub/i.test(ner);
  var s = sc.current_sentiment;
  var tone = (s == null || !isFinite(s)) ? null : (s > 0.30 ? 'BULLISH' : s < -0.30 ? 'BEARISH' : 'MIXED');
  // See deriveState() in _ticker.html for the rationale — both signals must
  // explicitly agree before the Quiet label fires; nulls default to FALSE.
  var nea = sc.narrative_energy_absolute != null && isFinite(Number(sc.narrative_energy_absolute))
    ? Number(sc.narrative_energy_absolute) : null;
  var lowEnergy = nea != null && nea < 100;
  var dailyAbsPct = priceChangePct != null && isFinite(Number(priceChangePct))
    ? Math.abs(Number(priceChangePct)) : null;
  var priceIsQuiet = dailyAbsPct != null && dailyAbsPct < 1;

  if (ns === 'WHALE_ACCUMULATION' && cc === 'LIKELY_COORDINATED') return 'Smart money behind a story';
  if (ns === 'WHALE_ACCUMULATION') return 'Quiet accumulation';
  if (ns === 'DISTRIBUTION' && (cc === 'LIKELY_COORDINATED' || cc === 'SUSPICIOUS_PATTERN') && tone === 'BULLISH') return 'Whales selling into hype';
  if (ns === 'DISTRIBUTION' && wr === 'EXHAUSTING') return 'Smart money exiting';
  if (ns === 'DISTRIBUTION' && freshEnergy) return 'Distribution into strength';
  if (ns === 'DISTRIBUTION') return 'Quiet distribution';
  if (ns === 'RETAIL_PUMP' && cc === 'LIKELY_COORDINATED') return 'Manufactured pump';
  if (ns === 'RETAIL_PUMP' && cc === 'SUSPICIOUS_PATTERN') return 'Suspicious retail activity';
  if (ns === 'RETAIL_PUMP') return 'Retail momentum';
  if (wr === 'EXHAUSTING') return 'Narrative collapsing';
  if (ns === 'DORMANT' && lowEnergy && priceIsQuiet) return 'Quiet';
  if (cc === 'LIKELY_COORDINATED') return 'Coordinated narrative';
  // Falls through to "Mixed signals" when ns is null/unclassified but other
  // scorecard fields are present (e.g. major tickers like AAPL with rich
  // coverage but no specific narrative state). See _ticker.html deriveState().
  return 'Mixed signals';
}

function compactState(story, scorecard, health, narratives, fairValue, articles) {
  var s = story || {};
  var sc = scorecard || {};
  var h = health || {};
  var fv = fairValue || {};
  var lines = [];

  // Header — ticker, sector, fundamentals.
  if (s.ticker) lines.push('Ticker: ' + s.ticker);
  if (s.sector_name) lines.push('Sector: ' + s.sector_name);
  if (s.price != null) lines.push('Current price: $' + Number(s.price).toFixed(2));
  // Valuation gap — emitted as explicit "undervalued/overvalued by X%" so the
  // LLM can't flip the sign. Convention: gap = (price - fair_value) / fair_value
  // (matches narrative_scorecard.fvd_pct: positive = overvalued).
  if (fv.fair_value != null && s.price) {
    var fvPrice = Number(fv.fair_value);
    var gapPct = (Number(s.price) - fvPrice) / fvPrice * 100;
    var direction = gapPct >= 0 ? 'overvalued' : 'undervalued';
    lines.push('Fair value: $' + fvPrice.toFixed(2)
      + ' (stock is ' + Math.abs(gapPct).toFixed(1) + '% ' + direction + ' vs fair value)');
  } else if (sc.fvd_pct != null) {
    var fvd = Number(sc.fvd_pct);
    var fvdDirection = fvd >= 0 ? 'overvalued' : 'undervalued';
    lines.push('Fair-value gap: stock is ' + Math.abs(fvd).toFixed(1) + '% ' + fvdDirection + ' vs fair value');
  }

  // Valuation-temperature flag — controls hype-style word bans in the LLM
  // paragraph. TEMPERATE = stock is within VALUATION_PREMIUM_TEMPERATE_PCT of
  // fair value AND pe_used < industry_pe_median (multiple below sector peers).
  // Both conditions must be computable; when industry_pe_median is null (current
  // state for most rows pending the upstream backfill of daily_fair_value),
  // the flag is left absent rather than guessed.
  var VALUATION_PREMIUM_TEMPERATE_PCT = 20;
  var valuationFlag = null;
  var _premiumAbsPct = null;
  if (fv.premium_pct != null) {
    _premiumAbsPct = Math.abs(Number(fv.premium_pct));
  } else if (fv.fair_value != null && s.price) {
    _premiumAbsPct = Math.abs((Number(s.price) - Number(fv.fair_value)) / Number(fv.fair_value) * 100);
  }
  if (_premiumAbsPct != null && fv.pe_used != null && fv.industry_pe_median != null) {
    var _closeToFV = _premiumAbsPct <= VALUATION_PREMIUM_TEMPERATE_PCT;
    var _underSectorPE = Number(fv.pe_used) < Number(fv.industry_pe_median);
    valuationFlag = (_closeToFV && _underSectorPE) ? 'TEMPERATE' : 'ELEVATED';
  }
  if (valuationFlag) {
    lines.push('');
    lines.push('Valuation flag: ' + valuationFlag
      + ' (premium |' + _premiumAbsPct.toFixed(1) + '%| vs '
      + VALUATION_PREMIUM_TEMPERATE_PCT + '% threshold, P/E '
      + Number(fv.pe_used).toFixed(1) + 'x '
      + (Number(fv.pe_used) < Number(fv.industry_pe_median) ? 'below' : 'at or above')
      + ' industry median ' + Number(fv.industry_pe_median).toFixed(1) + 'x)');
  }

  // P/E context from daily_fair_value — gives the LLM the same valuation lenses
  // that drive the visible "P/E vs Sector" badge so the paragraph can't
  // contradict it. Emit each lens as an explicit comparison vs the current P/E
  // so the model can't flip the direction. industry_pe_median is the canonical
  // sector source on this table but is currently unpopulated for most rows;
  // when null, the sector-comparison lens is simply absent from the prompt.
  if (fv.pe_used != null) {
    var peNow = Number(fv.pe_used);
    var peLines = ['Current P/E (model-used): ' + peNow.toFixed(1) + 'x'];
    if (fv.pe_5y_median != null) {
      var peMed = Number(fv.pe_5y_median);
      var medDir = peNow >= peMed ? 'above' : 'below';
      var medGap = Math.abs((peNow - peMed) / peMed * 100);
      peLines.push('5-yr median P/E: ' + peMed.toFixed(1) + 'x (current is '
        + medGap.toFixed(0) + '% ' + medDir + ' own historical multiple)');
    }
    if (fv.pe_implied != null) {
      var peImp = Number(fv.pe_implied);
      var impDir = peNow >= peImp ? 'above' : 'below';
      peLines.push('Implied P/E at fair value: ' + peImp.toFixed(1) + 'x (current is '
        + impDir + ' the implied multiple)');
    }
    if (fv.industry_pe_median != null) {
      var peInd = Number(fv.industry_pe_median);
      var indDir = peNow >= peInd ? 'above' : 'below';
      var indGap = Math.abs((peNow - peInd) / peInd * 100);
      peLines.push('Industry median P/E: ' + peInd.toFixed(1) + 'x (current is '
        + indGap.toFixed(0) + '% ' + indDir + ' sector peers — THIS matches what the visible "vs Sector" badge displays)');
    }
    lines.push('');
    lines.push('Valuation multiples (use these alongside fair value for the disagreement rule):');
    peLines.forEach(function(l) { lines.push('- ' + l); });
  }
  // Earnings timing — recompute days_to_earnings from next_earnings_date relative
  // to TODAY (server clock), not from the snapshot row. Snapshots are generated
  // pre-market and can be 1 day stale, which causes the LLM to say "earnings
  // tomorrow" when the frontend badge correctly says "Earnings today".
  var dteResolved = null;
  var earnDateISO = s.next_earnings_date || null;
  if (earnDateISO) {
    var _ep = String(earnDateISO).split('-');
    if (_ep.length === 3) {
      var _earnDate = new Date(Number(_ep[0]), Number(_ep[1]) - 1, Number(_ep[2]));
      var _now = new Date(); _now.setHours(0, 0, 0, 0);
      dteResolved = Math.round((_earnDate - _now) / 86400000);
    }
  }
  if (dteResolved == null && s.days_to_earnings != null) {
    dteResolved = Number(s.days_to_earnings);
  }
  if (dteResolved != null && isFinite(dteResolved)) {
    var earnPhrase;
    if (dteResolved === 0) earnPhrase = 'TODAY (after-hours or scheduled today — do NOT say "tomorrow")';
    else if (dteResolved === 1) earnPhrase = 'tomorrow (in 1 day)';
    else if (dteResolved === -1) earnPhrase = 'yesterday (1 day ago, post-earnings)';
    else if (dteResolved > 0) earnPhrase = 'in ' + dteResolved + ' days';
    else earnPhrase = Math.abs(dteResolved) + ' days ago (post-earnings)';
    lines.push('Earnings: ' + earnPhrase + (earnDateISO ? ' [' + earnDateISO + ']' : ''));
  }
  if (s.earnings_surprise_pct != null) lines.push('Last earnings surprise: ' + Number(s.earnings_surprise_pct).toFixed(1) + '%');
  if (s.guidance_direction) lines.push('Guidance: ' + s.guidance_direction);

  // Narrative signals.
  lines.push('');
  lines.push('Narrative signals:');
  if (sc.narrative_state) lines.push('- State: ' + sc.narrative_state);
  var cc = coordinationClass(sc.coordination_score);
  if (cc) lines.push('- Coordination: ' + cc + (sc.coordination_score != null ? ' (' + Math.round(sc.coordination_score) + ')' : ''));
  // Story momentum — plain-English read derived from the physics regimes so the
  // raw enum vocabulary (energy / critical / subcritical / exhausting) never
  // reaches the model. See plainMomentum().
  var momentumRead = plainMomentum(sc.narrative_energy_regime, sc.walsh_regime);
  if (momentumRead) lines.push('- Story momentum: ' + momentumRead);
  if (sc.current_sentiment != null) {
    var cs = Number(sc.current_sentiment);
    var tone = cs > 0.30 ? 'BULLISH' : cs < -0.30 ? 'BEARISH' : 'MIXED';
    lines.push('- Aggregate sentiment: ' + tone + ' (' + cs.toFixed(2) + ')');
  }
  if (sc.verdict || s.prism_verdict) lines.push('- Verdict: ' + (sc.verdict || s.prism_verdict));
  if (h.narrative_trend) lines.push('- Trend: ' + h.narrative_trend);

  // Synthesized state — the deterministic label rendered above this paragraph.
  // Surfaced explicitly so the LLM doesn't restate it. Pass today's price
  // change so the Quiet rule stays in sync with the frontend.
  var stateLabel = synthesizedStateLabel(sc, s.price_change_pct);
  lines.push('');
  lines.push('Synthesized state label (already shown above the paragraph — DO NOT restate): "' + stateLabel + '"');

  // Recent article narratives (raw text, capped).
  if (articles && articles.length) {
    lines.push('');
    lines.push('Recent article narratives (' + articles.length + ' articles in last 3 days):');
    articles.slice(0, 10).forEach(function(a) {
      var bits = [];
      if (a.source_outlet) bits.push(a.source_outlet);
      if (a.sentiment_score != null) {
        var sScore = Number(a.sentiment_score);
        bits.push(sScore > 0.30 ? 'BULLISH' : sScore < -0.30 ? 'BEARISH' : 'MIXED');
      }
      var txt = (a.narrative_text || '').toString().replace(/\s+/g, ' ').trim().slice(0, 200);
      lines.push('- [' + bits.join(', ') + ']: ' + txt);
    });
  } else if (narratives && narratives.length) {
    // Fallback to the deduped scorecard narratives view if narrative_analyses
    // returns nothing fresh. Only list narratives that actually carry text: a
    // row with just a propagation_pressure ("spread=2") and no `narrative` gives
    // the model nothing to write about, and it responds by asking the caller for
    // the missing labels (a refusal that then leaks to the page). The bare
    // spread=N metric is dropped entirely — it's noise, not narrative.
    var namedNarratives = narratives.filter(function(n) {
      return n && n.narrative && String(n.narrative).trim();
    });
    if (namedNarratives.length) {
      lines.push('');
      lines.push('Active narratives (most-cited first):');
      namedNarratives.slice(0, 5).forEach(function(n, i) {
        var bits = [String(n.narrative).trim()];
        // Translate the physics regime to plain momentum; drop the raw energy/
        // propagation field names so the model never sees those words.
        var nMom = plainMomentum(n.narrative_energy_regime, null);
        if (nMom) bits.push(nMom);
        lines.push('  ' + (i + 1) + '. ' + bits.join(' · '));
      });
    }
  }

  return lines.join('\n');
}

const rateLimit = require('./_rate-limit');

// Reject raw LLM refusals / meta-responses. When a thin ticker has no real
// article text, Haiku sometimes asks the caller for input instead of writing a
// summary (e.g. "I appreciate the request, but I need to flag a data issue: the
// active narratives list shows only spread metrics ... Could you provide the
// narrative labels?"). That must never be returned as `summary` — the ticker
// page renders it verbatim. Mirrors mpIsBadSummary() in _ticker.html.
const BAD_SUMMARY_RE = /\bI appreciate (?:the|your) request\b|\bneed to flag\b|\bflag a data issue\b|\bas required by the brief\b|\bto write this properly\b|\bcould you (?:provide|clarify|share)\b|\bthe active narratives list\b|\bno descriptive text\b|spread\s*=\s*\d|\bcannot write\b|\bcan['’]?t write\b|\bI['’]?d need\b|\bI would need\b|\bI can (?:deliver|write|provide)\b|\bI (?:am|['’]m) unable\b|\bI apologize\b|\bI['’]m sorry\b|\bplease provide\b|\blet me know if\b|\bwithout knowing what these\b|\bI don['’]?t have (?:enough|access|the)\b/i;
function isBadSummary(text) {
  if (!text) return false;
  return BAD_SUMMARY_RE.test(String(text));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  // Rate limit AFTER the CORS preflight so OPTIONS isn't blocked.
  // Hero summary calls Claude — expensive, so cap aggressively.
  if (!rateLimit(req, res, 'hero-summary', 30)) return;

  var url = new URL(req.url, 'http://localhost');
  var ticker = (url.searchParams.get('ticker') || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'ticker required' });
  }

  var apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'AI summary not configured' });
  }

  var tFilter = 'ticker=eq.' + encodeURIComponent(ticker);
  // narrative_analyses query — last 3 days, up to 10 rows. Uses snapshot_date
  // which is the per-article scrape date. Empty result is fine; compactState
  // falls back to the deduped scorecard narratives view.
  var sinceISO = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  var [storyRows, scoreRows, healthRows, narrativeRows, fvRows, articleRows] = await Promise.all([
    fetchSupabase('v_dash_daily_story?select=ticker,sector_name,price,price_change_pct,narrative_state,prism_verdict,story_claim,forensic_rebuttal,days_to_earnings,next_earnings_date,guidance_direction,earnings_surprise_pct,snapshot_date&' + tFilter + '&order=snapshot_date.desc&limit=1'),
    fetchSupabase('narrative_scorecard?select=ticker,verdict,narrative_state,coordination_score,walsh_regime,narrative_energy_regime,narrative_energy_absolute,current_sentiment,fvd_pct,snapshot_date&' + tFilter + '&order=snapshot_date.desc&limit=1'),
    fetchSupabase('v_dash_narrative_health?select=ticker,narrative_health,narrative_trend,snapshot_date&' + tFilter + '&order=snapshot_date.desc&limit=1'),
    fetchSupabase('v_narrative_scorecard_deduped?select=narrative,propagation_pressure,narrative_energy_regime,snapshot_date&' + tFilter + '&order=snapshot_date.desc,propagation_pressure.desc.nullslast&limit=8'),
    fetchSupabase('daily_fair_value?select=fair_value,fv_low,fv_high,verdict,premium_pct,pe_used,pe_5y_median,pe_implied,industry_pe_median,snapshot_date&' + tFilter + '&fair_value=not.is.null&order=snapshot_date.desc&limit=1'),
    fetchSupabase('narrative_analyses?select=narrative_text,source_outlet,sentiment_score,snapshot_date&' + tFilter + '&snapshot_date=gte.' + sinceISO + '&order=snapshot_date.desc&limit=10')
  ]);

  var story = (storyRows && storyRows[0]) || null;
  var scorecard = (scoreRows && scoreRows[0]) || null;
  var health = (healthRows && healthRows[0]) || null;
  var narratives = narrativeRows || [];
  var fairValue = (fvRows && fvRows[0]) || null;
  var articles = articleRows || [];

  if (!story && !scorecard && !narratives.length && !articles.length) {
    return res.status(404).json({ error: 'no data for ticker', ticker: ticker });
  }

  var stateBlock = compactState(story, scorecard, health, narratives, fairValue, articles);
  // Hard-rule reinforcement: if neither daily_fair_value nor scorecard fvd_pct
  // provided a valuation gap, forbid the LLM from inventing one. System prompt
  // already says this, but a per-request rule next to the data is harder to miss.
  var hasFV = (fairValue && fairValue.fair_value != null)
    || (scorecard && scorecard.fvd_pct != null);
  var fvRule = hasFV ? '' :
    '\n\nIMPORTANT: No fair-value data is available for this ticker. Do NOT mention fair value, valuation, premium, discount, over/undervalued, or any "X% above/below fair value" phrasing. Focus sentence 2 on narrative health and earnings instead.';
  var userMessage = 'Ticker dashboard state:\n\n' + stateBlock + fvRule + '\n\nWrite the 2-3 sentence editorial paragraph now.';

  // If there's no real narrative material to synthesize from (no fresh articles,
  // no named narratives, no story claim), don't ask the LLM to write from empty
  // inputs — it refuses, and the refusal leaks to the page. Return an empty
  // summary so the caller shows its neutral / coverage-in-progress fallback.
  var hasNamedNarrative = narratives.some(function(n) { return n && n.narrative && String(n.narrative).trim(); });
  var hasStoryClaim = story && (story.story_claim || story.forensic_rebuttal);
  if (!articles.length && !hasNamedNarrative && !hasStoryClaim) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json({ ticker: ticker, summary: '', reason: 'insufficient_narrative_content' });
  }

  try {
    var apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 360,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!apiRes.ok) {
      var errBody = await apiRes.text().catch(function() { return ''; });
      console.error('Anthropic error', apiRes.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'AI service error (' + apiRes.status + ')' });
    }

    var data = await apiRes.json();
    var text = (data.content && data.content[0] && data.content[0].text || '').trim();
    // Defensive: collapse any stray newlines into a single sentence.
    text = text.replace(/\s+/g, ' ').trim();
    // Never return a raw refusal / meta-response as the summary — the caller
    // renders it verbatim. Fall back to empty so the UI shows its neutral state.
    // (Belt-and-suspenders with the pre-LLM insufficient-content guard above.)
    if (!text || isBadSummary(text)) {
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.status(200).json({ ticker: ticker, summary: '', reason: 'no_valid_summary' });
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ticker: ticker,
      summary: text,
      snapshot_date: (story && story.snapshot_date) || (scorecard && scorecard.snapshot_date) || null,
      model: 'claude-haiku-4-5'
    });
  } catch (err) {
    console.error('hero-summary error', err);
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
};
