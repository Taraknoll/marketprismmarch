// ──────────────────────────────────────────────────────────────────────────
// POST /api/anomaly-agent — Agentic forensic anomaly assistant (preview)
//
// Self-contained CommonJS Vercel function. Drives an agentic tool-calling loop
// against Claude (model claude-sonnet-4-6) over the MarketScholar forensic
// scorecard + bubble + circular-finance data. Everything is READ-ONLY: tools
// fetch PostgREST with the anon key (SELECT only). The model NEVER writes the DB
// and the server NEVER leaks keys to the client.
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

  const card = {
    ui: 'risk_dossier',
    ticker,
    subtitle: `${r.verdict || 'Monitoring'} · ${snap} · theme ${r.macro_theme || 'n/a'}`,
    riskStatus,
    metrics,
    flags,
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

  const card = {
    ui: 'narrative_lab',
    ticker,
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

  const card = {
    ui: 'anomaly_feed',
    asOf: snap,
    rows: scored,
  };
  const summary = {
    snapshot_date: snap, minConfluence, returned: scored.length,
    rows: scored.map((x) => ({ ticker: x.ticker, score: x.score, confluence: x.confluence, axes: x.axes })),
    note: scored.length ? undefined : 'no tickers met the confluence threshold',
  };
  return { card, rowCount: scored.length, summary };
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

const EXECUTORS = {
  ticker_dossier: execTickerDossier,
  narrative_lab: execNarrativeLab,
  daily_anomaly_feed: execDailyAnomalyFeed,
  structural_screen: execStructuralScreen,
  bubble_screen: execBubbleScreen,
  circular_finance_lookup: execCircularFinanceLookup,
  sector_cross_section: execSectorCrossSection,
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
];

const SYSTEM_PROMPT = `You are the MarketScholar Anomaly Agent — a grounded forensic-analysis assistant for a patent-pending narrative-manipulation detection engine. You answer questions about market-narrative anomalies STRICTLY from the rows returned by your tools.

HARD GROUNDING RULES:
- Answer ONLY from tool-returned data. NEVER invent tickers, column values, numbers, loops, or sources. If a tool returns nothing, say so plainly ("no rows matched on the latest snapshot").
- Always call a tool before making any data claim. Prefer one well-chosen tool call; you may chain up to a few when genuinely needed.
- Cite the snapshot_date the data came from when you state figures.

HONESTY / FRAMING (encode these — do not overclaim):
- This is a FORENSIC / MEASUREMENT layer. It is NOT investment advice and NOT alpha. NEVER predict prices and NEVER say buy/sell/hold.
- The 'verdict' (incl. "Narrative Trap") is VALUATION-ANCHORED, not a falsity label — high VMS means claims actually verify. For fraud/falsity screening, point to the COMPONENTS: drift_score, coordination, material discrepancy, omission — not the verdict headline.
- 'suspicion_class' is a TRADING-FOOTPRINT read (volume Z-score + price move + claim size), NOT a coordination or manipulation verdict. "NORMAL_ACTIVITY" does not mean "nothing manipulative." Do not equate low suspicion with a clean bill.
- The circular-finance graph is a CURATED AI-CAPEX set (hyperscalers / model labs / chipmakers — Amazon, Anthropic, Alphabet, OpenAI, NVIDIA, Nebius, Microsoft, Oracle, CoreWeave, etc.). It is NOT EV/green and NOT broad coverage. Edges are TEXT-EXTRACTED commitments, not XBRL cashflows or SEC-confirmed cash. Many legs are private companies with no ticker. Say this honestly rather than implying broad coverage.
- macro_theme is a SPARSE narrative tag, not a real sector taxonomy. A theme filter (especially EV/green) may return almost nothing — report only what came back.
- Foreign-filer artifacts (TSM, NIO, BHP, RIO, VALE, NVO, RACE, STN, SPOT, GOLD) are excluded from cross-sections because they have no real 10-K to anchor; mention this only if relevant.

STYLE: concise, plain text with light markdown (no tables — the UI renders structured cards for you). Lead with the answer. When you have shown a card, do not re-dump every field in prose.`;

// ── Anthropic call ──────────────────────────────────────────────────────────

async function callClaude(messages, debug) {
  const key = process.env.ANTHROPIC_KEY || '';
  if (!key) throw new Error('ANTHROPIC_KEY missing');
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

  const debug = { toolCalls: [], ms: 0, model: MODEL, turns: 0 };
  const cards = [];

  // Allow only POST.
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ ok: false, answer: '', cards: [], debug: { ...debug, ms: Date.now() - started }, error: 'method not allowed' });
    return;
  }

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
  const ctx = { latestSnapshot: makeSnapshotCache(debugQueries), debugQueries };

  // Execute one tool and record card + debug.
  async function runTool(name, input) {
    const localQueries = [];
    const toolCtx = { latestSnapshot: ctx.latestSnapshot, debugQueries: localQueries };
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
