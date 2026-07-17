/**
 * seoHead.js
 * Generates SEO meta tag strings + JSON-LD for injection into <head>.
 * Used by ticker and SEO page API routes.
 */

/**
 * Build a complete set of meta tags for a ticker page.
 * @param {object} opts
 * @param {string} opts.ticker
 * @param {string} opts.title
 * @param {string} opts.description
 * @param {string} opts.url
 * @param {string} [opts.imageUrl]
 * @returns {string} HTML string of meta tags to inject into <head>
 */
function buildTickerMeta(opts) {
  const { ticker, title, description, url } = opts;
  const image = opts.imageUrl || 'https://www.marketprism.co/og-default.png';
  const desc = (description || '').substring(0, 160);

  return `
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Market Prism AI">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(image)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">`;
}

/**
 * Build JSON-LD WebPage schema for a ticker or SEO page.
 */
function buildWebPageSchema(opts) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": opts.title,
    "description": (opts.description || '').substring(0, 160),
    "url": opts.url,
    "isPartOf": {
      "@type": "WebSite",
      "name": "Market Prism",
      "alternateName": "Market Prism AI",
      "url": "https://www.marketprism.co"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Market Prism",
      "alternateName": "Market Prism AI",
      "url": "https://www.marketprism.co",
      "description": "AI-powered stock analysis and narrative intelligence platform."
    }
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildTickerMeta, buildWebPageSchema };
