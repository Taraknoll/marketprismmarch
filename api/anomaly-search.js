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
// Fronted by server-side requireAuth (login + the ENFORCE_SUBSCRIPTION kill
// switch), same as /signal-lab and /narrative-heatmap since the beta-code
// retirement. It must NOT additionally require the mp_beta cookie: the code
// redemption UI is gone, so a logged-in user without the cookie would be
// bounced to /login, which sees the valid session and bounces straight back —
// an infinite /ask↔/login loop inside the AI Lab iframe whose every /login
// pass fires a SIGNED_IN broadcast into all open tabs.
// Linked in the app sidebar as "AI Lab" (/ask). noindex.
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
