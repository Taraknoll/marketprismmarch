const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    let html = resolveTemplate('_narrative_heatmap.html');

    // If the deploy provides env vars, prefer them over the embedded fallback
    // (the embedded publishable anon key keeps the page working on static hosts).
    if (supabaseUrl && supabaseAnon) {
      html = html.replace(
        /window\.__env = \{[\s\S]*?\};/,
        `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}' };`
      );
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Narrative Heatmap error: ' + err.message);
  }
};
