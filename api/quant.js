// /quant — standalone, access-code-gated quant terminal (institutional
// evaluation surface). Serves _quant.html with _quant_field.html — ONE merged
// view: the Market Physics earnings-wall scene wearing the Narrative
// Universe's full interaction layer (dossier/radar/story/compare/feed), with
// the Belief Cycle below. The shell contains no data and no Supabase keys:
// everything flows through /api/quant-data, which requires the mq_session
// access-code cookie (see api/_require-quant.js).
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

    // Inject the merged quant field (earnings-wall scene + full Universe
    // interaction layer + Belief Cycle) — the terminal's single view.
    try {
      const qfView = resolveTemplate('_quant_field.html');
      html = html.replace('<!-- QUANT_FIELD_INJECT -->', function () { return qfView; });
    } catch (e) {
      console.warn('Quant field not found:', e.message);
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
