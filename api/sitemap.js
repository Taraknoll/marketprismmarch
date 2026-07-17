const { isHidden: isHiddenTicker } = require('./_hidden-tickers');

module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    const siteUrl = 'https://www.marketprism.co';

    // Static pages — PUBLIC only (no dashboard, ticker, daily, heatmap)
    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/stocks', priority: '0.9', changefreq: 'daily' },
      { loc: '/blog', priority: '0.9', changefreq: 'daily' },
      { loc: '/casestudies', priority: '0.8', changefreq: 'weekly' },
      { loc: '/pricing', priority: '0.7', changefreq: 'monthly' },
      { loc: '/methodology', priority: '0.6', changefreq: 'monthly' },
      { loc: '/calculators', priority: '0.8', changefreq: 'weekly' },
      { loc: '/growth-calculator', priority: '0.8', changefreq: 'weekly' },
      { loc: '/position-size-calculator', priority: '0.8', changefreq: 'weekly' },
      { loc: '/terms', priority: '0.3', changefreq: 'yearly' },
      { loc: '/privacy', priority: '0.3', changefreq: 'yearly' },
      { loc: '/faq', priority: '0.8', changefreq: 'monthly' },
    ];

    let blogEntries = [];
    let tickers = [];

    const headers = supabaseUrl && supabaseAnon ? {
      'apikey': supabaseAnon,
      'Authorization': `Bearer ${supabaseAnon}`,
    } : null;

    if (headers) {
      // Fetch blog posts and active tickers in parallel
      const [blogRes, tickerRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/blog_posts?status=eq.published&select=slug,published_at&order=published_at.desc&limit=500`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?select=ticker,snapshot_date&order=snapshot_date.desc&limit=200`, { headers }),
      ]).catch(() => [null, null]);

      if (blogRes && blogRes.ok) {
        blogEntries = await blogRes.json();
      }

      if (tickerRes && tickerRes.ok) {
        const rows = await tickerRes.json();
        // Deduplicate to unique tickers
        const seen = new Set();
        for (const r of rows) {
          if (r.ticker && !seen.has(r.ticker) && !isHiddenTicker(r.ticker)) {
            seen.add(r.ticker);
            tickers.push({ ticker: r.ticker, date: r.snapshot_date });
          }
        }
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    for (const page of staticPages) {
      xml += '  <url>\n';
      xml += `    <loc>${siteUrl}${page.loc}</loc>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += '  </url>\n';
    }

    // Blog posts
    for (const post of blogEntries) {
      const lastmod = post.published_at
        ? new Date(post.published_at).toISOString().split('T')[0]
        : '';
      xml += '  <url>\n';
      xml += `    <loc>${siteUrl}/blog/${post.slug}</loc>\n`;
      if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.7</priority>\n';
      xml += '  </url>\n';
    }

    // Case study pages (public)
    const caseStudies = ['nke', 'ccj', 'nvda'];
    for (const slug of caseStudies) {
      xml += '  <url>\n';
      xml += `    <loc>${siteUrl}/casestudy/${slug}</loc>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.7</priority>\n';
      xml += '  </url>\n';
    }

    // SEO pages only (NOT ticker pages — those require auth)
    for (const t of tickers) {
      const tickerLower = t.ticker.toLowerCase();
      const lastmod = t.date
        ? new Date(t.date).toISOString().split('T')[0]
        : '';

      // Public stock landing page (richer / shareable) — higher priority.
      xml += '  <url>\n';
      xml += `    <loc>${siteUrl}/stocks/${t.ticker}</loc>\n`;
      if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>daily</changefreq>\n';
      xml += '    <priority>0.8</priority>\n';
      xml += '  </url>\n';

      const seoPages = [
        `/why-is-${tickerLower}-stock-down`,
        `/is-${tickerLower}-overvalued`,
        `/should-i-buy-${tickerLower}`,
      ];
      for (const seoPath of seoPages) {
        xml += '  <url>\n';
        xml += `    <loc>${siteUrl}${seoPath}</loc>\n`;
        if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += '    <changefreq>daily</changefreq>\n';
        xml += '    <priority>0.6</priority>\n';
        xml += '  </url>\n';
      }
    }

    xml += '</urlset>\n';

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send('Sitemap error: ' + err.message);
  }
};
