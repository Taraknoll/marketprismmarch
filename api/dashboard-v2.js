const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    const auth = await requireAuth(req, res, { next: '/api/dashboard-v2' });
    if (!auth) return;

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    // ANTHROPIC_KEY / MASSIVE_API are secrets — never injected into the client.
    // Only the SCHOLAR_ENABLED flag is exposed.

    let html = resolveTemplate('_dashboard_v2.html');

    const scholarEnabled = process.env.ANTHROPIC_KEY ? 'true' : '';

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', SCHOLAR_ENABLED: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', SCHOLAR_ENABLED: '${scholarEnabled}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Dashboard-v2 error: ' + err.message);
  }
};
