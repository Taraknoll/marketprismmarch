const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    const html = resolveTemplate('_herbtraps.html');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Internal tool, password-gated: don't cache or index.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Herb traps generator error: ' + err.message);
  }
};
