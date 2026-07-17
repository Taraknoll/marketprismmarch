const resolveTemplate = require('./_resolve-template');

module.exports = (req, res) => {
  try {
    let html = resolveTemplate('_faq.html');

    const pageUrl = 'https://www.marketprism.co/faq';
    const title = 'FAQ — Frequently Asked Questions | Market Prism';
    const description = 'Answers to common questions about Market Prism AI stock analysis, narrative intelligence, trading signals, pricing, methodology, and data security.';

    html = html.replace(
      '<title>FAQ — Market Prism</title>',
      `<title>${title}</title>`
    );

    // Collect all Q&A pairs for FAQPage schema
    const faqs = [
      { q: 'What is Market Prism?', a: 'Market Prism is an AI-powered stock analysis platform that uses narrative intelligence to detect when media stories about stocks are backed by real fundamentals and when they are manufactured hype. We analyze SEC filings, earnings data, price action, and news coverage to give you a forensic view of every ticker we track.' },
      { q: 'How is Market Prism different from other stock analysis tools?', a: 'Most tools show you what the market is doing. Market Prism shows you why stories are being told and whether those stories are trustworthy. Our system cross-references narrative claims against SEC filings, detects coordinated media campaigns, measures how quickly stories decay, and flags narrative traps before they collapse.' },
      { q: 'What tickers does Market Prism cover?', a: 'We track over 100 actively traded US equities across 14 sectors including AI Infrastructure, Semiconductors, Cloud Computing, Energy, Defense, Fintech, and more.' },
      { q: 'How often is the data updated?', a: 'Our narrative scorecard pipeline runs daily before market open. Live stock prices update every 30 seconds during market hours via Polygon. Sector intelligence and trading signals are refreshed each morning.' },
      { q: 'What is a Narrative Trap?', a: 'A Narrative Trap is a stock where the bullish media story is not supported by underlying fundamentals. Our AI detects these by comparing what news outlets and analysts claim against SEC filings, earnings data, and price structure.' },
      { q: 'What does Structurally Supported mean?', a: 'A Structurally Supported verdict means the narrative around a stock is backed by real fundamentals: earnings growth, revenue beats, improving margins, or strong institutional positioning.' },
      { q: 'How does the Narrative Energy model work?', a: 'Narrative Energy measures the intensity and decay of media coverage around a stock. We track propagation speed, half-life, coordination score, drift from fundamentals, and absolute energy level.' },
      { q: 'What is Fair Value Deviation (FVD)?', a: 'Fair Value Deviation measures how far a stock\'s current price is from our AI-estimated fair value. A positive FVD means the stock trades above fair value (potentially overvalued), while a negative FVD means it trades below (potentially undervalued).' },
      { q: 'How does Market Prism detect coordinated media campaigns?', a: 'Our coordination detection system analyzes the timing, language similarity, and source clustering of news articles about each ticker. When multiple outlets publish stories with overlapping claims within a narrow time window without a fundamental catalyst, we flag elevated coordination.' },
      { q: 'What are the Daily Plays trade lanes?', a: 'Daily Plays organizes signals into six trade lanes: Day Trade, Swing Trade, Momentum, Earnings Play, Value Picks, and Narrative Traps. Each lane shows expected returns, hold periods, and directional signals.' },
      { q: 'What is the Sector Intelligence panel?', a: 'Sector Intelligence tracks 14 market sectors with daily momentum scores, narrative state (Surging, Stable, Fragile, Cooling), and bullish/bearish direction derived from live price action.' },
      { q: 'How accurate are Market Prism\'s signals?', a: 'Our Track Record page shows verified historical performance across all signal types. We publish hit rates, average returns at 5-day and 10-day horizons, and annualized portfolio-level returns.' },
      { q: 'What data sources does Market Prism use?', a: 'We aggregate data from SEC EDGAR filings, earnings reports, live market feeds via Polygon, news coverage from major financial publications, and social media sentiment.' },
      { q: 'How much does Market Prism cost?', a: 'Market Prism offers a Pro plan at $25/month (billed annually) that includes full access to Daily Plays, Signal Lab, Trading Cards, Trading Calendar, Track Record, Sector Intelligence, the Leaderboard, and Market Scholar AI.' },
      { q: 'Is there a free trial?', a: 'Yes. New users get access to explore the platform before committing to a paid plan. The free tier includes limited access to daily signals and sector intelligence.' },
      { q: 'Can I cancel my subscription?', a: 'Yes. You can cancel your subscription at any time from your account settings. Your access continues until the end of the current billing period.' },
      { q: 'Is my data secure?', a: 'Yes. Market Prism uses Supabase for authentication and data storage with row-level security policies. All data is encrypted in transit (TLS 1.3) and at rest. Payment is handled through Stripe.' },
      { q: 'Does Market Prism sell my data?', a: 'No. We do not sell, rent, or share your personal information with third parties for marketing purposes.' },
      { q: 'Is Market Prism investment advice?', a: 'No. Market Prism provides AI-generated analysis and narrative intelligence for informational and educational purposes only. It is not investment advice. Always consult a qualified financial advisor before making investment decisions.' },
    ];

    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a }
      }))
    };

    const breadcrumbSchema = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.marketprism.co' },
        { '@type': 'ListItem', position: 2, name: 'FAQ', item: pageUrl }
      ]
    };

    const speakableSchema = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: title,
      speakable: {
        '@type': 'SpeakableSpecification',
        cssSelector: ['.faq-hero h1', '.faq-q', '.faq-a-inner']
      },
      url: pageUrl
    };

    const seoBlock = `
  <meta name="description" content="${escAttr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Market Prism">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:site" content="@marketprism">
  <meta name="twitter:title" content="${escAttr(title)}">
  <meta name="twitter:description" content="${escAttr(description)}">
  <link rel="alternate" type="application/rss+xml" title="Market Prism Blog" href="https://www.marketprism.co/feed.xml">
  <script type="application/ld+json">${JSON.stringify(faqSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(speakableSchema)}</script>`;

    html = html.replace('<!-- SEO_INJECT -->', seoBlock);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('FAQ error: ' + err.message);
  }
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
