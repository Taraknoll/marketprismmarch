const resolveTemplate = require('./_resolve-template');
const path = require('path');
const fs = require('fs');

module.exports = async (req, res) => {
  try {
    const slug = (req.query.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

    const validStudies = {
      'ccj': {
        file: 'casestudy/ccj_case_study.html',
        title: 'CCJ Case Study — The Uranium Narrative Machine | Market Prism',
        description: 'How a supply constraint story with zero SEC confirmation traded Cameco to 499% above fundamental value — and why Market Prism classified it a Narrative Trap.'
      },
      'nke': {
        file: 'casestudy/nke_case_study.html',
        title: 'NKE Case Study — Catching the Crash | Market Prism',
        description: 'How Market Prism\'s narrative decay engine flagged Nike\'s collapse weeks before Wall Street caught up. A 30-day advance warning window.'
      },
      'nvda': {
        file: 'casestudy/nvda_case_study.html',
        title: 'NVDA Case Study — The Inverse Trap | Market Prism',
        description: 'Five China narrative cycles. A Coordinated Campaign classification. How NVIDIA was talked down to $65 below fundamental value by high-credibility bearish sources.'
      }
    };

    const study = validStudies[slug];
    if (!study) {
      res.writeHead(302, { Location: '/casestudies' });
      return res.end();
    }

    // Try to read the case study HTML file
    let html;
    const filePath = path.join(__dirname, '..', study.file);
    if (fs.existsSync(filePath)) {
      html = fs.readFileSync(filePath, 'utf-8');
    } else {
      // Fallback for Vercel bundling
      html = resolveTemplate(study.file);
    }

    const pageUrl = `https://www.marketprism.co/casestudy/${slug}`;

    const metaTags = `
  <meta name="description" content="${escAttr(study.description)}">
  <link rel="canonical" href="${pageUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Market Prism">
  <meta property="og:title" content="${escAttr(study.title)}">
  <meta property="og:description" content="${escAttr(study.description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(study.title)}">
  <meta name="twitter:description" content="${escAttr(study.description)}">`;

    html = html.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Case study error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
