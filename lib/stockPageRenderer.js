/**
 * stockPageRenderer.js
 * Server-side renderer for the public, indexable, shareable stock landing pages
 * at /stocks/:ticker. Robinhood-style layout with:
 *   - free, anon-readable content: company name, narrative read, sentiment,
 *     Reality-Belief gauge, 7-day Signal Lab chart, key signals, narrative
 *     sections (why/overvalued/next), FAQ, ticker calculators, loudest stories
 *   - a server-gated "projected price & trade signal" block rendered as a
 *     blurred placeholder only (real numbers never sent to an anon client)
 *
 * SEO: per-ticker title/meta/canonical, WebPage (dated, with stock entity) +
 * Breadcrumb + FAQPage + paywall JSON-LD, dynamic per-ticker OG image.
 */

const { transformNarrative, generateFAQ } = require('./narrativeEngine');
const { buildTickerMeta } = require('./seoHead');
const resolveTemplate = require('../api/_resolve-template');
const { isHidden: isHiddenTicker } = require('../api/_hidden-tickers');

const SITE = 'https://www.marketprism.co';

async function renderStockPage(opts, req, res) {
  const ticker = opts.ticker;

  if (!ticker || isHiddenTicker(ticker)) {
    res.status(404).send('Not found');
    return;
  }

  const supabaseUrl  = process.env.SUPABASE_URL  || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';

  const { latest, series, loudest, company, rbi } =
    await fetchStockData(ticker, supabaseUrl, supabaseAnon);

  // No scorecard row → no real content → don't serve a thin/empty indexable page.
  if (!latest) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(404).send('No analysis available for ' + esc(ticker));
    return;
  }

  const companyName = (company && company.name) ? String(company.name) : '';
  const sectorLine = [company && company.sector, company && company.industry]
    .map(s => s && String(s).trim()).filter(Boolean).join(' · ');

  // Narrative engine (same field mapping as lib/seoPageRenderer for consistency)
  const narr = transformNarrative({
    ticker,
    verdict: latest.verdict,
    fvd: latest.fvd_pct != null ? latest.fvd_pct : latest.fvd,
    vms: latest.vms,
    energy: latest.energy_remaining,
    decay: latest.decay_rate,
    coordination: latest.coordination_score,
    narrative: latest.narrative,
    suspicion: latest.suspicion_score,
    rbi: rbi && rbi.reality_belief_index,
    rbiZone: rbi && rbi.gauge_zone,
  });

  // Verdict family → badge / accent color (covers all 15 scorer verdicts).
  const verdictClass = ({ bull: 'bull', bear: 'bear', caution: 'caution' }[narr.verdictFamily]) || 'neutral';

  const narrativeRead = esc([narr.summary, narr.whyMoving].filter(Boolean).join(' '));

  // ── meta / titles ──
  const nameForTitle = companyName ? `${companyName} (${ticker})` : ticker;
  const seoTitle  = `${nameForTitle} Stock — Narrative Analysis & Signals | Market Prism`;
  const h1        = `${ticker} Stock — Narrative & Sentiment Analysis`;
  const canonical = `${SITE}/stocks/${ticker}`;
  const ogImage   = `${SITE}/stock-og/${ticker}`;
  const metaTags  = buildTickerMeta({ ticker, title: seoTitle, description: narr.metaDescription, url: canonical, imageUrl: ogImage });

  const dateModified  = isoDate(latest.snapshot_date) || isoDate(todayStr());
  const datePublished = isoDate(latest.genesis_date) || dateModified;

  const webPageSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": seoTitle,
    "description": (narr.metaDescription || '').substring(0, 160),
    "url": canonical,
    "datePublished": datePublished,
    "dateModified": dateModified,
    "about": {
      "@type": "Corporation",
      "name": companyName || ticker,
      "tickerSymbol": ticker
    },
    // AEO: tell answer engines / voice assistants which nodes hold the answer.
    "speakable": { "@type": "SpeakableSpecification", "cssSelector": [".answer-text", ".faq-q", ".faq-a"] },
    "isPartOf": { "@type": "WebSite", "name": "Market Prism", "url": SITE },
    "publisher": {
      "@type": "Organization",
      "name": "Market Prism",
      "url": SITE,
      "description": "AI-powered stock analysis and narrative intelligence platform."
    }
  });

  const breadcrumbSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Market Prism", "item": SITE },
      { "@type": "ListItem", "position": 2, "name": "Stocks", "item": `${SITE}/stocks` },
      { "@type": "ListItem", "position": 3, "name": `${ticker} Analysis`, "item": canonical }
    ]
  });

  const paywallSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "url": canonical,
    "isAccessibleForFree": false,
    "hasPart": { "@type": "WebPageElement", "isAccessibleForFree": false, "cssSelector": ".locked-card" }
  });

  // ── FAQ (visible + schema, verbatim match for AEO) ──
  const faqs = (generateFAQ(ticker, narr) || []).filter(f => f && f.question && f.answer);
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({ "@type": "Question", "name": f.question, "acceptedAnswer": { "@type": "Answer", "text": f.answer } }))
  });
  const faqBlock = faqs.length ? `<section class="section"><div class="con">
    <h2 class="section-title">Frequently asked questions</h2>
    <div class="faq-list">
      ${faqs.map(f => `<div class="faq-item"><h3 class="faq-q">${esc(f.question)}</h3><p class="faq-a">${esc(f.answer)}</p></div>`).join('\n      ')}
    </div>
  </div></section>` : '';

  // ── badges ──
  const sentiment = classifySentiment(latest.current_sentiment);
  const stateLabel = titleCase(latest.narrative_state || 'Monitoring');
  // Richer engine label (covers all 15 verdicts) with humanVerdict fallback.
  const verdictLabel = narr.verdictLabel || humanVerdict(latest.verdict) || 'Monitoring';

  // ── answer-first verdict block (AEO + conversion hook) ──
  // The provenance chips foreground exactly what a generic LLM can't give:
  // a live price, a daily-refreshed read, and proprietary forensic signals.
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const answerBlock = `<div class="answer-card">
      <div class="answer-accent ${verdictClass}"></div>
      <div class="answer-eyebrow"><span>Market Prism verdict</span><span class="answer-verdict ${verdictClass}">${esc(verdictLabel)}</span></div>
      <p class="answer-text">${esc(narr.tldr)}</p>
      <div class="answer-prov">
        <span class="prov-chip"><span class="prov-dot"></span>Live price</span>
        <span class="prov-chip">Updated ${esc(today)}</span>
        <span class="prov-chip">Proprietary forensic signals</span>
      </div>
    </div>`;

  // ── price ──
  const seedPrice = num(latest.current_price);
  const priceStr = seedPrice != null ? fmtUsd(seedPrice) : '—';

  // ── stat grid ──
  const statRows = buildStatRows(latest);

  // ── chart series ──
  const chartData = (series || []).slice().reverse().map(r => ({
    date: shortDate(r.snapshot_date),
    force: num(r.yellow_energy) || 0,
    pressure: num(r.narrative_pressure) || 0,
  }));

  // ── reality-belief gauge ──
  const rbiSection = buildRbiSection(rbi, ticker);

  // ── narrative content sections ──
  const sections = [
    { h: `What's driving ${ticker} right now`, b: narr.whyMoving },
    { h: `Is ${ticker} overvalued?`, b: narr.isOvervalued },
    { h: `What happens next for ${ticker}`, b: narr.whatsNext },
  ].filter(s => s.b && String(s.b).trim());
  const contentSections = sections.map(s =>
    `<section class="section"><div class="con"><h2 class="section-title">${esc(s.h)}</h2><p class="narrative-read">${esc(s.b)}</p></div></section>`
  ).join('\n');

  // ── calculator deep-links ──
  const growthHref = `/growth-calculator?ticker=${encodeURIComponent(ticker)}`;
  const posHref = seedPrice != null
    ? `/position-size-calculator?entry=${seedPrice.toFixed(2)}`
    : `/position-size-calculator`;

  // ── loudest + related ──
  const loudHtml = buildLoudest(loudest, ticker);
  const t = ticker.toLowerCase();
  const relatedLinks = [
    `<a href="/why-is-${t}-stock-down">Why is ${ticker} down?</a>`,
    `<a href="/is-${t}-overvalued">Is ${ticker} overvalued?</a>`,
    `<a href="/should-i-buy-${t}">Should I buy ${ticker}?</a>`,
    `<a href="/ticker/${ticker}">Full ${ticker} analysis →</a>`,
    `<a href="/stocks">All stocks</a>`,
  ].join('\n      ');

  // ── populate template ──
  let html = resolveTemplate('_stock_ticker.html');
  html = html
    .replace(/%%SEO_TITLE%%/g, esc(seoTitle))
    .replace('%%SEO_META%%', metaTags)
    .replace('%%SCHEMA_WEBPAGE%%', webPageSchema)
    .replace('%%SCHEMA_BREADCRUMB%%', breadcrumbSchema)
    .replace('%%SCHEMA_FAQ%%', faqSchema)
    .replace('%%SCHEMA_PAYWALL%%', paywallSchema)
    .replace(/%%TICKER%%/g, esc(ticker))
    .replace(/%%OG_IMAGE%%/g, esc(ogImage))
    .replace(/%%COMPANY%%/g, esc(companyName || 'Narrative intelligence report'))
    .replace('%%SECTOR_LINE%%', esc(sectorLine))
    .replace('%%H1%%', esc(h1))
    .replace('%%PRICE%%', esc(priceStr))
    .replace('%%SENTIMENT_CLASS%%', sentiment.cls)
    .replace('%%SENTIMENT_LABEL%%', esc(sentiment.label))
    .replace('%%STATE_LABEL%%', esc(stateLabel))
    .replace(/%%VERDICT_CLASS%%/g, verdictClass)
    .replace('%%VERDICT%%', esc(verdictLabel))
    .replace('%%ANSWER_BLOCK%%', answerBlock)
    .replace('%%NARRATIVE_READ%%', narrativeRead)
    .replace('%%RBI_SECTION%%', rbiSection)
    .replace('%%STAT_ROWS%%', statRows)
    .replace('%%CONTENT_SECTIONS%%', contentSections)
    .replace('%%CALC_GROWTH_HREF%%', esc(growthHref))
    .replace('%%CALC_POS_HREF%%', esc(posHref))
    .replace('%%FAQ_BLOCK%%', faqBlock)
    .replace('%%LOUDEST%%', loudHtml)
    .replace('%%RELATED_LINKS%%', relatedLinks)
    .replace(/%%DATE%%/g, esc(today));

  const shareText = `${nameForTitle}: what the market believes right now — narrative analysis on Market Prism`;
  const shareObj = { ticker, url: canonical, card: ogImage, title: seoTitle, text: shareText };
  html = html.replace(
    '<script>\n(function(){',
    `<script>window.__MP_CHART = ${JSON.stringify(chartData)}; window.__MP_SHARE = ${JSON.stringify(shareObj)};</script>\n<script>\n(function(){`
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.status(200).send(html);
}

async function fetchStockData(ticker, supabaseUrl, supabaseAnon) {
  const out = { latest: null, series: [], loudest: [], company: null, rbi: null };
  if (!supabaseUrl || !supabaseAnon) return out;

  const headers = { 'apikey': supabaseAnon, 'Authorization': `Bearer ${supabaseAnon}` };
  const enc = encodeURIComponent(ticker);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const signal = controller.signal;

  const [latestRes, seriesRes, loudRes, companyRes, rbiRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=7&select=snapshot_date,yellow_energy,narrative_pressure`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_loudest_stories?order=sum_impact.desc&limit=8&select=ticker,story_count,outlets,avg_sentiment`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_ticker_universe_search?ticker=eq.${enc}&select=name,sector,industry&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/ticker_reality_belief?ticker=eq.${enc}&select=reality_belief_index,gauge_zone,active_narrative_count,dominant_belief_theme&limit=1`, { headers, signal }).catch(() => null),
  ]).finally(() => clearTimeout(timeout));

  try { if (latestRes && latestRes.ok)  { const r = await latestRes.json();  out.latest  = r[0] || null; } } catch (_) {}
  try { if (seriesRes && seriesRes.ok)  { out.series = await seriesRes.json(); } } catch (_) {}
  try { if (loudRes && loudRes.ok)      { out.loudest = await loudRes.json(); } } catch (_) {}
  try { if (companyRes && companyRes.ok){ const r = await companyRes.json(); out.company = r[0] || null; } } catch (_) {}
  try { if (rbiRes && rbiRes.ok)        { const r = await rbiRes.json();     out.rbi     = r[0] || null; } } catch (_) {}

  return out;
}

function buildRbiSection(rbi, ticker) {
  if (!rbi) return '';
  const value = num(rbi.reality_belief_index);
  const count = num(rbi.active_narrative_count) || 0;
  const zone = String(rbi.gauge_zone || '').toLowerCase();
  const theme = (rbi.dominant_belief_theme || '').replace(/_/g, ' ');
  if (value == null || count <= 0) return '';

  const colors = { reality: '#00DE94', plausible: '#84cc16', risky: '#FFB800', belief: '#FF4D4D' };
  const zc = colors[zone] || '#A0A8B0';
  const cx = 100, cy = 108, r = 75;
  const arc = (s, e, c) => {
    const sr = s * Math.PI / 180, er = e * Math.PI / 180;
    const x1 = (cx + r * Math.cos(sr)).toFixed(2), y1 = (cy - r * Math.sin(sr)).toFixed(2);
    const x2 = (cx + r * Math.cos(er)).toFixed(2), y2 = (cy - r * Math.sin(er)).toFixed(2);
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}" stroke="${c}" stroke-width="14" fill="none"/>`;
  };
  const arcs = arc(180, 135, '#00DE94') + arc(135, 90, '#84cc16') + arc(90, 45, '#FFB800') + arc(45, 0, '#FF4D4D');
  const angle = (-90 + (value / 100) * 180).toFixed(1);
  const tipY = cy - r + 6;
  const needle = `<g style="transform:rotate(${angle}deg);transform-origin:${cx}px ${cy}px;">`
    + `<path d="M ${cx} ${tipY} L ${cx - 5} ${cy - 8} L ${cx + 5} ${cy - 8} Z" fill="${zc}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="6" fill="#0C1018" stroke="${zc}" stroke-width="2"/></g>`;
  const labels = `<text x="${cx - r + 2}" y="${cy + 22}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-family="Inter,sans-serif" font-size="10" letter-spacing="1">REALITY</text>`
    + `<text x="${cx + r - 2}" y="${cy + 22}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-family="Inter,sans-serif" font-size="10" letter-spacing="1">BELIEF</text>`;
  const svg = `<svg viewBox="0 0 200 135" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:240px;display:block;" role="img" aria-label="${esc(ticker)} Reality-Belief index ${Math.round(value)} of 100, ${esc(zone)} zone">${arcs}${needle}${labels}</svg>`;

  const explainMap = {
    reality: `${ticker}'s story is largely grounded in its fundamentals — the price reflects what the company is actually doing.`,
    plausible: `${ticker}'s narrative runs slightly ahead of its fundamentals, but stays within a defensible range.`,
    risky: `Belief is starting to outpace ${ticker}'s fundamentals — elevated narrative risk.`,
    belief: `${ticker}'s price is driven mostly by belief and is detached from its underlying fundamentals.`,
  };
  const explain = explainMap[zone] || `Where ${ticker}'s price sits between fundamentals (reality) and narrative (belief).`;
  const themeChip = theme
    ? `<div class="rbi-theme"><span class="rbi-theme-k">Driving theme</span> <span class="rbi-theme-v">${esc(theme)}</span></div>`
    : '';

  return `<section class="section"><div class="con">
    <h2 class="section-title">Reality vs. Belief</h2>
    <div class="section-sub">How far ${esc(ticker)}'s narrative has drifted from its fundamentals.</div>
    <div class="card rbi-card">
      <div class="card-accent" style="background:linear-gradient(90deg,${zc},var(--mp-cyan));"></div>
      <div class="rbi-wrap">
        <div class="rbi-gauge">${svg}</div>
        <div class="rbi-readout">
          <div class="rbi-zone" style="color:${zc};">${esc(titleCase(zone))} zone</div>
          <div class="rbi-value">${Math.round(value)}<span class="rbi-value-max">/100</span></div>
          <p class="rbi-explain">${esc(explain)}</p>
          ${themeChip}
        </div>
      </div>
    </div>
  </div></section>`;
}

function buildStatRows(r) {
  const stats = [];
  const add = (label, value, meta) => {
    if (value == null || value === '') return;
    stats.push(`<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${meta ? `<div class="stat-meta">${esc(meta)}</div>` : ''}</div>`);
  };
  const fvd = num(r.fvd_pct != null ? r.fvd_pct : r.fvd);
  if (fvd != null) add('Valuation gap', `${fvd > 0 ? '+' : ''}${fvd.toFixed(1)}%`, fvd > 0 ? 'Above narrative fundamental value' : 'Below narrative fundamental value');
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
    const sc = num(r.story_count), out = num(r.outlets);
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
  const p = String(iso).split('-');
  return p.length === 3 ? `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}` : String(iso);
}
function isoDate(iso) {
  if (!iso) return '';
  const p = String(iso).split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : '';
}
function todayStr() {
  return new Date().toISOString();
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { renderStockPage };
