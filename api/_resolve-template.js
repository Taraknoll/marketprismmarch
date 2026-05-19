const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { HIDDEN_TICKERS } = require('./_hidden-tickers');

// Injected after <head>: defines the global denylist + wraps fetch so any
// Supabase REST array response has hidden-ticker rows stripped out. This is
// the single choke point that hides excluded tickers from every dashboard,
// list, snapshot, scorecard, leaderboard etc. served by the platform.
// Also intercepts /functions/v1/ responses (Supabase edge functions) — needed
// so dashboard-data's scorecard/snapshots/etc arrays get the same denylist
// pass that /rest/v1/ already gets. For object bodies, walks top-level array
// fields and filters each (the dashboard bundle is shaped as {scorecard:[...],
// snapshots:[...], ...} so we can't just filter the root).
const HIDDEN_INJECT = '\n<script>(function(){var H=new Set(' + JSON.stringify(HIDDEN_TICKERS.map(function(t){return String(t).toUpperCase();})) + ');window.MP_HIDDEN_TICKERS=Array.from(H);window.MP_IS_HIDDEN_TICKER=function(t){return !!t&&H.has(String(t).toUpperCase());};if(window.fetch&&!window.__mpHideWrap){window.__mpHideWrap=1;var _f=window.fetch.bind(window);function _isH(t){return !!t&&H.has(String(t).toUpperCase());}function _filterArr(a){return a.filter(function(row){if(!row||typeof row!=="object")return true;return !_isH(row.ticker||row.symbol);});}window.fetch=function(input,init){var url=typeof input==="string"?input:(input&&input.url)||"";var isSupa=url.indexOf("/rest/v1/")>=0||url.indexOf("/functions/v1/")>=0;if(!isSupa)return _f(input,init);return _f(input,init).then(function(r){if(!r||!r.ok)return r;var ct=(r.headers&&r.headers.get&&r.headers.get("content-type"))||"";if(ct.indexOf("application/json")<0)return r;var cl=r.clone();return cl.json().then(function(body){var filtered=body;if(Array.isArray(body)){filtered=_filterArr(body);}else if(body&&typeof body==="object"){if(_isH(body.ticker||body.symbol)){return new Response(JSON.stringify({code:"PGRST116",message:"Hidden ticker"}),{status:406,headers:{"content-type":"application/json"}});}filtered={};for(var k in body){var v=body[k];filtered[k]=Array.isArray(v)?_filterArr(v):v;}}return new Response(JSON.stringify(filtered),{status:r.status,statusText:r.statusText,headers:r.headers});}).catch(function(){return r;});});};}})();</script>';

function injectHiddenTickerGuard(html) {
  if (!html || HIDDEN_TICKERS.length === 0) return html;
  // Insert right after the opening <head ...> tag so the wrapper is in place
  // before any subsequent <script> runs.
  return html.replace(/<head([^>]*)>/i, function (m) {
    return m + HIDDEN_INJECT;
  });
}

/**
 * Resolve and read an HTML template file.
 * Tries multiple paths to handle Vercel's serverless file bundling.
 */
module.exports = function resolveTemplate(filename) {
  const candidates = [
    join(__dirname, filename),
    join(__dirname, '..', filename),
    join(process.cwd(), filename),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return injectHiddenTickerGuard(readFileSync(p, 'utf8'));
    }
  }

  throw new Error('Template not found: ' + filename + '. Searched: ' + candidates.join(', '));
};
