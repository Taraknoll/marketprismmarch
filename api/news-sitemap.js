/**
 * Google News Sitemap
 * Format: https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap
 * Only includes articles published within the last 48 hours (Google News requirement).
 */
module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    const siteUrl = 'https://www.marketprism.co';

    let entries = [];

    if (supabaseUrl && supabaseAnon) {
      try {
        // Google News sitemaps should only contain articles from the last 2 days
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        const apiUrl = `${supabaseUrl}/rest/v1/blog_posts`
          + `?status=eq.published`
          + `&published_at=gte.${twoDaysAgo}`
          + `&select=ticker,slug,title,published_at,tag`
          + `&order=published_at.desc`
          + `&limit=100`;

        const response = await fetch(apiUrl, {
          headers: {
            'apikey': supabaseAnon,
            'Authorization': `Bearer ${supabaseAnon}`,
          },
        });

        if (response.ok) {
          entries = await response.json();
        }
      } catch (fetchErr) {
        console.error('[news-sitemap] Supabase fetch failed:', fetchErr.message);
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
    xml += '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n';
    xml += '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

    for (const post of entries) {
      const pubDate = post.published_at
        ? new Date(post.published_at).toISOString()
        : new Date().toISOString();

      // Map tags to Google News keywords
      const keywords = [];
      if (post.ticker && post.ticker !== 'MP') keywords.push(post.ticker);
      if (post.tag) keywords.push(post.tag);
      keywords.push('market analysis', 'narrative intelligence');

      // Per-article OG card (matches what blog-post.js sets as og:image)
      const imageUrl = `${siteUrl}/og-image/${esc(post.slug)}`;

      xml += '  <url>\n';
      xml += `    <loc>${siteUrl}/blog/${esc(post.slug)}</loc>\n`;
      xml += '    <news:news>\n';
      xml += '      <news:publication>\n';
      xml += '        <news:name>Market Prism</news:name>\n';
      xml += '        <news:language>en</news:language>\n';
      xml += '      </news:publication>\n';
      xml += `      <news:publication_date>${pubDate}</news:publication_date>\n`;
      xml += `      <news:title>${esc(post.title)}</news:title>\n`;
      if (keywords.length > 0) {
        xml += `      <news:keywords>${esc(keywords.join(', '))}</news:keywords>\n`;
      }
      // Note: <news:stock_tickers> requires EXCHANGE:TICKER format. Since exchange
      // isn't reliably known per ticker, we omit this field rather than guess wrong
      // (a wrong exchange is worse than none — Google may reject the entry).
      // The ticker still appears in <news:keywords> above for discoverability.
      xml += '    </news:news>\n';
      xml += '    <image:image>\n';
      xml += `      <image:loc>${imageUrl}</image:loc>\n`;
      xml += `      <image:title>${esc(post.title)}</image:title>\n`;
      xml += '    </image:image>\n';
      xml += '  </url>\n';
    }

    xml += '</urlset>\n';

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send('News sitemap error: ' + err.message);
  }
};

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
