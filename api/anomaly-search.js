const resolveTemplate = require('./_resolve-template');

// ──────────────────────────────────────────────────────────────────────────
// /anomaly-search — AI Semantic Anomaly Search (lightweight MVP, preview)
//
// Serves the self-contained _anomaly_search.html page. All querying happens
// CLIENT-SIDE via the anon Supabase REST key (PostgREST) — same pattern as the
// rest of the dashboard (see lib/mp-core.js MP.rest). No server SQL, no LLM, no
// new dependency or env: SUPABASE_URL / SUPABASE_ANON already exist in prod.
//
// Intentionally NOT behind requireAuth: this is an UNLISTED test page (noindex,
// not linked in nav). To gate it before any production merge, add:
//     const requireAuth = require('./_require-auth');
//     const auth = await requireAuth(req, res); if (!auth) return;
// ──────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    let html = resolveTemplate('_anomaly_search.html');

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}' };`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Anomaly Search view error: ' + err.message);
  }
};
