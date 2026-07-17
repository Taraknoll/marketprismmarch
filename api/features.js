const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_features.html');

    const pageUrl = 'https://www.marketprism.co/features';
    const title = 'Features & Benefits — Market Prism';
    const description = 'Real, live screens from the Market Prism dashboard — and how the forensic narrative engine stacks up against Bloomberg, Yahoo, Seeking Alpha, FinChat and ChatGPT-style stock-tip wrappers. Not an LLM wrapper.';

    const metaTags = `
  <meta property="og:type" content="website">
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
        { "@type": "ListItem", "position": 2, "name": "Features", "item": pageUrl }
      ]
    };

    const pageSchema = {
      "@context": "https://schema.org",
      "@type": "WebPage",
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

    const schemas = [breadcrumbSchema, pageSchema]
      .map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
      .join('\n');

    html = html.replace('</head>', `${metaTags}\n${schemas}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Features error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
