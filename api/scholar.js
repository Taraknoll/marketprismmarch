// Market Scholar AI — streaming Claude endpoint with rate limiting
// Vercel Serverless Function (Node.js runtime)

const RATE_LIMIT = {};
const RATE_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 6;        // 6 per minute per IP

function rateCheck(ip) {
  var now = Date.now();
  if (!RATE_LIMIT[ip]) RATE_LIMIT[ip] = [];
  RATE_LIMIT[ip] = RATE_LIMIT[ip].filter(function(t) { return now - t < RATE_WINDOW; });
  if (RATE_LIMIT[ip].length >= MAX_REQUESTS) return false;
  RATE_LIMIT[ip].push(now);
  return true;
}

const SYSTEM_PROMPT = `You are the Market Scholar — a polymathic intelligence embedded within Market Prism. You think about markets the way a Renaissance scholar would: drawing connections across history, behavioral psychology, macro-economics, geopolitics, sector dynamics, and narrative theory.

Your voice is calm, incisive, and deeply knowledgeable. You do not give financial advice or recommendations to buy/sell. Instead, you illuminate — helping users see the deeper structures, narratives, and forces shaping market behavior.

Core principles:
- Think holistically: connect dots across sectors, macro trends, sentiment, and narrative states
- Reference the user's live data when relevant — you have access to their current dashboard signals AND can look up any specific ticker from the full Supabase database
- When the user asks about a specific ticker, ALWAYS check the data context for that ticker before saying you don't have data on it. The system queries Supabase for any tickers mentioned in the question.
- Be concise but substantive. Lead with insight, not filler.
- When discussing a specific ticker, include a markdown link: [TICKER](/ticker/TICKER) so the user can navigate there
- When referencing dashboard views, link them: [Discover](/dashboard), [Sector Pulse](/dashboard), [Narrative History](/dashboard)
- Use the narrative states (Breaking, Surging, Fragile, Stable) and verdicts (Narrative Trap, Structurally Supported) as your analytical vocabulary
- Occasionally draw from historical market parallels, behavioral finance concepts, or cross-domain analogies
- If you don't have enough data to answer well, say so honestly rather than speculating
- Never claim to predict the future. Frame insights as "structural observations" or "narrative readings"
- Keep responses under 250 words unless the question truly demands more`;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  var ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  ip = ip.split(',')[0].trim();
  if (!rateCheck(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment before asking again.' });
  }

  var apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'Scholar AI is not configured. Add ANTHROPIC_API_KEY to environment.' });
  }

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  var question = (body.question || '').trim();
  if (!question || question.length > 1000) {
    return res.status(400).json({ error: 'Question is required (max 1000 chars)' });
  }
  var questionUpper = question.toUpperCase();

  // Common company name → ticker mappings for natural language questions
  var COMPANY_TICKERS = {
    'REDDIT':'RDDT','NVIDIA':'NVDA','APPLE':'AAPL','MICROSOFT':'MSFT','GOOGLE':'GOOGL',
    'ALPHABET':'GOOGL','AMAZON':'AMZN','META':'META','FACEBOOK':'META','TESLA':'TSLA',
    'NETFLIX':'NFLX','ADOBE':'ADBE','SALESFORCE':'CRM','ORACLE':'ORCL','PALANTIR':'PLTR',
    'CROWDSTRIKE':'CRWD','SNOWFLAKE':'SNOW','SHOPIFY':'SHOP','SPOTIFY':'SPOT','SNAP':'SNAP',
    'SNAPCHAT':'SNAP','ROBLOX':'RBLX','COINBASE':'COIN','ROBINHOOD':'HOOD','SOFI':'SOFI',
    'DOORDASH':'DASH','UBER':'UBER','AIRBNB':'ABNB','GAMESTOP':'GME','AMD':'AMD',
    'INTEL':'INTC','BROADCOM':'AVGO','QUALCOMM':'QCOM','MICRON':'MU','SUPERMICRO':'SMCI',
    'JPMORGAN':'JPM','GOLDMAN':'GS','VISA':'V','MASTERCARD':'MA','PAYPAL':'PYPL',
    'COSTCO':'COST','WALMART':'WMT','TARGET':'TGT','DISNEY':'DIS','BOEING':'BA',
    'EXXON':'XOM','CHEVRON':'CVX','PFIZER':'PFE','JOHNSON':'JNJ','MODERNA':'MRNA',
    'BERKSHIRE':'BRK.B','OPENDOOR':'OPEN','PELOTON':'PTON','TRUMP':'DJT'
  };
  var companyLookups = [];
  Object.keys(COMPANY_TICKERS).forEach(function(name) {
    if (questionUpper.indexOf(name) !== -1) {
      companyLookups.push(COMPANY_TICKERS[name]);
    }
  });

  // Build context from the user's live data
  var context = '';
  var marketDataMap = {};
  if (body.market_data && Array.isArray(body.market_data)) {
    body.market_data.forEach(function(d) { marketDataMap[d.ticker] = d; });

    // Check if the question mentions a specific ticker — prioritize that data
    var allTickerSymbols = Object.keys(marketDataMap);
    var mentionedInData = allTickerSymbols.filter(function(t) {
      return questionUpper.indexOf(t) !== -1;
    });
    // Also include company-name-resolved tickers
    companyLookups.forEach(function(t) {
      if (marketDataMap[t] && mentionedInData.indexOf(t) === -1) mentionedInData.push(t);
    });

    // Build context: mentioned tickers first (full detail), then summary of all
    var contextLines = [];
    if (mentionedInData.length > 0) {
      contextLines.push('--- Tickers mentioned in question (from dashboard data) ---');
      mentionedInData.forEach(function(t) {
        var d = marketDataMap[t];
        var line = d.ticker + ': $' + d.price + ' (' + (d.price_change_pct > 0 ? '+' : '') + d.price_change_pct + '%)';
        line += ' | State: ' + (d.narrative_state || '–') + ' | Verdict: ' + (d.prism_verdict || '–');
        line += ' | Driver: ' + (d.primary_driver || '–') + ' | Sector: ' + (d.sector_name || '–');
        if (d.story_claim) line += ' | Story: ' + d.story_claim;
        if (d.pe_ratio) line += ' | P/E: ' + d.pe_ratio;
        if (d.fair_value) line += ' | Fundamental Value: $' + d.fair_value;
        if (d.narrative_health) line += ' | Health: ' + d.narrative_health;
        if (d.narrative_trend) line += ' | Trend: ' + d.narrative_trend;
        if (d.recovery_probability) line += ' | Recovery: ' + d.recovery_probability;
        if (d.guidance_direction) line += ' | Guidance: ' + d.guidance_direction;
        contextLines.push(line);
      });
    }

    // Include all tickers as a compact summary
    contextLines.push('\n--- All tracked tickers (' + allTickerSymbols.length + ' total) ---');
    body.market_data.forEach(function(d) {
      contextLines.push(d.ticker + ': $' + d.price + ' (' + (d.price_change_pct > 0 ? '+' : '') + d.price_change_pct + '%) ' + (d.narrative_state || '') + ' ' + (d.prism_verdict || ''));
    });

    context = '\n\nCurrent Market Prism dashboard data (live signals):\n' + contextLines.join('\n');
  }

  // Look up specific tickers from Supabase if the user mentioned tickers not in their dashboard data
  var supabaseUrl = process.env.SUPABASE_URL || '';
  var supabaseAnon = process.env.SUPABASE_ANON || '';
  var lookupTickers = (body.lookup_tickers && Array.isArray(body.lookup_tickers)) ? body.lookup_tickers.slice(0, 10) : [];
  // Add company-name-resolved tickers not already in market data
  companyLookups.forEach(function(t) {
    if (!marketDataMap[t] && lookupTickers.indexOf(t) === -1) lookupTickers.push(t);
  });
  // Also extract ticker-like patterns from the question itself as a fallback
  var qMatches = questionUpper.match(/\b[A-Z]{1,5}\b/g);
  if (qMatches) {
    var SKIP_WORDS = ['THE','AND','FOR','ARE','BUT','NOT','YOU','ALL','CAN','HER','WAS','ONE','OUR','OUT','HAS','HIS','HOW','ITS','MAY','NEW','NOW','OLD','SEE','WAY','WHO','DID','GET','HIM','LET','SAY','SHE','TOO','USE','WHAT','WILL','WITH','THIS','THAT','HAVE','FROM','THEY','BEEN','SOME','WHEN','VERY','JUST','THAN','THEM','EACH','MAKE','LIKE','LONG','LOOK','MANY','MOST','OVER','SUCH','TAKE','ALSO','BACK','COME','GOOD','INTO','KNOW','MORE','MUCH','ONLY','TELL','WELL','DOES','GOES','GOING','ABOUT','WHERE','WHICH','THEIR','WOULD','COULD','SHOULD','THERE','THINK','THESE','OTHER','AFTER','BEING','STILL','STOCK','PRICE','HIGH','DOWN','BEST','WORST','WHY'];
    qMatches.forEach(function(t) {
      if (t.length >= 2 && SKIP_WORDS.indexOf(t) === -1 && !marketDataMap[t] && lookupTickers.indexOf(t) === -1) {
        lookupTickers.push(t);
      }
    });
  }

  if (lookupTickers.length > 0 && supabaseUrl && supabaseAnon) {
    try {
      var hdrs = { 'apikey': supabaseAnon, 'Authorization': 'Bearer ' + supabaseAnon, 'Accept': 'application/json' };
      // Query multiple tables in parallel for the mentioned tickers
      var tickerFilter = 'ticker=in.(' + lookupTickers.map(function(t) { return '"' + t + '"'; }).join(',') + ')';
      var storyP = fetch(supabaseUrl + '/rest/v1/v_dash_daily_story?select=ticker,price,price_change_pct,narrative_state,primary_driver,prism_verdict,story_claim,sector_name,pe_ratio,fair_value,guidance_direction,snapshot_date&' + tickerFilter + '&order=snapshot_date.desc', { headers: hdrs }).catch(function() { return null; });
      var snapP = fetch(supabaseUrl + '/rest/v1/ticker_snapshots?select=ticker,price_close,volume_day,volume_7d_avg,sector,industry,drawdown_from_peak,fcf_per_share,snapshot_date&' + tickerFilter + '&order=snapshot_date.desc', { headers: hdrs }).catch(function() { return null; });
      var healthP = fetch(supabaseUrl + '/rest/v1/v_dash_narrative_health?select=ticker,narrative_health,narrative_trend,attention_trend,sentiment_score,snapshot_date&' + tickerFilter + '&order=snapshot_date.desc', { headers: hdrs }).catch(function() { return null; });
      var tradeP = fetch(supabaseUrl + '/rest/v1/trade_classifications?select=ticker,primary_label,primary_confidence,shortest_timeframe,longest_timeframe,snapshot_date&' + tickerFilter + '&order=snapshot_date.desc', { headers: hdrs }).catch(function() { return null; });
      var trapP = fetch(supabaseUrl + '/rest/v1/narrative_traps?select=ticker,narrative,fvd_pct,vms,predicted_exhaustion_days,coordination_class,drift_score,snapshot_date&' + tickerFilter + '&order=snapshot_date.desc', { headers: hdrs }).catch(function() { return null; });

      var results = await Promise.all([storyP, snapP, healthP, tradeP, trapP]);
      var extraContext = [];

      // Process story data (deduped by ticker — most recent first)
      var storySeen = {};
      try {
        if (results[0] && results[0].ok) {
          var storyRows = await results[0].json();
          storyRows.forEach(function(r) {
            if (storySeen[r.ticker]) return;
            storySeen[r.ticker] = true;
            extraContext.push('\n--- ' + r.ticker + ' (from Supabase lookup) ---');
            extraContext.push('Price: $' + (r.price || '–') + ' | Change: ' + (r.price_change_pct > 0 ? '+' : '') + (r.price_change_pct || 0) + '%');
            extraContext.push('State: ' + (r.narrative_state || '–') + ' | Verdict: ' + (r.prism_verdict || '–'));
            extraContext.push('Driver: ' + (r.primary_driver || '–') + ' | Sector: ' + (r.sector_name || '–'));
            if (r.story_claim) extraContext.push('Story: ' + r.story_claim);
            if (r.pe_ratio) extraContext.push('P/E: ' + r.pe_ratio);
            if (r.fair_value) extraContext.push('Fundamental Value: $' + r.fair_value);
            if (r.guidance_direction) extraContext.push('Guidance: ' + r.guidance_direction);
          });
        }
      } catch (_) {}

      // Snapshot data
      var snapSeen = {};
      try {
        if (results[1] && results[1].ok) {
          var snapRows = await results[1].json();
          snapRows.forEach(function(r) {
            if (snapSeen[r.ticker]) return;
            snapSeen[r.ticker] = true;
            var parts = [];
            if (r.price_close) parts.push('Close: $' + r.price_close);
            if (r.volume_day) parts.push('Volume: ' + r.volume_day);
            if (r.drawdown_from_peak != null) parts.push('Drawdown: ' + r.drawdown_from_peak + '%');
            if (r.sector) parts.push('Sector: ' + r.sector);
            if (r.industry) parts.push('Industry: ' + r.industry);
            if (parts.length) {
              if (!storySeen[r.ticker]) extraContext.push('\n--- ' + r.ticker + ' (from Supabase lookup) ---');
              extraContext.push('Snapshot: ' + parts.join(' | '));
            }
          });
        }
      } catch (_) {}

      // Narrative health
      var healthSeen = {};
      try {
        if (results[2] && results[2].ok) {
          var healthRows = await results[2].json();
          healthRows.forEach(function(r) {
            if (healthSeen[r.ticker]) return;
            healthSeen[r.ticker] = true;
            var parts = [];
            if (r.narrative_health) parts.push('Health: ' + r.narrative_health);
            if (r.narrative_trend) parts.push('Trend: ' + r.narrative_trend);
            if (r.attention_trend) parts.push('Attention: ' + r.attention_trend);
            if (r.sentiment_score != null) parts.push('Sentiment: ' + r.sentiment_score);
            if (parts.length) extraContext.push('Narrative: ' + parts.join(' | '));
          });
        }
      } catch (_) {}

      // Trade classifications
      var tradeSeen = {};
      try {
        if (results[3] && results[3].ok) {
          var tradeRows = await results[3].json();
          tradeRows.forEach(function(r) {
            if (tradeSeen[r.ticker]) return;
            tradeSeen[r.ticker] = true;
            var parts = [];
            if (r.primary_label) parts.push('Label: ' + r.primary_label);
            if (r.primary_confidence) parts.push('Confidence: ' + r.primary_confidence);
            if (r.shortest_timeframe) parts.push('Timeframe: ' + r.shortest_timeframe + '–' + (r.longest_timeframe || ''));
            if (parts.length) extraContext.push('Trade Class: ' + parts.join(' | '));
          });
        }
      } catch (_) {}

      // Narrative traps
      var trapSeen = {};
      try {
        if (results[4] && results[4].ok) {
          var trapRows = await results[4].json();
          trapRows.forEach(function(r) {
            if (trapSeen[r.ticker]) return;
            trapSeen[r.ticker] = true;
            var parts = [];
            if (r.narrative) parts.push('Narrative: ' + r.narrative);
            if (r.fvd_pct != null) parts.push('Hype Gap: ' + r.fvd_pct + '%');
            if (r.vms != null) parts.push('Reliability: ' + r.vms);
            if (r.predicted_exhaustion_days != null) parts.push('Days Left: ' + r.predicted_exhaustion_days);
            if (r.coordination_class) parts.push('Coordination: ' + r.coordination_class);
            if (r.drift_score != null) parts.push('Drift: ' + r.drift_score);
            if (parts.length) extraContext.push('Trap Analysis: ' + parts.join(' | '));
          });
        }
      } catch (_) {}

      if (extraContext.length > 0) {
        context += '\n\nAdditional Supabase data for tickers mentioned in the question:\n' + extraContext.join('\n');
      }
    } catch (lookupErr) {
      console.error('Scholar Supabase lookup error:', lookupErr);
    }
  }

  var conversationHistory = [];
  if (body.history && Array.isArray(body.history)) {
    conversationHistory = body.history.slice(-6).map(function(m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 2000) };
    });
  }

  var messages = conversationHistory.concat([
    { role: 'user', content: question + context }
  ]);

  // Stream from Claude
  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      var errText = await response.text();
      console.error('Claude API error:', response.status, errText);
      // Surface the upstream status + parsed error so failures are diagnosable
      // from the UI instead of showing a generic "temporarily unavailable" fallback.
      var upstreamErr = null;
      try {
        var errJson = JSON.parse(errText);
        if (errJson && errJson.error) {
          upstreamErr = (errJson.error.type || '') + ': ' + (errJson.error.message || '');
        }
      } catch (e) { /* non-JSON body; fall through */ }
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({
        error: 'Scholar AI error (' + response.status + ')'
          + (upstreamErr ? ': ' + upstreamErr.slice(0, 240) : '')
      });
    }

    // Set streaming headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      var lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line === 'event: ping') continue;
        if (line.startsWith('data: ')) {
          var data = line.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            var parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
              res.write('data: ' + JSON.stringify({ text: parsed.delta.text }) + '\n\n');
            }
            if (parsed.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch (e) {
            // skip unparseable lines
          }
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('Scholar stream error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.end();
  }
};
