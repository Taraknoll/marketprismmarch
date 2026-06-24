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
// PRIVATE BETA: requires the beta-code cookie (mp_beta), not just any login.
// Non-beta visitors are bounced to /login to enter a code (validated vs BETA_CODES).
// Linked in the app sidebar as "AI Search" (/ask). noindex.
// ──────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  // Private beta: must hold a valid beta code (mp_beta). Logged-in users without
  // a code are sent to /login to enter one.
  if (!auth.hasBeta) {
    res.statusCode = 302;
    res.setHeader('Location', '/login?next=%2Fask');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }
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
