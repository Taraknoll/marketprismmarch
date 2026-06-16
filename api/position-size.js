const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_position_size.html');

    const pageUrl = 'https://marketprism.co/position-size-calculator';
    const title = 'Position Size Calculator — Size Any Trade by Risk | Market Prism';
    const description = 'Free position size and risk calculator. Enter your account size, risk per trade, entry, and stop-loss to get the exact share count, capital at risk, and reward-to-risk ratio.';

    html = html.replace(
      '<title>Position Size Calculator — Market Prism™</title>',
      `<title>${title}</title>`
    );

    const appSchema = {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Position Size Calculator',
      url: pageUrl,
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      description: description,
      publisher: { '@type': 'Organization', name: 'Market Prism', url: 'https://marketprism.co' }
    };

    const breadcrumbSchema = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://marketprism.co' },
        { '@type': 'ListItem', position: 2, name: 'Free Tools', item: 'https://marketprism.co/calculators' },
        { '@type': 'ListItem', position: 3, name: 'Position Size Calculator', item: pageUrl }
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
  <script type="application/ld+json">${JSON.stringify(appSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;

    html = html.replace('<!-- SEO_INJECT -->', seoBlock);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Position size calculator error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
