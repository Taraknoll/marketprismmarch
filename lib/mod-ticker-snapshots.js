// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Ticker Snapshots Module (v2)
// Sortable/filterable table of all active signals
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

var currentSort = 'trade_score';
var currentDir = 'desc';
var currentFilter = 'all';
var allRows = [];

function renderTable(){
  var grid = document.getElementById('snap-table-body');
  if(!grid) return;

  var filtered = allRows;
  if(currentFilter === 'bearish') filtered = allRows.filter(function(r){return (r.direction||'').toUpperCase()==='BEARISH';});
  else if(currentFilter === 'bullish') filtered = allRows.filter(function(r){return (r.direction||'').toUpperCase()==='BULLISH';});
  else if(currentFilter === 'traps') filtered = allRows.filter(function(r){return ['NARRATIVE_TRAP','FUNDAMENTAL_DISCONNECT','FADE_THE_HYPE','AIR_POCKET_SHORT','OMISSION_CASCADE'].indexOf(r.primary_label)!==-1;});
  else if(currentFilter === 'supported') filtered = allRows.filter(function(r){return ['ACCUMULATE','MOMENTUM_CONFIRMED','FUNDAMENTAL_LONG'].indexOf(r.primary_label)!==-1;});
  else if(currentFilter === 'coordinated') filtered = allRows.filter(function(r){return r.coordination_class && (r.coordination_class.indexOf('COORDINATED')!==-1 || r.coordination_class.indexOf('SUSPICIOUS')!==-1);});

  filtered.sort(function(a,b){
    var va = a[currentSort], vb = b[currentSort];
    if(va == null) va = currentDir === 'desc' ? -Infinity : Infinity;
    if(vb == null) vb = currentDir === 'desc' ? -Infinity : Infinity;
    if(typeof va === 'string') va = va.toLowerCase();
    if(typeof vb === 'string') vb = vb.toLowerCase();
    return currentDir === 'desc' ? (vb > va ? 1 : vb < va ? -1 : 0) : (va > vb ? 1 : va < vb ? -1 : 0);
  });

  var countEl = document.getElementById('snap-count');
  if(countEl) countEl.textContent = filtered.length + ' tickers';

  if(!filtered.length){
    grid.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--mp-text-muted);">No tickers match.</td></tr>';
    return;
  }

  grid.innerHTML = filtered.map(function(r){
    var dir = (r.direction||'').toUpperCase();
    var dirColor = dir === 'BEARISH' ? '#FF4D4D' : 'var(--mp-cyan)';
    var dirArrow = dir === 'BEARISH' ? '\u25BC' : dir === 'BULLISH' ? '\u25B2' : '';
    var action = ACTIONS[r.primary_label] || 'Monitor';
    var price = r.price ? '$' + MP.fmtPrice(Number(r.price)) : '\u2014';
    var fvd = r.pct_above_fair_value != null ? (Number(r.pct_above_fair_value) > 0 ? '+' : '') + Number(r.pct_above_fair_value).toFixed(0) + '%' : '\u2014';
    var fvdColor = r.pct_above_fair_value > 30 ? '#FF4D4D' : r.pct_above_fair_value < -10 ? 'var(--mp-cyan)' : 'var(--mp-text-secondary)';
    var domain = MP.DOMAINS[r.ticker];
    var logo = domain ? '<img class="snap-logo" src="https://www.google.com/s2/favicons?domain='+domain+'&sz=32" alt="" onerror="this.style.display=\'none\';">' : '';
    var sector = r.sector || r.industry || '';
    var flags = [];
    if(r.coordination_class && (r.coordination_class.indexOf('COORDINATED')!==-1 || r.coordination_class.indexOf('SUSPICIOUS')!==-1)) flags.push('Coordinated');
    if(r.dark_pool_signal === 'HEAVY') flags.push('Dark Pool');

    return '<tr data-ticker="'+MP.esc(r.ticker)+'">'
      + '<td><div class="snap-ticker-cell">'+logo+'<span>'+MP.esc(r.ticker)+'</span></div></td>'
      + '<td>'+price+'</td>'
      + '<td>'+MP.esc(fmtLabel(r.primary_label))+'</td>'
      + '<td>'+MP.esc(action)+'</td>'
      + '<td style="color:'+dirColor+';">'+dirArrow+' '+MP.esc(dir)+'</td>'
      + '<td style="color:'+fvdColor+';">'+fvd+'</td>'
      + '<td>'+flags.map(function(f){return '<span class="snap-flag">'+MP.esc(f)+'</span>';}).join(' ')+'</td>'
    + '</tr>';
  }).join('');

  grid.querySelectorAll('tr[data-ticker]').forEach(function(row){
    row.addEventListener('click', function(){ window.location.href = '/ticker/' + encodeURIComponent(this.dataset.ticker); });
  });
}

async function init(){
  var root = document.getElementById('snapshots-root');
  if(!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Loading\u2026</div>';

  try{
    var rows = await MP.rest('trade_cards_live', {
      select: 'ticker,direction,primary_label,confidence,price,card_tier,sector,industry,fair_value,pct_above_fair_value,pe_ratio,coordination_class,dark_pool_signal,trade_score',
      order: 'trade_score.desc'
    });
    if(!rows || !rows.length){ root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">No data.</div>'; return; }
    allRows = rows;

    root.innerHTML = '<div class="page-header">'
        + '<div class="ph-eyebrow">Ticker Snapshots</div>'
        + '<h1>Every signal at a glance.</h1>'
        + '<span class="ph-italic">Sorted, filtered, actionable.</span>'
        + '<p>'+rows.length+' active signals</p>'
      + '</div>'
      + '<div class="snap-controls">'
        + '<div class="snap-filters">'
          + '<button class="snap-chip active" data-filter="all">All '+rows.length+'</button>'
          + '<button class="snap-chip" data-filter="traps">Traps</button>'
          + '<button class="snap-chip" data-filter="supported">Supported</button>'
          + '<button class="snap-chip" data-filter="bearish">Bearish</button>'
          + '<button class="snap-chip" data-filter="bullish">Bullish</button>'
          + '<button class="snap-chip" data-filter="coordinated">Coordinated</button>'
        + '</div>'
        + '<span class="snap-count" id="snap-count"></span>'
      + '</div>'
      + '<div class="snap-table-wrap"><table class="snap-table">'
        + '<thead><tr>'
          + '<th data-sort="ticker">Ticker</th>'
          + '<th data-sort="price">Price</th>'
          + '<th data-sort="primary_label">Signal</th>'
          + '<th>Action</th>'
          + '<th data-sort="direction">Direction</th>'
          + '<th data-sort="pct_above_fair_value">vs Fundamental Value</th>'
          + '<th>Flags</th>'
        + '</tr></thead>'
        + '<tbody id="snap-table-body"></tbody>'
      + '</table></div>';

    renderTable();

    root.querySelectorAll('.snap-chip').forEach(function(c){
      c.addEventListener('click', function(){
        root.querySelectorAll('.snap-chip').forEach(function(x){x.classList.remove('active');});
        this.classList.add('active');
        currentFilter = this.dataset.filter;
        renderTable();
      });
    });
    root.querySelectorAll('th[data-sort]').forEach(function(th){
      th.addEventListener('click', function(){
        var col = this.dataset.sort;
        if(currentSort === col) currentDir = currentDir === 'desc' ? 'asc' : 'desc';
        else { currentSort = col; currentDir = 'desc'; }
        renderTable();
      });
    });
  }catch(e){ root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--mp-text-muted);">Failed to load.</div>'; }
}

MP.register('snapshots', init);
})();
