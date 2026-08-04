/**
 * seoPageRenderer.js
 * Shared renderer for programmatic SEO ticker pages:
 *   /why-is-:ticker-stock-down   (why-down)
 *   /is-:ticker-overvalued       (overvalued)
 *   /should-i-buy-:ticker        (should-buy)
 *
 * Conversion-optimized, answer-first landing pages:
 *   - free, indexable content: a direct answer box, narrative read, Reality-
 *     Belief gauge, 7-day signal chart, key signals, narrative detail, FAQ
 *   - a server-gated "projected price & trade signal" block (blurred teaser
 *     only — real numbers never sent to an anon client) that drives signup
 *
 * SEO/AEO: per-page title/meta/canonical, WebPage + Breadcrumb + FAQPage
 * (verbatim Q&A match) + paywall JSON-LD.
 */

const { transformNarrative, generateFAQ } = require('./narrativeEngine');
const { buildTickerMeta, buildWebPageSchema } = require('./seoHead');
const resolveTemplate = require('../api/_resolve-template');
const { isHidden: isHiddenTicker } = require('../api/_hidden-tickers');

const SITE = 'https://www.marketprism.co';

/**
 * @param {object} opts
 * @param {string} opts.ticker        Uppercase ticker symbol
 * @param {string} opts.pageType      "why-down" | "overvalued" | "should-buy"
 * @param {object} req
 * @param {object} res
 */
async function renderSEOPage(opts, req, res) {
  const { ticker, pageType } = opts;

  if (isHiddenTicker(ticker)) {
    res.status(404).send('Not found');
    return;
  }

  const supabaseUrl  = process.env.SUPABASE_URL  || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';

  let html = resolveTemplate('_seo_ticker.html');

  // Fetch all data server-side.
  let data = {};
  if (supabaseUrl && supabaseAnon) {
    data = await fetchTickerData(ticker, supabaseUrl, supabaseAnon);
  }

  const companyName = cleanCompanyName(data.companyName);

  const narr = transformNarrative({
    ticker,
    companyName,
    verdict: data.verdict,
    fvd: data.fvd,
    vms: data.vms,
    energy: data.energy,
    decay: data.decay,
    coordination: data.coordination,
    narrative: data.narrative,
    suspicion: data.suspicion,
    direction: data.direction,
    rbi: data.rbi,
    rbiZone: data.rbiZone,
  });

  const pageConfig = getPageConfig(ticker, pageType, narr, data, companyName);

  // ── meta / schema ──
  const metaTags = buildTickerMeta({
    ticker,
    title: pageConfig.seoTitle,
    description: pageConfig.metaDesc,
    url: pageConfig.canonicalUrl,
    imageUrl: `${SITE}/stock-og/${ticker}`,
  });

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const webPageSchema = JSON.stringify({
    ...JSON.parse(buildWebPageSchema({
      title: pageConfig.seoTitle,
      description: pageConfig.metaDesc,
      url: pageConfig.canonicalUrl,
    })),
    "dateModified": isoDate(data.snapshotDate) || isoDate(new Date().toISOString()),
    "about": { "@type": "Corporation", "name": companyName || ticker, "tickerSymbol": ticker },
  });

  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": pageConfig.faqs.map(f => ({
      "@type": "Question",
      "name": f.question,
      "acceptedAnswer": { "@type": "Answer", "text": f.answer }
    }))
  });

  const breadcrumbSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Market Prism", "item": SITE },
      { "@type": "ListItem", "position": 2, "name": `${ticker} Stocks`, "item": `${SITE}/stocks/${ticker}` },
      { "@type": "ListItem", "position": 3, "name": pageConfig.h1, "item": pageConfig.canonicalUrl }
    ]
  });

  const paywallSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "url": pageConfig.canonicalUrl,
    "isAccessibleForFree": false,
    "hasPart": { "@type": "WebPageElement", "isAccessibleForFree": false, "cssSelector": ".locked-card" }
  });

  // ── badges ──
  const verdictClass = familyClass(narr.verdictFamily);
  const sentiment = classifySentiment(data.sentiment, narr.verdictFamily);

  // ── seed price ──
  const seedPrice = numOrNull(data.price);
  const priceStr = seedPrice != null ? fmtUsd(seedPrice) : '—';

  // ── visual blocks ──
  const rbiSection = buildRbiSection(data, ticker);
  const statRows = buildStatRows(data);
  const chartData = buildChartSeries(data.series);

  // ── detail content sections ──
  const contentSections = pageConfig.sections.map(s =>
    `<section class="section"><div class="con">
      <h2 class="section-title">${esc(s.heading)}</h2>
      <p class="narrative-read">${esc(s.body)}</p>
    </div></section>`
  ).join('\n');

  // ── FAQ (visible + schema verbatim) ──
  const faqBlock = `<section class="section"><div class="con">
    <h2 class="section-title">Frequently asked questions</h2>
    <div class="faq-list">
      ${pageConfig.faqs.map(f => `<div class="faq-item">
        <h3 class="faq-q">${esc(f.question)}</h3>
        <p class="faq-a">${esc(f.answer)}</p>
      </div>`).join('\n      ')}
    </div>
  </div></section>`;

  // ── loudest + related ──
  const loudHtml = buildLoudest(data.loudest, ticker);
  const relatedLinks = buildRelatedLinks(ticker, pageType, companyName);

  // ── calculators ──
  const growthHref = `/growth-calculator?ticker=${encodeURIComponent(ticker)}`;
  const posHref = seedPrice != null
    ? `/position-size-calculator?entry=${seedPrice.toFixed(2)}`
    : `/position-size-calculator`;

  // ── populate template ──
  html = html
    .replace(/%%SEO_TITLE%%/g, esc(pageConfig.seoTitle))
    .replace('%%SEO_META%%', metaTags)
    .replace('%%SCHEMA_WEBPAGE%%', webPageSchema)
    .replace('%%SCHEMA_FAQ%%', faqSchema)
    .replace('%%SCHEMA_BREADCRUMB%%', breadcrumbSchema)
    .replace('%%SCHEMA_PAYWALL%%', paywallSchema)
    .replace('%%EYEBROW%%', esc(pageConfig.eyebrow))
    .replace('%%H1_TITLE%%', esc(pageConfig.h1))
    .replace('%%SUBTITLE%%', esc(pageConfig.subtitle))
    .replace('%%ANSWER%%', esc(pageConfig.answer))
    .replace(/%%VERDICT_CLASS%%/g, verdictClass)
    .replace(/%%VERDICT_LABEL%%/g, esc(narr.verdictLabel))
    .replace('%%SENTIMENT_CLASS%%', sentiment.cls)
    .replace('%%SENTIMENT_LABEL%%', esc(sentiment.label))
    .replace('%%PRICE%%', esc(priceStr))
    .replace('%%WHY_HEADING%%', esc(pageConfig.whyHeading))
    .replace('%%WHY_BODY%%', esc(pageConfig.whyBody))
    .replace('%%RBI_SECTION%%', rbiSection)
    .replace('%%STAT_ROWS%%', statRows)
    .replace('%%CONTENT_SECTIONS%%', contentSections)
    .replace('%%FAQ_BLOCK%%', faqBlock)
    .replace('%%LOUDEST%%', loudHtml)
    .replace('%%RELATED_LINKS%%', relatedLinks)
    .replace('%%CALC_GROWTH_HREF%%', esc(growthHref))
    .replace('%%CALC_POS_HREF%%', esc(posHref))
    .replace(/%%COMPANY%%/g, esc(companyName || 'Narrative intelligence report'))
    .replace(/%%DATE%%/g, esc(today))
    .replace(/%%TICKER%%/g, esc(ticker));

  // Chart + share payloads.
  const shareText = `${companyName ? companyName + ' (' + ticker + ')' : ticker}: ${pageConfig.h1} — forensic narrative analysis on Market Prism`;
  const shareObj = { ticker, url: pageConfig.canonicalUrl, card: `${SITE}/stock-og/${ticker}`, title: pageConfig.seoTitle, text: shareText };
  html = html.replace(
    '/*__MP_DATA__*/',
    `window.__MP_CHART = ${JSON.stringify(chartData)}; window.__MP_SHARE = ${JSON.stringify(shareObj)};`
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.status(200).send(html);
}

async function fetchTickerData(ticker, supabaseUrl, supabaseAnon) {
  const headers = { 'apikey': supabaseAnon, 'Authorization': `Bearer ${supabaseAnon}` };
  const enc = encodeURIComponent(ticker);
  const data = {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const signal = controller.signal;

  const [scRes, seriesRes, tcRes, companyRes, rbiRes, loudRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${enc}&order=snapshot_date.desc&limit=7&select=snapshot_date,yellow_energy,narrative_pressure`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_trade_cards?ticker=eq.${enc}&order=snapshot_date.desc&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_ticker_universe_search?ticker=eq.${enc}&select=name,sector,industry&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/ticker_reality_belief?ticker=eq.${enc}&select=reality_belief_index,gauge_zone,active_narrative_count,dominant_belief_theme&limit=1`, { headers, signal }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/v_loudest_stories?order=sum_impact.desc&limit=8&select=ticker,story_count,outlets,avg_sentiment`, { headers, signal }).catch(() => null),
  ]).finally(() => clearTimeout(timeout));

  try {
    if (scRes && scRes.ok) {
      const rows = await scRes.json();
      const r = rows[0];
      if (r) {
        data.snapshotDate = r.snapshot_date;
        data.verdict = r.verdict;
        data.fvd = r.fvd_pct != null ? r.fvd_pct : r.fvd;
        data.vms = r.vms;
        data.energy = r.energy_remaining;
        data.decay = r.decay_rate;
        data.coordination = r.coordination_score;
        data.narrative = r.narrative;
        data.suspicion = r.suspicion_score;
        data.sentiment = r.current_sentiment;
        data.npi = r.npi; data.npiBand = r.npi_band;
        data.halfLife = r.half_life;
        data.acs = r.acs; data.acsBand = r.acs_band;
        data.srs = r.srs; data.srsBand = r.srs_band;
      }
    }
  } catch (e) { console.error('[seo] scorecard:', e.message); }

  try { if (seriesRes && seriesRes.ok) data.series = await seriesRes.json(); } catch (_) {}

  try {
    if (tcRes && tcRes.ok) {
      const rows = await tcRes.json();
      if (rows[0]) { data.direction = rows[0].direction; data.price = rows[0].price; data.label = rows[0].primary_label; }
    }
  } catch (_) {}

  try {
    if (companyRes && companyRes.ok) {
      const rows = await companyRes.json();
      if (rows[0]) { data.companyName = rows[0].name; data.sector = rows[0].sector; data.industry = rows[0].industry; }
    }
  } catch (_) {}

  try {
    if (rbiRes && rbiRes.ok) {
      const rows = await rbiRes.json();
      if (rows[0]) {
        data.rbi = rows[0].reality_belief_index;
        data.rbiZone = rows[0].gauge_zone;
        data.rbiCount = rows[0].active_narrative_count;
        data.rbiTheme = rows[0].dominant_belief_theme;
      }
    }
  } catch (_) {}

  try { if (loudRes && loudRes.ok) data.loudest = await loudRes.json(); } catch (_) {}

  return data;
}

function getPageConfig(ticker, pageType, narr, data, companyName) {
  const t = ticker.toLowerCase();
  const nameForTitle = companyName ? `${companyName} (${ticker})` : ticker;
  const cleanTldr = narr.tldr.replace(/^The short answer:\s*/i, '').replace(/^./, c => c.toUpperCase());

  if (pageType === 'overvalued') {
    return {
      seoTitle: `Is ${ticker} Overvalued? AI Fundamental Value Analysis | Market Prism`,
      metaDesc: `Is ${ticker} overvalued? ${narr.isOvervalued.substring(0, 110)}`,
      canonicalUrl: `${SITE}/is-${t}-overvalued`,
      eyebrow: `${ticker} · Valuation Analysis`,
      h1: `Is ${ticker} Overvalued Right Now?`,
      subtitle: `A forensic read of ${nameForTitle}'s valuation — narrative vs. fundamentals, not a buy or sell rating.`,
      answer: narr.isOvervalued,
      whyHeading: `${ticker} fundamental value assessment`,
      whyBody: narr.isOvervalued,
      sections: [
        { heading: `What's driving ${ticker}'s price`, body: narr.whyMoving },
        { heading: `Market Prism's verdict on ${ticker}`, body: narr.verdictExplain },
        { heading: `Valuation outlook for ${ticker}`, body: narr.whatsNext },
      ],
      faqs: [
        { question: `Is ${ticker} overvalued right now?`, answer: narr.isOvervalued },
        { question: `What is Market Prism's verdict on ${ticker}?`, answer: narr.verdictExplain },
        { question: `What happens next for ${ticker}?`, answer: narr.whatsNext },
        { question: `Is ${ticker} a good value investment?`, answer: `Market Prism does not provide investment recommendations. Our forensic analysis shows: ${narr.summary}` },
      ],
    };
  }

  if (pageType === 'should-buy') {
    return {
      seoTitle: `Should I Buy ${ticker} Stock? AI Analysis & Signals | Market Prism`,
      metaDesc: `Should you buy ${ticker}? ${cleanTldr.substring(0, 110)}`,
      canonicalUrl: `${SITE}/should-i-buy-${t}`,
      eyebrow: `${ticker} · Signal Analysis`,
      h1: `Should I Buy ${ticker} Stock?`,
      subtitle: `Market Prism doesn't give buy or sell ratings. Here's what our forensic narrative analysis of ${nameForTitle} actually shows.`,
      answer: narr.tldr,
      whyHeading: `What the ${ticker} signals show`,
      whyBody: narr.summary + ' ' + narr.whyMoving,
      sections: [
        { heading: `Is ${ticker} overvalued?`, body: narr.isOvervalued },
        { heading: `Market Prism's verdict on ${ticker}`, body: narr.verdictExplain },
        { heading: `Key risks & what happens next`, body: narr.whatsNext },
      ],
      faqs: generateFAQ(ticker, narr),
    };
  }

  // why-down (default)
  return {
    seoTitle: `Why Is ${ticker} Stock Down Today? | Market Prism AI Analysis`,
    metaDesc: `Why is ${ticker} down? ${cleanTldr.substring(0, 110)}`,
    canonicalUrl: `${SITE}/why-is-${t}-stock-down`,
    eyebrow: `${ticker} · Price Movement Analysis`,
    h1: `Why Is ${ticker} Stock Down?`,
    subtitle: `A forensic read of what's moving ${nameForTitle} — the story behind the price, not a buy or sell rating.`,
    answer: narr.tldr,
    whyHeading: `What's driving ${ticker}'s price action`,
    whyBody: narr.whyMoving,
    sections: [
      { heading: `Is ${ticker} overvalued?`, body: narr.isOvervalued },
      { heading: `Market Prism's verdict on ${ticker}`, body: narr.verdictExplain },
      { heading: `What happens next for ${ticker}`, body: narr.whatsNext },
    ],
    faqs: [
      { question: `Why is ${ticker} stock down today?`, answer: narr.whyMoving },
      { question: `Is ${ticker} overvalued right now?`, answer: narr.isOvervalued },
      { question: `What is Market Prism's verdict on ${ticker}?`, answer: narr.verdictExplain },
      { question: `Will ${ticker} stock recover?`, answer: narr.whatsNext },
    ],
  };
}

/* ── visual builders ── */

function buildRbiSection(data, ticker) {
  const value = numOrNull(data.rbi);
  const count = numOrNull(data.rbiCount) || 0;
  const zone = String(data.rbiZone || '').toLowerCase();
  const theme = (data.rbiTheme || '').replace(/_/g, ' ');
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

function buildStatRows(d) {
  const stats = [];
  const add = (label, value, meta) => {
    if (value == null || value === '') return;
    stats.push(`<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${meta ? `<div class="stat-meta">${esc(meta)}</div>` : ''}</div>`);
  };
  const fvd = numOrNull(d.fvd);
  if (fvd != null) add('Valuation gap', `${fvd > 0 ? '+' : ''}${fvd.toFixed(1)}%`, fvd > 0 ? 'Above narrative fundamental value' : 'Below narrative fundamental value');
  if (numOrNull(d.energy) != null) add('Narrative energy', `${numOrNull(d.energy).toFixed(0)}%`, numOrNull(d.energy) < 40 ? 'Fading' : 'Remaining fuel');
  if (numOrNull(d.vms) != null) add('Volatility-momentum', numOrNull(d.vms).toFixed(0), 'Price displacement');
  if (numOrNull(d.npi) != null) add('Narrative persistence', numOrNull(d.npi).toFixed(0), d.npiBand || null);
  if (numOrNull(d.halfLife) != null) add('Narrative half-life', `${numOrNull(d.halfLife).toFixed(1)}d`, 'Attention decay');
  if (numOrNull(d.acs) != null) add('Source credibility', numOrNull(d.acs).toFixed(0), d.acsBand || null);
  if (numOrNull(d.coordination) != null) add('Coordination', numOrNull(d.coordination).toFixed(0), null);
  if (numOrNull(d.srs) != null) add('Signal reliability', numOrNull(d.srs).toFixed(0), d.srsBand || null);
  if (numOrNull(d.sentiment) != null) add('Narrative sentiment', numOrNull(d.sentiment).toFixed(1), 'Tone of coverage');
  return stats.slice(0, 6).join('\n      ') || '<div class="stat"><div class="stat-label">Status</div><div class="stat-value">Updating</div><div class="stat-meta">Check back shortly</div></div>';
}

function buildChartSeries(series) {
  return (series || []).slice().reverse().map(r => ({
    date: shortDate(r.snapshot_date),
    force: numOrNull(r.yellow_energy) || 0,
    pressure: numOrNull(r.narrative_pressure) || 0,
  }));
}

function buildLoudest(rows, currentTicker) {
  const items = [];
  for (const r of (rows || [])) {
    if (!r.ticker || r.ticker === currentTicker || isHiddenTicker(r.ticker)) continue;
    const sc = numOrNull(r.story_count), out = numOrNull(r.outlets);
    const meta = [sc != null ? `${sc} stories` : null, out != null ? `${out} outlets` : null].filter(Boolean).join(' · ') || 'Active narrative';
    items.push(`<a class="loud-item" href="/stocks/${esc(r.ticker)}"><span class="loud-tkr">${esc(r.ticker)}</span><span class="loud-txt">${esc(meta)}</span></a>`);
    if (items.length >= 5) break;
  }
  return items.join('\n      ') || '<div class="loud-txt">No active stories right now.</div>';
}

function buildRelatedLinks(ticker, currentType, companyName) {
  const t = ticker.toLowerCase();
  const links = [];
  if (currentType !== 'why-down') links.push(`<a href="/why-is-${t}-stock-down">Why is ${ticker} down?</a>`);
  if (currentType !== 'overvalued') links.push(`<a href="/is-${t}-overvalued">Is ${ticker} overvalued?</a>`);
  if (currentType !== 'should-buy') links.push(`<a href="/should-i-buy-${t}">Should I buy ${ticker}?</a>`);
  links.push(`<a href="/stocks/${ticker}">${ticker} full analysis →</a>`);
  links.push(`<a href="/stocks">All stocks</a>`);
  return links.join('\n      ');
}

/* ── helpers ── */
function cleanCompanyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s+Class [A-Z]\s+Common Stock$/i, '')
    .replace(/\s+Common Stock$/i, '')
    .replace(/\s+Ordinary Shares$/i, '')
    .replace(/,?\s+Inc\.?$/i, ' Inc.')
    .trim();
}
function familyClass(family) {
  if (family === 'bull') return 'bull';
  if (family === 'bear') return 'bear';
  if (family === 'caution') return 'caution';
  return 'neutral';
}
function classifySentiment(s, family) {
  const v = numOrNull(s);
  if (family === 'bull') return { cls: 'bull', label: 'Bullish narrative' };
  if (family === 'bear') return { cls: 'bear', label: 'Bearish narrative' };
  if (v != null && v >= 5) return { cls: 'bull', label: 'Bullish narrative' };
  if (v != null && v <= -5) return { cls: 'bear', label: 'Bearish narrative' };
  return { cls: 'neutral', label: 'Neutral narrative' };
}
function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
}
function numOrNull(v) {
  if (v == null || v === '') return null;
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
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { renderSEOPage };
