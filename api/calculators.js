const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_calculators.html');

    const pageUrl = 'https://www.marketprism.co/calculators';
    const title = 'Free Stock Market Calculators & Tools | Market Prism';
    const description = 'Free stock market calculators from Market Prism: investment growth, position sizing, and more. No login required.';

    html = html.replace(
      '<title>Free Stock Tools &amp; Calculators — Market Prism™</title>',
      `<title>${title}</title>`
    );

    const itemListSchema = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Free Stock Market Calculators',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Growth of $10K Calculator', url: 'https://www.marketprism.co/growth-calculator' },
        { '@type': 'ListItem', position: 2, name: 'Position Size Calculator', url: 'https://www.marketprism.co/position-size-calculator' }
      ]
    };

    const breadcrumbSchema = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.marketprism.co' },
        { '@type': 'ListItem', position: 2, name: 'Free Tools', item: pageUrl }
      ]
    };

    const seoBlock = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Market Prism">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(description)}">
  <script type="application/ld+json">${JSON.stringify(itemListSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;

    html = html.replace('<!-- SEO_INJECT -->', seoBlock);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Calculators hub error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
