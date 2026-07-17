const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_privacy.html');

    // ── SEO injection (non-destructive, head-only) ──────────────────────
    const pageUrl = 'https://www.marketprism.co/privacy';
    const title = 'Privacy Policy — Market Prism';
    const description = 'Market Prism Privacy Policy. Learn how we collect, use, and protect your data on our financial narrative intelligence platform.';

    // Replace title
    html = html.replace(
      '<title>Privacy Policy — Market Prism</title>',
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
  <meta name="twitter:card" content="summary">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(description)}">`;

    // Breadcrumb schema
    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.marketprism.co" },
        { "@type": "ListItem", "position": 2, "name": "Privacy Policy", "item": pageUrl }
      ]
    };

    // WebPage schema
    const webPageSchema = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "name": title,
      "description": description,
      "url": pageUrl,
      "inLanguage": "en",
      "isPartOf": {
        "@type": "WebSite",
        "name": "Market Prism",
        "url": "https://www.marketprism.co"
      },
      "datePublished": "2026-04-02",
      "dateModified": "2026-04-02"
    };

    // Build all schema scripts
    const schemas = [
      breadcrumbSchema,
      webPageSchema
    ].map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');

    // Inject before </head>
    html = html.replace('</head>', `${metaTags}\n${schemas}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Privacy policy error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
