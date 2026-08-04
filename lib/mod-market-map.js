// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Market Heatmap Module
// Sector-grouped grid heatmap: each cell = ticker, color = direction/confidence
// Click any cell for detail panel
// ══════════════════════════════════════════════════════════════════════════════
(function(){

var SECTOR_COLORS = {
  'Technology':'#00AEFF','Healthcare':'#00DE94','Energy':'#FFB800',
  'Financials':'#7B61FF','Industrials':'#38C8B8','Consumer Discretionary':'#FF6B9D',
  'Consumer Staples':'#A0A8B0','Materials':'#FF8C00','Communication Services':'#E040FB',
  'Utilities':'#66BB6A','Real Estate':'#8D6E63'
};

var LABEL_ACTIONS = {
  'NARRATIVE_TRAP':          'Avoid or short \u2014 narrative contradicts fundamentals',
  'FUNDAMENTAL_DISCONNECT':  'Avoid \u2014 price disconnected from value',
  'FADE_THE_HYPE':           'Fade rallies \u2014 hype exceeding reality',
  'DRIFT_COMPRESSION_SHORT': 'Short on bounce \u2014 narrative drifting',
  'AIR_POCKET_SHORT':        'Stay away \u2014 narrative collapsing',
  'ACCUMULATE':              'Buy dips \u2014 fundamentals support upside',
  'MOMENTUM_CONFIRMED':      'Ride the trend \u2014 momentum confirmed',
  'FUNDAMENTAL_LONG':        'Accumulate \u2014 trading below fundamental value',
  'OMISSION_CASCADE':        'Avoid \u2014 key information hidden'
};

function cellColor(dir, conf){
  var c = Number(conf) || 0.5;
  var alpha = 0.3 + c * 0.6; // 0.3 to 0.9 based on confidence
  if(dir === 'BEARISH') return 'rgba(255,77,77,' + alpha.toFixed(2) + ')';
  if(dir === 'BULLISH') return 'rgba(0,222,148,' + alpha.toFixed(2) + ')';
  return 'rgba(0,174,255,' + (alpha * 0.7).toFixed(2) + ')';
}

function cellBorder(dir){
  if(dir === 'BEARISH') return '#FF4D4D';
  if(dir === 'BULLISH') return '#00DE94';
  return '#00AEFF';
}

function tierBadgeHTML(tier){
  if(!tier) return '';
  var t = tier.toUpperCase();
  if(t === 'PLATINUM') return '<span class="hm-tier hm-plat">\u25C6</span>';
  if(t === 'GOLD') return '<span class="hm-tier hm-gold">\u25B2</span>';
  if(t === 'SURPRISE') return '<span class="hm-tier hm-surp">\u26A1</span>';
  return '';
}

function buildDetailPanel(n){
  var dirColor = n.direction === 'BEARISH' ? '#FF4D4D' : n.direction === 'BULLISH' ? '#00DE94' : '#00AEFF';
  var action = LABEL_ACTIONS[n.primary_label] || 'Monitor for developments';
  return '<div class="hm-detail" id="hm-detail">'
    + '<button class="hm-detail-close" onclick="document.getElementById(\'hm-detail\').remove();">&times;</button>'
    + '<div class="hm-detail-header">'
      + '<span class="hm-detail-ticker">' + MP.esc(n.ticker) + '</span>'
      + '<span class="hm-detail-dir" style="color:'+dirColor+';">' + MP.esc(n.direction||'') + '</span>'
    + '</div>'
    + '<div class="hm-detail-sector">' + MP.esc((n.sector||'') + (n.industry ? ' \u00B7 ' + n.industry : '')) + '</div>'
    + '<div class="hm-detail-action" style="border-left:3px solid '+dirColor+';padding-left:12px;margin:10px 0;font-size:14px;font-weight:600;color:'+dirColor+';">' + MP.esc(action) + '</div>'
    + '<div class="hm-detail-desc">' + MP.esc(n.description||'') + '</div>'
    + '<div class="hm-detail-stats">'
      + '<div class="hm-stat"><span class="hm-stat-l">Confidence</span><span class="hm-stat-v" style="color:'+dirColor+';">' + Math.round(Number(n.confidence)*100) + '%</span></div>'
      + '<div class="hm-stat"><span class="hm-stat-l">Tier</span><span class="hm-stat-v">' + MP.esc(n.card_tier||'STANDARD') + '</span></div>'
      + (n.price ? '<div class="hm-stat"><span class="hm-stat-l">Price</span><span class="hm-stat-v">$' + MP.fmtPrice(Number(n.price)) + '</span></div>' : '')
      + (n.fair_value ? '<div class="hm-stat"><span class="hm-stat-l">Fundamental Value</span><span class="hm-stat-v">$' + MP.fmtPrice(Number(n.fair_value)) + '</span></div>' : '')
    + '</div>'
    + '<a class="hm-detail-link" href="/ticker/'+encodeURIComponent(n.ticker)+'">View Full Analysis \u2192</a>'
  + '</div>';
}

async function init(){
  var container = document.getElementById('mm-container');
  if(!container) return;

  var wrap = document.getElementById('mm-wrap');
  if(wrap) wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Loading heatmap\u2026</div>';

  try{
    var rows = await MP.rest('v_trade_cards', {
      select: 'ticker,direction,confidence,card_tier,primary_label,sector,industry,description,price,fair_value',
      order: 'trade_score.desc'
    });

    if(!rows || !rows.length){
      if(wrap) wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">No signal data available.</div>';
      return;
    }

    // Group by sector
    var sectors = {};
    rows.forEach(function(r){
      var s = r.sector || 'Other';
      if(!sectors[s]) sectors[s] = [];
      sectors[s].push(r);
    });
    // Sort sectors by size
    var sectorNames = Object.keys(sectors).sort(function(a,b){ return sectors[b].length - sectors[a].length; });

    // Build HTML
    var html = '<div class="hm-grid">';
    sectorNames.forEach(function(sName){
      var group = sectors[sName];
      var sc = SECTOR_COLORS[sName] || '#00AEFF';
      // Sort within sector: highest confidence first
      group.sort(function(a,b){ return (Number(b.confidence)||0) - (Number(a.confidence)||0); });

      html += '<div class="hm-sector">';
      html += '<div class="hm-sector-label" style="color:'+sc+';border-bottom-color:'+sc+'33;">'
        + MP.esc(sName) + ' <span class="hm-sector-count">'+group.length+'</span>'
      + '</div>';
      html += '<div class="hm-sector-cells">';
      group.forEach(function(r, i){
        var conf = Number(r.confidence) || 0.5;
        var dir = (r.direction || '').toUpperCase();
        var bg = cellColor(dir, conf);
        var border = cellBorder(dir);
        var domain = MP.DOMAINS[r.ticker];
        var logoHTML = domain
          ? '<img class="hm-cell-logo" src="https://www.google.com/s2/favicons?domain='+domain+'&sz=32" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\';">'
            + '<span class="hm-cell-initials" style="display:none;color:'+border+';">'+r.ticker.slice(0,3)+'</span>'
          : '<span class="hm-cell-initials" style="color:'+border+';">'+r.ticker.slice(0,3)+'</span>';

        html += '<div class="hm-cell" data-idx="'+i+'" data-sector="'+MP.esc(sName)+'" style="background:'+bg+';border-color:'+border+'22;" title="'+MP.esc(r.ticker + ' \u2014 ' + (r.direction||'') + ' ' + Math.round(conf*100) + '%')+'">'
          + tierBadgeHTML(r.card_tier)
          + '<div class="hm-cell-logo-wrap">'+logoHTML+'</div>'
          + '<div class="hm-cell-ticker">'+MP.esc(r.ticker)+'</div>'
          + '<div class="hm-cell-conf" style="color:'+border+';">'+Math.round(conf*100)+'%</div>'
        + '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';

    if(wrap) wrap.innerHTML = html;

    // Legend
    var bull = rows.filter(function(r){return (r.direction||'').toUpperCase()==='BULLISH';}).length;
    var bear = rows.filter(function(r){return (r.direction||'').toUpperCase()==='BEARISH';}).length;
    var neut = rows.length - bull - bear;
    var legendEl = document.getElementById('mm-legend');
    if(legendEl) legendEl.innerHTML =
      '<span style="color:#00DE94;">\u25A0 ' + bull + ' Bullish</span>'
      + '<span style="color:#FF4D4D;">\u25A0 ' + bear + ' Bearish</span>'
      + '<span style="color:#00AEFF;">\u25A0 ' + neut + ' Neutral</span>'
      + '<span style="color:var(--mp-text-muted);">' + rows.length + ' total</span>';

    // Click handler — show detail panel
    wrap.querySelectorAll('.hm-cell').forEach(function(cell){
      cell.addEventListener('click', function(){
        var sName = this.dataset.sector;
        var idx = parseInt(this.dataset.idx);
        var r = sectors[sName] ? sectors[sName][idx] : null;
        if(!r) return;
        // Remove existing
        var ex = document.getElementById('hm-detail');
        if(ex) ex.remove();
        wrap.insertAdjacentHTML('beforeend', buildDetailPanel(r));
      });
    });

  }catch(e){
    console.warn('[HM] Load failed:', e);
    if(wrap) wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Failed to load heatmap.</div>';
  }
}

MP.register('market-map', init);
})();
