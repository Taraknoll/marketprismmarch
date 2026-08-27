// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Trade Lanes Module (v2)
// "What's the play?" — Day Trade / Swing Trade / Long Hold
// Compact list layout, sorted by confidence
// ══════════════════════════════════════════════════════════════════════════════
(function(){

var LANE_CONFIG = {
  day: {
    title: 'Day Trade',
    subtitle: 'In and out today',
    count: 0
  },
  swing: {
    title: 'Swing Trade',
    subtitle: '3\u201314 day window',
    count: 0
  },
  position: {
    title: 'Long Hold',
    subtitle: 'Weeks to months',
    count: 0
  }
};

var ACTIONS = {
  'NARRATIVE_TRAP':          'Short',
  'FUNDAMENTAL_DISCONNECT':  'Short',
  'FADE_THE_HYPE':           'Fade rallies',
  'DRIFT_COMPRESSION_SHORT': 'Short on bounce',
  'AIR_POCKET_SHORT':        'Short',
  'ACCUMULATE':              'Buy dips',
  'MOMENTUM_CONFIRMED':      'Ride up',
  'FUNDAMENTAL_LONG':        'Buy and hold',
  'OMISSION_CASCADE':        'Short'
};

function fmtLabel(label){
  if(!label) return 'Signal';
  return label.replace(/_/g,' ').toLowerCase().replace(/\b\w/g,function(c){return c.toUpperCase();});
}

var LANE_LIMIT = 5;

function buildRow(r){
  var dir = (r.direction||'').toUpperCase();
  var isBear = dir === 'BEARISH';
  var isBull = dir === 'BULLISH';
  var dirColor = isBear ? '#FF4D4D' : isBull ? '#00DE94' : '#00AEFF';
  var dirArrow = isBear ? '\u25BC' : isBull ? '\u25B2' : '';
  var action = ACTIONS[r.primary_label] || 'Monitor';
  var actionColor = isBear ? '#FF4D4D' : isBull ? '#00DE94' : 'var(--mp-text-secondary)';
  var price = r.price ? '$' + MP.fmtPrice(Number(r.price)) : '';
  var tier = (r.card_tier||'').toUpperCase();
  var tierHTML = '';
  if(tier === 'PLATINUM') tierHTML = '<span class="tl-tier tl-plat">Plat</span>';
  else if(tier === 'GOLD') tierHTML = '<span class="tl-tier tl-gold">Gold</span>';
  else if(tier === 'SURPRISE') tierHTML = '<span class="tl-tier tl-surp">Surp</span>';
  var domain = MP.DOMAINS[r.ticker];

  return '<div class="tl-row" data-ticker="'+MP.esc(r.ticker)+'">'
    + '<div class="tl-row-left">'
      + tierHTML
      + (domain
        ? '<img class="tl-row-logo" src="https://www.google.com/s2/favicons?domain='+domain+'&sz=32" alt="" onerror="this.style.display=\'none\';">'
        : '')
      + '<span class="tl-row-ticker">'+MP.esc(r.ticker)+'</span>'
      + '<span class="tl-row-price">'+price+'</span>'
    + '</div>'
    + '<div class="tl-row-right">'
      + '<span class="tl-row-action" style="color:'+actionColor+';">'+MP.esc(action)+'</span>'
      + '<span class="tl-row-dir" style="color:'+dirColor+';">'+dirArrow+'</span>'
    + '</div>'
  + '</div>';
}

/* trade_cards_live carries confidence at three stages of refinement. The raw
   `confidence` prior saturates at a 0.79 ceiling and regime_adjusted_confidence
   holds only a couple of distinct values, so ordering on either leaves these
   lanes essentially arbitrary within a large tie. keyword_adjusted_confidence is
   the per-ticker stage — walk the chain most-refined-first. (Mirrors
   gcResolveConfidence in _template.html; duplicated because this module is a
   separate IIFE with no shared scope.) */
function resolveConfidence(r){
  if(!r) return 0;
  var chain = [r.keyword_adjusted_confidence, r.regime_adjusted_confidence, r.confidence];
  for(var i=0;i<chain.length;i++){
    if(chain[i] == null) continue;
    var v = Number(chain[i]);
    if(isFinite(v) && v > 0) return v;
  }
  return 0;
}

function buildLane(key, cards){
  var cfg = LANE_CONFIG[key];
  if(!cfg || !cards.length) return '';
  cards.sort(function(a,b){ return resolveConfidence(b) - resolveConfidence(a); });

  var visible = cards.slice(0, LANE_LIMIT);
  var overflow = cards.slice(LANE_LIMIT);
  var laneId = 'tl-overflow-' + key;

  var html = '<div class="tl-lane">'
    + '<div class="tl-lane-header">'
      + '<div class="tl-lane-title">'+cfg.title+'</div>'
      + '<div class="tl-lane-sub">'+cfg.subtitle+' \u00B7 '+cards.length+' signals</div>'
    + '</div>'
    + '<div class="tl-lane-rows">';
  visible.forEach(function(c){ html += buildRow(c); });
  if(overflow.length){
    html += '<div class="tl-overflow" id="'+laneId+'" style="display:none;">';
    overflow.forEach(function(c){ html += buildRow(c); });
    html += '</div>';
    html += '<button class="tl-view-more" data-target="'+laneId+'">View '+overflow.length+' more</button>';
  }
  html += '</div></div>';
  return html;
}

function buildValueRow(r){
  var discount = r._discount;
  var discountStr = discount != null ? Math.abs(discount).toFixed(1) + '% under FV' : '';
  var revGrowth = r.revenue_growth_pct != null ? '+' + Number(r.revenue_growth_pct).toFixed(1) + '% rev' : '';
  var price = r.price ? '$' + MP.fmtPrice(Number(r.price)) : '';
  var domain = MP.DOMAINS[r.ticker];

  return '<div class="tl-row" data-ticker="' + MP.esc(r.ticker) + '">'
    + '<div class="tl-row-left">'
      + (domain ? '<img class="tl-row-logo" src="https://www.google.com/s2/favicons?domain=' + domain + '&sz=32" alt="" onerror="this.style.display=\'none\';">' : '')
      + '<span class="tl-row-ticker">' + MP.esc(r.ticker) + '</span>'
      + '<span class="tl-row-price">' + price + '</span>'
    + '</div>'
    + '<div class="tl-row-right">'
      + '<span class="tl-row-action" style="color:#38C8B8;">' + MP.esc(discountStr) + '</span>'
      + (revGrowth ? '<span style="font-size:11px;color:var(--mp-text-muted);font-family:var(--font-body);margin-left:6px;">' + MP.esc(revGrowth) + '</span>' : '')
      + '<span class="tl-row-dir" style="color:#00DE94;">\u25B2</span>'
    + '</div>'
  + '</div>';
}

function buildValueLane(cards){
  if(!cards.length) return '';
  var visible = cards.slice(0, LANE_LIMIT);
  var overflow = cards.slice(LANE_LIMIT);
  var laneId = 'tl-overflow-value-picks';

  var html = '<div class="tl-lane">'
    + '<div class="tl-lane-header">'
      + '<div class="tl-lane-title">Value Picks</div>'
      + '<div class="tl-lane-sub">Under fundamental value \u00B7 strong fundamentals \u00B7 ' + cards.length + ' picks</div>'
    + '</div>'
    + '<div class="tl-lane-rows">';
  visible.forEach(function(c){ html += buildValueRow(c); });
  if(overflow.length){
    html += '<div class="tl-overflow" id="' + laneId + '" style="display:none;">';
    overflow.forEach(function(c){ html += buildValueRow(c); });
    html += '</div>';
    html += '<button class="tl-view-more" data-target="' + laneId + '">View ' + overflow.length + ' more</button>';
  }
  html += '</div></div>';
  return html;
}

async function loadValuePicks(){
  try{
    var dateRows = await MP.rest('ticker_snapshots', {select:'snapshot_date', order:'snapshot_date.desc', limit:'1'});
    if(!dateRows || !dateRows.length) return [];
    var maxDate = dateRows[0].snapshot_date;

    var storiesP = MP.rest('v_dash_daily_story', {
      select: 'ticker,fair_value,pe_ratio,revenue_growth_pct,sector_name',
      snapshot_date: 'eq.' + maxDate,
      'fair_value': 'not.is.null'
    });
    var snapsP = MP.rest('ticker_snapshots', {
      select: 'ticker,price_close',
      snapshot_date: 'eq.' + maxDate
    });
    var sigsP = MP.rest('ticker_signatures', {
      select: 'ticker,brier_score_overall',
      'brier_score_overall': 'not.is.null'
    });
    var bearishP = MP.rest('trade_cards_live', {
      select: 'ticker,direction',
      direction: 'eq.BEARISH'
    });

    var stories = await storiesP;
    var snaps = await snapsP;
    var sigs = await sigsP;
    var bearishCards = await bearishP;
    if(!stories || !snaps) return [];

    var priceMap = {};
    snaps.forEach(function(s){ priceMap[s.ticker] = Number(s.price_close); });
    var brierMap = {};
    if(sigs) sigs.forEach(function(s){ brierMap[s.ticker] = Number(s.brier_score_overall); });
    var bearishSet = {};
    if(bearishCards) bearishCards.forEach(function(c){ bearishSet[c.ticker] = true; });

    var picks = [];
    stories.forEach(function(d){
      if(bearishSet[d.ticker]) return;
      var price = priceMap[d.ticker];
      var fv = Number(d.fair_value);
      if(!price || !fv || fv <= 0) return;
      var discount = ((price - fv) / fv) * 100;
      if(discount >= -35 && discount <= -2 && Number(d.revenue_growth_pct) > 0){
        picks.push({
          ticker: d.ticker, price: price, fair_value: fv,
          _discount: discount, revenue_growth_pct: d.revenue_growth_pct,
          pe_ratio: d.pe_ratio, sector_name: d.sector_name,
          brier: brierMap[d.ticker] || 1
        });
      }
    });
    picks.sort(function(a,b){ return (a.brier - b.brier) || (a._discount - b._discount); });
    return picks;
  }catch(e){ console.warn('[VP] Value picks failed:', e); return []; }
}

async function init(){
  var container = document.getElementById('tl-container');
  if(!container) return;

  try{
    var tradeP = MP.rest('trade_cards_live', {
      select: 'ticker,direction,confidence,regime_adjusted_confidence,keyword_adjusted_confidence,card_tier,primary_label,timeframe,holding_days,price',
      order: 'keyword_adjusted_confidence.desc.nullslast'
    });
    var valueP = loadValuePicks();

    var rows = await tradeP;
    var valuePicks = await valueP;

    var buckets = { day:[], swing:[], position:[] };
    if(rows && rows.length){
      rows.forEach(function(r){
        var tf = (r.timeframe || '').toLowerCase();
        if(tf === 'day') buckets.day.push(r);
        else if(tf === 'swing') buckets.swing.push(r);
        else if(tf === 'position') buckets.position.push(r);
        else {
          var hd = r.holding_days || 7;
          if(hd <= 2) buckets.day.push(r);
          else if(hd <= 14) buckets.swing.push(r);
          else buckets.position.push(r);
        }
      });
    }

    var html = '';
    html += buildLane('day', buckets.day);
    html += buildLane('swing', buckets.swing);
    html += buildValueLane(valuePicks);

    var grid = document.getElementById('tl-grid');
    if(grid) grid.innerHTML = html;
    if((rows && rows.length) || valuePicks.length) container.style.display = 'block';
    else container.style.display = 'none';

    // Click — rows
    container.querySelectorAll('.tl-row[data-ticker]').forEach(function(row){
      row.addEventListener('click', function(){
        window.location.href = '/ticker/' + encodeURIComponent(this.dataset.ticker);
      });
    });

    // Click — view more
    container.querySelectorAll('.tl-view-more').forEach(function(btn){
      btn.addEventListener('click', function(){
        var target = document.getElementById(this.dataset.target);
        if(!target) return;
        var showing = target.style.display !== 'none';
        target.style.display = showing ? 'none' : 'block';
        this.textContent = showing
          ? 'View ' + target.children.length + ' more'
          : 'Show less';
      });
    });

  }catch(e){ console.warn('[TL] Load failed:', e); }
}

MP.register('trade-lanes', init);
})();
