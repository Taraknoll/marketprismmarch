// Design-test route: serves the uniform-black dashboard (_template_black.html)
// at /dashboard-black. Identical to api/dashboard.js in auth + partial
// injection so the test is faithful; only the template file differs.
// Promote by porting _template_black.html's palette into _template.html,
// then delete this route + template.
const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    // Preserve deep-link queries (e.g. ?tab=universe) through the login round-trip.
    const qs = (req.url || '').includes('?') ? (req.url || '').slice((req.url || '').indexOf('?')) : '';
    const auth = await requireAuth(req, res, { next: '/dashboard-black' + qs });
    if (!auth) return;

    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    // ANTHROPIC_KEY / MASSIVE_API are secrets — never injected into the client.
    // Only the SCHOLAR_ENABLED flag is exposed.

    let html = resolveTemplate('_template_black.html');

    // Neutralize the shared partials' blue-tinted obsidian hardcodes for the
    // black test page only — the partial files themselves stay untouched
    // because the live /dashboard injects them too.
    const neutralize = (s) => s
      .replace(/#0C1018/g, '#121212')
      .replace(/#111927/g, '#1A1A1A')
      .replace(/#080B11/g, '#0A0A0A')
      .replace(/#0A0E1A/g, '#121212')
      .replace(/#0C0D14/g, '#101010')
      .replace(/rgba\(12,16,24/g, 'rgba(18,18,18')
      .replace(/rgba\(17,25,39/g, 'rgba(26,26,26')
      .replace(/rgba\(8,11,17/g, 'rgba(10,10,10');

    // Inject Signal Lab tab partial
    try {
      const slTab = neutralize(resolveTemplate('_signal_lab_tab.html'));
      html = html.replace('<!-- SIGNAL_LAB_INJECT -->', function() { return slTab; });
    } catch (e) {
      console.warn('Signal Lab tab not found:', e.message);
    }

    // Inject Ticker Research tab partial
    try {
      const trTab = neutralize(resolveTemplate('_ticker_tab.html'));
      html = html.replace('<!-- TICKER_TAB_INJECT -->', function() { return trTab; });
    } catch (e) {
      console.warn('Ticker tab not found:', e.message);
    }

    // Inject Narrative Universe tab partial
    try {
      const uvTab = neutralize(resolveTemplate('_universe_tab.html'));
      html = html.replace('<!-- UNIVERSE_TAB_INJECT -->', function() { return uvTab; });
    } catch (e) {
      console.warn('Universe tab not found:', e.message);
    }

    const scholarEnabled = process.env.ANTHROPIC_KEY ? 'true' : '';

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', SCHOLAR_ENABLED: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', SCHOLAR_ENABLED: '${scholarEnabled}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Authenticated/beta responses are user-specific — must not be cached by the CDN.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Dashboard-black error: ' + err.message);
  }
};
