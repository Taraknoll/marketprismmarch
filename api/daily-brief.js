// Daily brief headline — server-side Claude proxy.
//
// The /daily page used to call api.anthropic.com directly from the browser
// with the Anthropic key embedded in window.__env (View Source → key). That
// leaked the founder's key to anyone. This endpoint keeps the key server-side
// and only emits a short market headline + tags from the posted dashboard
// signals, mirroring the pattern in scholar.js / hero-summary.js.
//
// Input (POST JSON): { signals, traps, bull, bear, movers, trapDetails, sectors }
//   - movers / trapDetails / sectors are pre-built summary strings from the
//     client's already-loaded dashboard data.
// Output: { headline, tags:[...] }

const rateLimit = require('./_rate-limit');

// Cap posted strings so this can't be abused as a general Claude relay.
function clamp(v, max) {
  return (v == null ? '' : String(v)).slice(0, max);
}
function num(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Calls Claude — cap aggressively per IP.
  if (!rateLimit(req, res, 'daily-brief', 20)) return;

  var apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'Daily brief AI is not configured.' });
  }

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  var signals = num(body.signals);
  var traps = num(body.traps);
  var bull = num(body.bull);
  var bear = num(body.bear);
  var movers = clamp(body.movers, 1200);
  var trapDetails = clamp(body.trapDetails, 1200);
  var sectors = clamp(body.sectors, 600);

  var date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  var prompt = 'You are Market Prism. Today is ' + date + '. Write ONE sharp headline (max 15 words) based ONLY on this data. '
    + 'Signals=' + signals + ', Traps=' + traps + ', Bull=' + bull + ', Bear=' + bear + '. '
    + 'Movers: ' + (movers || 'none') + '. Traps: ' + (trapDetails || 'none') + '. Sectors: ' + (sectors || 'none') + '. '
    + 'Return ONLY JSON: {"headline":"...","tags":["t1","t2","t3","t4","t5"]}';

  try {
    var apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiRes.ok) {
      var errText = await apiRes.text().catch(function() { return ''; });
      console.error('daily-brief Anthropic error', apiRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: 'AI service error (' + apiRes.status + ')' });
    }

    var data = await apiRes.json();
    var text = (data.content && data.content[0] && data.content[0].text || '').trim();
    var parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse AI response' });
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      headline: parsed.headline || '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : []
    });
  } catch (err) {
    console.error('daily-brief error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
