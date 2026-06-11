// Design-test route: serves the uniform-black dashboard (_template_black.html)
// at /dashboard-black. Identical to api/dashboard.js in auth + partial
// injection so the test is faithful; only the template file differs.
// Promote by porting _template_black.html's palette into _template.html,
// then delete this route + template.
const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    const auth = await requireAuth(req, res, { next: '/dashboard-black' });
    if (!auth) return;

    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    const anthropicKey = process.env.ANTHROPIC_KEY || '';
    const massiveApi   = process.env.MASSIVE_API   || '';

    let html = resolveTemplate('_template_black.html');

    // Inject Signal Lab tab partial
    try {
      const slTab = resolveTemplate('_signal_lab_tab.html');
      html = html.replace('<!-- SIGNAL_LAB_INJECT -->', function() { return slTab; });
    } catch (e) {
      console.warn('Signal Lab tab not found:', e.message);
    }

    // Inject Ticker Research tab partial
    try {
      const trTab = resolveTemplate('_ticker_tab.html');
      html = html.replace('<!-- TICKER_TAB_INJECT -->', function() { return trTab; });
    } catch (e) {
      console.warn('Ticker tab not found:', e.message);
    }

    const scholarEnabled = process.env.ANTHROPIC_KEY ? 'true' : '';

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', SCHOLAR_ENABLED: '', ANTHROPIC_KEY: '', MASSIVE_API: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', SCHOLAR_ENABLED: '${scholarEnabled}', ANTHROPIC_KEY: '${anthropicKey}', MASSIVE_API: '${massiveApi}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Authenticated/beta responses are user-specific — must not be cached by the CDN.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Dashboard-black error: ' + err.message);
  }
};
