/**
 * seoPageRenderer.js
 * Shared renderer for programmatic SEO ticker pages.
 * Fetches data from Supabase server-side and populates the _seo_ticker.html template.
 */

const { transformNarrative, generateFAQ } = require('./narrativeEngine');
const { buildTickerMeta, buildWebPageSchema } = require('./seoHead');
const resolveTemplate = require('../api/_resolve-template');
const { isHidden: isHiddenTicker } = require('../api/_hidden-tickers');

/**
 * @param {object} opts
 * @param {string} opts.ticker        - Uppercase ticker symbol
 * @param {string} opts.pageType      - "why-down" | "overvalued" | "should-buy"
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

  // Fetch scorecard + trade data server-side
  let data = {};
  if (supabaseUrl && supabaseAnon) {
    data = await fetchTickerData(ticker, supabaseUrl, supabaseAnon);
  }

  const narr = transformNarrative({ ticker, ...data });
  const faqs = generateFAQ(ticker, narr);

  // Page-type-specific content
  const pageConfig = getPageConfig(ticker, pageType, narr, data);

  // Build meta tags
  const metaTags = buildTickerMeta({
    ticker,
    title: pageConfig.seoTitle,
    description: pageConfig.metaDesc,
    url: pageConfig.canonicalUrl,
  });

  const webPageSchema = buildWebPageSchema({
    title: pageConfig.seoTitle,
    description: pageConfig.metaDesc,
    url: pageConfig.canonicalUrl,
  });

  // Build FAQ schema from relevant subset
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": pageConfig.faqs.map(f => ({
      "@type": "Question",
      "name": f.question,
      "acceptedAnswer": { "@type": "Answer", "text": f.answer }
    }))
  });

  // Build signal rows
  const signalRows = buildSignalRows(ticker, data);

  // Build related links
  const relatedLinks = buildRelatedLinks(ticker, pageType);

  // Build content sections
  const contentSections = pageConfig.sections.map(s =>
    `<div class="seo-section">
      <h2>${esc(s.heading)}</h2>
      <p>${esc(s.body)}</p>
    </div>`
  ).join('\n');

  // Build visible FAQ block — questions/answers match FAQPage schema
  // verbatim so Google's "visible to user" rule for FAQ structured data is
  // satisfied and AI engines (Perplexity / ChatGPT / AI Overviews) can
  // extract clean Q&A pairs.
  const faqBlock = `<section class="seo-faq" aria-label="Frequently asked questions">
    <h2 class="seo-faq-title">Frequently asked questions</h2>
    <div class="seo-faq-list">
      ${pageConfig.faqs.map(f => `<div class="seo-faq-item">
        <h3 class="seo-faq-q">${esc(f.question)}</h3>
        <p class="seo-faq-a">${esc(f.answer)}</p>
      </div>`).join('\n')}
    </div>
  </section>`;

  // Today's date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Build breadcrumb schema
  const breadcrumbSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Market Prism AI", "item": "https://marketprism.co" },
      { "@type": "ListItem", "position": 2, "name": pageConfig.h1, "item": pageConfig.canonicalUrl }
    ]
  });

  // Replace all placeholders
  html = html.replace('%%SEO_TITLE%%', esc(pageConfig.seoTitle));
  html = html.replace('%%SEO_META%%', metaTags);
  html = html.replace('%%SCHEMA_WEBPAGE%%', webPageSchema);
  html = html.replace('%%SCHEMA_FAQ%%', faqSchema);
  html = html.replace('%%SCHEMA_BREADCRUMB%%', breadcrumbSchema);
  html = html.replace('%%EYEBROW%%', esc(pageConfig.eyebrow));
  html = html.replace('%%H1_TITLE%%', esc(pageConfig.h1));
  html = html.replace('%%SUBTITLE%%', esc(pageConfig.subtitle));
  html = html.replace('%%DATE%%', today);
  html = html.replace('%%CONTENT_SECTIONS%%', contentSections);
  html = html.replace('%%SIGNAL_ROWS%%', signalRows);
  html = html.replace('%%FAQ_BLOCK%%', faqBlock);
  html = html.replace(/%%TICKER%%/g, esc(ticker));
  html = html.replace('%%RELATED_LINKS%%', relatedLinks);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.status(200).send(html);
}

async function fetchTickerData(ticker, supabaseUrl, supabaseAnon) {
  const headers = {
    'apikey': supabaseAnon,
    'Authorization': `Bearer ${supabaseAnon}`,
  };

  const data = {};

  try {
    // Fetch scorecard
    const scUrl = `${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${encodeURIComponent(ticker)}&order=snapshot_date.desc&limit=1`;
    const scRes = await fetch(scUrl, { headers });
    if (scRes.ok) {
      const rows = await scRes.json();
      if (rows.length > 0) {
        const r = rows[0];
        data.verdict = r.verdict;
        data.fvd = r.fvd_pct != null ? r.fvd_pct : r.fvd;
        data.vms = r.vms;
        data.energy = r.energy_remaining;
        data.decay = r.decay_rate;
        data.coordination = r.coordination_score;
        data.narrative = r.narrative;
        data.suspicion = r.suspicion_score;
      }
    }
  } catch (e) {
    console.error('[seo] scorecard fetch error:', e.message);
  }

  try {
    // Fetch trade classification
    const tcUrl = `${supabaseUrl}/rest/v1/v_trade_cards?ticker=eq.${encodeURIComponent(ticker)}&order=snapshot_date.desc&limit=1`;
    const tcRes = await fetch(tcUrl, { headers });
    if (tcRes.ok) {
      const rows = await tcRes.json();
      if (rows.length > 0) {
        data.direction = rows[0].direction;
        data.price = rows[0].price;
        data.label = rows[0].primary_label;
      }
    }
  } catch (e) {
    console.error('[seo] trade card fetch error:', e.message);
  }

  return data;
}

function getPageConfig(ticker, pageType, narr, data) {
  const base = `https://marketprism.co`;

  if (pageType === 'why-down') {
    return {
      seoTitle: `Why Is ${ticker} Stock Down Today? | Market Prism™ AI Analysis`,
      metaDesc: `${ticker} stock analysis: ${narr.summary.substring(0, 100)} AI-powered narrative intelligence from Market Prism™.`,
      canonicalUrl: `${base}/why-is-${ticker.toLowerCase()}-stock-down`,
      eyebrow: `${ticker} · Price Movement Analysis`,
      h1: `Why Is ${ticker} Stock Down?`,
      subtitle: narr.whyMoving.substring(0, 200),
      sections: [
        { heading: `What's driving ${ticker}'s price action?`, body: narr.whyMoving },
        { heading: `Is ${ticker} overvalued?`, body: narr.isOvervalued },
        { heading: `Market Prism Verdict`, body: narr.verdictExplain },
        { heading: `What happens next for ${ticker}?`, body: narr.whatsNext },
      ],
      faqs: [
        { question: `Why is ${ticker} stock down today?`, answer: narr.whyMoving },
        { question: `Is ${ticker} a narrative trap?`, answer: narr.verdictExplain },
        { question: `Will ${ticker} stock recover?`, answer: narr.whatsNext },
      ],
    };
  }

  if (pageType === 'overvalued') {
    return {
      seoTitle: `Is ${ticker} Overvalued? AI Fair Value Analysis | Market Prism™`,
      metaDesc: `Is ${ticker} overvalued? ${narr.isOvervalued.substring(0, 100)} AI-powered valuation analysis from Market Prism™.`,
      canonicalUrl: `${base}/is-${ticker.toLowerCase()}-overvalued`,
      eyebrow: `${ticker} · Valuation Analysis`,
      h1: `Is ${ticker} Overvalued Right Now?`,
      subtitle: narr.isOvervalued.substring(0, 200),
      sections: [
        { heading: `${ticker} Fair Value Assessment`, body: narr.isOvervalued },
        { heading: `Narrative Context`, body: narr.whyMoving },
        { heading: `Market Prism Verdict`, body: narr.verdictExplain },
        { heading: `Valuation Outlook`, body: narr.whatsNext },
      ],
      faqs: [
        { question: `Is ${ticker} overvalued right now?`, answer: narr.isOvervalued },
        { question: `What is ${ticker}'s fair value?`, answer: narr.isOvervalued },
        { question: `Is ${ticker} a good value investment?`, answer: `Market Prism does not provide investment recommendations. Our forensic analysis shows: ${narr.summary}` },
      ],
    };
  }

  // should-buy
  return {
    seoTitle: `Should I Buy ${ticker} Stock? AI Analysis & Signals | Market Prism™`,
    metaDesc: `Should you buy ${ticker}? ${narr.summary.substring(0, 100)} AI-powered signal intelligence from Market Prism™.`,
    canonicalUrl: `${base}/should-i-buy-${ticker.toLowerCase()}`,
    eyebrow: `${ticker} · Investment Analysis`,
    h1: `Should I Buy ${ticker} Stock?`,
    subtitle: `Market Prism does not provide buy or sell recommendations. Here's what our forensic narrative analysis reveals.`,
    sections: [
      { heading: `${ticker} Signal Summary`, body: narr.summary },
      { heading: `Current Price Action`, body: narr.whyMoving },
      { heading: `Valuation Assessment`, body: narr.isOvervalued },
      { heading: `Market Prism Verdict`, body: narr.verdictExplain },
      { heading: `Key Risk Factors`, body: narr.whatsNext },
    ],
    faqs: [
      { question: `Should I buy ${ticker} stock?`, answer: `Market Prism does not provide buy or sell recommendations. Our forensic analysis shows: ${narr.summary} Investors should use this signal intelligence alongside their own due diligence and professional financial advice.` },
      { question: `Is ${ticker} a good investment right now?`, answer: narr.verdictExplain },
      { question: `What is the outlook for ${ticker}?`, answer: narr.whatsNext },
    ],
  };
}

function buildSignalRows(ticker, data) {
  const rows = [];

  const addRow = (label, value) => {
    if (value != null && value !== '' && value !== 'N/A') {
      rows.push(`<div class="signal-row"><span class="signal-label">${esc(label)}</span><span class="signal-value">${esc(String(value))}</span></div>`);
    }
  };

  addRow('Verdict', humanVerdict(data.verdict));
  addRow('Fair Value Deviation', data.fvd != null ? `${data.fvd > 0 ? '+' : ''}${Number(data.fvd).toFixed(1)}%` : null);
  addRow('Narrative Energy', data.energy != null ? `${Number(data.energy).toFixed(0)}%` : null);
  addRow('Volatility-Momentum', data.vms != null ? Number(data.vms).toFixed(1) : null);
  addRow('Coordination Score', data.coordination != null ? Number(data.coordination).toFixed(0) : null);
  addRow('Decay Rate', data.decay != null ? `${Number(data.decay).toFixed(1)}%` : null);
  addRow('Direction', data.direction || null);
  addRow('Price', data.price != null ? `$${Number(data.price).toFixed(2)}` : null);

  if (rows.length === 0) {
    rows.push(`<div class="signal-row"><span class="signal-label">Status</span><span class="signal-value">Data loading — check back shortly</span></div>`);
  }

  return rows.join('\n    ');
}

function humanVerdict(v) {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes('trap')) return 'Narrative Trap';
  if (s.includes('support')) return 'Structurally Supported';
  if (s.includes('monitor')) return 'Monitoring';
  return v;
}

function buildRelatedLinks(ticker, currentType) {
  const t = ticker.toLowerCase();
  const links = [];

  if (currentType !== 'why-down') {
    links.push(`<a href="/why-is-${t}-stock-down">Why is ${ticker} down?</a>`);
  }
  if (currentType !== 'overvalued') {
    links.push(`<a href="/is-${t}-overvalued">Is ${ticker} overvalued?</a>`);
  }
  if (currentType !== 'should-buy') {
    links.push(`<a href="/should-i-buy-${t}">Should I buy ${ticker}?</a>`);
  }

  links.push(`<a href="/stocks/${ticker}">${ticker} Stock Analysis</a>`);
  links.push(`<a href="/ticker/${ticker}">${ticker} Signal Card</a>`);
  links.push(`<a href="/blog">Intelligence Journal</a>`);
  links.push(`<a href="/dashboard">Full Dashboard</a>`);
  links.push(`<a href="/">Market Prism Home</a>`);

  return links.join('\n      ');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { renderSEOPage };
