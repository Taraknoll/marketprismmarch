// ──────────────────────────────────────────────────────────────────────────
// POST /api/anomaly-agent — Agentic forensic anomaly assistant (preview)
//
// Self-contained CommonJS Vercel function. Drives an agentic tool-calling loop
// against Claude (model claude-sonnet-4-6) over the Market Prism dataset: the
// forensic scorecard + bubble + circular-finance core (curated REST tools) plus
// a read-only text-to-SQL escape hatch (run_sql/describe_schema) that spans the
// whole public schema EXCEPT a hard-blocked PII/billing/brokerage set (see
// _ro_sql.BLOCKED_RELATION_PATTERNS). Everything is READ-ONLY: curated tools
// fetch PostgREST with the anon key (SELECT only); run_sql uses a dedicated
// SELECT-only Postgres role. The model NEVER writes the DB and the server NEVER
// leaks keys to the client.
//
// Request:  { messages: [ { role:'user'|'assistant', content:string }, ... ] }
// Response: { ok, answer, cards, debug:{ toolCalls, ms, model, turns, fellBack? }, error? }
//
// Env (all already set in prod): ANTHROPIC_KEY, SUPABASE_URL, SUPABASE_ANON.
// Page-serving sibling api/anomaly-search.js + vercel.json are NOT touched here.
// ──────────────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_TURNS = 4;
const ROW_CAP = 50;

// Read-only text-to-SQL escape hatch (Option 1: dedicated SELECT-only Postgres role).
const ro = require('./_ro_sql');
const { SCHEMA_DIGEST, describeSchema } = require('./_schema_digest');
const requireAuth = require('./_require-auth');

// Foreign-filer artifacts: VMS≈50 / drift=100 artifacts with no real 10-K to
// anchor — excluded from every scorecard cross-section.
const FOREIGN_FILERS = ['TSM', 'NIO', 'BHP', 'RIO', 'VALE', 'NVO', 'RACE', 'STN', 'SPOT', 'GOLD'];

// Exact, case-sensitive macro_theme strings on narrative_scorecard.
const MACRO_THEMES = [
  'Company_Specific', 'Earnings_Season', 'Sector_Rotation', 'AI_Infrastructure',
  'Other', 'Consumer_Demand', 'AI_software_disruption', 'Energy_Transition',
  'Rate_Cycle', 'Geopolitical', 'Supply_Constraint', 'GLP1_disruption',
  'EV_competition', 'Tariff_Trade_War',
];

// Public-entity → ticker map for circular-finance enrichment (private cos = null).
// Resolved live from circular_finance_entities at call time; this is a fallback.
const ENTITY_TICKER_FALLBACK = {
  Alphabet: 'GOOGL', Amazon: 'AMZN', AMD: 'AMD', Broadcom: 'AVGO',
  CoreWeave: 'CRWV', Microsoft: 'MSFT', Nebius: 'NBIS', NVIDIA: 'NVDA', Oracle: 'ORCL',
};

// ── helpers ────────────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 1) {
  const n = num(v);
  if (n === null) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function clampLimit(v, def = 20) {
  const n = num(v);
  if (n === null) return def;
  return Math.max(1, Math.min(ROW_CAP, Math.floor(n)));
}

function cleanTicker(t) {
  if (typeof t !== 'string') return '';
  // Allow only A-Z, digits and dot (BRK.B); upper-case. Prevents filter injection.
  return t.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
}

async function readBody(req) {
  // req.body may be a parsed object, a string, or undefined on Vercel node.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  // Fall back to reading the raw stream.
  try {
    const chunks = [];
    for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// PostgREST GET. Read-only; anon key in headers only (never returned to client).
async function rest(pathAndQuery, debugQueries) {
  const url = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON || '';
  if (!url || !anon) throw new Error('supabase env missing');
  const full = `${url.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  if (Array.isArray(debugQueries)) {
    // Record the path+query only — strip the host so no env leaks into debug.
    debugQueries.push(`/rest/v1/${pathAndQuery}`);
  }
  const resp = await fetch(full, {
    method: 'GET',
    headers: {
      apikey: anon,
      Authorization: 'Bearer ' + anon,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`postgrest ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// Per-request cache of latest snapshot_date for a given resource.
function makeSnapshotCache(debugQueries) {
  const cache = {};
  return async function latestSnapshot(resource) {
    if (cache[resource] !== undefined) return cache[resource];
    const rows = await rest(
      `${resource}?select=snapshot_date&order=snapshot_date.desc&limit=1`,
      debugQueries
    );
    const d = rows.length ? rows[0].snapshot_date : null;
    cache[resource] = d;
    return d;
  };
}

const FOREIGN_EXCL = `ticker=not.in.(${FOREIGN_FILERS.join(',')})`;

// ── axis / risk computation (shared) ────────────────────────────────────────

function computeAxes(row, bubbleActive) {
  const axes = [];
  if (num(row.drift_score) !== null && num(row.drift_score) >= 70) axes.push('drift');
  if (num(row.coordination_score) !== null && num(row.coordination_score) >= 20) axes.push('coordination');
  if (num(row.suspicion_score) !== null && num(row.suspicion_score) >= 60) axes.push('suspicion');
  const fvd = num(row.fvd_pct);
  if (fvd !== null && Math.abs(fvd) >= 100) axes.push('fvd');
  if (bubbleActive) axes.push('bubble');
  return axes;
}

function riskStatusFrom(axesCount, nrs) {
  const n = num(nrs);
  if (axesCount >= 3 || (n !== null && n >= 70)) return 'HIGH';
  if (axesCount === 2 || (n !== null && n >= 50)) return 'ELEVATED';
  if (axesCount === 1 || (n !== null && n >= 30)) return 'MODERATE';
  return 'LOW';
}

function flagLevel(value, thresholds) {
  // thresholds: [severe, elevated, weak] ascending; returns level label.
  const v = num(value);
  if (v === null) return 'ok';
  if (v >= thresholds[0]) return 'severe';
  if (v >= thresholds[1]) return 'elevated';
  if (v >= thresholds[2]) return 'weak';
  return 'ok';
}

// ── plain-English layer (finance-literate, deterministic, honest) ────────────
const AXIS_PLAIN = {
  drift:        'story has drifted from the filing',
  coordination: 'synchronized coverage across outlets',
  suspicion:    'abnormal trading footprint',
  fvd:          'price far from fundamentals',
  bubble:       'active price bubble',
};

// FVD% = (price/fair_value - 1) * 100, so price/fair = 1 + fvd/100.
function valuationClause(fvdPct) {
  const f = num(fvdPct);
  if (f === null) return null;
  const mult = 1 + f / 100;
  if (mult >= 1.5)  return `trades at ~${mult.toFixed(1)}× what its fundamentals justify`;
  if (mult >= 1.15) return `carries a ~${Math.round(f)}% premium to fundamentals`;
  if (mult >= 0.9)  return 'is priced roughly in line with fundamentals';
  if (mult > 0)     return `trades ~${Math.round(Math.abs(f))}% below fundamental fair value`;
  return 'is priced below any fundamental anchor';
}

function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Returns { plain, headline, firing } — a one-line analyst verdict + confluence headline.
function plainDossier(r, bubbleActive, axes) {
  const vms = num(r.vms), drift = num(r.drift_score);
  const coordHot = (num(r.coordination_score) || 0) >= 20 || r.coordination_class === 'LIKELY_COORDINATED';
  const tapeHot  = r.suspicion_class === 'HIGH_MANIPULATION_RISK';
  const tapeCalm = r.suspicion_class === 'NORMAL_ACTIVITY' || r.suspicion_class === 'NORMAL';

  // drift fires on selective framing, NOT just falsity — keep the language honest.
  let claims;
  if (vms !== null && vms >= 80) claims = 'the claims line up with the filings';
  else if (vms !== null && vms < 50) claims = "the claims don't square with the filings";
  else claims = 'the claims only partly match the filings';
  if (drift !== null && drift >= 70) claims += ', but the story is framed well beyond what was filed';

  let coordClause = null;
  if (coordHot && tapeCalm) coordClause = 'coverage is running in lockstep across outlets while the tape stays calm — an orchestrated story, not a provable crime';
  else if (coordHot && tapeHot) coordClause = 'coverage is synchronized and the trading footprint is abnormal — the strongest manipulation-shaped pattern';
  else if (coordHot) coordClause = 'coverage looks synchronized across outlets';
  else if (tapeHot)  coordClause = 'the trading footprint looks abnormal for the story';

  const val = valuationClause(r.fvd_pct);
  const parts = [];
  if (val) parts.push(`The stock ${val}`);
  parts.push(capFirst(claims));
  if (coordClause) parts.push(capFirst(coordClause));
  const plain = parts.join('. ') + '.';

  const firing = (axes || []).map((a) => AXIS_PLAIN[a]).filter(Boolean);
  const headline = firing.length
    ? `${firing.length} forensic red flag${firing.length === 1 ? '' : 's'} firing: ${firing.join(' · ')}.`
    : 'No forensic red flags firing — structurally clean.';

  return { plain, headline, firing };
}

function plainNarrativeLab(focus, peers, state) {
  const median = (arr) => { const a = arr.filter((v) => v !== null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
  const ff = num(focus.fvd_pct), fd = num(focus.drift_score);
  const mFvd = median((peers || []).map((p) => num(p.fvdPct)));
  const mDrift = median((peers || []).map((p) => num(p.drift)));
  const bits = [];
  if (ff !== null && mFvd !== null) bits.push(ff > mFvd ? 'more richly valued than the median peer' : 'cheaper than the median peer');
  if (fd !== null && mDrift !== null) bits.push(fd > mDrift ? 'its story has drifted further from the filings' : 'its story tracks the filings more closely than most');
  const tail = bits.length ? ` Versus its peers, it's ${bits.join(', and ')}.` : '';
  const phase = String(state || '').toLowerCase().replace(/_/g, ' ') || 'unclassified';
  const n = (peers || []).length;
  return `${focus.ticker || ''} sits with ${n} same-phase peer${n === 1 ? '' : 's'} in the ${phase} group.${tail}`;
}

// period_of_report is inconsistent across sources (ISO date, or a unix epoch for yfinance rows).
function fmtPeriod(p) {
  if (p == null) return null;
  const s = String(p);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{9,}$/.test(s)) { const d = new Date(Number(s) * 1000); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
  return s;
}
// Filing snippets carry HTML entities (e.g. MANAGEMENT&#8217;S) — decode before display.
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => { const c = parseInt(n, 10); return isFinite(c) ? String.fromCharCode(c) : ''; })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// ── tool executors + card builders ──────────────────────────────────────────
// Each returns { card | cards, rowCount, summary } — summary is the JSON fed
// back to Claude as the tool_result.

async function execTickerDossier(input, ctx) {
  const ticker = cleanTicker(input && input.ticker);
  if (!ticker) return { rowCount: 0, summary: { error: 'no valid ticker provided' } };
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  const cols = 'ticker,snapshot_date,verdict,vms,vms_gap,drift_score,drift_explanation,' +
    'coordination_score,coordination_class,suspicion_score,suspicion_class,energy_remaining,' +
    'narrative_state,narrative_mass,walsh_regime,signal_regime,fvd,fvd_pct,fair_value,' +
    'earnings_credibility_score,nrs,ccp,srs,macro_theme';
  const rows = await rest(
    `narrative_scorecard?select=${cols}&snapshot_date=eq.${snap}&ticker=eq.${ticker}&limit=1`,
    ctx.debugQueries
  );
  if (!rows.length) {
    return { rowCount: 0, summary: { ticker, found: false, note: `no scorecard row for ${ticker} on ${snap}` } };
  }
  const r = rows[0];

  // Bubble status for this ticker (latest bubble snapshot).
  let bubbleActive = false;
  let bubbleRegime = null;
  try {
    const bsnap = await ctx.latestSnapshot('bubble_metrics');
    if (bsnap) {
      const brows = await rest(
        `bubble_metrics?select=ticker,regime,bubble_active_idio,bsadf_now,crit_value&snapshot_date=eq.${bsnap}&ticker=eq.${ticker}&limit=1`,
        ctx.debugQueries
      );
      if (brows.length) {
        bubbleActive = brows[0].bubble_active_idio === true;
        bubbleRegime = brows[0].regime || null;
      }
    }
  } catch (_) { /* bubble is optional context */ }

  const axes = computeAxes(r, bubbleActive);
  const riskStatus = riskStatusFrom(axes.length, r.nrs);
  const plain = plainDossier(r, bubbleActive, axes);

  const metrics = [
    { label: 'Verdict', value: r.verdict || '—' },
    { label: 'NRS', value: round(r.nrs, 0) },
    { label: 'VMS', value: round(r.vms, 0) },
    { label: 'Drift', value: round(r.drift_score, 0) },
    { label: 'Coordination', value: round(r.coordination_score, 0) },
    { label: 'Suspicion', value: r.suspicion_class || round(r.suspicion_score, 0) },
    { label: 'FVD %', value: round(r.fvd_pct, 1) },
    { label: 'Energy', value: round(r.energy_remaining, 0) },
    { label: 'State', value: r.narrative_state || '—' },
    { label: 'Regime', value: r.walsh_regime || r.signal_regime || '—' },
  ];

  const flags = [
    { name: 'Narrative drift', level: flagLevel(r.drift_score, [70, 50, 30]),
      reading: r.drift_explanation ? String(r.drift_explanation).slice(0, 220) : `drift_score=${round(r.drift_score, 0)}` },
    { name: 'Coordination', level: flagLevel(r.coordination_score, [40, 20, 10]),
      reading: `${r.coordination_class || 'n/a'} (score ${round(r.coordination_score, 0)})` },
    { name: 'Trading footprint', level: r.suspicion_class === 'HIGH_MANIPULATION_RISK' ? 'severe'
        : r.suspicion_class === 'MODERATE' ? 'elevated' : 'ok',
      reading: `${r.suspicion_class || 'n/a'} — trading-footprint read, NOT a manipulation verdict` },
    { name: 'Fair-value divergence', level: (() => {
        const a = Math.abs(num(r.fvd_pct) || 0);
        return a >= 150 ? 'severe' : a >= 100 ? 'elevated' : a >= 50 ? 'weak' : 'ok';
      })(), reading: `FVD ${round(r.fvd_pct, 1)}% vs fair value ${round(r.fair_value, 2)}` },
    { name: 'Bubble (idiosyncratic)', level: bubbleActive ? 'elevated' : 'ok',
      reading: bubbleActive ? `bubble_active_idio=true (${bubbleRegime || 'regime n/a'})` : 'no active idiosyncratic bubble' },
  ];

  // ── Receipts: evidence the user can click through to (parallel, best-effort) ─
  const receipts = {};
  const [covRows, coordRows, filingRows] = await Promise.all([
    rest(`articles?select=title,publication_name,published_at,url,narrative_direction_gemini&ticker=eq.${ticker}&is_about_ticker_gemini=is.true&order=published_at.desc&limit=5`, ctx.debugQueries).catch(() => []),
    rest(`coordination_flags?select=sources_within_1hr,identical_phrasing_count,identical_phrases_json,has_primary_source,primary_source_url,coordination_score,coordination_class&ticker=eq.${ticker}&order=snapshot_date.desc&limit=1`, ctx.debugQueries).catch(() => []),
    rest(`claim_verifications?select=form_type,period_of_report,filing_date,sec_revenue,sec_eps,vms_score,mda_snippet&ticker=eq.${ticker}&order=snapshot_date.desc&limit=1`, ctx.debugQueries).catch(() => []),
  ]);
  if (covRows && covRows.length) {
    receipts.coverage = covRows.map((a) => {
      let t = a.title || '';
      if (a.publication_name && t.endsWith(' - ' + a.publication_name)) t = t.slice(0, -(' - ' + a.publication_name).length);
      return { title: t, source: a.publication_name, at: a.published_at, url: a.url, direction: a.narrative_direction_gemini };
    });
  }
  if (coordRows && coordRows.length) {
    const c0 = coordRows[0];
    const cscore = num(c0.coordination_score) || 0;
    if (cscore >= 40 || c0.coordination_class === 'LIKELY_COORDINATED' || c0.coordination_class === 'SUSPICIOUS_PATTERN') {
      let phrases = [];
      try { let j = c0.identical_phrases_json; if (typeof j === 'string') j = JSON.parse(j); if (Array.isArray(j)) phrases = j.slice(0, 3).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))); } catch (_) { /* phrases optional */ }
      receipts.coordination = {
        sourcesWithin1hr: num(c0.sources_within_1hr), identicalPhrasing: num(c0.identical_phrasing_count),
        phrases, primarySourceUrl: c0.has_primary_source ? c0.primary_source_url : null, cls: c0.coordination_class,
      };
    }
  }
  if (filingRows && filingRows.length) {
    const f = filingRows[0];
    receipts.filing = {
      isSec: !!(f.form_type && f.form_type !== 'yfinance'),
      form: f.form_type, period: fmtPeriod(f.period_of_report),
      revenue: num(f.sec_revenue), eps: num(f.sec_eps), vms: num(f.vms_score),
      snippet: f.mda_snippet ? decodeEntities(String(f.mda_snippet)).slice(0, 260) : null,
    };
  }

  const card = {
    ui: 'risk_dossier',
    ticker,
    subtitle: `${r.verdict || 'Monitoring'} · ${snap} · theme ${r.macro_theme || 'n/a'}`,
    riskStatus,
    plain: plain.plain,
    headline: plain.headline,
    firing: plain.firing,
    metrics,
    flags,
    receipts: Object.keys(receipts).length ? receipts : undefined,
  };

  const summary = {
    ticker, snapshot_date: snap, verdict: r.verdict,
    nrs: num(r.nrs), vms: num(r.vms), vms_gap: num(r.vms_gap),
    drift_score: num(r.drift_score), coordination_score: num(r.coordination_score),
    coordination_class: r.coordination_class, suspicion_score: num(r.suspicion_score),
    suspicion_class: r.suspicion_class, fvd_pct: num(r.fvd_pct), fair_value: num(r.fair_value),
    energy_remaining: num(r.energy_remaining), narrative_state: r.narrative_state,
    walsh_regime: r.walsh_regime, macro_theme: r.macro_theme,
    earnings_credibility_score: num(r.earnings_credibility_score),
    bubble_active_idio: bubbleActive, bubble_regime: bubbleRegime,
    axes, risk_status: riskStatus,
    drift_explanation: r.drift_explanation || null,
  };
  return { card, rowCount: 1, summary };
}

async function execNarrativeLab(input, ctx) {
  const ticker = cleanTicker(input && input.ticker);
  if (!ticker) return { rowCount: 0, summary: { error: 'no valid ticker provided' } };
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  const cols = 'ticker,verdict,narrative_state,vms,drift_score,fvd_pct,nrs,coordination_class';
  const focusRows = await rest(
    `narrative_scorecard?select=${cols}&snapshot_date=eq.${snap}&ticker=eq.${ticker}&limit=1`,
    ctx.debugQueries
  );
  if (!focusRows.length) {
    return { rowCount: 0, summary: { ticker, found: false, note: `no scorecard row for ${ticker}` } };
  }
  const focus = focusRows[0];
  const state = focus.narrative_state || null;

  // Same-state peers (foreign filers excluded), excluding the focus ticker.
  let peers = [];
  if (state) {
    const peerRows = await rest(
      `narrative_scorecard?select=ticker,narrative_state,vms,drift_score,fvd_pct&snapshot_date=eq.${snap}` +
      `&narrative_state=eq.${encodeURIComponent(state)}&ticker=neq.${ticker}&${FOREIGN_EXCL}` +
      `&order=drift_score.desc&limit=${ROW_CAP}`,
      ctx.debugQueries
    );
    peers = peerRows.slice(0, 12).map((p) => ({
      ticker: p.ticker, state: p.narrative_state,
      vms: round(p.vms, 0), drift: round(p.drift_score, 0), fvdPct: round(p.fvd_pct, 1),
    }));
  }

  const totalPeers = peers.length;
  const consensusPct = totalPeers
    ? Math.round((peers.filter((p) => p.state === state).length / totalPeers) * 100)
    : 0;

  const synthesis = `${ticker} is classified ${state || 'unclassified'} ` +
    `(verdict ${focus.verdict || 'Monitoring'}, NRS ${round(focus.nrs, 0)}, drift ${round(focus.drift_score, 0)}). ` +
    `${totalPeers} same-state peer${totalPeers === 1 ? '' : 's'} on ${snap}. ` +
    `Verdict is valuation-anchored, not a falsity label — read the components (drift/coordination), not the headline.`;

  const plain = plainNarrativeLab(focus, peers, state);
  const card = {
    ui: 'narrative_lab',
    ticker,
    plain,
    synthesis,
    consensusPct,
    consensusCaption: state ? `${totalPeers} peers share the ${state} state` : 'no state classification',
    peers,
  };
  const summary = {
    ticker, snapshot_date: snap, narrative_state: state, verdict: focus.verdict,
    peer_count: totalPeers, peers: peers.map((p) => ({ ticker: p.ticker, vms: p.vms, drift: p.drift, fvdPct: p.fvdPct })),
  };
  return { card, rowCount: totalPeers + 1, summary };
}

async function execDailyAnomalyFeed(input, ctx) {
  const limit = clampLimit(input && input.limit, 20);
  const minConfluence = Math.max(0, Math.floor(num(input && input.minConfluence) || 1));
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  const cols = 'ticker,verdict,drift_score,coordination_score,suspicion_score,fvd_pct,nrs,narrative_state';
  const rows = await rest(
    `narrative_scorecard?select=${cols}&snapshot_date=eq.${snap}&${FOREIGN_EXCL}` +
    `&order=nrs.desc&limit=${ROW_CAP}`,
    ctx.debugQueries
  );

  // Bubble actives for the latest bubble snapshot → set of tickers.
  const bubbleSet = new Set();
  try {
    const bsnap = await ctx.latestSnapshot('bubble_metrics');
    if (bsnap) {
      const brows = await rest(
        `bubble_metrics?select=ticker,bubble_active_idio&snapshot_date=eq.${bsnap}&bubble_active_idio=is.true&limit=${ROW_CAP}`,
        ctx.debugQueries
      );
      brows.forEach((b) => bubbleSet.add(b.ticker));
    }
  } catch (_) { /* optional */ }

  const scored = rows.map((r) => {
    const axes = computeAxes(r, bubbleSet.has(r.ticker));
    return {
      ticker: r.ticker,
      score: round(r.nrs, 0) || 0,
      confluence: axes.length,
      axes,
      state: r.narrative_state || '—',
    };
  }).filter((x) => x.confluence >= minConfluence)
    .sort((a, b) => (b.confluence - a.confluence) || (b.score - a.score))
    .slice(0, limit);

  const top = scored[0];
  const multi = scored.filter((s) => s.confluence >= 2).length;
  const headline = scored.length
    ? `${scored.length} name${scored.length === 1 ? '' : 's'} showing forensic red flags today${multi ? `; ${multi} with two or more axes firing` : ''}. ${top.ticker} tops the list.`
    : 'No names are firing multiple forensic flags right now.';
  const card = {
    ui: 'anomaly_feed',
    asOf: snap,
    headline,
    rows: scored,
  };
  const summary = {
    snapshot_date: snap, minConfluence, returned: scored.length,
    rows: scored.map((x) => ({ ticker: x.ticker, score: x.score, confluence: x.confluence, axes: x.axes })),
    note: scored.length ? undefined : 'no tickers met the confluence threshold',
  };
  return { card, rowCount: scored.length, summary };
}

// "What changed today" — diff the latest scorecard snapshot vs the prior one for
// NEWLY-fired forensic axes (and verdict shifts). No bubble (separate table).
async function execWhatChanged(input, ctx) {
  const limit = clampLimit(input && input.limit, 25);
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  let prevSnap = null;
  try {
    const pr = await rest(
      `narrative_scorecard?select=snapshot_date&snapshot_date=lt.${snap}&order=snapshot_date.desc&limit=1`,
      ctx.debugQueries
    );
    if (pr.length) prevSnap = pr[0].snapshot_date;
  } catch (_) { /* no prior snapshot */ }

  const cols = 'ticker,verdict,drift_score,coordination_score,suspicion_score,fvd_pct,nrs,narrative_state';
  const [todayRows, prevRows] = await Promise.all([
    rest(`narrative_scorecard?select=${cols}&snapshot_date=eq.${snap}&${FOREIGN_EXCL}&limit=300`, ctx.debugQueries).catch(() => []),
    prevSnap ? rest(`narrative_scorecard?select=${cols}&snapshot_date=eq.${prevSnap}&${FOREIGN_EXCL}&limit=300`, ctx.debugQueries).catch(() => []) : Promise.resolve([]),
  ]);

  const TAG = { drift: 'drift', coordination: 'coordination', suspicion: 'footprint', fvd: 'valuation' };
  function axisSet(r) {
    const s = new Set();
    if ((num(r.drift_score) || 0) >= 70) s.add('drift');
    if ((num(r.coordination_score) || 0) >= 20) s.add('coordination');
    if ((num(r.suspicion_score) || 0) >= 60) s.add('suspicion');
    if (Math.abs(num(r.fvd_pct) || 0) >= 100) s.add('fvd');
    return s;
  }
  const prevMap = new Map();
  prevRows.forEach((r) => prevMap.set(r.ticker, { axes: axisSet(r), verdict: r.verdict }));

  const changes = [];
  todayRows.forEach((r) => {
    const today = axisSet(r);
    const prior = prevMap.get(r.ticker);
    const priorAxes = prior ? prior.axes : new Set();
    const newly = [...today].filter((a) => !priorAxes.has(a));
    const verdictChanged = !!(prior && prior.verdict && r.verdict && prior.verdict !== r.verdict);
    if (!newly.length && !verdictChanged) return;
    changes.push({
      ticker: r.ticker,
      score: round(r.nrs, 0) || 0,
      confluence: newly.length,
      axes: newly.map((a) => TAG[a] || a),
      state: r.narrative_state || '—',
      note: verdictChanged ? `verdict ${prior.verdict} → ${r.verdict}` : null,
      _new: newly.length,
    });
  });

  changes.sort((a, b) => (b._new - a._new) || (b.score - a.score));
  const rows = changes.slice(0, limit).map((c) => ({ ticker: c.ticker, score: c.score, confluence: c.confluence, axes: c.axes, state: c.state, note: c.note }));

  const newlyFlagged = changes.filter((c) => c._new > 0).length;
  const verdictShifts = changes.length - newlyFlagged;
  const headline = !prevSnap
    ? 'No prior snapshot to compare against yet.'
    : changes.length
      ? `${newlyFlagged} name${newlyFlagged === 1 ? '' : 's'} lit up new forensic flags since ${prevSnap}${verdictShifts ? `, plus ${verdictShifts} verdict shift${verdictShifts === 1 ? '' : 's'}` : ''}.`
      : `Nothing new lit up since ${prevSnap} — the board is quiet.`;

  const card = {
    ui: 'anomaly_feed',
    title: 'What changed today',
    subtitle: prevSnap ? `new vs ${prevSnap}` : 'no prior snapshot',
    asOf: snap,
    headline,
    rows,
  };
  const summary = {
    snapshot_date: snap, prev_snapshot: prevSnap, changed: rows.length,
    rows: rows.map((x) => ({ ticker: x.ticker, newly_fired: x.axes, note: x.note })),
    note: rows.length ? undefined : 'no transitions since the prior snapshot',
  };
  return { card, rowCount: rows.length, summary };
}

// Validate a narrative/thesis against the historical corpus via the existing
// /api/dots-predict engine (embeds the thesis, pgvector-searches narrative_dots).
// Honest framing: descriptive precedent, NOT a forward return signal.
async function execValidateNarrative(input, ctx) {
  const ticker = cleanTicker(input && input.ticker);
  const narrativeText = String((input && input.narrative) || '').trim();
  if (!ticker) return { rowCount: 0, summary: { error: 'validate_narrative needs a ticker (the company the thesis is about).' } };
  if (narrativeText.length < 10) return { rowCount: 0, summary: { error: 'validate_narrative needs a narrative/thesis of at least a sentence.' } };
  if (!ctx.origin) return { rowCount: 0, summary: { error: 'analogue engine unavailable (no request origin).' } };

  let data;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 28000);
    const r = await fetch(`${ctx.origin}/api/dots-predict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, narrativeText: narrativeText.slice(0, 4000) }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    data = await r.json().catch(() => ({}));
    if (ctx.debugQueries) ctx.debugQueries.push(`POST /api/dots-predict (${ticker}, ${data && data.n_similar_dots != null ? data.n_similar_dots + ' dots' : 'err'})`);
    if (!r.ok || (data && data.error)) return { rowCount: 0, summary: { error: (data && data.error) || `dots-predict ${r.status}` } };
  } catch (e) {
    return { rowCount: 0, summary: { error: 'analogue search failed: ' + (e && e.message ? e.message : 'unknown') } };
  }

  if (data.warning === 'no_similar_dots' || !data.n_similar_dots) {
    const card = { ui: 'narrative_validate', ticker, query: narrativeText.slice(0, 240), nSimilar: 0, warning: 'no_similar_dots' };
    return { card, rowCount: 0, summary: { ticker, n_similar_dots: 0, note: 'no close historical analogues in the corpus' } };
  }

  const pctOf = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 10); // fraction -> % (1 decimal)
  const card = {
    ui: 'narrative_validate',
    ticker,
    query: narrativeText.slice(0, 240),
    nSimilar: data.n_similar_dots,
    nResolved: data.n_resolved_neighbors,
    consensusPct: pctOf(data.narrative_hit_rate_5d),
    cluster: data.cluster_thesis_label ? {
      thesis: data.cluster_thesis_label,
      hitRatePct: pctOf(data.cluster_hit_rate_5d),
      nResolved: data.cluster_n_resolved,
      baselineDeltaPct: pctOf(data.cluster_baseline_delta),
    } : null,
    predicted: { d5: pctOf(data.predicted_5d_return), d10: pctOf(data.predicted_10d_return), d20: pctOf(data.predicted_20d_return) },
    examples: Array.isArray(data.neighbor_examples) ? data.neighbor_examples.slice(0, 3).map((n) => ({ ticker: n.ticker, narrative: n.narrative, at: n.observed_at })) : [],
  };
  const summary = {
    ticker, n_similar_dots: data.n_similar_dots, analogue_consensus_pct: card.consensusPct,
    cluster_thesis: data.cluster_thesis_label, cluster_hit_rate_pct: card.cluster ? card.cluster.hitRatePct : null,
    predicted_5d_pct: card.predicted.d5, note: 'descriptive precedent from similar past narratives — NOT a validated forward return signal',
  };
  return { card, rowCount: data.n_similar_dots, summary };
}

async function execStructuralScreen(input, ctx) {
  const limit = clampLimit(input && input.limit, 25);
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  const filters = [`snapshot_date=eq.${snap}`, FOREIGN_EXCL];

  const minCoord = num(input && input.minCoordination);
  if (minCoord !== null) filters.push(`coordination_score=gte.${minCoord}`);
  const minDrift = num(input && input.minDrift);
  if (minDrift !== null) filters.push(`drift_score=gte.${minDrift}`);
  const maxVms = num(input && input.maxVms);
  if (maxVms !== null) filters.push(`vms=lte.${maxVms}`);
  const minFvd = num(input && input.minFvdPct);
  if (minFvd !== null) filters.push(`fvd_pct=gte.${minFvd}`);
  const maxFvd = num(input && input.maxFvdPct);
  if (maxFvd !== null) filters.push(`fvd_pct=lte.${maxFvd}`);

  const energy = (input && input.energy || '').toLowerCase();
  if (energy === 'full') filters.push('energy_remaining=gte.80');
  else if (energy === 'dying') { filters.push('energy_remaining=gte.5'); filters.push('energy_remaining=lte.20'); }
  else if (energy === 'dead') filters.push('energy_remaining=lt.5');

  const state = input && input.state;
  if (typeof state === 'string' && state.trim()) {
    filters.push(`narrative_state=eq.${encodeURIComponent(state.trim())}`);
  }

  const theme = input && input.theme;
  if (typeof theme === 'string' && theme.trim()) {
    // Accept exact known themes only; comma-list allowed via in.(...).
    const parts = theme.split(',').map((t) => t.trim()).filter((t) => MACRO_THEMES.includes(t));
    if (parts.length === 1) filters.push(`macro_theme=eq.${encodeURIComponent(parts[0])}`);
    else if (parts.length > 1) filters.push(`macro_theme=in.(${parts.map(encodeURIComponent).join(',')})`);
  }

  const cols = 'ticker,verdict,macro_theme,nrs,vms,drift_score,coordination_score,coordination_class,' +
    'suspicion_class,fvd_pct,energy_remaining,narrative_state,walsh_regime';
  const rows = await rest(
    `narrative_scorecard?select=${cols}&${filters.join('&')}&order=nrs.desc&limit=${ROW_CAP}`,
    ctx.debugQueries
  );

  const outRows = rows.slice(0, limit).map((r) => ({
    ticker: r.ticker,
    verdict: r.verdict || '—',
    theme: r.macro_theme || '—',
    nrs: round(r.nrs, 0),
    vms: round(r.vms, 0),
    drift: round(r.drift_score, 0),
    coord: round(r.coordination_score, 0),
    coord_class: r.coordination_class || '—',
    suspicion: r.suspicion_class || '—',
    fvd_pct: round(r.fvd_pct, 1),
    energy: round(r.energy_remaining, 0),
    state: r.narrative_state || '—',
    regime: r.walsh_regime || '—',
  }));

  const card = {
    ui: 'table',
    title: `Structural screen · ${snap}${theme ? ' · ' + theme : ''}`,
    columns: ['ticker', 'verdict', 'theme', 'nrs', 'vms', 'drift', 'coord', 'coord_class', 'suspicion', 'fvd_pct', 'energy', 'state', 'regime'],
    rows: outRows,
  };
  const summary = {
    snapshot_date: snap, filters_applied: filters.filter((f) => !f.startsWith('snapshot_date') && f !== FOREIGN_EXCL),
    returned: outRows.length, rows: outRows,
    note: outRows.length ? undefined : 'no tickers matched (theme coverage is sparse — many filters return 0-2 rows)',
  };
  return { card, rowCount: outRows.length, summary };
}

async function execBubbleScreen(input, ctx) {
  const limit = clampLimit(input && input.limit, 25);
  const snap = await ctx.latestSnapshot('bubble_metrics');
  if (!snap) return { rowCount: 0, summary: { error: 'no bubble snapshot' } };

  const cols = 'ticker,regime,bsadf_now,crit_value,bubble_active_idio,bubble_active_raw,current_episode_start';
  const rows = await rest(
    `bubble_metrics?select=${cols}&snapshot_date=eq.${snap}&bubble_active_idio=is.true&order=bsadf_now.desc&limit=${ROW_CAP}`,
    ctx.debugQueries
  );

  const outRows = rows.slice(0, limit).map((r) => ({
    ticker: r.ticker,
    regime: r.regime || '—',
    bsadf_now: round(r.bsadf_now, 4),
    crit_value: round(r.crit_value, 4),
    raw_bubble: r.bubble_active_raw === true,
    episode_start: r.current_episode_start || '—',
  }));

  const card = {
    ui: 'table',
    title: `Active idiosyncratic bubbles · ${snap}`,
    columns: ['ticker', 'regime', 'bsadf_now', 'crit_value', 'raw_bubble', 'episode_start'],
    rows: outRows,
  };
  const summary = {
    snapshot_date: snap, returned: outRows.length, rows: outRows,
    note: outRows.length ? 'bubble_active_idio = beta-stripped/idiosyncratic bubble flag'
      : 'no active idiosyncratic bubbles on the latest snapshot (this screen is genuinely sparse)',
  };
  return { card, rowCount: outRows.length, summary };
}

async function execCircularFinanceLookup(input, ctx) {
  const limit = clampLimit(input && input.limit, 25);

  // Build name→{ticker,display} map from entities (client-side join; no self-join in PostgREST).
  let entityMap = {};
  try {
    const ents = await rest(
      'circular_finance_entities?select=entity_id,display_name,ticker,is_public,role&limit=' + ROW_CAP,
      ctx.debugQueries
    );
    ents.forEach((e) => {
      entityMap[e.entity_id] = {
        display: e.display_name || e.entity_id,
        ticker: e.ticker || ENTITY_TICKER_FALLBACK[e.entity_id] || null,
        is_public: e.is_public === true,
      };
    });
  } catch (_) {
    Object.keys(ENTITY_TICKER_FALLBACK).forEach((k) => {
      entityMap[k] = { display: k, ticker: ENTITY_TICKER_FALLBACK[k], is_public: true };
    });
  }

  // Optional entity/ticker filter → resolve to an entity_id, then query the view
  // by entity_a OR entity_b (two calls; PostgREST can't OR across a self-join).
  const q = input && input.entityOrTicker;
  let entityIdFilter = null;
  if (typeof q === 'string' && q.trim()) {
    const raw = q.trim();
    const asTicker = cleanTicker(raw);
    // direct entity_id match?
    if (entityMap[raw]) entityIdFilter = raw;
    if (!entityIdFilter) {
      for (const [id, v] of Object.entries(entityMap)) {
        if (v.ticker && v.ticker === asTicker) { entityIdFilter = id; break; }
        if (id.toLowerCase() === raw.toLowerCase()) { entityIdFilter = id; break; }
        if (v.display && v.display.toLowerCase() === raw.toLowerCase()) { entityIdFilter = id; break; }
      }
    }
  }

  const viewCols = 'entity_a,entity_b,a_to_b_relations,a_to_b_amount,b_to_a_relations,b_to_a_amount,latest';
  let rows = [];
  if (entityIdFilter) {
    const enc = encodeURIComponent(entityIdFilter);
    const [aRows, bRows] = await Promise.all([
      rest(`v_circular_finance_roundtrips?select=${viewCols}&entity_a=eq.${enc}&order=latest.desc&limit=${ROW_CAP}`, ctx.debugQueries),
      rest(`v_circular_finance_roundtrips?select=${viewCols}&entity_b=eq.${enc}&order=latest.desc&limit=${ROW_CAP}`, ctx.debugQueries),
    ]);
    const seen = new Set();
    [...aRows, ...bRows].forEach((r) => {
      const key = `${r.entity_a}|${r.entity_b}|${r.latest}`;
      if (!seen.has(key)) { seen.add(key); rows.push(r); }
    });
    rows.sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
  } else {
    rows = await rest(
      `v_circular_finance_roundtrips?select=${viewCols}&order=latest.desc&limit=${ROW_CAP}`,
      ctx.debugQueries
    );
  }

  const loops = rows.slice(0, limit).map((r) => {
    const a = entityMap[r.entity_a] || { display: r.entity_a, ticker: ENTITY_TICKER_FALLBACK[r.entity_a] || null };
    const b = entityMap[r.entity_b] || { display: r.entity_b, ticker: ENTITY_TICKER_FALLBACK[r.entity_b] || null };
    const fromLabel = a.ticker ? `${a.display} (${a.ticker})` : a.display;
    const toLabel = b.ticker ? `${b.display} (${b.ticker})` : b.display;
    const rel = []
      .concat(Array.isArray(r.a_to_b_relations) ? r.a_to_b_relations : [])
      .concat(Array.isArray(r.b_to_a_relations) ? r.b_to_a_relations.map((x) => `${x} (reverse)`) : []);
    const amt = num(r.a_to_b_amount) || num(r.b_to_a_amount);
    return {
      from: fromLabel,
      to: toLabel,
      relation: rel.join(', ') || 'related',
      amountUsd: amt,
      confidence: 'curated',
      source: 'circular_finance_edges (text-extracted, AI-capex)',
      url: '',
    };
  });

  const card = {
    ui: 'circular_finance',
    title: 'AI-capex circular-finance loops (curated; NOT EV/green; text-extracted commitments, not XBRL cashflows)',
    loops,
  };
  const summary = {
    coverage: 'CURATED AI-capex set only (Amazon/Anthropic/Alphabet/OpenAI/NVIDIA/Nebius/Microsoft/Oracle/CoreWeave/Crusoe/SoftBank/xAI). Edges are text-extracted commitments, not XBRL cashflows; many legs are private cos with NO ticker.',
    filter_entity_id: entityIdFilter,
    returned: loops.length,
    loops: loops.map((l) => ({ from: l.from, to: l.to, relation: l.relation, amountUsd: l.amountUsd })),
    note: loops.length ? undefined : 'no loops matched',
  };
  return { card, rowCount: loops.length, summary };
}

async function execSectorCrossSection(input, ctx) {
  const limit = clampLimit(input && input.limit, 25);
  const snap = await ctx.latestSnapshot('narrative_scorecard');
  if (!snap) return { rowCount: 0, summary: { error: 'no scorecard snapshot' } };

  const cols = 'ticker,verdict,macro_theme,sector_regime_class,nrs,vms,drift_score,coordination_class,fvd_pct,narrative_state';
  const rows = await rest(
    `narrative_scorecard?select=${cols}&snapshot_date=eq.${snap}&${FOREIGN_EXCL}&order=drift_score.desc&limit=${ROW_CAP}`,
    ctx.debugQueries
  );

  const outRows = rows.slice(0, limit).map((r) => ({
    ticker: r.ticker,
    verdict: r.verdict || '—',
    theme: r.macro_theme || '—',
    sector_regime: r.sector_regime_class || '—',
    nrs: round(r.nrs, 0),
    vms: round(r.vms, 0),
    drift: round(r.drift_score, 0),
    coord_class: r.coordination_class || '—',
    fvd_pct: round(r.fvd_pct, 1),
    state: r.narrative_state || '—',
  }));

  const card = {
    ui: 'table',
    title: `Sector cross-section · highest drift · ${snap}`,
    columns: ['ticker', 'verdict', 'theme', 'sector_regime', 'nrs', 'vms', 'drift', 'coord_class', 'fvd_pct', 'state'],
    rows: outRows,
  };
  const summary = {
    snapshot_date: snap, returned: outRows.length, rows: outRows,
  };
  return { card, rowCount: outRows.length, summary };
}

// ── text-to-SQL escape hatch executors ──────────────────────────────────────
async function execRunSql(input, ctx) {
  const sql = (input && input.sql) || '';
  if (ctx && ctx.debugQueries) {
    ctx.debugQueries.push('run_sql: ' + String(sql).replace(/\s+/g, ' ').slice(0, 300));
  }
  if (!ro.isConfigured()) {
    return { rowCount: 0, summary: { ok: false,
      error: 'Read-only SQL is not enabled on this deployment (ANOMALY_RO_DATABASE_URL unset). Use a catalog tool, or tell the user the read-only DB role must be configured first.' } };
  }
  const out = await ro.runReadOnlySql(sql);
  if (!out || !out.ok) {
    return { rowCount: 0, summary: { ok: false, error: (out && out.error) || 'query rejected by the read-only guard', sql } };
  }
  const rows = Array.isArray(out.rows) ? out.rows : [];
  const card = rows.length
    ? { ui: 'table', title: 'Query result', columns: Object.keys(rows[0]), rows: rows }
    : null;
  return {
    card: card,
    rowCount: out.rowCount != null ? out.rowCount : rows.length,
    summary: { ok: true, rowCount: rows.length, rows: rows.slice(0, ROW_CAP) },
  };
}

async function execDescribeSchema(input, ctx) {
  const keyword = (input && input.keyword) || '';
  if (ctx && ctx.debugQueries) ctx.debugQueries.push('describe_schema: ' + String(keyword).slice(0, 60));
  try {
    const rows = await describeSchema(keyword);
    const list = Array.isArray(rows) ? rows : [];
    return { rowCount: list.length, summary: { ok: true, columns: list.slice(0, 200) } };
  } catch (err) {
    return { rowCount: 0, summary: { ok: false, error: 'describe_schema failed: ' + (err && err.message ? err.message : 'unknown') } };
  }
}

const EXECUTORS = {
  ticker_dossier: execTickerDossier,
  narrative_lab: execNarrativeLab,
  daily_anomaly_feed: execDailyAnomalyFeed,
  what_changed: execWhatChanged,
  validate_narrative: execValidateNarrative,
  structural_screen: execStructuralScreen,
  bubble_screen: execBubbleScreen,
  circular_finance_lookup: execCircularFinanceLookup,
  sector_cross_section: execSectorCrossSection,
  run_sql: execRunSql,
  describe_schema: execDescribeSchema,
};

// ── tool definitions sent to Claude ─────────────────────────────────────────

const TOOLS = [
  {
    name: 'ticker_dossier',
    description: 'Full forensic risk dossier for ONE ticker from the latest narrative_scorecard snapshot (plus its bubble status). Returns verdict, VMS, drift, coordination, suspicion, FVD, energy, narrative_state, regime, and the anomaly axes that fired. Use when the user names a single company/ticker and wants its risk read.',
    input_schema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Ticker symbol, e.g. NVDA, AAPL, BRK.B.' } },
      required: ['ticker'],
    },
  },
  {
    name: 'narrative_lab',
    description: 'Narrative-state analysis for ONE focus ticker plus its same-narrative_state peers (foreign filers excluded) from the latest snapshot. Use to understand how a name sits relative to peers sharing its Wyckoff/narrative state (DISTRIBUTION, RETAIL_PUMP, WHALE_ACCUMULATION, DORMANT).',
    input_schema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Focus ticker symbol.' } },
      required: ['ticker'],
    },
  },
  {
    name: 'daily_anomaly_feed',
    description: 'Cross-ticker anomaly feed for the latest snapshot, ranked by confluence (how many forensic axes fired). Axes: drift (drift_score>=70), coordination (coordination_score>=20), suspicion (suspicion_score>=60), fvd (|fvd_pct|>=100), bubble (bubble_active_idio). Foreign filers excluded. Use for "what looks anomalous today" / "top anomalies".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows (<=50, default 20).' },
        minConfluence: { type: 'integer', description: 'Minimum number of axes that must fire (default 1).' },
      },
    },
  },
  {
    name: 'what_changed',
    description: 'What CHANGED since the prior snapshot: tickers that NEWLY fired a forensic axis today vs the previous day (drift>=70, coordination>=20, suspicion>=60, |fvd_pct|>=100), plus verdict shifts. Foreign filers excluded. Use for "what changed today", "what is new", "what just flipped", "what entered a red-flag state", "anything new since yesterday", daily-monitoring questions.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows (<=50, default 25).' },
      },
    },
  },
  {
    name: 'validate_narrative',
    description: 'Validate a NARRATIVE / THESIS / CLAIM against the 3.5M-observation history: embeds the thesis and finds the most similar PAST narratives (semantic search over the narrative_dots corpus), returning how those analogues resolved (analogue consensus = % that rose over 5 days), the matched pattern-cluster (its thesis label + hit rate), example precedent cases ("what it rhymes with"), and a descriptive historical move. This is the "Narrative Lab" engine. Use when the user PASTES or STATES a narrative/thesis to check, or asks "is this thesis real/likely?", "what does this rhyme with?", "what happened to similar narratives?", "validate: <claim>", "has this story played out before?". REQUIRES the ticker the thesis is about and the narrative text. Results are descriptive precedent, NOT a price prediction.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker the thesis is about, e.g. NVDA.' },
        narrative: { type: 'string', description: 'The narrative/thesis/claim text to validate (a sentence or short paragraph).' },
      },
      required: ['ticker', 'narrative'],
    },
  },
  {
    name: 'structural_screen',
    description: 'Filtered screen over the latest narrative_scorecard snapshot (foreign filers excluded). Use for "show me names with X". theme filters macro_theme and accepts ONLY these exact case-sensitive strings (single or comma-list): Company_Specific, Earnings_Season, Sector_Rotation, AI_Infrastructure, Other, Consumer_Demand, AI_software_disruption, Energy_Transition, Rate_Cycle, Geopolitical, Supply_Constraint, GLP1_disruption, EV_competition, Tariff_Trade_War. NOTE: macro_theme is a SPARSE narrative tag, not a sector taxonomy — most themes return 0-2 rows; EV/green tags are nearly empty. Report only the rows returned.',
    input_schema: {
      type: 'object',
      properties: {
        minCoordination: { type: 'number', description: 'Minimum coordination_score.' },
        minDrift: { type: 'number', description: 'Minimum drift_score.' },
        maxVms: { type: 'number', description: 'Maximum VMS (lower = claims verify less).' },
        minFvdPct: { type: 'number', description: 'Minimum fvd_pct (e.g. 100 for richly valued).' },
        maxFvdPct: { type: 'number', description: 'Maximum fvd_pct (e.g. -50 for cheap).' },
        energy: { type: 'string', enum: ['full', 'dying', 'dead'], description: 'energy_remaining band: full>=80, dying 5-20, dead<5.' },
        state: { type: 'string', description: 'Exact narrative_state, e.g. DISTRIBUTION, RETAIL_PUMP, WHALE_ACCUMULATION, DORMANT.' },
        theme: { type: 'string', description: 'Exact macro_theme string (see allowed values in the tool description), or a comma-list.' },
        limit: { type: 'integer', description: 'Max rows (<=50, default 25).' },
      },
    },
  },
  {
    name: 'bubble_screen',
    description: 'Names with an active idiosyncratic (beta-stripped) bubble on the latest bubble_metrics snapshot, ordered by bsadf_now desc. This screen is genuinely sparse — often 1 name or empty. Report only the literal rows returned; never imply a broad bubble list.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows (<=50, default 25).' } },
    },
  },
  {
    name: 'circular_finance_lookup',
    description: 'Directed money-flow round-trip loops between entities (e.g. hyperscaler invests in a model lab, model lab buys its compute back). HONEST COVERAGE: this is a CURATED AI-capex set (Amazon/Anthropic/Alphabet/OpenAI/NVIDIA/Nebius/Microsoft/Oracle/CoreWeave/Crusoe/SoftBank/xAI), NOT EV/green, and edges are TEXT-EXTRACTED commitments — not XBRL cashflows or SEC-confirmed. Many legs are private companies with NO ticker. Optionally filter by an entity name or public ticker.',
    input_schema: {
      type: 'object',
      properties: {
        entityOrTicker: { type: 'string', description: 'Optional entity name (e.g. NVIDIA, OpenAI) or public ticker (e.g. NVDA) to filter loops touching it.' },
        limit: { type: 'integer', description: 'Max loops (<=50, default 25).' },
      },
    },
  },
  {
    name: 'sector_cross_section',
    description: 'Broad cross-section of the latest narrative_scorecard snapshot, highest drift first (foreign filers excluded). The safe default/fallback when the request is general or another tool is not a clear fit.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows (<=50, default 25).' } },
    },
  },
  {
    name: 'run_sql',
    description: 'Escape hatch for anything the catalog tools do not cover. Provide ONE read-only statement (a single SELECT or WITH ... SELECT). It reaches almost the ENTIRE public schema — the forensic core AND every product/analytics domain in the SCHEMA MAP (daily plays, paper-portfolio P&L, trade cards, forecasts, leaderboards, sector stories, traps, blog) — using the tables in the SCHEMA MAP; call describe_schema first for columns you are unsure of. A hard guard REJECTS any query touching the out-of-scope PII/billing/brokerage tables (user_*, stripe_customers, subscriptions, *_signups, alpaca_*, *_keys) — do not target them. It is checked by a fail-closed read-only guard and run as a SELECT-only role. Exclude foreign-filer tickers on forensic cross-sections, cap with LIMIT (<=50), and pin to the latest snapshot_date/date. If part of the question needs data that does not exist, say so plainly instead of guessing.',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single read-only SELECT/WITH statement. No DDL/DML, no multiple statements, no semicolon chaining.' } },
      required: ['sql'],
    },
  },
  {
    name: 'describe_schema',
    description: 'Discover columns of tables not detailed in the SCHEMA MAP. Pass a table-name fragment; returns matching tables/columns across the whole public schema (the out-of-scope PII/billing/brokerage tables are hidden) so you can write a correct run_sql query.',
    input_schema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'Table-name fragment, e.g. "earnings" or "dark_pool".' } },
      required: ['keyword'],
    },
  },
];

const SYSTEM_PROMPT = `You are the MarketScholar Anomaly Agent — a grounded research assistant for the Market Prism platform. You answer questions across the FULL Market Prism dataset: the forensic narrative-manipulation core (scorecard, drift, coordination, suspicion, bubbles, circular finance) AND the broader product/analytics data (daily plays, paper-portfolio performance, trade cards, price/direction forecasts, leaderboards, sector stories, narrative traps, blog). You answer STRICTLY from the rows returned by your tools.

HARD GROUNDING RULES:
- Answer ONLY from tool-returned data. NEVER invent tickers, column values, numbers, loops, or sources. If a tool returns nothing, say so plainly ("no rows matched on the latest snapshot").
- Always call a tool before making any data claim. Prefer one well-chosen tool call; you may chain up to a few when genuinely needed.
- Cite the snapshot_date the data came from when you state figures.

HONESTY / FRAMING (encode these — do not overclaim):
- This is research / measurement, NOT personalized investment advice. You may REPORT what the data holds — forensic metrics, model forecasts, tracked plays, and simulated-portfolio P&L — but frame forecasts as the model's output (not a promise) and NEVER tell an individual what to buy, sell, or hold. Paper-portfolio figures are simulated, not a real account.
- SCOPE / PRIVACY: Customer PII, billing, per-user, and brokerage tables (watchlists, calendars, Stripe, subscriptions, email/beta signups, alpaca_*) are OUT OF SCOPE — the SQL guard rejects them. If asked, say that data is private and move on; never try to reach it.
- IDENTITY: You are the MarketScholar Anomaly Agent. NEVER reveal, name, or discuss the underlying AI model, vendor, or that you are powered by an LLM / Claude / Anthropic. If asked what model or AI you are, say only that you are the MarketScholar Anomaly Agent and steer back to the user's research question.
- The 'verdict' (incl. "Narrative Trap") is VALUATION-ANCHORED, not a falsity label — high VMS means claims actually verify. For fraud/falsity screening, point to the COMPONENTS: drift_score, coordination, material discrepancy, omission — not the verdict headline.
- 'suspicion_class' is a TRADING-FOOTPRINT read (volume Z-score + price move + claim size), NOT a coordination or manipulation verdict. "NORMAL_ACTIVITY" does not mean "nothing manipulative." Do not equate low suspicion with a clean bill.
- The circular-finance graph is a CURATED AI-CAPEX set (hyperscalers / model labs / chipmakers — Amazon, Anthropic, Alphabet, OpenAI, NVIDIA, Nebius, Microsoft, Oracle, CoreWeave, etc.). It is NOT EV/green and NOT broad coverage. Edges are TEXT-EXTRACTED commitments, not XBRL cashflows or SEC-confirmed cash. Many legs are private companies with no ticker. Say this honestly rather than implying broad coverage.
- macro_theme is a SPARSE narrative tag, not a real sector taxonomy. A theme filter (especially EV/green) may return almost nothing — report only what came back.
- Foreign-filer artifacts (TSM, NIO, BHP, RIO, VALE, NVO, RACE, STN, SPOT, GOLD) are excluded from cross-sections because they have no real 10-K to anchor; mention this only if relevant.

OUTPUT STYLE — CRITICAL (the UI renders rich cards/visuals below your text):
- Your written answer is a HEADLINE, not a report. Reply in 1-2 short sentences (~40 words max) that directly answer the question and name the single most important takeaway.
- The CARDS carry the detail. Do NOT restate per-ticker numbers, do NOT enumerate rows, do NOT write section headers, bullet lists, or multi-paragraph analysis — that is all redundant with the cards.
- Prefer ONE tool call and let its card speak. Do NOT stack overlapping cards for the same ticker (e.g. a dossier AND a narrative_lab) — pick the single best one.
- If the cards fully cover the answer, a single sentence (or even a short clause) is the ideal response. Brevity is the goal.
- Write status / verdict / regime labels in plain Title Case (e.g. "Normal Activity", "Likely Coordinated", "Narrative Trap", "Distribution", "Organic Spread") — NEVER the raw ALL_CAPS_ENUM form (NORMAL_ACTIVITY, LIKELY_COORDINATED). Ticker symbols stay uppercase.

ADVANCED — WRITE YOUR OWN READ-ONLY SQL (run_sql):
run_sql reaches almost the ENTIRE public schema (read-only) — the forensic core AND every product/analytics domain in the SCHEMA MAP below — EXCEPT the hard-blocked PII/billing/brokerage set. Use it for anything the catalog tools do not cover (multi-table joins, custom thresholds, product questions like "how are the tracked daily plays doing this week" or "top trade cards by conviction", combinations like "mid-cap tech in decay with bearish dark-pool flow"). The SCHEMA MAP names the tables but does NOT list every column — call describe_schema('<fragment>') to confirm columns BEFORE writing the query, especially for the product/analytics tables. ALWAYS exclude foreign filers on forensic cross-sections, LIMIT <= 50, and pin to the latest snapshot_date/date. State plainly when the data to answer part of a question does not exist instead of guessing. Cite the date. If run_sql is not configured or a query is rejected (e.g. it touched a blocked table), fall back to a catalog tool or tell the user that slice is out of scope.

SCHEMA MAP:
${SCHEMA_DIGEST}`;

// ── Anthropic call ──────────────────────────────────────────────────────────

async function callClaude(messages, debug) {
  // Accept whichever name the key is stored under (frontend uses ANTHROPIC_KEY,
  // the backend convention is ANTHROPIC_API_KEY; tolerate common aliases too).
  const key = process.env.ANTHROPIC_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.CLAUDE_API_KEY
    || process.env.CLAUDE_KEY
    || '';
  if (!key) throw new Error('No Anthropic key in env (checked ANTHROPIC_KEY / ANTHROPIC_API_KEY / CLAUDE_API_KEY / CLAUDE_KEY)');
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`anthropic ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp.json();
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Build a sanitized conversation: only user/assistant string turns from client.
function buildInitialMessages(raw) {
  const msgs = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
      if (!role) continue;
      const content = typeof m.content === 'string' ? m.content : '';
      if (!content) continue;
      msgs.push({ role, content });
    }
  }
  // Ensure conversation starts with a user turn and is non-empty.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

// ── handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const started = Date.now();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const debug = { toolCalls: [], ms: 0, model: 'marketscholar-anomaly-engine', turns: 0 };
  const cards = [];

  // Allow only POST.
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ ok: false, answer: '', cards: [], debug: { ...debug, ms: Date.now() - started }, error: 'method not allowed' });
    return;
  }

  // Gated by requireAuth (login + the ENFORCE_SUBSCRIPTION kill switch) — the
  // extra mp_beta requirement is retired along with the beta-code program, and
  // must match the /ask page gate: the page serving while this API 403'd would
  // strand every logged-in user at an unusable agent.
  const auth = await requireAuth(req, res, { jsonOnly: true });
  if (!auth) return;

  let messages;
  try {
    const body = await readBody(req);
    messages = buildInitialMessages(body && body.messages);
    if (!messages.length) {
      res.status(200).json({
        ok: false, answer: 'Ask me about a ticker, today\'s anomalies, a structural screen, active bubbles, or AI-capex circular-finance loops.',
        cards: [], debug: { ...debug, ms: Date.now() - started }, error: 'no user message',
      });
      return;
    }
  } catch (err) {
    res.status(200).json({ ok: false, answer: '', cards: [], debug: { ...debug, ms: Date.now() - started }, error: 'bad request body' });
    return;
  }

  const debugQueries = [];
  const origin = (req.headers && req.headers.host) ? `https://${req.headers.host}` : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const ctx = { latestSnapshot: makeSnapshotCache(debugQueries), debugQueries, origin };

  // Execute one tool and record card + debug.
  async function runTool(name, input) {
    const localQueries = [];
    const toolCtx = { latestSnapshot: ctx.latestSnapshot, debugQueries: localQueries, origin: ctx.origin };
    let result;
    try {
      const exec = EXECUTORS[name];
      if (!exec) {
        result = { rowCount: 0, summary: { error: `unknown tool ${name}` } };
      } else {
        result = await exec(input || {}, toolCtx);
      }
    } catch (err) {
      result = { rowCount: 0, summary: { error: 'tool execution failed: ' + (err && err.message ? err.message : 'unknown') } };
    }
    if (result.card) cards.push(result.card);
    if (Array.isArray(result.cards)) result.cards.forEach((c) => cards.push(c));
    debug.toolCalls.push({
      name, input: input || {}, restQueries: localQueries, rowCount: result.rowCount || 0,
    });
    return result.summary !== undefined ? result.summary : { ok: true };
  }

  try {
    let finalText = '';
    for (let turn = 0; turn < MAX_TOOL_TURNS + 1; turn++) {
      const response = await callClaude(messages, debug);
      debug.turns = turn + 1;
      const content = Array.isArray(response.content) ? response.content : [];
      const toolUses = content.filter((b) => b && b.type === 'tool_use');

      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        finalText = extractText(content);
        break;
      }

      // Stop calling more tools once we've hit the budget — ask for a final answer.
      if (turn >= MAX_TOOL_TURNS) {
        finalText = extractText(content) ||
          'I gathered the available data above; here is the summary based on the cards shown.';
        break;
      }

      // Append assistant turn (full content, preserves tool_use blocks).
      messages.push({ role: 'assistant', content });

      // Execute every requested tool, push results back as one user turn.
      const toolResults = [];
      for (const tu of toolUses) {
        const summary = await runTool(tu.name, tu.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(summary).slice(0, 8000),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    debug.ms = Date.now() - started;
    res.status(200).json({
      ok: true,
      answer: finalText || 'No answer generated.',
      cards,
      debug,
    });
  } catch (err) {
    // Degrade gracefully: try the safe fallback (sector_cross_section) and never throw to the client.
    debug.fellBack = err && err.message ? String(err.message).slice(0, 200) : 'error';
    try {
      const summary = await runTool('sector_cross_section', { limit: 25 });
      debug.ms = Date.now() - started;
      res.status(200).json({
        ok: false,
        answer: 'I hit an error reaching the analysis model, so here is the latest sector cross-section (highest narrative drift first) as a fallback. This is forensic measurement, not investment advice.',
        cards,
        debug,
        error: debug.fellBack,
      });
    } catch (err2) {
      debug.ms = Date.now() - started;
      res.status(200).json({
        ok: false,
        answer: 'The anomaly agent is temporarily unavailable. Please try again shortly.',
        cards,
        debug,
        error: (debug.fellBack || 'error') + ' | fallback: ' + (err2 && err2.message ? err2.message : 'failed'),
      });
    }
  }
};
