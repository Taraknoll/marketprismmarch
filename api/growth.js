const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_growth.html');

    const pageUrl = 'https://www.marketprism.co/growth-calculator';
    const title = 'Stock Investment Growth Calculator — See What Any Stock Would Be Worth Today | Market Prism';
    const description = 'Free stock investment calculator. Enter any ticker, amount, and start date to see what your investment would be worth today, with split-adjusted prices and a live S&P 500 comparison.';

    html = html.replace(
      '<title>Stock Investment Growth Calculator — Market Prism™</title>',
      `<title>${title}</title>`
    );

    const appSchema = {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Stock Investment Growth Calculator',
      url: pageUrl,
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      description: description,
      publisher: { '@type': 'Organization', name: 'Market Prism', url: 'https://www.marketprism.co' }
    };

    const breadcrumbSchema = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.marketprism.co' },
        { '@type': 'ListItem', position: 2, name: 'Stock Investment Growth Calculator', item: pageUrl }
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
  <link rel="alternate" type="application/rss+xml" title="Market Prism Blog" href="https://www.marketprism.co/feed.xml">
  <script type="application/ld+json">${JSON.stringify(appSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;

    html = html.replace('<!-- SEO_INJECT -->', seoBlock);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Growth calculator error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
