// Daily Plays — Top AI Picks via Claude API
// Vercel Serverless Function (Node.js runtime)
//
// Cache strategy: check Supabase ai_daily_picks first (persists across cold
// starts). Only call Claude when no row exists for today's snapshot_date.
// In-memory CACHE Map acts as a hot layer to skip the Supabase round-trip on
// subsequent requests within the same function instance.

const { isHidden: isHiddenTicker } = require('./_hidden-tickers');

// FIX 2A — a pick may never be persisted/returned as Long when the forensic
// verdict is bearish OR price sits above fair value (fvd > 0 = overvalued).
// Deterministic, verdict-driven; mirrors the frontend Conviction List guard.
const BEARISH_VERDICTS = new Set([
  'Narrative Risk', 'Narrative Trap', 'Air Pocket Short',
  'Drift Compression Short', 'Exhausted Narrative', 'Omission Cascade'
]);
function longContradictsForensics(pick, signals) {
  var isLong = pick && (pick.direction === 'BULLISH' || pick.action === 'Long');
  if (!isLong || !signals) return false;
  if (signals.verdict && BEARISH_VERDICTS.has(signals.verdict)) return true;
  if (signals.fvd != null && Number(signals.fvd) > 0) return true; // overvalued
  return false;
}

const CACHE = new Map(); // key = snapshot_date, value = {picks, generated_at, model}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h safety cap

const RATE_LIMIT = {};
const RATE_WINDOW = 60 * 1000;
const MAX_REQUESTS = 10;

function rateCheck(ip) {
  var now = Date.now();
  if (!RATE_LIMIT[ip]) RATE_LIMIT[ip] = [];
  RATE_LIMIT[ip] = RATE_LIMIT[ip].filter(function(t) { return now - t < RATE_WINDOW; });
  if (RATE_LIMIT[ip].length >= MAX_REQUESTS) return false;
  RATE_LIMIT[ip].push(now);
  return true;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

function getSbCreds() {
  var url = process.env.SUPABASE_URL || '';
  var key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
  return { url, key };
}

async function sbRead(snapshotDate) {
  var { url, key } = getSbCreds();
  if (!url || !key) return null;
  try {
    var r = await fetch(url + '/rest/v1/ai_daily_picks?snapshot_date=eq.' + encodeURIComponent(snapshotDate) + '&limit=1', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    if (!r.ok) return null;
    var rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (_) { return null; }
}

async function sbWrite(snapshotDate, picks, model) {
  var { url, key } = getSbCreds();
  if (!url || !key) return;
  try {
    await fetch(url + '/rest/v1/ai_daily_picks', {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ snapshot_date: snapshotDate, picks: picks, model: model, generated_at: new Date().toISOString() })
    });
  } catch (_) {}
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Market Prism senior signal analyst. You receive a compact JSON list of tickers with forensic signals derived from the narrative scorecard pipeline. Your job is to surface the 10 highest-conviction trades for the day across ALL setup types — day trade, swing, momentum, earnings, value, or trap shorts.

You are NOT re-sorting by a single metric. You synthesize across signals. Prefer tickers that light up on multiple independent dimensions (e.g. Clear Path + low NRS + positive WKS + narrative energy), over tickers strong on only one axis.

SIGNAL GLOSSARY (use these terms in your thesis lines, never invent new ones):
- nrs: Narrative Risk Score (0-100, higher = more forensic risk)
- wks_score: Keyword sentiment (-100 to +100, + bullish, - bearish)
- walsh_regime: CLEAR_PATH (bullish), PERSISTENT (bearish entrenchment), DRIFT (quiet short), or null
- narrative_energy_absolute: raw energy (>500 = momentum present, >1000 = explosive)
- fvd_pct: fundamental-value deviation (negative = undervalued)
- verdict: "Narrative Trap" / "Structurally Supported" / etc
- half_life: narrative decay window in days (<15 = fast-moving)
- coordination_score: coordinated-coverage signal (0-100, >30 = suspicious)
- drift_score: off-narrative price drift (0-100, >60 = divergence)

OUTPUT FORMAT — respond ONLY with a JSON array, no prose, no markdown fences. Exactly 10 entries:
[
  {
    "ticker": "NVDA",
    "action": "Long" | "Short" | "Watch",
    "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
    "conviction": 1-100,
    "thesis": "One sentence, under 140 chars, lead with the cross-signal pattern. No hype words."
  },
  ...
]

RULES:
- Return valid JSON only. No leading text, no trailing text, no code fences.
- Rank by conviction descending.
- Never use the words: crash, violent, guaranteed, certain, moonshot, explosion.
- Thesis must reference at least two distinct signals (e.g. "Clear Path regime with NRS 18 and +42 WKS"). Numbers belong in the thesis.
- Do NOT recommend position sizing or stops. This is signal synthesis, not financial advice.
- If fewer than 10 tickers meet a reasonable conviction bar, return what you have — do not pad.`;

function pickCompact(r) {
  return {
    ticker: r.ticker,
    price: r.price,
    nrs: r.nrs,
    wks: r.wks_score,
    regime: r.walsh_regime,
    energy: r.narrative_energy_absolute,
    energy_regime: r.narrative_energy_regime,
    mass: r.narrative_mass_score,
    coord: r.coordination_score,
    drift: r.drift_score,
    half_life: r.half_life,
    fvd: r.fvd_pct,
    vms: r.vms,
    verdict: r.verdict,
    conf: r.verdict_confidence,
    dte: r._earn ? r._earn.days_to_earnings : null,
    surprise: r._earn ? r._earn.earnings_surprise_pct : null
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  ip = ip.split(',')[0].trim();
  if (!rateCheck(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  }

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  var snapshotDate = (body && body.snapshot_date) ? String(body.snapshot_date) : '';
  var rows = (body && Array.isArray(body.rows)) ? body.rows : [];
  if (!snapshotDate || !rows.length) {
    return res.status(400).json({ error: 'snapshot_date and rows[] required' });
  }

  // 1. In-memory hot cache (same function instance)
  var cached = CACHE.get(snapshotDate);
  if (cached && (Date.now() - cached.generated_at) < CACHE_TTL_MS) {
    return res.status(200).json({ picks: cached.picks, snapshot_date: snapshotDate, model: cached.model, cached: true });
  }

  // 2. Supabase persistent cache (survives cold starts)
  var sbRow = await sbRead(snapshotDate);
  if (sbRow && sbRow.picks) {
    var sbPicks = (Array.isArray(sbRow.picks) ? sbRow.picks : [])
      .filter(function(p){ return p && !isHiddenTicker(p.ticker); });
    CACHE.set(snapshotDate, { picks: sbPicks, generated_at: Date.now(), model: sbRow.model });
    return res.status(200).json({ picks: sbPicks, snapshot_date: snapshotDate, model: sbRow.model, cached: true });
  }

  // 3. No cache — call Claude
  var apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'AI picks not configured (no ANTHROPIC_API_KEY / ANTHROPIC_KEY in env).' });
  }

  var candidates = rows.filter(function(r) {
    if (!r || !r.ticker) return false;
    if (isHiddenTicker(r.ticker)) return false;
    return (r.walsh_regime === 'CLEAR_PATH')
      || (r.walsh_regime === 'PERSISTENT' && r.nrs > 40)
      || (r.narrative_energy_absolute > 500)
      || (r.fvd_pct != null && r.fvd_pct < -5)
      || (r.verdict === 'Narrative Trap' || r.verdict === 'Narrative Risk')
      || (r.half_life < 15)
      || (r.drift_score > 60)
      || (r._earn && r._earn.days_to_earnings != null && Math.abs(r._earn.days_to_earnings) <= 7);
  }).slice(0, 120).map(pickCompact);

  if (!candidates.length) {
    return res.status(200).json({ picks: [], snapshot_date: snapshotDate, model: null });
  }

  var userMessage = 'Snapshot date: ' + snapshotDate + '\n\nCandidate tickers (JSON):\n' + JSON.stringify(candidates);

  var MODEL_CHAIN = ['claude-sonnet-4-6', 'claude-haiku-4-5'];

  async function callAnthropic(model) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
  }

  try {
    var response = null;
    var lastErrText = '';
    var lastStatus = 0;
    var modelUsed = null;

    for (var i = 0; i < MODEL_CHAIN.length; i++) {
      var model = MODEL_CHAIN[i];
      response = await callAnthropic(model);
      if (!response.ok && response.status >= 500 && response.status < 600) {
        await new Promise(function(r){ setTimeout(r, 800); });
        response = await callAnthropic(model);
      }
      if (response.ok) { modelUsed = model; break; }
      lastStatus = response.status;
      lastErrText = await response.text();
      console.error('Anthropic API error:', model, lastStatus, lastErrText);
      if (lastStatus < 500 || lastStatus >= 600) break;
    }

    if (!response || !response.ok) {
      var detail = '';
      try {
        var parsed = JSON.parse(lastErrText);
        detail = (parsed && parsed.error && parsed.error.message) ? parsed.error.message : lastErrText;
      } catch (_) { detail = lastErrText || ''; }
      detail = String(detail).slice(0, 240);
      return res.status(502).json({ error: 'AI service error (' + lastStatus + ')' + (detail ? ': ' + detail : '') });
    }

    var data = await response.json();
    var text = data.content && data.content[0] ? data.content[0].text : '';

    var picks = null;
    try {
      picks = JSON.parse(text);
    } catch (e) {
      var start = text.indexOf('[');
      var end = text.lastIndexOf(']');
      if (start >= 0 && end > start) {
        try { picks = JSON.parse(text.slice(start, end + 1)); } catch (e2) { picks = null; }
      }
    }

    if (!Array.isArray(picks)) {
      return res.status(502).json({ error: 'AI returned unparseable response' });
    }

    // Map each candidate ticker back to its forensic signals so we can drop
    // any model "Long" call that contradicts the verdict / fair-value gap.
    var candByTicker = {};
    candidates.forEach(function(c){ if (c && c.ticker) candByTicker[c.ticker] = { verdict: c.verdict, fvd: c.fvd }; });

    var clean = picks.filter(function(p){
      if (!p || !p.ticker || isHiddenTicker(p.ticker)) return false;
      if (longContradictsForensics(p, candByTicker[String(p.ticker).toUpperCase()])) return false;
      return true;
    }).slice(0, 10).map(function(p){
      return {
        ticker: String(p.ticker).toUpperCase().slice(0, 8),
        action: ['Long','Short','Watch'].indexOf(p.action) >= 0 ? p.action : 'Watch',
        direction: ['BULLISH','BEARISH','NEUTRAL'].indexOf(p.direction) >= 0 ? p.direction : 'NEUTRAL',
        conviction: Math.max(0, Math.min(100, Number(p.conviction) || 0)),
        thesis: String(p.thesis || '').slice(0, 180)
      };
    });

    // Persist to both caches so future calls (any cold start) skip Claude
    CACHE.set(snapshotDate, { picks: clean, generated_at: Date.now(), model: modelUsed });
    await sbWrite(snapshotDate, clean, modelUsed);

    return res.status(200).json({ picks: clean, snapshot_date: snapshotDate, model: modelUsed, cached: false });
  } catch (err) {
    console.error('Top AI Picks error:', err);
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
};
