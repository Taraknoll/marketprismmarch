// On-demand ticker meme card generator.
//
// Generates a 1080x1350 PNG share card from a ticker's current narrative
// scorecard + earnings + price data. Two variants: 'bull' (mint #00DE94)
// and 'bear' (amber #FFB800). Per-variant content selection picks the
// strongest data points available and skips anything missing — never
// invents stats.
//
// Endpoint:
//   GET  /api/tickers/:ticker/meme-card?variant=bull|bear   (preferred — direct download)
//   POST /api/ticker-meme-card?ticker=NVDA  body { variant }
//
// Visual identity matches the existing OG card pattern in api/og-image.js.
// Runtime: Edge — required by @vercel/og.
//
// Data sources (real schema in this repo):
//   narrative_scorecard:        fvd_pct, current_price, fair_value, vms, energy_remaining,
//                               decay_rate, coordination_score, suspicion_score, verdict,
//                               narrative, walsh_regime, narrative_energy_regime, nrs,
//                               current_sentiment, snapshot_date, created_at
//   v_narrative_scorecard_deduped: per-narrative regime / energy / propagation
//   earnings_context:           eps_surprise_pct, revenue_surprise_pct, last_earnings_date,
//                               guidance_direction, earnings_position
//
// Lookahead-bias filter on narrative_scorecard: created_at <= snapshot_date + 2 days
// (applied client-side because PostgREST can't express column arithmetic in a filter).

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const BG = '#080B11';
const GRID = '#1C202A';
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_DIM = '#B4BCC8';
const TEXT_MUTED = '#6B7280';
const ACCENT = { bull: '#00DE94', bear: '#FFB800' };

const BULL_CLOSERS = [
  'The tape is repricing.',
  'Mass building. Energy intact.',
  'Fair value gap is open.',
  'Narrative loaded. Conviction rising.',
  'Discount visible. Engine confirms.',
];
const BEAR_CLOSERS = [
  'Narrative running on fumes.',
  'Mass decaying. FV ceiling holding.',
  'Energy spent. Engine sees exhaustion.',
  'The story is louder than the math.',
  'Premium visible. Engine flags risk.',
];

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const tickerRaw = url.searchParams.get('ticker') || '';
    const ticker = tickerRaw.replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    let variant = (url.searchParams.get('variant') || '').toLowerCase();

    if (req.method === 'POST' && !variant) {
      try {
        const body = await req.json();
        if (body && typeof body.variant === 'string') variant = body.variant.toLowerCase();
      } catch (_) { /* fall through */ }
    }

    if (!ticker) return jsonError(400, 'Missing ticker');
    if (variant !== 'bull' && variant !== 'bear') {
      return jsonError(400, "variant must be 'bull' or 'bear'");
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    if (!supabaseUrl || !supabaseAnon) return jsonError(500, 'Card generation temporarily unavailable. Try again in a moment.');

    let data;
    try {
      data = await fetchTickerData(ticker, supabaseUrl, supabaseAnon);
    } catch (e) {
      console.error('[meme-card] data fetch failed:', e && e.message);
      return jsonError(500, 'Card generation temporarily unavailable. Try again in a moment.');
    }

    const composed = composeCard(ticker, variant, data);
    if (!composed) return jsonError(404, 'No narrative data available for this ticker yet.');

    // ?format=json — return the composed payload so the frontend can build
    // share captions that stay in sync with what's drawn on the card.
    if ((url.searchParams.get('format') || '').toLowerCase() === 'json') {
      return new Response(JSON.stringify({ ticker, variant, ...composed }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const filename = `${ticker}_${variant}_${ymd(new Date())}.png`;
    const accent = ACCENT[variant];

    return new ImageResponse(renderCard(ticker, variant, accent, composed), {
      width: 1080,
      height: 1350,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[meme-card] unhandled:', err && err.message, err && err.stack);
    return jsonError(500, 'Card generation temporarily unavailable. Try again in a moment.');
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ── Data fetch ──────────────────────────────────────────────────────────────

async function fetchTickerData(ticker, supabaseUrl, supabaseAnon) {
  const headers = { apikey: supabaseAnon, Authorization: `Bearer ${supabaseAnon}` };
  const tFilter = `ticker=eq.${encodeURIComponent(ticker)}`;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);

  // Pull last 5 scorecard rows so we can apply the lookahead-bias filter
  // client-side (PostgREST can't do column arithmetic in a filter clause).
  const scorecardSelect = [
    'snapshot_date', 'created_at', 'fvd_pct', 'current_price', 'fair_value',
    'vms', 'nrs', 'energy_remaining', 'decay_rate', 'coordination_score',
    'suspicion_score', 'verdict', 'narrative', 'walsh_regime',
    'narrative_energy_regime', 'current_sentiment',
  ].join(',');

  const [scRows, narrRows, earnRows] = await Promise.all([
    sbFetch(supabaseUrl, headers,
      `narrative_scorecard?${tFilter}&select=${scorecardSelect}&order=snapshot_date.desc&limit=5`),
    sbFetch(supabaseUrl, headers,
      `v_narrative_scorecard_deduped?${tFilter}&select=narrative,propagation_pressure,energy_remaining,narrative_energy_regime,snapshot_date&order=snapshot_date.desc,propagation_pressure.desc.nullslast&limit=5`),
    sbFetch(supabaseUrl, headers,
      `earnings_context?${tFilter}&select=last_earnings_date,eps_surprise_pct,revenue_surprise_pct,guidance_direction,earnings_position&last_earnings_date=gte.${ninetyDaysAgo}&order=snapshot_date.desc&limit=1`),
  ]);

  const scorecard = pickFreshScorecard(scRows);
  const earnings = (Array.isArray(earnRows) && earnRows[0]) || null;
  if (earnings) {
    // earnings_context surprise columns are decimal fractions (0.0968 = 9.68%),
    // unlike fvd_pct which is already percent-scale. Normalize once here so
    // downstream fmtPct/magnitude comparisons all work on percent scale.
    if (isFiniteNum(earnings.eps_surprise_pct)) earnings.eps_surprise_pct *= 100;
    if (isFiniteNum(earnings.revenue_surprise_pct)) earnings.revenue_surprise_pct *= 100;
  }
  return {
    scorecard,
    narratives: Array.isArray(narrRows) ? narrRows : [],
    earnings,
  };
}

async function sbFetch(supabaseUrl, headers, path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return await res.json();
}

// Lookahead-bias filter: keep only rows where the row was created within
// 2 days of the snapshot date it represents. Falls back to the newest row
// if no row passes the filter (better than rendering nothing for tickers
// whose scorecard is mid-rebuild).
function pickFreshScorecard(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const fresh = rows.filter((r) => {
    if (!r.snapshot_date || !r.created_at) return false;
    const snap = new Date(r.snapshot_date + 'T00:00:00Z').getTime();
    const created = new Date(r.created_at).getTime();
    return created <= snap + 2 * 86400 * 1000;
  });
  return fresh[0] || rows[0] || null;
}

// ── Variant composition ─────────────────────────────────────────────────────

function composeCard(ticker, variant, data) {
  const sc = data.scorecard;
  if (!sc) return null;

  const composed = variant === 'bull'
    ? composeBull(sc, data.narratives, data.earnings)
    : composeBear(sc, data.narratives, data.earnings);

  if (!composed.headline) return null;
  composed.ticker = ticker;
  composed.price = sc.current_price;
  composed.closer = pickCloser(variant);
  return composed;
}

function composeBull(sc, narratives, earn) {
  const candidates = [];

  if (isFiniteNum(sc.fvd_pct) && sc.fvd_pct < 0) {
    candidates.push({
      magnitude: Math.abs(sc.fvd_pct),
      headline: { value: fmtPct(Math.abs(sc.fvd_pct)), label: 'discount to fair value' },
    });
  }
  if (earn && isFiniteNum(earn.eps_surprise_pct) && earn.eps_surprise_pct > 0) {
    candidates.push({
      magnitude: Math.abs(earn.eps_surprise_pct),
      headline: { value: fmtPct(earn.eps_surprise_pct, true), label: 'EPS beat last quarter' },
    });
  }
  if (earn && isFiniteNum(earn.revenue_surprise_pct) && earn.revenue_surprise_pct > 0) {
    candidates.push({
      magnitude: Math.abs(earn.revenue_surprise_pct),
      headline: { value: fmtPct(earn.revenue_surprise_pct, true), label: 'revenue beat last quarter' },
    });
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);
  const headline = candidates[0] ? candidates[0].headline : null;

  const supporting = [];
  pushIf(supporting, isBullishWalsh(sc.walsh_regime), {
    value: titleCase(sc.walsh_regime), label: 'regime',
  });
  pushIf(supporting, isBullishEnergyRegime(sc.narrative_energy_regime), {
    value: titleCase(sc.narrative_energy_regime), label: 'narrative energy',
  });
  pushIf(supporting, isFiniteNum(sc.energy_remaining) && sc.energy_remaining > 50, {
    value: fmtNum(sc.energy_remaining, 0), label: 'energy remaining',
  });
  pushIf(supporting, isFiniteNum(sc.fair_value) && isFiniteNum(sc.current_price), {
    value: '$' + fmtNum(sc.fair_value, 2), label: 'engine fair value',
  });
  pushIf(supporting, isFiniteNum(sc.vms) && sc.vms > 0, {
    value: fmtNum(sc.vms, 1), label: 'narrative mass score',
  });
  pushIf(supporting, sc.verdict, {
    value: titleCase(sc.verdict), label: 'verdict',
  });
  if (earn && isFiniteNum(earn.eps_surprise_pct) && earn.eps_surprise_pct > 0
      && (!headline || !/EPS/i.test(headline.label))) {
    supporting.push({ value: fmtPct(earn.eps_surprise_pct, true), label: 'last EPS surprise' });
  }
  pushIf(supporting, narratives && narratives[0] && narratives[0].propagation_pressure > 0, {
    value: fmtNum(narratives[0] && narratives[0].propagation_pressure, 0),
    label: 'top narrative propagation',
  });

  return { headline, supporting: supporting.slice(0, 5) };
}

function composeBear(sc, narratives, earn) {
  const candidates = [];

  if (isFiniteNum(sc.fvd_pct) && sc.fvd_pct > 0) {
    candidates.push({
      magnitude: Math.abs(sc.fvd_pct),
      headline: { value: fmtPct(sc.fvd_pct, true), label: 'premium to fair value' },
    });
  }
  if (earn && isFiniteNum(earn.eps_surprise_pct) && earn.eps_surprise_pct < 0) {
    candidates.push({
      magnitude: Math.abs(earn.eps_surprise_pct),
      headline: { value: fmtPct(earn.eps_surprise_pct, true), label: 'EPS miss last quarter' },
    });
  }
  if (earn && isFiniteNum(earn.revenue_surprise_pct) && earn.revenue_surprise_pct < 0) {
    candidates.push({
      magnitude: Math.abs(earn.revenue_surprise_pct),
      headline: { value: fmtPct(earn.revenue_surprise_pct, true), label: 'revenue miss last quarter' },
    });
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);
  const headline = candidates[0] ? candidates[0].headline : null;

  const supporting = [];
  pushIf(supporting, isBearishWalsh(sc.walsh_regime), {
    value: titleCase(sc.walsh_regime), label: 'regime',
  });
  pushIf(supporting, isBearishEnergyRegime(sc.narrative_energy_regime), {
    value: titleCase(sc.narrative_energy_regime), label: 'narrative energy',
  });
  pushIf(supporting, isFiniteNum(sc.energy_remaining) && sc.energy_remaining < 30, {
    value: fmtNum(sc.energy_remaining, 0), label: 'energy remaining',
  });
  pushIf(supporting, isFiniteNum(sc.coordination_score) && sc.coordination_score >= 0.6, {
    value: fmtNum(sc.coordination_score, 2), label: 'coordination score',
  });
  pushIf(supporting, isFiniteNum(sc.suspicion_score) && sc.suspicion_score >= 0.6, {
    value: fmtNum(sc.suspicion_score, 2), label: 'suspicion score',
  });
  pushIf(supporting, isFiniteNum(sc.decay_rate) && sc.decay_rate > 0, {
    value: fmtNum(sc.decay_rate, 2), label: 'decay rate',
  });
  pushIf(supporting, isFiniteNum(sc.fair_value), {
    value: '$' + fmtNum(sc.fair_value, 2), label: 'engine fair value',
  });
  pushIf(supporting, sc.verdict, {
    value: titleCase(sc.verdict), label: 'verdict',
  });
  if (earn && isFiniteNum(earn.eps_surprise_pct) && earn.eps_surprise_pct < 0
      && (!headline || !/EPS/i.test(headline.label))) {
    supporting.push({ value: fmtPct(earn.eps_surprise_pct, true), label: 'last EPS surprise' });
  }

  return { headline, supporting: supporting.slice(0, 5) };
}

function isBullishWalsh(r) {
  if (!r) return false;
  const u = String(r).toUpperCase();
  return u === 'CLEAR_PATH' || u === 'NEUTRAL' || u === 'BUILDING';
}
function isBearishWalsh(r) {
  if (!r) return false;
  const u = String(r).toUpperCase();
  return u === 'EXHAUSTING' || u === 'EXHAUSTED' || u === 'PRESSURE';
}
function isBullishEnergyRegime(r) {
  if (!r) return false;
  const u = String(r).toUpperCase();
  return u === 'BUILDING' || u === 'RECOVERING' || u === 'EXPLOSIVE' || u === 'HIGH';
}
function isBearishEnergyRegime(r) {
  if (!r) return false;
  const u = String(r).toUpperCase();
  return u === 'FADING' || u === 'PRESSURE' || u === 'DORMANT' || u === 'LOW';
}

function pushIf(arr, cond, item) { if (cond) arr.push(item); }
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtNum(v, decimals) {
  if (!isFiniteNum(Number(v))) return '';
  const n = Number(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(v, signed) {
  if (!isFiniteNum(Number(v))) return '';
  const n = Number(v);
  const abs = Math.abs(n).toFixed(1) + '%';
  if (!signed) return abs;
  return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(1) + '%';
}
function titleCase(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function pickCloser(variant) {
  const pool = variant === 'bull' ? BULL_CLOSERS : BEAR_CLOSERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Render (Satori-friendly object tree, no JSX transform required) ─────────

function renderCard(ticker, variant, accent, composed) {
  const headlineValue = composed.headline.value || '';
  const headlineLabel = composed.headline.label || '';
  const priceLine = isFiniteNum(Number(composed.price)) ? '$' + fmtNum(composed.price, 2) : '';

  return el('div', {
    style: {
      width: '1080px', height: '1350px',
      display: 'flex', flexDirection: 'column',
      background: BG,
      backgroundImage:
        `linear-gradient(${GRID} 1px, transparent 1px), linear-gradient(90deg, ${GRID} 1px, transparent 1px)`,
      backgroundSize: '60px 60px',
      backgroundPosition: '0 0, 0 0',
      padding: '60px',
      position: 'relative',
      color: TEXT_PRIMARY,
      fontFamily: 'sans-serif',
    },
  }, [
    // Top accent bar
    el('div', {
      style: {
        position: 'absolute', top: '60px', left: '60px',
        width: '960px', height: '4px',
        background: accent, display: 'flex',
      },
    }),

    // Header row: brand left / ticker+price right
    el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        marginTop: '32px',
      },
    }, [
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
        el('div', {
          style: {
            fontSize: '28px', fontWeight: 700, letterSpacing: '0.06em',
            color: TEXT_PRIMARY, fontFamily: 'sans-serif', display: 'flex',
          },
        }, ['MARKET PRISM']),
        el('div', {
          style: {
            fontSize: '20px', fontWeight: 400, color: TEXT_DIM,
            fontFamily: 'sans-serif', display: 'flex',
          },
        }, ['Narrative Intelligence for Markets']),
      ]),
      el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' } }, [
        el('div', {
          style: {
            fontSize: '48px', fontWeight: 700, color: accent,
            fontFamily: 'sans-serif', letterSpacing: '-0.02em', display: 'flex',
          },
        }, [ticker]),
        priceLine && el('div', {
          style: {
            fontSize: '22px', fontWeight: 400, color: TEXT_DIM,
            fontFamily: 'sans-serif', display: 'flex',
          },
        }, [priceLine]),
      ].filter(Boolean)),
    ]),

    // Headline stat
    el('div', {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        marginTop: '120px',
      },
    }, [
      el('div', {
        style: {
          fontSize: '160px', fontWeight: 700, color: accent,
          fontFamily: 'sans-serif', letterSpacing: '-0.04em', lineHeight: 1, display: 'flex',
        },
      }, [headlineValue]),
      el('div', {
        style: {
          fontSize: '24px', fontWeight: 400, color: TEXT_DIM,
          fontFamily: 'sans-serif', marginTop: '20px',
          textTransform: 'uppercase', letterSpacing: '0.10em', display: 'flex',
        },
      }, [headlineLabel]),
    ]),

    // Supporting data points (2-col grid via flex wrap)
    el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '36px 56px',
        marginTop: '72px',
      },
    }, composed.supporting.map((d) =>
      el('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '4px',
          width: '420px',
        },
      }, [
        el('div', {
          style: {
            fontSize: '32px', fontWeight: 700, color: TEXT_PRIMARY,
            fontFamily: 'sans-serif', display: 'flex',
          },
        }, [String(d.value)]),
        el('div', {
          style: {
            fontSize: '18px', fontWeight: 400, color: TEXT_DIM,
            fontFamily: 'sans-serif', textTransform: 'uppercase',
            letterSpacing: '0.08em', display: 'flex',
          },
        }, [d.label]),
      ])
    )),

    // Spacer
    el('div', { style: { flex: 1, display: 'flex' } }),

    // Closer line
    el('div', {
      style: {
        fontSize: '38px', fontStyle: 'italic', fontFamily: 'sans-serif',
        color: accent, letterSpacing: '-0.01em', display: 'flex',
        marginBottom: '40px',
      },
    }, [composed.closer]),

    // Footer
    el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        paddingTop: '24px', borderTop: '1px solid rgba(255,255,255,0.08)',
      },
    }, [
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
        el('div', {
          style: {
            fontSize: '22px', fontWeight: 600, color: accent,
            fontFamily: 'sans-serif', display: 'flex',
          },
        }, ['marketprism.co']),
        el('div', {
          style: {
            fontSize: '16px', color: TEXT_DIM, fontFamily: 'sans-serif', display: 'flex',
          },
        }, ['Forensic intel, not investment advice.']),
      ]),
      el('div', {
        style: {
          fontSize: '14px', color: TEXT_MUTED, fontFamily: 'sans-serif',
          letterSpacing: '0.08em', textTransform: 'uppercase', display: 'flex',
        },
      }, [variant === 'bull' ? 'BULL READ' : 'BEAR READ']),
    ]),
  ]);
}

// React.createElement-style helper that avoids needing a JSX transform.
// Children can be a string, a node, or an array of (string | node | falsy).
function el(type, props, children) {
  let kids = children;
  if (kids === undefined) kids = null;
  if (kids != null && !Array.isArray(kids)) kids = [kids];
  if (kids) {
    kids = kids.filter(Boolean);
    kids = kids.length === 1 ? kids[0]
         : kids.length === 0 ? null
         : kids;
  }
  return { type, props: { ...props, children: kids } };
}

// Exports for the test harness — pure, no edge runtime needed.
export { composeCard, fetchTickerData, renderCard };
