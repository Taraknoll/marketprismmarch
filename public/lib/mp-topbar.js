// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Shared Topbar (mp-topbar.js)
// ══════════════════════════════════════════════════════════════════════════════
// Same topbar shell as the dashboard, used on every page that needs the
// centered scholar-bar search + right-side date/theme/logout chrome.
//
//   <div class="topbar" id="topbar"></div>
//   <script src="/lib/mp-topbar.js"></script>
//   <script>
//     MP.renderTopbar({ container: '#topbar', title: 'Stock Prism' });
//     MP.initScholarBar();
//   </script>
//
// The dashboard (_template.html) keeps its own inline copy for now; this
// module exists so _ticker.html / _search.html etc. don't drift visually
// or functionally from it. To migrate the dashboard later, swap its inline
// topbar markup for the placeholder + render call above and pass
// `injectStyles: false` so its existing CSS isn't duplicated.
// ══════════════════════════════════════════════════════════════════════════════

(function(){
  var MP = window.MP || (window.MP = {});

  // ── CSS — copy of the dashboard's inline topbar + scholar-bar rules so the
  //   look matches byte-for-byte. Injected once per page (marker tag below).
  var TOPBAR_CSS = ''+
    /* Topbar background: transparent so it inherits whatever the host page's
       body uses (dashboard sits on a navy gradient, ticker pages sit on near-
       black). Backdrop blur still gives a frosted feel when content scrolls
       behind. The border-bottom keeps it visually anchored. */
    '.topbar{position:sticky;top:0;z-index:50;background:transparent;backdrop-filter:blur(20px) saturate(1.2);border-bottom:1px solid var(--mp-border);padding:0 36px;height:56px;display:flex;align-items:center;justify-content:space-between;gap:16px;}'+
    '.topbar-title{font-family:var(--font-mono,Inter,sans-serif);font-size:12px;font-weight:400;letter-spacing:.10em;text-transform:uppercase;color:var(--mp-text-secondary);}'+
    '.topbar-right{display:flex;align-items:center;gap:10px;}'+
    '.topbar-date{font-family:var(--font-mono,Inter,sans-serif);font-size:11px;color:var(--mp-text-tertiary);}'+
    '.topbar-center{flex:1;display:flex;justify-content:center;max-width:520px;margin:0 auto;}'+
    /* Scholar bar — animated glisten sweep so users notice it's a search input.
       Animates background-position (not a pseudo-element) so the absolute-positioned
       dropdown isn't clipped. Pauses on focus so it doesn't distract while typing. */
    '@keyframes scholar-glisten{0%,100%{background-position:200% 0;}50%{background-position:-100% 0;}}'+
    '.scholar-bar{display:flex;align-items:center;gap:10px;width:100%;position:relative;padding:9px 16px;border-radius:12px;border:1px solid rgba(0,0,0,0.10);background:linear-gradient(110deg,#FFFFFF 0%,#F5F7FA 45%,#FFFFFF 55%,#FFFFFF 100%);background-size:220% 100%;animation:scholar-glisten 5s ease-in-out infinite;transition:border-color .25s ease,box-shadow .25s ease;cursor:text;box-shadow:0 1px 3px rgba(0,0,0,0.04);}'+
    '.scholar-bar:hover{border-color:rgba(0,174,255,0.25);box-shadow:0 2px 8px rgba(0,174,255,0.08);}'+
    '.scholar-bar:focus-within{border-color:rgba(0,174,255,0.4);box-shadow:0 0 0 3px rgba(0,174,255,0.12),0 4px 16px rgba(0,174,255,0.10);animation-play-state:paused;}'+
    '[data-theme="dark"] .scholar-bar{border-color:rgba(255,255,255,0.20);background:linear-gradient(110deg,rgba(255,255,255,0.10) 0%,rgba(255,255,255,0.22) 45%,rgba(255,255,255,0.10) 55%,rgba(255,255,255,0.10) 100%);background-size:220% 100%;box-shadow:0 0 24px rgba(255,255,255,0.08),inset 0 1px 0 rgba(255,255,255,0.12);}'+
    '[data-theme="dark"] .scholar-bar:hover{border-color:rgba(0,174,255,0.40);box-shadow:0 0 28px rgba(0,174,255,0.15),inset 0 1px 0 rgba(255,255,255,0.14);}'+
    '[data-theme="dark"] .scholar-bar:focus-within{border-color:rgba(0,174,255,0.55);box-shadow:0 0 0 3px rgba(0,174,255,0.18),0 0 32px rgba(0,174,255,0.20),inset 0 1px 0 rgba(255,255,255,0.16);}'+
    '.scholar-bar-icon{width:18px;height:18px;flex-shrink:0;opacity:0.85;}'+
    '.scholar-bar-input{flex:1;background:transparent;border:none;outline:none;font-family:var(--font-body,Inter,sans-serif);font-size:13px;color:var(--mp-text-primary);letter-spacing:0.01em;}'+
    '.scholar-bar-input::placeholder{color:var(--mp-text-tertiary);font-weight:400;}'+
    '.scholar-bar-kbd{font-family:var(--font-mono,Inter,sans-serif);font-size:10px;color:var(--mp-text-tertiary);padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);line-height:1;flex-shrink:0;}'+
    '[data-theme="light"] .scholar-bar-kbd{border-color:rgba(0,0,0,0.08);background:rgba(0,0,0,0.03);}'+
    '.scholar-dropdown{display:none;position:absolute;top:100%;left:0;right:0;z-index:999;background:var(--mp-surface);border:1px solid var(--mp-border-hover);border-radius:0 0 12px 12px;max-height:320px;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5);}'+
    '.scholar-dropdown.open{display:block;}'+
    '.scholar-dd-item{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.03);transition:background .12s;}'+
    '.scholar-dd-item:last-child{border-bottom:none;}'+
    '.scholar-dd-item:hover,.scholar-dd-item.active{background:rgba(255,255,255,0.05);}'+
    '.scholar-dd-ticker{font-size:13px;font-weight:700;color:var(--mp-text-primary);min-width:50px;font-family:var(--font-body,Inter,sans-serif);}'+
    '.scholar-dd-name{font-size:12px;color:var(--mp-text-tertiary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'+
    '.scholar-dd-sector{font-size:10px;color:var(--mp-text-muted);flex-shrink:0;}'+
    '.scholar-dd-empty{padding:16px;text-align:center;font-size:12px;color:var(--mp-text-muted);}'+
    '.scholar-dropdown.scholar-browse-mode{max-height:min(70vh,560px);padding:8px 0;}'+
    '.scholar-browse-head{padding:10px 16px 8px;font-size:11px;color:var(--mp-text-muted);text-transform:uppercase;letter-spacing:.10em;font-family:var(--font-body,Inter,sans-serif);border-bottom:1px solid rgba(255,255,255,0.04);margin-bottom:6px;}'+
    '.scholar-sector-group{padding:10px 16px 14px;}'+
    '.scholar-sector-label{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mp-text-tertiary);margin-bottom:8px;display:flex;align-items:center;gap:8px;font-family:var(--font-body,Inter,sans-serif);}'+
    '.scholar-sector-label::after{content:"";flex:1;height:1px;background:var(--mp-border);}'+
    '.scholar-sector-count{font-size:10px;color:var(--mp-text-muted);font-weight:500;letter-spacing:.04em;}'+
    '.scholar-chips{display:flex;flex-wrap:wrap;gap:6px;}'+
    '.scholar-chip{display:inline-flex;align-items:center;padding:5px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);font-size:12px;font-weight:600;color:var(--mp-text-secondary);text-decoration:none;font-family:var(--font-body,Inter,sans-serif);transition:background .15s,border-color .15s,color .15s;letter-spacing:.02em;}'+
    '.scholar-chip:hover{background:rgba(0,174,255,0.10);border-color:rgba(0,174,255,0.30);color:#00AEFF;}'+
    '.hamburger-btn{background:none;border:none;color:var(--mp-text-primary);cursor:pointer;padding:4px;display:flex;align-items:center;}'+
    '.hamburger-btn svg{width:20px;height:20px;}'+
    '.theme-toggle{background:none;border:none;cursor:pointer;font-size:18px;line-height:1;padding:4px 6px;border-radius:6px;transition:background .15s;}'+
    '.theme-toggle:hover{background:rgba(255,255,255,0.05);}'+
    '@media(max-width:767px){.topbar{padding:0 14px;}.topbar-title{display:none;}.topbar-date{display:none;}}';

  function injectStylesOnce(){
    if (document.querySelector('style[data-mp-topbar-css]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-mp-topbar-css','');
    s.textContent = TOPBAR_CSS;
    document.head.appendChild(s);
  }

  function escAttr(s){ return (s+'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  // Render the topbar shell into the given container. The container itself
  // becomes <div class="topbar">. Optional opts:
  //   title: string shown in the top-left (after hamburger)
  //   tickerCount: number to show in the search placeholder
  MP.renderTopbar = function(opts){
    opts = opts || {};
    var container = (typeof opts.container === 'string') ? document.querySelector(opts.container) : opts.container;
    if (!container) return;
    if (opts.injectStyles !== false) injectStylesOnce();

    var title = opts.title || '';
    var placeholder = opts.tickerCount
      ? 'Search ' + opts.tickerCount + ' tickers… e.g. AAPL, NVDA, TSLA'
      : 'Search tickers… e.g. AAPL, NVDA, TSLA';

    container.innerHTML = ''+
      '<button class="hamburger-btn" id="hamburger-btn-desktop" aria-label="Toggle menu" style="margin-right:8px;">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>'+
      '</button>'+
      '<div class="topbar-title" id="topbar-title">'+escAttr(title)+'</div>'+
      '<div class="topbar-center">'+
        '<div class="scholar-bar" id="scholar-bar">'+
          '<svg class="scholar-bar-icon" viewBox="0 0 24 24" fill="none" stroke="var(--mp-text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'+
          '<input class="scholar-bar-input" id="scholar-bar-input" placeholder="'+escAttr(placeholder)+'" autocomplete="off">'+
          '<kbd class="scholar-bar-kbd">⌘K</kbd>'+
          '<div class="scholar-dropdown" id="scholar-dropdown"></div>'+
        '</div>'+
      '</div>'+
      '<div class="topbar-right">'+
        '<span class="topbar-date" id="topbar-date"></span>'+
        '<span class="topbar-date" id="topbar-user" style="display:none;"></span>'+
        '<button class="theme-toggle" onclick="if(typeof toggleTheme===\'function\')toggleTheme()" title="Toggle theme">🌙</button>'+
      '</div>';

    if (!container.classList.contains('topbar')) container.classList.add('topbar');
    if (!container.id) container.id = 'topbar';

    // Populate the date — same Fri, May 1, 2026 format the dashboard uses.
    try {
      var d = new Date();
      var fmt = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      var dateEl = container.querySelector('#topbar-date');
      if (dateEl) dateEl.textContent = fmt;
    } catch (e) {}
  };

  // Wire up the search bar's filter dropdown + browse-all flyout. Pulls the
  // ticker universe from ticker_industry_lookup. Safe to call once renderTopbar
  // has built the input. Reads supabase config from window (SUPABASE_URL,
  // SUPABASE_ANON, MP_EXCLUDED_TICKERS) — same conventions as the dashboard.
  MP.initScholarBar = function(opts){
    opts = opts || {};
    var barInput = document.getElementById('scholar-bar-input');
    var ddEl = document.getElementById('scholar-dropdown');
    var scholarBar = document.getElementById('scholar-bar');
    if (!barInput || !ddEl) return;

    // Pages set Supabase config in different places: dashboard uses globals on
    // window directly, ticker pages put them under window.__env. Check both.
    var env = window.__env || {};
    var SUPABASE_URL = window.SUPABASE_URL || env.SUPABASE_URL || '';
    var SUPABASE_ANON = window.SUPABASE_ANON || env.SUPABASE_ANON || '';
    var EXCL = window.MP_EXCLUDED_TICKERS || env.MP_EXCLUDED_TICKERS || '';

    var _ddTickers = [];
    var _ddIdx = -1;

    function esc(s){return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

    if (SUPABASE_URL && SUPABASE_ANON) {
      var url = SUPABASE_URL + '/rest/v1/ticker_industry_lookup?select=ticker,name,sector&order=ticker.asc&limit=300';
      if (EXCL) url += '&ticker=' + encodeURIComponent(EXCL);
      fetch(url, { headers:{'apikey':SUPABASE_ANON,'Authorization':'Bearer '+SUPABASE_ANON,'Accept':'application/json'} })
        .then(function(r){return r.ok?r.json():[];})
        .then(function(rows){
          _ddTickers = (rows||[]).filter(function(r){return r.ticker;});
          if (_ddTickers.length > 0) barInput.placeholder = 'Search ' + _ddTickers.length + ' tickers… e.g. AAPL, NVDA, TSLA';
        }).catch(function(){});
    }

    function renderFiltered(matches){
      ddEl.classList.remove('scholar-browse-mode');
      if (!matches.length) {
        ddEl.innerHTML = '<div class="scholar-dd-empty">No matching tickers</div>';
        ddEl.classList.add('open');
        return;
      }
      _ddIdx = -1;
      ddEl.innerHTML = matches.slice(0, 12).map(function(r, i){
        return '<div class="scholar-dd-item" data-ticker="'+esc(r.ticker)+'" data-idx="'+i+'">'
          +'<span class="scholar-dd-ticker">'+esc(r.ticker)+'</span>'
          +'<span class="scholar-dd-name">'+esc(r.name||'')+'</span>'
          +'<span class="scholar-dd-sector">'+esc(r.sector||'')+'</span>'
        +'</div>';
      }).join('');
      ddEl.classList.add('open');
      ddEl.querySelectorAll('.scholar-dd-item').forEach(function(item){
        item.addEventListener('mousedown', function(e){
          e.preventDefault();
          window.location.href = '/ticker/' + encodeURIComponent(this.dataset.ticker);
        });
      });
    }

    function renderBrowseAll(){
      _ddIdx = -1;
      if (!_ddTickers.length) {
        ddEl.innerHTML = '<div class="scholar-dd-empty">Loading tickers…</div>';
        ddEl.classList.add('open');
        return;
      }
      var bySector = {};
      _ddTickers.forEach(function(r){ var s = r.sector || 'Other'; (bySector[s] = bySector[s] || []).push(r); });
      var sectorNames = Object.keys(bySector).sort(function(a,b){ return bySector[b].length - bySector[a].length; });
      var html = '<div class="scholar-browse-head">All ' + _ddTickers.length + ' tickers · grouped by sector · type to filter</div>';
      html += sectorNames.map(function(s){
        var tickers = bySector[s].slice().sort(function(a,b){ return a.ticker.localeCompare(b.ticker); });
        return '<div class="scholar-sector-group">'
          +'<div class="scholar-sector-label">'+esc(s)+'<span class="scholar-sector-count">'+tickers.length+'</span></div>'
          +'<div class="scholar-chips">'
          +tickers.map(function(r){
            return '<a class="scholar-chip" href="/ticker/'+encodeURIComponent(r.ticker)+'" title="'+esc(r.name||r.ticker)+'" data-ticker="'+esc(r.ticker)+'">'+esc(r.ticker)+'</a>';
          }).join('')
          +'</div>'
        +'</div>';
      }).join('');
      ddEl.innerHTML = html;
      ddEl.classList.add('open');
      ddEl.classList.add('scholar-browse-mode');
      ddEl.querySelectorAll('.scholar-chip').forEach(function(chip){
        chip.addEventListener('mousedown', function(e){
          e.preventDefault();
          window.location.href = '/ticker/' + encodeURIComponent(this.dataset.ticker);
        });
      });
    }

    function ddClose(){ ddEl.classList.remove('open'); ddEl.classList.remove('scholar-browse-mode'); _ddIdx = -1; }

    barInput.addEventListener('input', function(){
      var q = this.value.trim().toUpperCase();
      if (!q) { renderBrowseAll(); return; }
      var matches = _ddTickers.filter(function(r){
        return r.ticker.indexOf(q) === 0 || (r.name && r.name.toUpperCase().indexOf(q) !== -1);
      });
      renderFiltered(matches);
    });
    barInput.addEventListener('focus', function(){
      var q = this.value.trim().toUpperCase();
      if (!q) { renderBrowseAll(); return; }
      var m = _ddTickers.filter(function(r){
        return r.ticker.indexOf(q) === 0 || (r.name && r.name.toUpperCase().indexOf(q) !== -1);
      });
      renderFiltered(m);
    });
    barInput.addEventListener('blur', function(){ setTimeout(ddClose, 150); });
    barInput.addEventListener('keydown', function(e){
      var items = ddEl.querySelectorAll('.scholar-dd-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); _ddIdx = Math.min(_ddIdx+1, items.length-1); items.forEach(function(it){it.classList.remove('active');}); if(items[_ddIdx]) items[_ddIdx].classList.add('active'); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _ddIdx = Math.max(_ddIdx-1, 0); items.forEach(function(it){it.classList.remove('active');}); if(items[_ddIdx]) items[_ddIdx].classList.add('active'); return; }
      if (e.key === 'Escape')    { ddClose(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (_ddIdx >= 0 && items[_ddIdx]) { window.location.href = '/ticker/' + encodeURIComponent(items[_ddIdx].dataset.ticker); return; }
        if (this.value.trim()) {
          var v = this.value.trim().toUpperCase();
          this.value = ''; ddClose();
          window.location.href = '/ticker/' + encodeURIComponent(v);
        }
      }
    });
    if (scholarBar) scholarBar.addEventListener('click', function(){ barInput.focus(); });

    // ⌘K / Ctrl+K → focus the search bar (matches dashboard convention).
    document.addEventListener('keydown', function(e){
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); barInput.focus(); }
    });
  };
})();
