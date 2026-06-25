const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    // Preserve any ?ticker=&narrative= so the user lands back on the prefilled
    // search after logging in.
    const nextPath = req.url && req.url.indexOf('?') >= 0
      ? '/search' + req.url.slice(req.url.indexOf('?'))
      : '/search';
    const auth = await requireAuth(req, res, { next: nextPath });
    if (!auth) return;

    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    // ANTHROPIC_KEY / MASSIVE_API are secrets — never injected into the client.
    // Only the SCHOLAR_ENABLED flag is exposed.

    let html = resolveTemplate('_search.html');

    const scholarEnabled = process.env.ANTHROPIC_KEY ? 'true' : '';

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', SCHOLAR_ENABLED: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', SCHOLAR_ENABLED: '${scholarEnabled}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Search view error: ' + err.message);
  }
};
