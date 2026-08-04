// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Leaderboard Module (v2)
// Ranked lists: highest conviction, most overvalued, undervalued, coordinated
// ══════════════════════════════════════════════════════════════════════════════
(function(){

var ACTIONS = {
  'NARRATIVE_TRAP':'Short or avoid','FUNDAMENTAL_DISCONNECT':'Avoid',
  'FADE_THE_HYPE':'Fade rallies','DRIFT_COMPRESSION_SHORT':'Short on bounce',
  'AIR_POCKET_SHORT':'Stay away','ACCUMULATE':'Buy dips',
  'MOMENTUM_CONFIRMED':'Ride the trend','FUNDAMENTAL_LONG':'Accumulate',
  'OMISSION_CASCADE':'Avoid'
};

function fmtLabel(l){ return l ? l.replace(/_/g,' ').toLowerCase().replace(/\b\w/g,function(c){return c.toUpperCase();}) : ''; }

function buildRow(r, rank){
  var dir = (r.direction||'').toUpperCase();
  var dirColor = dir === 'BEARISH' ? '#FF4D4D' : 'var(--mp-cyan)';
  var action = ACTIONS[r.primary_label] || 'Monitor';
  var price = r.price ? '$' + MP.fmtPrice(Number(r.price)) : '';
  var fvd = r.pct_above_fair_value != null ? (Number(r.pct_above_fair_value) > 0 ? '+' : '') + Number(r.pct_above_fair_value).toFixed(0) + '%' : '\u2014';
  var fvdColor = r.pct_above_fair_value > 30 ? '#FF4D4D' : r.pct_above_fair_value < -10 ? 'var(--mp-cyan)' : 'var(--mp-text-secondary)';
  var domain = MP.DOMAINS[r.ticker];
  var logo = domain ? '<img class="lb-logo" src="https://www.google.com/s2/favicons?domain='+domain+'&sz=32" alt="" onerror="this.style.display=\'none\';">' : '';
  var score = r.trade_score ? Math.round(Number(r.trade_score) * 100) : 0;

  return '<div class="lb-row" data-ticker="'+MP.esc(r.ticker)+'">'
    + '<div class="lb-rank">'+rank+'</div>'
    + '<div class="lb-id">'+logo+'<span>'+MP.esc(r.ticker)+'</span></div>'
    + '<div class="lb-price" data-live-price="'+MP.esc(r.ticker)+'">'+price+'</div>'
    + '<div class="lb-signal">'+MP.esc(fmtLabel(r.primary_label))+'</div>'
    + '<div class="lb-action">'+MP.esc(action)+'</div>'
    + '<div class="lb-dir" style="color:'+dirColor+';">'+(dir==='BEARISH'?'\u25BC':dir==='BULLISH'?'\u25B2':'')+' '+MP.esc(dir)+'</div>'
    + '<div class="lb-fvd" style="color:'+fvdColor+';">'+fvd+'</div>'
    + '<div class="lb-score">'+score+'</div>'
  + '</div>';
}

function buildSection(title, subtitle, rows){
  if(!rows.length) return '';
  var html = '<div class="lb-section">'
    + '<div class="lb-section-head">'
      + '<div class="lb-section-title">'+MP.esc(title)+'</div>'
      + '<div class="lb-section-sub">'+MP.esc(subtitle)+'</div>'
    + '</div>'
    + '<div class="lb-table">'
      + '<div class="lb-thead"><div class="lb-rank">#</div><div class="lb-id">Ticker</div><div class="lb-price">Price</div><div class="lb-signal">Signal</div><div class="lb-action">Action</div><div class="lb-dir">Dir</div><div class="lb-fvd">vs FV</div><div class="lb-score">Score</div></div>';
  rows.forEach(function(r, i){ html += buildRow(r, i + 1); });
  html += '</div></div>';
  return html;
}

async function init(){
  var root = document.getElementById('leaderboard-root');
  if(!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Loading Leaderboard\u2026</div>';

  try{
    var rows = await MP.rest('trade_cards_live', {
      select: 'ticker,direction,primary_label,confidence,price,card_tier,sector,industry,fair_value,pct_above_fair_value,trade_score,coordination_class',
      order: 'trade_score.desc'
    });
    if(!rows || !rows.length){ root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">No data.</div>'; return; }

    var topScore = rows.slice(0, 10);
    var overvalued = rows.filter(function(r){ return r.pct_above_fair_value != null && Number(r.pct_above_fair_value) > 20; })
      .sort(function(a,b){ return Number(b.pct_above_fair_value) - Number(a.pct_above_fair_value); }).slice(0, 10);
    var undervalued = rows.filter(function(r){ return r.pct_above_fair_value != null && Number(r.pct_above_fair_value) < 0; })
      .sort(function(a,b){ return Number(a.pct_above_fair_value) - Number(b.pct_above_fair_value); }).slice(0, 10);
    var coordinated = rows.filter(function(r){ return r.coordination_class && (r.coordination_class.indexOf('COORDINATED')!==-1 || r.coordination_class.indexOf('SUSPICIOUS')!==-1); }).slice(0, 10);

    root.innerHTML = '<div class="page-header">'
        + '<div class="ph-eyebrow">Leaderboard</div>'
        + '<h1>Today\'s top signals.</h1>'
        + '<span class="ph-italic">Ranked by conviction.</span>'
        + '<p>'+rows.length+' tickers scored and ranked by narrative forensics</p>'
      + '</div>'
      + buildSection('Highest Conviction', 'Top signals by trade score', topScore)
      + buildSection('Most Overvalued', 'Stocks trading furthest above fundamental value', overvalued)
      + buildSection('Most Undervalued', 'Stocks trading below fundamental value', undervalued)
      + buildSection('Coordinated Activity', 'Tickers with suspicious narrative patterns', coordinated);

    root.querySelectorAll('.lb-row[data-ticker]').forEach(function(row){
      row.addEventListener('click', function(){ window.location.href = '/ticker/' + encodeURIComponent(this.dataset.ticker); });
    });
  }catch(e){ root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Failed to load.</div>'; }
}

MP.register('leaderboard', init);
})();
