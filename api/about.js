const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_about.html');

    // ── SEO injection ──────────────────────
    const pageUrl = 'https://www.marketprism.co/about';
    const title = 'Built Out of Rage — Market Prism';
    const description = 'Why Market Prism exists: a forensic narrative engine for retail traders who got tired of being the exit liquidity. Built for the WSB-burned generation — and against the era of AI-generated market noise.';

    html = html.replace(
      '<title>Built Out of Rage — Market Prism</title>',
      `<title>${title}</title>`
    );

    const metaTags = `
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Market Prism">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(description)}">`;

    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.marketprism.co" },
        { "@type": "ListItem", "position": 2, "name": "About", "item": pageUrl }
      ]
    };

    const aboutSchema = {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      "name": title,
      "description": description,
      "url": pageUrl,
      "inLanguage": "en-US",
      "isPartOf": {
        "@type": "WebSite",
        "name": "Market Prism",
        "url": "https://www.marketprism.co"
      }
    };

    const schemas = [breadcrumbSchema, aboutSchema]
      .map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
      .join('\n');

    html = html.replace('</head>', `${metaTags}\n${schemas}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('About error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
