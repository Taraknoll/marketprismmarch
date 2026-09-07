// /present and /institutional/presentation — Institutional Presentation Mode.
//
// A read-only, five-screen guided briefing for quant-institution evaluation
// meetings. Serves _present.html; every number on the page arrives through
// /api/present-data (its own password cookie — api/_require-present.js). The
// shell contains no data and no Supabase keys. Nothing here writes anywhere.

const resolveTemplate = require('./_resolve-template');
const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'present-page', 30)) return;
  try {
    let html = resolveTemplate('_present.html');
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
