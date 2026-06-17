/**
 * stockPageRenderer.js
 * Server-side renderer for the public, indexable, shareable stock landing pages
 * at /stocks/:ticker. Robinhood-style layout: price hero + narrative read +
 * 7-day Signal Lab chart + key signals (all free / anon-readable) and a
 * server-gated "projected price & trade signal" section that is rendered as a
 * blurred placeholder only — the real fair-value / target numbers are NEVER
 * sent to an anonymous client (no cloaking, no data leak).
 *
 * Free data is read with the anon key (same as the dashboard browser). The
 * locked tier lives behind /login on the gated /ticker app.
 */

const { transformNarrative } = require('./narrativeEngine');
const { buildTickerMeta, buildWebPageSchema } = require('./seoHead');
const resolveTemplate = require('../api/_resolve-template');
const { isHidden: isHiddenTicker } = require('../api/_hidden-tickers');

const SITE = 'https://marketprism.co';

async function renderStockPage(opts, req, res) {
  const ticker = opts.ticker;

  if (!ticker || isHiddenTicker(ticker)) {
    res.status(404).send('Not found');
    return;
  }

  const supabaseUrl  = process.env.SUPABASE_URL  || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';

  const { latest, series, loudest } = await fetchStockData(ticker, supabaseUrl, supabaseAnon);

  // No scorecard row → no real content → don't serve a thin/empty indexable page.
  if (!latest) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(404).send('No analysis available for ' + esc(ticker));
    return;
  }

  // Map scorecard fields to the narrative engine's expected shape (mirrors
  // lib/seoPageRenderer.fetchTickerData so prose stays consistent site-wide).
  const narrData = {
    ticker,
    verdict: latest.verdict,
    fvd: latest.fvd_pct != null ? latest.fvd_pct : latest.fvd,
    vms: latest.vms,
    energy: latest.energy_remaining,
    decay: latest.decay_rate,
    coordination: latest.coordination_score,
    narrative: latest.narrative,
    suspicion: latest.suspicion_score,
  };
  const narr = transformNarrative(narrData);

  const narrativeRead = esc([narr.summary, narr.whyMoving].filter(Boolean).join(' '));

  // ── meta ──
  const seoTitle = `${ticker} Stock — Narrative Analysis, Signals & Fair Value | Market Prism`;
  const canonical = `${SITE}/stocks/${ticker}`;
  const ogImage   = `${SITE}/stock-og/${ticker}`;
  const metaTags  = buildTickerMeta({ ticker, title: seoTitle, description: narr.metaDescription, url: canonical, imageUrl: ogImage });
  const webPageSchema = buildWebPageSchema({ title: seoTitle, description: narr.metaDescription, url: canonical });

  const breadcrumbSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Market Prism", "item": SITE },
      { "@type": "ListItem", "position": 2, "name": `${ticker} Analysis`, "item": canonical }
    ]
  });

  // Paywall structured data — declares the locked block as not-free so the
  // teaser is a documented freemium gate, not cloaking. cssSelector must match
  // the locked DOM in _stock_ticker.html.
  const paywallSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "url": canonical,
    "isAccessibleForFree": false,
    "hasPart": {
      "@type": "WebPageElement",
      "isAccessibleForFree": false,
      "cssSelector": ".locked-card"
    }
  });

  // ── badges ──
  const sentiment = classifySentiment(latest.current_sentiment);
  const stateLabel = titleCase(latest.narrative_state || 'Monitoring');
  const verdictLabel = humanVerdict(latest.verdict) || 'Monitoring';

  // ── price (server-rendered seed; client live-quote refreshes it) ──
  const seedPrice = num(latest.current_price);
  const priceStr = seedPrice != null ? fmtUsd(seedPrice) : '—';

  // ── stat grid ──
  const statRows = buildStatRows(latest);

  // ── chart series (chronological) ──
  const chartData = (series || [])
    .slice()
    .reverse()
    .map(r => ({
      date: shortDate(r.snapshot_date),
      force: num(r.yellow_energy) || 0,
      pressure: num(r.narrative_pressure) || 0,
    }));

  // ── loudest stories (cross-links the /stocks graph) ──
  const loudHtml = buildLoudest(loudest, ticker);

  // ── related links ──
  const t = ticker.toLowerCase();
  const relatedLinks = [
    `<a href="/why-is-${t}-stock-down">Why is ${ticker} down?</a>`,
    `<a href="/is-${t}-overvalued">Is ${ticker} overvalued?</a>`,
    `<a href="/should-i-buy-${t}">Should I buy ${ticker}?</a>`,
    `<a href="/ticker/${ticker}">Full ${ticker} analysis →</a>`,
    `<a href="/dashboard">Open dashboard</a>`,
  ].join('\n      ');

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // ── populate template ──
  let html = resolveTemplate('_stock_ticker.html');
  html = html
    .replace(/%%SEO_TITLE%%/g, esc(seoTitle))
    .replace('%%SEO_META%%', metaTags)
    .replace('%%SCHEMA_WEBPAGE%%', webPageSchema)
    .replace('%%SCHEMA_BREADCRUMB%%', breadcrumbSchema)
    .replace('%%SCHEMA_PAYWALL%%', paywallSchema)
    .replace(/%%TICKER%%/g, esc(ticker))
    .replace('%%COMPANY%%', 'Forensic narrative report')
    .replace('%%PRICE%%', esc(priceStr))
    .replace('%%SENTIMENT_CLASS%%', sentiment.cls)
    .replace('%%SENTIMENT_LABEL%%', esc(sentiment.label))
    .replace('%%STATE_LABEL%%', esc(stateLabel))
    .replace('%%VERDICT%%', esc(verdictLabel))
    .replace('%%NARRATIVE_READ%%', narrativeRead)
    .replace('%%STAT_ROWS%%', statRows)
    .replace('%%LOUDEST%%', loudHtml)
    .replace('%%RELATED_LINKS%%', relatedLinks)
    .replace(/%%DATE%%/g, esc(today));

  // Inject chart series as a JS global (server-side, no client round-trip).
  html = html.replace(
    '<script>\n(function(){',
    `<script>window.__MP_CHART = ${JSON.stringify(chartData)};</script>\n<script>\n(function(){`
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.status(200).send(html);
}

async function fetchStockData(ticker, supabaseUrl, supabaseAnon) {
  const out = { latest: null, series: [], loudest: [] };
  if (!supabaseUrl || !supabaseAnon) return out;

  const headers = { 'apikey': supabaseAnon, 'Authorization': `Bearer ${supabaseAnon}` };
  const enc = encodeURIComponent(ticker);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const signal = controller.signal;

  const [latestRes, seriesRes, loudRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=7&select=snapshot_date,yellow_energy,narrative_pressure`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_loudest_stories?order=sum_impact.desc&limit=8&select=ticker,story_count,outlets,avg_sentiment`, { headers, signal }).catch(() => null),
  ]).finally(() => clearTimeout(timeout));

  try { if (latestRes && latestRes.ok) { const r = await latestRes.json(); out.latest = r[0] || null; } } catch (_) {}
  try { if (seriesRes && seriesRes.ok) { out.series = await seriesRes.json(); } } catch (_) {}
  try { if (loudRes && loudRes.ok) { out.loudest = await loudRes.json(); } } catch (_) {}

  return out;
}

function buildStatRows(r) {
  const stats = [];
  const add = (label, value, meta) => {
    if (value == null || value === '' ) return;
    stats.push(`<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${meta ? `<div class="stat-meta">${esc(meta)}</div>` : ''}</div>`);
  };

  const fvd = num(r.fvd_pct != null ? r.fvd_pct : r.fvd);
  if (fvd != null) add('Valuation gap', `${fvd > 0 ? '+' : ''}${fvd.toFixed(1)}%`, fvd > 0 ? 'Above narrative fair value' : 'Below narrative fair value');

  if (num(r.npi) != null) add('Narrative persistence', num(r.npi).toFixed(0), r.npi_band || null);
  if (num(r.half_life) != null) add('Narrative half-life', `${num(r.half_life).toFixed(1)}d`, 'Attention decay');
  if (num(r.acs) != null) add('Source credibility', num(r.acs).toFixed(0), r.acs_band || null);
  if (num(r.coordination_score) != null) add('Coordination', num(r.coordination_score).toFixed(0), humanClass(r.coordination_class));
  if (num(r.srs) != null) add('Signal reliability', num(r.srs).toFixed(0), r.srs_band || null);
  if (num(r.current_sentiment) != null) add('Narrative sentiment', num(r.current_sentiment).toFixed(1), 'Tone of coverage');

  return stats.slice(0, 6).join('\n      ') || '<div class="stat"><div class="stat-label">Status</div><div class="stat-value">Updating</div><div class="stat-meta">Check back shortly</div></div>';
}

function buildLoudest(rows, currentTicker) {
  const items = [];
  for (const r of (rows || [])) {
    if (!r.ticker || r.ticker === currentTicker || isHiddenTicker(r.ticker)) continue;
    const sc = num(r.story_count);
    const out = num(r.outlets);
    const meta = [sc != null ? `${sc} stories` : null, out != null ? `${out} outlets` : null].filter(Boolean).join(' · ') || 'Active narrative';
    items.push(`<a class="loud-item" href="/stocks/${esc(r.ticker)}"><span class="loud-tkr">${esc(r.ticker)}</span><span class="loud-txt">${esc(meta)}</span></a>`);
    if (items.length >= 5) break;
  }
  return items.join('\n      ') || '<div class="loud-txt">No active stories right now.</div>';
}

/* ── helpers ── */
function classifySentiment(s) {
  const v = num(s);
  if (v == null) return { cls: 'neutral', label: 'Neutral narrative' };
  if (v >= 5) return { cls: 'bull', label: 'Bullish narrative' };
  if (v <= -5) return { cls: 'bear', label: 'Bearish narrative' };
  return { cls: 'neutral', label: 'Neutral narrative' };
}

function humanVerdict(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes('trap')) return 'Narrative Trap';
  if (s.includes('support')) return 'Structurally Supported';
  if (s.includes('monitor')) return 'Monitoring';
  return v;
}

function humanClass(c) {
  if (!c) return null;
  return String(c).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
}

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-'); // YYYY-MM-DD
  if (parts.length === 3) return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  return String(iso);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { renderStockPage };
