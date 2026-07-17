const resolveTemplate = require('./_resolve-template');

module.exports = async (req, res) => {
  try {
    let html = resolveTemplate('_casestudies.html');

    const pageUrl = 'https://www.marketprism.co/casestudies';
    const title = 'Case Studies — Forensic Narrative Intelligence | Market Prism';
    const description = 'Real-world proof of how Market Prism\'s narrative intelligence detects market-moving signals before price catches up. NKE crash detection, CCJ narrative trap analysis, and more.';

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
  <meta name="twitter:description" content="${escAttr(description)}">`;

    html = html.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Case studies error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
