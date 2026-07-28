// /quant — standalone, access-code-gated quant terminal (institutional
// evaluation surface). Serves _quant.html with the SAME production tab
// partials the dashboard uses (Market Physics + Narrative Universe), so the
// terminal always matches the product view. The shell contains no data and
// no Supabase keys: everything flows through /api/quant-data, which requires
// the mq_session access-code cookie (see api/_require-quant.js).
//
// The shell itself is served ungated — it is markup + the gate overlay. If
// the request already carries a valid quant cookie, __MQ.authed is flipped so
// the page skips the gate without a round-trip or flash.

const resolveTemplate = require('./_resolve-template');
const rateLimit = require('./_rate-limit');
const quant = require('./_require-quant');

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'quant-page', 30)) return;
  try {
    let html = resolveTemplate('_quant.html');

    // Inject Market Physics tab partial (shared with the dashboard)
    try {
      const pxTab = resolveTemplate('_physics_tab.html');
      html = html.replace('<!-- PHYSICS_TAB_INJECT -->', function () { return pxTab; });
    } catch (e) {
      console.warn('Physics tab not found:', e.message);
    }

    // Inject Narrative Universe tab partial (shared with the dashboard)
    try {
      const uvTab = resolveTemplate('_universe_tab.html');
      html = html.replace('<!-- UNIVERSE_TAB_INJECT -->', function () { return uvTab; });
    } catch (e) {
      console.warn('Universe tab not found:', e.message);
    }

    if (quant.isAuthed(req)) {
      html = html.replace(
        'window.__MQ = { authed: false };',
        'window.__MQ = { authed: true };'
      );
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Quant terminal error: ' + err.message);
  }
};
