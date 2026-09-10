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

const fs = require('fs');
const path = require('path');
const resolveTemplate = require('./_resolve-template');

// Static asset reference: the bundler's file tracer sees this literal path and
// ships _present_os.html next to this function, so no vercel.json includeFiles
// entry is required. resolveTemplate() then finds it at __dirname/../.
const TEMPLATE_PATH = path.join(__dirname, '..', '_present_os.html');
function rawTemplate() { return fs.readFileSync(TEMPLATE_PATH, 'utf8'); }
const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'present-os-page', 30)) return;
  try {
    let html;
    try { html = resolveTemplate('_present_os.html'); } catch (_e) { html = rawTemplate(); }
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
