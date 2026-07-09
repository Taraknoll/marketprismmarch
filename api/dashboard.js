const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

module.exports = async (req, res) => {
  try {
    // Preserve deep-link queries (e.g. ?tab=universe) through the login round-trip.
    const qs = (req.url || '').includes('?') ? (req.url || '').slice((req.url || '').indexOf('?')) : '';
    const auth = await requireAuth(req, res, { next: '/dashboard' + qs });
    if (!auth) return;

    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';
    // ANTHROPIC_KEY / MASSIVE_API are secrets — never injected into the client.
    // Client-initiated Claude calls go through api/scholar.js; price history
    // through api/price-history.js. Only the SCHOLAR_ENABLED flag is exposed.

    let html = resolveTemplate('_template.html');

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

    // Inject Narrative Universe tab partial
    try {
      const uvTab = resolveTemplate('_universe_tab.html');
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
    res.status(500).send('Dashboard error: ' + err.message);
  }
};
