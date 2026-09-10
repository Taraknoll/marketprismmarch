// /present-os — Founder Briefing.
//
// A read-only, five-slide sibling of /present (Institutional Presentation
// Mode), prepared for a data-sourcing evaluation meeting: why Market Prism
// exists, what it measures, how the live system becomes the dataset, what
// existed when, and how it is used and evaluated. Serves _present_os.html;
// every number on the page arrives through /api/present-data (unchanged) and
// /api/present-os-data, both behind the same presentation password cookie
// (api/_require-present.js). The shell contains no data and no Supabase keys.
// Nothing here writes anywhere, and nothing in /present is touched.

const resolveTemplate = require('./_resolve-template');
const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'present-os-page', 30)) return;
  try {
    let html = resolveTemplate('_present_os.html');
    if (gate.isAuthed(req)) {
      html = html.replace('window.__MQ = { authed: false };', 'window.__MQ = { authed: true };');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Presentation error: ' + err.message);
  }
};
