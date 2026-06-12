const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    const auth = await requireAuth(req, res, { next: '/api/dashboard-dev' });
    if (!auth) return;

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    const anthropicKey = process.env.ANTHROPIC_KEY || '';
    const massiveApi   = process.env.MASSIVE_API   || '';

    let html = resolveTemplate('_template_dev.html');

    const scholarEnabled = process.env.ANTHROPIC_KEY ? 'true' : '';

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', SCHOLAR_ENABLED: '', ANTHROPIC_KEY: '', MASSIVE_API: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', SCHOLAR_ENABLED: '${scholarEnabled}', ANTHROPIC_KEY: '${anthropicKey}', MASSIVE_API: '${massiveApi}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Dashboard-dev error: ' + err.message);
  }
};
