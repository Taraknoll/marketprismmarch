module.exports = (req, res) => {
  // Gated paths that require authentication. Listed once and reused for both
  // the wildcard user-agent block and the per-bot blocks below.
  const protectedPaths = [
    '/dashboard',
    '/dashboard-dev',
    '/dashboard-v2',
    '/ticker/',
    '/ticker-dev/',
    '/daily',
    '/heatmap',
    '/scorer-dev',
    '/signalstudies',
    '/signal-charts',
    '/signal-lab',
    '/search',
    '/api/',          // server-side API endpoints — never crawl
    '/_vercel/',      // Vercel internals
  ];

  const lines = [];

  // Default rule for all bots that respect robots.txt.
  lines.push('User-agent: *');
  lines.push('Allow: /');
  lines.push('');
  lines.push('# Protected app pages — require authentication');
  protectedPaths.forEach(p => lines.push('Disallow: ' + p));
  lines.push('');

  // AI training crawlers that respect robots.txt — keep them off everything
  // gated AND off marketing pages we do not want training-corpus'd.
  // (These bots all respect robots.txt: GPTBot, ChatGPT-User, ClaudeBot,
  // anthropic-ai, PerplexityBot, Google-Extended, CCBot, Bytespider,
  // FacebookBot, Amazonbot. Blocking gated paths is defense-in-depth — auth
  // already blocks them at the server — but it tells well-behaved crawlers
  // not to even try, and it removes pages from AI training corpora.)
  const aiBots = [
    'GPTBot',
    'ChatGPT-User',
    'OAI-SearchBot',
    'ClaudeBot',
    'anthropic-ai',
    'Claude-Web',
    'PerplexityBot',
    'Google-Extended',
    'CCBot',
    'Bytespider',
    'FacebookBot',
    'Amazonbot',
    'Applebot-Extended',
    'cohere-ai',
    'Diffbot',
    'omgili',
    'omgilibot',
  ];
  aiBots.forEach(bot => {
    lines.push('User-agent: ' + bot);
    protectedPaths.forEach(p => lines.push('Disallow: ' + p));
    lines.push('');
  });

  lines.push('Sitemap: https://www.marketprism.co/sitemap.xml');
  lines.push('Sitemap: https://www.marketprism.co/news-sitemap.xml');
  lines.push('');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  res.status(200).send(lines.join('\n'));
};
