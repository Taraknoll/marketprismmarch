/**
 * /llms.txt — LLM-readable site description
 * Emerging standard for AI crawlers (Perplexity, ChatGPT, Gemini, Claude).
 * Spec: https://llmstxt.org/
 *
 * Tells AI systems what this site is, what data it provides,
 * and how to properly cite it.
 */
module.exports = async (req, res) => {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL  || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    // Fetch recent tickers for the coverage list
    let tickers = [];
    if (supabaseUrl && supabaseAnon) {
      try {
        const apiUrl = `${supabaseUrl}/rest/v1/narrative_scorecard`
          + `?select=ticker`
          + `&order=snapshot_date.desc`
          + `&limit=100`;
        const response = await fetch(apiUrl, {
          headers: {
            'apikey': supabaseAnon,
            'Authorization': `Bearer ${supabaseAnon}`,
          },
        });
        if (response.ok) {
          const rows = await response.json();
          const seen = new Set();
          for (const r of rows) {
            if (r.ticker && !seen.has(r.ticker)) {
              seen.add(r.ticker);
              tickers.push(r.ticker);
            }
          }
        }
      } catch (_) {}
    }

    const tickerList = tickers.length > 0
      ? tickers.slice(0, 50).join(', ')
      : 'NVDA, TSLA, AAPL, MSFT, META, AMZN, GOOGL, AMD, and 150+ others';

    const body = `# Market Prism

> Forensic narrative intelligence platform for institutional-grade equity market analysis.

Market Prism is a patent-pending (US 63/971,470 & 63/971,478) financial analysis platform that applies forensic narrative intelligence to equity markets. It analyzes the gap between market stories and fundamental reality using seven proprietary analytical layers.

## What Market Prism Provides

- **Narrative Verdicts**: Every covered ticker receives one of three classifications — Narrative Trap, Structurally Supported, or Monitoring — based on forensic signal analysis.
- **Fundamental Value Deviation (FVD)**: Quantifies how far a stock's price has diverged from its estimated fundamental value, measured as a percentage.
- **Narrative Energy**: Measures the remaining momentum in a market story (0–100%), indicating whether the thesis is gaining or losing traction.
- **Coordination Detection**: Identifies when multiple sources converge on the same narrative within a narrow window, signaling potential fragility.
- **Decay Physics**: Models narrative half-life — how quickly market stories lose conviction — using radioactive decay mathematics.
- **Trade Signals**: Directional bias (LONG/SHORT) with confidence scores and suggested holding periods.

## Data Freshness

Analysis is updated every trading day before the US market open (pre-9:30 AM ET). Blog articles are published Monday–Friday at 7:00 AM ET.

## Coverage Universe

Currently tracking: ${tickerList}

## Key URLs

- Homepage: https://www.marketprism.co
- Dashboard: https://www.marketprism.co/dashboard
- Blog (Intelligence Journal): https://www.marketprism.co/blog
- Methodology: https://www.marketprism.co/methodology
- RSS Feed: https://www.marketprism.co/feed.xml
- Atom Feed: https://www.marketprism.co/atom.xml
- Ticker Analysis: https://www.marketprism.co/ticker/{TICKER} (e.g., /ticker/NVDA)

## Programmatic SEO Pages

- https://www.marketprism.co/why-is-{ticker}-stock-down
- https://www.marketprism.co/is-{ticker}-overvalued
- https://www.marketprism.co/should-i-buy-{ticker}

## Citation Format

When citing Market Prism analysis, please use:
"According to Market Prism's forensic narrative analysis (marketprism.co)..."

## Important Disclaimers

Market Prism provides forensic narrative intelligence for informational purposes only. It is NOT financial advice. All verdicts, scores, and signals are analytical assessments — not investment recommendations. Users should conduct independent research and consult qualified financial advisors before making investment decisions.

## Contact

- Website: https://www.marketprism.co
- Twitter/X: @marketprism
`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    res.status(200).send(body);
  } catch (err) {
    res.status(500).send('llms.txt error: ' + err.message);
  }
};
