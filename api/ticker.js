const resolveTemplate = require('./_resolve-template');
const requireAuth = require('./_require-auth');
const { isHidden: isHiddenTicker } = require('./_hidden-tickers');
const { isProcessing: isProcessingTicker } = require('./_processing-tickers');

module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    // Extract ticker — try multiple sources because Vercel rewrites may
    // change req.url to the destination path (/api/ticker instead of /ticker/NVDA)
    let ticker = '';

    // 1. Vercel populates req.query with named rewrite params (:ticker)
    if (req.query && req.query.ticker) {
      ticker = req.query.ticker;
    }

    // 2. Try the original URL path (works when req.url preserves the source)
    if (!ticker) {
      const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      if (last !== 'ticker' && last !== 'api') {
        ticker = last;
      }
    }

    // 3. Try x-now-route-matches header (Vercel internal routing metadata)
    if (!ticker && req.headers && req.headers['x-now-route-matches']) {
      try {
        const matches = decodeURIComponent(req.headers['x-now-route-matches']);
        const m = matches.match(/ticker=([^&]+)/);
        if (m) ticker = decodeURIComponent(m[1]);
      } catch (_) {}
    }

    // 4. Try query string ?t=NVDA as last resort
    if (!ticker && req.query && req.query.t) {
      ticker = req.query.t;
    }

    // Sanitise — only allow alphanumeric + dot + hyphen
    const safeTicker = ticker.replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();

    // Tickers hidden from the frontend (e.g. fair-value issues) — redirect
    // before auth/render so they never leak into bookmarks or referrers.
    if (isHiddenTicker(safeTicker)) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.statusCode = 302;
      res.setHeader('Location', '/dashboard');
      res.end();
      return;
    }

    // Hard gate — bail before the expensive Supabase fetches below.
    const nextPath = safeTicker ? `/ticker/${safeTicker}` : '/dashboard';
    const auth = await requireAuth(req, res, { next: nextPath });
    if (!auth) return;

    let html = resolveTemplate('_ticker.html');

    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '', TICKER: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}', TICKER: '${safeTicker}' };`
    );

    // Tracked ticker with no article-scraper coverage yet → swap the empty
    // article-derived sections (narratives, story feed, forensic timeline,
    // claim integrity, scholarly) for a "coverage in progress" banner. The CSS
    // + banner markup live in _ticker.html, gated on body.mp-processing.
    if (isProcessingTicker(safeTicker)) {
      html = html.replace('<body>', '<body class="mp-processing">');
    }

    // ── SEO + AEO injection (server-side, non-destructive) ──────────────
    if (safeTicker && supabaseUrl && supabaseAnon) {
      try {
        const { buildTickerMeta, buildWebPageSchema } = require('../lib/seoHead');
        const { buildAEOBlock } = require('../lib/aeoBlock');
        const { transformNarrative } = require('../lib/narrativeEngine');

        // Fetch scorecard data server-side for meta tags + AEO
        const headers = {
          'apikey': supabaseAnon,
          'Authorization': `Bearer ${supabaseAnon}`,
        };

        const data = {};

        const controller = new AbortController();
        const seoTimeout = setTimeout(() => controller.abort(), 5000);
        const [scRes, tcRes, rbiRes] = await Promise.all([
          fetch(`${supabaseUrl}/rest/v1/narrative_scorecard?ticker=eq.${encodeURIComponent(safeTicker)}&order=snapshot_date.desc&limit=1`, { headers, signal: controller.signal }),
          fetch(`${supabaseUrl}/rest/v1/v_trade_cards?ticker=eq.${encodeURIComponent(safeTicker)}&order=snapshot_date.desc&limit=1`, { headers, signal: controller.signal }),
          fetch(`${supabaseUrl}/rest/v1/ticker_reality_belief?ticker=eq.${encodeURIComponent(safeTicker)}&select=reality_belief_index,gauge_zone&limit=1`, { headers, signal: controller.signal }).catch(() => null),
        ]).finally(() => clearTimeout(seoTimeout));

        if (scRes.ok) {
          const rows = await scRes.json();
          if (rows.length > 0) {
            const r = rows[0];
            data.verdict = r.verdict;
            data.fvd = r.fvd_pct != null ? r.fvd_pct : r.fvd;
            data.vms = r.vms;
            data.energy = r.energy_remaining;
            data.decay = r.decay_rate;
            data.coordination = r.coordination_score;
            data.narrative = r.narrative;
            data.suspicion = r.suspicion_score;
          }
        }

        if (tcRes.ok) {
          const rows = await tcRes.json();
          if (rows.length > 0) {
            data.direction = rows[0].direction;
            data.price = rows[0].price;
            data.label = rows[0].primary_label;
          }
        }

        if (rbiRes && rbiRes.ok) {
          const rows = await rbiRes.json();
          if (rows.length > 0) {
            data.rbi = rows[0].reality_belief_index;
            data.rbiZone = rows[0].gauge_zone;
          }
        }

        // Build narrative for meta description + free answer-first summary
        const narr = transformNarrative({ ticker: safeTicker, ...data });

        // 1. Inject SEO <title>
        html = html.replace(
          '<title>Ticker \u2014 Market Prism</title>',
          `<title>${escHtml(safeTicker)} Analysis \u2014 Narrative Intelligence | Market Prism</title>`
        );

        // 2. Inject meta tags after <title> line (safe head injection)
        const metaTags = buildTickerMeta({
          ticker: safeTicker,
          title: `${safeTicker} Analysis \u2014 Narrative Intelligence | Market Prism`,
          description: narr.metaDescription,
          url: `https://www.marketprism.co/ticker/${safeTicker}`,
        });
        const webPageSchema = `<script type="application/ld+json">${buildWebPageSchema({
          title: `${safeTicker} Analysis`,
          description: narr.metaDescription,
          url: `https://www.marketprism.co/ticker/${safeTicker}`,
        })}</script>`;

        // Breadcrumb schema
        const breadcrumbSchema = `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.marketprism.co" },
            { "@type": "ListItem", "position": 2, "name": "Dashboard", "item": "https://www.marketprism.co/dashboard" },
            { "@type": "ListItem", "position": 3, "name": safeTicker, "item": `https://www.marketprism.co/ticker/${safeTicker}` }
          ]
        })}</script>`;

        // RSS autodiscovery
        const feedLinks = `<link rel="alternate" type="application/rss+xml" title="Market Prism Intelligence Journal" href="https://www.marketprism.co/feed.xml">\n<link rel="alternate" type="application/atom+xml" title="Market Prism Intelligence Journal (Atom)" href="https://www.marketprism.co/atom.xml">`;

        // Inject meta tags before </head>
        html = html.replace(
          '</head>',
          `${metaTags}\n${webPageSchema}\n${breadcrumbSchema}\n${feedLinks}\n</head>`
        );

        // 3. Append AEO block inside main content (before </main>) so it
        //    inherits the page layout and sits below all tab content
        const aeoHtml = buildAEOBlock(safeTicker, data);
        html = html.replace('</main>', `${aeoHtml}\n</main>`);

        // 4. Free answer-first verdict summary — a plain-English "short answer"
        //    read shown to ALL logged-in users (incl. free), injected as a
        //    sibling ABOVE the Pro-gated #verdict-banner so it sits outside the
        //    body.mp-teaser-locked blur scope. The precise forecast / entry /
        //    target / stop stay Pro.
        if (data.verdict) {
          const { buildAnswerFirst } = require('../lib/answerFirst');
          const answerHtml = buildAnswerFirst(narr, { esc: escHtml });
          html = html.replace(
            '<div class="verdict-banner" id="verdict-banner">',
            `${answerHtml}\n  <div class="verdict-banner" id="verdict-banner">`
          );
        }

      } catch (seoErr) {
        // Non-fatal — page still works without SEO/AEO
        console.error('[ticker] SEO/AEO injection failed:', seoErr.message);
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Ticker error: ' + err.message);
  }
};

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
