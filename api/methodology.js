const resolveTemplate = require('./_resolve-template');

module.exports = async (req, res) => {
  try {
    let html = resolveTemplate('_methodology.html');

    // ── SEO injection (non-destructive, head-only) ──────────────────────
    const pageUrl = 'https://www.marketprism.co/methodology';
    const title = 'Methodology \u2014 Seven Forensic Layers | Market Prism';
    const description = 'How Market Prism analyzes equity markets: 7 forensic layers including narrative classification, decay physics, SEC filing forensics, coordination detection, Bayesian reliability, fair value stress testing, and contagion mapping.';

    // Replace title
    html = html.replace(
      '<title>Methodology \u2014 Market Prism</title>',
      `<title>${title}</title>`
    );

    // Build meta tags + schemas
    const metaTags = `
  <meta name="description" content="${escAttr(description)}">
  <link rel="canonical" href="${pageUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Market Prism">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(description)}">
  <link rel="alternate" type="application/rss+xml" title="Market Prism Intelligence Journal" href="https://www.marketprism.co/feed.xml">
  <link rel="alternate" type="application/atom+xml" title="Market Prism Intelligence Journal (Atom)" href="https://www.marketprism.co/atom.xml">`;

    // HowTo schema — describes the 7-layer analysis process
    const howToSchema = {
      "@context": "https://schema.org",
      "@type": "HowTo",
      "name": "How Market Prism Analyzes Equity Narratives",
      "description": "Market Prism's patent-pending framework applies seven forensic analytical layers to every covered ticker before each market open.",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Narrative State Classification", "text": "Classify where each market story sits in its lifecycle (breaking, surging, maturing, fragile, collapsing, stable) using natural language analysis, attention velocity, and repetition entropy." },
        { "@type": "HowToStep", "position": 2, "name": "Narrative Decay Physics", "text": "Calculate the narrative half-life for each active story, measuring how quickly attention and conviction dissipate using radioactive decay mathematics." },
        { "@type": "HowToStep", "position": 3, "name": "SEC Filing Forensics", "text": "Measure divergence between management narrative claims in MD&A sections and quantitative disclosures in SEC filing tables." },
        { "@type": "HowToStep", "position": 4, "name": "Coordination Detection", "text": "Detect when multiple independent sources converge on the same thesis within a narrow window, identifying coordinated narrative clusters." },
        { "@type": "HowToStep", "position": 5, "name": "Bayesian Analyst Reliability", "text": "Maintain Bayesian reliability models for every source, updating conviction weights based on historical accuracy, sector expertise, and timing precision." },
        { "@type": "HowToStep", "position": 6, "name": "Fair Value Stress Testing", "text": "Compare current price against where the narrative implies it should be using multi-factor models combining fundamental anchors with narrative energy." },
        { "@type": "HowToStep", "position": 7, "name": "Contagion Mapping", "text": "Map how narrative shocks propagate through supply chains, sector peers, and thematic clusters to identify upstream and downstream impact." }
      ]
    };

    // DefinedTerm schemas for key Market Prism concepts
    const definedTerms = [
      {
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        "name": "Narrative Trap",
        "description": "A Market Prism verdict indicating that a stock's price is being driven by a story that forensic evidence doesn't support. The gap between narrative energy and structural reality is widening, historically associated with downside risk.",
        "inDefinedTermSet": { "@type": "DefinedTermSet", "name": "Market Prism Verdicts" }
      },
      {
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        "name": "Structurally Supported",
        "description": "A Market Prism verdict indicating that the underlying narrative aligns with fundamentals, SEC filings, and sector dynamics. The story is credible and the price action is justified by verifiable data.",
        "inDefinedTermSet": { "@type": "DefinedTermSet", "name": "Market Prism Verdicts" }
      },
      {
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        "name": "Fair Value Deviation",
        "description": "A Market Prism metric quantifying how far a stock's current price has diverged from its estimated fair value, expressed as a percentage. Positive values indicate overvaluation, negative values indicate undervaluation.",
        "inDefinedTermSet": { "@type": "DefinedTermSet", "name": "Market Prism Metrics" }
      },
      {
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        "name": "Narrative Energy",
        "description": "A Market Prism metric measuring the remaining momentum in a market story on a 0-100% scale. High energy indicates the thesis is gaining traction; declining energy signals the narrative is losing conviction.",
        "inDefinedTermSet": { "@type": "DefinedTermSet", "name": "Market Prism Metrics" }
      }
    ];

    // Breadcrumb schema
    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.marketprism.co" },
        { "@type": "ListItem", "position": 2, "name": "Methodology", "item": pageUrl }
      ]
    };

    // Speakable schema
    const speakableSchema = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "speakable": {
        "@type": "SpeakableSpecification",
        "cssSelector": [".meth-hero-lead", ".layer-desc"]
      },
      "url": pageUrl
    };

    // Build all schema scripts
    const schemas = [
      howToSchema,
      ...definedTerms,
      breadcrumbSchema,
      speakableSchema,
    ].map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');

    // Inject before </head>
    html = html.replace('</head>', `${metaTags}\n${schemas}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Methodology error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
