const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    const auth = await requireAuth(req, res, { next: '/signalstudies' });
    if (!auth) return;

    let html = resolveTemplate('_signalstudies.html');

    const pageUrl = 'https://www.marketprism.co/signalstudies';
    const title = 'Signal Studies — How to Read Narrative Energy Charts | Market Prism';
    const description = 'Learn how to read Market Prism Signal Lab charts. Six real case studies showing Temporal Energy predicted price reversals on MP, NKE, SNAP, NVDA, DJT, and TSLA.';

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

    html = html.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Signal Studies error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
