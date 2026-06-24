const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');

// ──────────────────────────────────────────────────────────────────────────
// /anomaly-search — AI Semantic Anomaly Search (lightweight MVP, preview)
//
// Serves the self-contained _anomaly_search.html page. All querying happens
// CLIENT-SIDE via the anon Supabase REST key (PostgREST) — same pattern as the
// rest of the dashboard (see lib/mp-core.js MP.rest). No server SQL, no LLM, no
// new dependency or env: SUPABASE_URL / SUPABASE_ANON already exist in prod.
//
// Gated behind requireAuth (login or beta cookie) — same gate as the dashboard.
// Linked in the app sidebar as "AI Search" (/ask). noindex (beta).
// ──────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
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
