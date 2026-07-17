/**
 * RSS 2.0 + Atom feed for Market Prism Intelligence Journal.
 * - /feed or /feed.xml → RSS 2.0 (default)
 * - /feed?format=atom or /atom.xml → Atom 1.0
 *
 * Used by ChatGPT Browse, Perplexity, Google News, Feedly, and other aggregators.
 */
module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    const siteUrl = 'https://www.marketprism.co';
    const isAtom = (req.query && req.query.format === 'atom')
      || (req.url || '').includes('atom');

    let posts = [];

    if (supabaseUrl && supabaseAnon) {
      try {
        const apiUrl = `${supabaseUrl}/rest/v1/blog_posts`
          + `?status=eq.published`
          + `&select=ticker,slug,title,excerpt,body,tag,author,published_at,image_url`
          + `&order=published_at.desc`
          + `&limit=30`;

        const response = await fetch(apiUrl, {
          headers: {
            'apikey': supabaseAnon,
            'Authorization': `Bearer ${supabaseAnon}`,
          },
        });

        if (response.ok) {
          posts = await response.json();
        }
      } catch (fetchErr) {
        console.error('[feed] Supabase fetch failed:', fetchErr.message);
      }
    }

    const output = isAtom ? buildAtom(posts, siteUrl) : buildRSS(posts, siteUrl);
    const contentType = isAtom ? 'application/atom+xml' : 'application/rss+xml';

    res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(output);
  } catch (err) {
    res.status(500).send('Feed error: ' + err.message);
  }
};

function buildRSS(posts, siteUrl) {
  const now = new Date().toUTCString();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">\n';
  xml += '<channel>\n';
  xml += '  <title>Market Prism Intelligence Journal</title>\n';
  xml += `  <link>${siteUrl}/blog</link>\n`;
  xml += '  <description>Forensic narrative intelligence and institutional-grade equity market analysis. Published daily before the opening bell.</description>\n';
  xml += '  <language>en-us</language>\n';
  xml += `  <lastBuildDate>${now}</lastBuildDate>\n`;
  xml += `  <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml" />\n`;
  xml += '  <copyright>Copyright 2025-2026 Market Prism. All rights reserved.</copyright>\n';
  xml += '  <managingEditor>research@marketprism.co (Market Prism Research)</managingEditor>\n';
  xml += `  <image>\n`;
  xml += `    <url>${siteUrl}/logo.png</url>\n`;
  xml += '    <title>Market Prism</title>\n';
  xml += `    <link>${siteUrl}</link>\n`;
  xml += '  </image>\n';

  for (const post of posts) {
    const postUrl = `${siteUrl}/blog/${post.slug}`;
    const pubDate = post.published_at
      ? new Date(post.published_at).toUTCString()
      : now;
    const desc = (post.excerpt || '').substring(0, 300);
    const categories = [];
    if (post.tag) categories.push(post.tag);
    if (post.ticker && post.ticker !== 'MP') categories.push(post.ticker);

    xml += '  <item>\n';
    xml += `    <title>${esc(post.title)}</title>\n`;
    xml += `    <link>${postUrl}</link>\n`;
    xml += `    <guid isPermaLink="true">${postUrl}</guid>\n`;
    xml += `    <pubDate>${pubDate}</pubDate>\n`;
    xml += `    <description>${esc(desc)}</description>\n`;
    xml += `    <author>research@marketprism.co (${esc(post.author || 'Market Prism Research')})</author>\n`;
    for (const cat of categories) {
      xml += `    <category>${esc(cat)}</category>\n`;
    }
    if (post.image_url) {
      xml += `    <media:content url="${esc(post.image_url)}" medium="image" />\n`;
      xml += `    <media:thumbnail url="${esc(post.image_url)}" />\n`;
    }
    xml += '  </item>\n';
  }

  xml += '</channel>\n</rss>\n';
  return xml;
}

function buildAtom(posts, siteUrl) {
  const now = new Date().toISOString();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<feed xmlns="http://www.w3.org/2005/Atom">\n';
  xml += '  <title>Market Prism Intelligence Journal</title>\n';
  xml += '  <subtitle>Forensic narrative intelligence and institutional-grade equity market analysis.</subtitle>\n';
  xml += `  <link href="${siteUrl}/blog" />\n`;
  xml += `  <link href="${siteUrl}/atom.xml" rel="self" type="application/atom+xml" />\n`;
  xml += `  <id>${siteUrl}/blog</id>\n`;
  xml += `  <updated>${now}</updated>\n`;
  xml += '  <author>\n';
  xml += '    <name>Market Prism Research</name>\n';
  xml += `    <uri>${siteUrl}</uri>\n`;
  xml += '  </author>\n';
  xml += '  <rights>Copyright 2025-2026 Market Prism</rights>\n';

  for (const post of posts) {
    const postUrl = `${siteUrl}/blog/${post.slug}`;
    const updated = post.published_at
      ? new Date(post.published_at).toISOString()
      : now;
    const summary = (post.excerpt || '').substring(0, 300);

    xml += '  <entry>\n';
    xml += `    <title>${esc(post.title)}</title>\n`;
    xml += `    <link href="${postUrl}" />\n`;
    xml += `    <id>${postUrl}</id>\n`;
    xml += `    <published>${updated}</published>\n`;
    xml += `    <updated>${updated}</updated>\n`;
    xml += `    <summary>${esc(summary)}</summary>\n`;
    xml += `    <author><name>${esc(post.author || 'Market Prism Research')}</name></author>\n`;
    if (post.tag) {
      xml += `    <category term="${esc(post.tag)}" />\n`;
    }
    xml += '  </entry>\n';
  }

  xml += '</feed>\n';
  return xml;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
