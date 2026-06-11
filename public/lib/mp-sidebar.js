// ══════════════════════════════════════════════════════════════════════════════
// Market Prism — Shared Sidebar Renderer (mp-sidebar.js)
// ══════════════════════════════════════════════════════════════════════════════
// Single source of truth for the dashboard left-nav.
//
// Pages render the same nav by including this script and calling:
//
//   MP.renderSidebar({ container: '#side-nav', mode: 'tabs' })   // dashboard
//   MP.renderSidebar({ container: '#side-nav', mode: 'links',
//                      activeTab: 'ticker' })                    // other pages
//
// To add / hide / rename a nav item: edit NAV_CONFIG below. Every page that
// uses MP.renderSidebar picks the change up automatically.
//
// Modes:
//   'tabs'  — emits <button onclick="switchTab(...)"> per item; relies on the
//             host page exposing a global switchTab(tabId, btnEl). Use only on
//             /dashboard (the SPA-style template).
//   'links' — emits <a href="/dashboard?tab=..."> per item. Use everywhere
//             else; the dashboard reads ?tab= on load and selects the tab.
// ══════════════════════════════════════════════════════════════════════════════

(function(){
  var MP = window.MP || (window.MP = {});

  // ── SVG icons (inlined, sized to 24x24, rendered at 16x16 by .nav-item svg)
  var ICONS = {
    daily:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6v-3z"/></svg>',
    leaderboard:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    insights:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    prism:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 3 3 20 21 20 12 3"/><line x1="12" y1="3" x2="7.5" y2="20"/><line x1="12" y1="3" x2="16.5" y2="20"/></svg>',
    signallab:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5"/></svg>',
    cards:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="8" height="13" rx="2"/><rect x="14" y="3" width="8" height="13" rx="2"/><path d="M6 19h12"/><path d="M10 21h4"/></svg>',
    ticker:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>',
    validation:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 5-5"/><circle cx="18" cy="9" r="1.25"/></svg>',
    search:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    help:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    sparkle:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>',
    // Brand-cyan sparkle, full opacity — used to single out a "featured" item
    // (escapes the .nav-item svg{opacity:.5} default via inline style).
    sparkleFeature:'<svg viewBox="0 0 24 24" fill="none" stroke="#4DC8F0" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="opacity:1;filter:drop-shadow(0 0 4px rgba(77,200,240,0.55));"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"/></svg>',
    sparkle2:     '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#00DE94" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"/></svg>',
    moon:         '<svg id="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/></svg>',
    sun:          '<svg id="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.25v1.5m0 16.5v1.5M4.219 4.219l1.061 1.061m13.44 13.44l1.061 1.061M2.25 12h1.5m16.5 0h1.5M4.219 19.781l1.061-1.061M18.72 5.28l1.061-1.061"/></svg>'
  };

  // ── Reusable badge style strings (matches the inline styles used historically)
  var BADGE_NEW_GREEN     = 'background:rgba(0,222,148,0.15);color:#00DE94;border-color:rgba(0,222,148,0.30);font-size:10px;letter-spacing:.06em;';
  var BADGE_NEW_TEAL_DIM  = 'background:rgba(56,200,184,0.12);color:#38C8B8;border-color:rgba(56,200,184,0.25);font-size:10px;';
  var BADGE_TESTING_AMBER = 'background:rgba(255,184,0,0.15);color:#FFB800;border-color:rgba(255,184,0,0.3);font-size:10px;letter-spacing:.06em;';

  // ── Nav definition. Edit this list to add/hide/rename items site-wide.
  // Sections are grouped by user intent (2026-06-11 IA reorg):
  //   Today            — daily-refreshed content feeds, passively consumed
  //   Research a stock — interactive tools the user drives
  //   Performance      — proof / validation of past picks
  // Badge policy: at most ONE green NEW badge across the nav at a time;
  // retire it after ~2-3 weeks. New capabilities should land as sections
  // inside existing tabs, not as new nav rows.
  var NAV_CONFIG = [
    { type:'section', label:'Today' },
    { type:'item',    tab:'daily',       label:'Daily Plays',    icon:ICONS.daily },
    { type:'item',    tab:'insights',    label:'Market Insights', icon:ICONS.insights,  badge:{ style:BADGE_NEW_GREEN, text:'NEW' } },
    { type:'item',    tab:'leaderboard', label:'Leaderboard',    icon:ICONS.leaderboard },
    { type:'item',    tab:'cards',       label:'Trading Cards',  icon:ICONS.cards },

    { type:'section', label:'Research a stock' },
    // Stock Prism opens the standalone /ticker/:ticker page (served by api/ticker.js
    // per vercel.json). Bypasses the dashboard's iframe-based ticker tab, which
    // was producing the duplicate-sidebar layout. Keeps tab:'ticker' so the
    // active-state highlight still matches when the ticker page mounts the
    // sidebar with activeTab:'ticker'.
    { type:'item',    tab:'ticker',      href:'/ticker/AAPL', label:'Stock Forensics', icon:ICONS.ticker,
                      subtitle:'Deep-dive one ticker' },
    { type:'item',    href:'/search',    label:'Narrative Lab',  icon:ICONS.sparkleFeature,
                      subtitle:'Any ticker. Any claim.',
                      tooltip:'Validate any narrative against 3.5M historical analogues — works on any US-listed ticker, not just our tracked universe.' },
    { type:'item',    tab:'signallab',   label:'Signal Lab',     icon:ICONS.signallab,
                      subtitle:'Forces & regime, one ticker' },
    { type:'item',    tab:'prism',       label:'Market Physics', icon:ICONS.prism,
                      subtitle:'Every tracked ticker, one map' },

    // Research section hidden 2026-05-01 — to restore, uncomment:
    // { type:'item', tab:'calendar', label:'Trading Calendar', icon:ICONS.calendar, badge:{ cls:'teal', text:'New', id:'nav-badge-calendar' } },
    // { type:'item', tab:'memes',    label:'Market Sharing',   icon:ICONS.memes,    badge:{ cls:'teal', text:'New', id:'nav-badge-memes' } },
    // { type:'item', tab:'scorer',   label:'Score Any Stock',  icon:ICONS.scorer,   badge:{ style:BADGE_TESTING_AMBER, text:'TESTING' } },

    { type:'section', label:'Performance' },
    { type:'item',    tab:'validation',  label:'Track Record',   icon:ICONS.validation,
                      badge:{ style:BADGE_TESTING_AMBER, text:'TESTING' },
                      tooltip:'Still in active development — expect bugs in progress as we build out the analytics.' }
  ];

  var NAV_BOTTOM = [
    { type:'item',          tab:'help', label:'Help & Account', icon:ICONS.help },
    { type:'upgrade',       href:'/pricing', label:'Upgrade plan', icon:ICONS.sparkle },
    { type:'theme-toggle' },
    { type:'back-home' },
    { type:'share-row' },
    { type:'data-sources' }
  ];

  // Where dashboard tabs are reachable from off-dashboard pages.
  var DASHBOARD_URL = '/dashboard';

  function escAttr(s){ return (s+'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  function renderBadge(b){
    if (!b) return '';
    var cls = b.cls ? ' '+b.cls : '';
    var sty = b.style ? ' style="'+escAttr(b.style)+'"' : '';
    var id  = b.id ? ' id="'+escAttr(b.id)+'"' : '';
    return '<span class="nav-item-badge'+cls+'"'+sty+id+'>'+b.text+'</span>';
  }

  function renderItem(item, mode, activeTab){
    // activeTab matches either item.tab (e.g. 'ticker', 'cards') or item.href
    // (e.g. '/search'). Lets non-tab pages mark themselves active too.
    var isActive = activeTab && (item.tab === activeTab || item.href === activeTab);
    var cls = 'nav-item' + (isActive ? ' active' : '') + (item.subtitle ? ' has-sub' : '');
    var icon = item.icon || '';
    var badge = renderBadge(item.badge);
    // Wrap label + optional subtitle in a flex column so the row stays a single
    // hit-target but reads as two lines. Keeps badge + icon vertically centered.
    var labelHtml = item.subtitle
      ? '<span class="nav-item-text"><span class="nav-item-label">'+item.label+'</span>'+
        '<span class="nav-item-sub">'+item.subtitle+'</span></span>'
      : item.label;
    var titleAttr = item.tooltip ? ' title="'+escAttr(item.tooltip)+'"' : '';

    // Explicit href (e.g., /search) wins regardless of mode.
    if (item.href){
      return '<a class="'+cls+'" href="'+escAttr(item.href)+'" style="text-decoration:none;"'+titleAttr+'>'+icon+labelHtml+badge+'</a>';
    }

    if (mode === 'tabs' && item.tab){
      return '<button class="'+cls+'" data-tab="'+escAttr(item.tab)+'" onclick="switchTab(\''+item.tab+'\',this)"'+titleAttr+'>'+icon+labelHtml+badge+'</button>';
    }

    return '<a class="'+cls+'" href="'+DASHBOARD_URL+'?tab='+escAttr(item.tab)+'" style="text-decoration:none;"'+titleAttr+'>'+icon+labelHtml+badge+'</a>';
  }

  function renderPromo(item, mode){
    var click;
    if (mode === 'tabs' && item.tab){
      click = 'onclick="switchTab(\''+item.tab+'\',document.querySelector(\'.nav-item[data-tab='+item.tab+']\'))"';
    } else {
      click = 'onclick="window.location.href=\''+DASHBOARD_URL+'?tab='+escAttr(item.tab)+'\'"';
    }
    return '<div class="nav-promo" '+click+'>'+
             '<div class="nav-promo-title">'+(item.icon||'')+item.title+'</div>'+
             '<div class="nav-promo-desc">'+item.desc+'</div>'+
           '</div>';
  }

  function renderUpgrade(item){
    return '<a href="'+escAttr(item.href)+'" class="nav-upgrade">'+(item.icon||'')+item.label+'</a>';
  }

  function renderThemeToggle(){
    return '<button class="theme-toggle-btn" id="theme-toggle" onclick="if(typeof toggleTheme===\'function\')toggleTheme()">'+
             ICONS.moon + ICONS.sun +
             '<span id="theme-label">Light mode</span>'+
           '</button>';
  }

  function renderBackHome(){
    return '<a href="/">← Back to home</a>';
  }

  function renderShareRow(){
    var shareTitle = 'Market Prism — Narrative Intelligence';
    var twHover  = "this.style.color='rgba(255,255,255,0.8)'";
    var twLeave  = "this.style.color='rgba(255,255,255,0.4)'";
    var iconStyle = 'color:rgba(255,255,255,0.4);transition:color .2s;';
    var t = "window.open('https://twitter.com/intent/tweet?url='+encodeURIComponent(location.href)+'&text='+encodeURIComponent('"+shareTitle+"'),'_blank','width=550,height=420');return false;";
    var r = "window.open('https://www.reddit.com/submit?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent('"+shareTitle+"'),'_blank','width=550,height=420');return false;";
    var f = "window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(location.href),'_blank','width=550,height=420');return false;";
    return '<div style="display:flex;gap:10px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--mp-border);">'+
             '<span style="font-family:var(--font-body);font-size:10px;color:var(--mp-text-muted);letter-spacing:.04em;">Share</span>'+
             '<a href="#" onclick="'+t+'" style="'+iconStyle+'" onmouseover="'+twHover+'" onmouseout="'+twLeave+'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>'+
             '<a href="#" onclick="'+r+'" style="'+iconStyle+'" onmouseover="'+twHover+'" onmouseout="'+twLeave+'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.866-7.004 4.866-3.874 0-7.004-2.172-7.004-4.867 0-.191.016-.378.042-.531A1.745 1.745 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 000-.462.342.342 0 00-.462 0c-.545.533-1.684.73-2.512.73-.828 0-1.967-.182-2.512-.73a.345.345 0 00-.205-.095z"/></svg></a>'+
             '<a href="#" onclick="'+f+'" style="'+iconStyle+'" onmouseover="'+twHover+'" onmouseout="'+twLeave+'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>'+
           '</div>';
  }

  function renderDataSources(){
    return '<div class="nav-data-sources">Data: SEC EDGAR · Market feeds · Proprietary AI<br>Patent Pending: 63/971,470</div>';
  }

  // Canonical sidebar CSS — kept identical to _template.html's inline rules so
  // injecting here on other pages produces the same look without divergence.
  // Injected at most once (marker: <style data-mp-sidebar-css>).
  var SIDEBAR_CSS = ''+
    '.app{display:flex;min-height:100vh;}'+
    '.side-nav{position:fixed;top:0;left:0;width:248px;height:100vh;background:#FFFFFF;border-right:1px solid rgba(0,0,0,0.08);display:flex;flex-direction:column;z-index:100;overflow-y:auto;transition:transform .25s ease;}'+
    /* Mobile: hidden by default; slides in via .open. */
    '@media(max-width:767px){.side-nav{transform:translateX(-100%);}.side-nav.open{transform:translateX(0);}}'+
    '[data-theme="dark"] .side-nav{background:var(--mp-deep,#0C1018);border-right-color:var(--mp-border,rgba(255,255,255,0.06));}'+
    '.nav-logo{padding:22px 18px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--mp-border,rgba(255,255,255,0.06));text-decoration:none;flex-shrink:0;}'+
    '.nav-logo-icon{display:none;}'+
    '.nav-logo-img{height:32px;width:auto;flex-shrink:0;}'+
    '.nav-logo-img.logo-light{display:block;}'+
    '.nav-logo-img.logo-dark{display:none;}'+
    '[data-theme="light"] .nav-logo-img.logo-light{display:none;}'+
    '[data-theme="light"] .nav-logo-img.logo-dark{display:block;}'+
    '.nav-section-lbl{font-family:var(--font-body,Inter,sans-serif);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mp-text-muted,rgba(255,255,255,0.3));padding:20px 18px 8px;display:flex;align-items:center;gap:8px;}'+
    '.nav-section-lbl::after{content:"";flex:1;height:1px;background:var(--mp-border,rgba(255,255,255,0.06));}'+
    '.nav-items{padding:4px 10px;flex:1;display:flex;flex-direction:column;gap:1px;}'+
    '.nav-item{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:10px;font-size:14px;font-family:var(--font-body,Inter,sans-serif);font-weight:500;color:var(--mp-text-secondary,rgba(255,255,255,0.7));text-decoration:none;transition:all .2s cubic-bezier(0.16,1,0.3,1);border-left:2px solid transparent;cursor:pointer;border:none;background:none;width:100%;text-align:left;position:relative;}'+
    '.nav-item:hover{background:rgba(0,174,255,0.04);color:var(--mp-text-primary,#fff);}'+
    '.nav-item.active{background:rgba(0,174,255,0.08);color:#00AEFF;font-weight:600;border-left:2px solid #00AEFF;}'+
    '[data-theme="dark"] .nav-item:hover{background:rgba(255,255,255,0.05);}'+
    '[data-theme="dark"] .nav-item.active{background:rgba(0,174,255,0.08);color:#fff;}'+
    '.nav-item.active::before{content:"";position:absolute;inset:0;border-radius:10px;box-shadow:inset 0 0 12px rgba(232,232,227,0.04);pointer-events:none;}'+
    '.nav-item svg{width:16px;height:16px;flex-shrink:0;opacity:.5;transition:opacity .2s;}'+
    '.nav-item:hover svg{opacity:.8;}'+
    '.nav-item.active svg{opacity:1;filter:drop-shadow(0 0 3px rgba(232,232,227,0.2));}'+
    /* Two-line nav item (e.g. "Narrative Lab" + tagline). Wraps label + subtitle. */
    '.nav-item.has-sub{align-items:center;padding-top:8px;padding-bottom:8px;}'+
    '.nav-item-text{display:flex;flex-direction:column;gap:1px;min-width:0;line-height:1.2;}'+
    '.nav-item-label{font-size:14px;font-weight:500;}'+
    '.nav-item-sub{font-family:var(--font-body,Inter,sans-serif);font-size:10px;font-weight:400;color:var(--mp-text-muted,rgba(255,255,255,0.45));letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
    '.nav-item.active .nav-item-sub,.nav-item:hover .nav-item-sub{color:var(--mp-text-tertiary,#A0A8B0);}'+
    '.nav-item-badge{margin-left:auto;font-family:var(--font-body,Inter,sans-serif);font-size:10px;font-weight:500;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,0.05);color:var(--mp-text-tertiary,#A0A8B0);border:1px solid rgba(0,0,0,0.08);}'+
    '.nav-item-badge.blue{background:rgba(0,174,255,0.08);color:#00AEFF;border-color:rgba(0,174,255,0.15);}'+
    '.nav-item-badge.teal{background:rgba(0,222,148,0.08);color:#00DE94;border-color:rgba(0,222,148,0.15);font-size:10px;letter-spacing:.04em;}'+
    '[data-theme="dark"] .nav-item-badge{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.06);}'+
    '[data-theme="dark"] .nav-item-badge.blue{background:rgba(0,174,255,0.1);color:rgba(232,232,227,0.5);border-color:rgba(0,174,255,0.2);}'+
    '[data-theme="dark"] .nav-item-badge.teal{background:rgba(0,222,148,0.1);color:rgba(232,232,227,0.5);border-color:rgba(0,222,148,0.2);}'+
    '.nav-promo{margin:12px 12px 6px;padding:14px;border-radius:12px;background:linear-gradient(135deg,rgba(0,174,255,0.04),rgba(0,222,148,0.03));border:1px solid rgba(0,174,255,0.12);cursor:pointer;transition:all .2s;}'+
    '.nav-promo:hover{border-color:rgba(0,174,255,0.2);background:linear-gradient(135deg,rgba(0,174,255,0.06),rgba(0,222,148,0.04));}'+
    '[data-theme="dark"] .nav-promo{background:linear-gradient(135deg,rgba(232,232,227,0.04),rgba(232,232,227,0.03));border-color:rgba(232,232,227,0.1);}'+
    '[data-theme="dark"] .nav-promo:hover{border-color:rgba(232,232,227,0.18);}'+
    '.nav-promo-title{font-family:var(--font-body,Inter,sans-serif);font-size:12px;font-weight:600;color:var(--mp-text-primary,#fff);margin-bottom:4px;display:flex;align-items:center;gap:6px;}'+
    '.nav-promo-desc{font-family:var(--font-body,Inter,sans-serif);font-size:11px;color:var(--mp-text-tertiary,#A0A8B0);line-height:1.4;}'+
    '.nav-bottom{padding:10px 12px 14px;border-top:1px solid var(--mp-border,rgba(255,255,255,0.06));display:flex;flex-direction:column;gap:6px;}'+
    '.nav-bottom a{font-size:11px;color:var(--mp-text-tertiary,#A0A8B0);text-decoration:none;transition:color .12s;padding:2px 6px;}'+
    '.nav-bottom a:hover{color:var(--mp-text-secondary,rgba(255,255,255,0.7));}'+
    '.nav-data-sources{padding:6px 8px;margin:4px 0;font-family:var(--font-body,Inter,sans-serif);font-size:10px;letter-spacing:.06em;color:var(--mp-text-tertiary,#A0A8B0);line-height:1.6;border-top:1px solid var(--mp-border,rgba(255,255,255,0.06));padding-top:10px;}'+
    '.nav-upgrade{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;margin:0 0 6px;background:linear-gradient(135deg,rgba(123,97,255,0.06),rgba(0,174,255,0.04));border:1px solid rgba(123,97,255,0.15);font-family:var(--font-body,Inter,sans-serif);font-size:12px;font-weight:500;color:var(--mp-text-primary,#fff);text-decoration:none;transition:all .2s;cursor:pointer;}'+
    '.nav-upgrade:hover{border-color:rgba(123,97,255,0.25);background:linear-gradient(135deg,rgba(123,97,255,0.10),rgba(0,174,255,0.06));}'+
    '[data-theme="dark"] .nav-upgrade{background:linear-gradient(135deg,rgba(232,232,227,0.05),rgba(232,232,227,0.03));border-color:rgba(232,232,227,0.12);color:rgba(255,255,255,0.85);}'+
    '[data-theme="dark"] .nav-upgrade:hover{border-color:rgba(232,232,227,0.2);color:#fff;}'+
    '.nav-upgrade svg{width:14px;height:14px;opacity:.7;}'+
    '@media(min-width:768px){.side-nav ~ .main, .side-nav ~ .main-content{margin-left:248px;}}'+
    '@media(max-width:767px){.nav-overlay.open{display:block;}}';

  function injectStylesOnce(){
    if (document.querySelector('style[data-mp-sidebar-css]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-mp-sidebar-css','');
    s.textContent = SIDEBAR_CSS;
    document.head.appendChild(s);
  }

  MP.renderSidebar = function(opts){
    opts = opts || {};
    var container = (typeof opts.container === 'string') ? document.querySelector(opts.container) : opts.container;
    if (!container) return;
    var mode = opts.mode || 'links';
    var activeTab = opts.activeTab || null;
    if (opts.injectStyles !== false) injectStylesOnce();

    var html = ''+
      '<a href="/" class="nav-logo">'+
        '<img class="nav-logo-img logo-light" src="/assets/Market-Prism-Logo-Light.png" alt="Market Prism">'+
        '<img class="nav-logo-img logo-dark" src="/assets/Market-Prism-Logo-Dark.png" alt="Market Prism">'+
      '</a>'+
      '<div class="nav-items">';

    NAV_CONFIG.forEach(function(item){
      if (item.type === 'section')      html += '<div class="nav-section-lbl">'+item.label+'</div>';
      else if (item.type === 'item')    html += renderItem(item, mode, activeTab);
      else if (item.type === 'promo')   html += renderPromo(item, mode);
    });

    html += '</div><div class="nav-bottom">';

    NAV_BOTTOM.forEach(function(item){
      if (item.type === 'item')              html += renderItem(item, mode, activeTab);
      else if (item.type === 'upgrade')      html += renderUpgrade(item);
      else if (item.type === 'theme-toggle') html += renderThemeToggle();
      else if (item.type === 'back-home')    html += renderBackHome();
      else if (item.type === 'share-row')    html += renderShareRow();
      else if (item.type === 'data-sources') html += renderDataSources();
    });

    html += '</div>';

    container.innerHTML = html;
    if (!container.classList.contains('side-nav')) container.classList.add('side-nav');
    if (!container.id) container.id = 'side-nav';
  };

  // Expose config for diagnostics / future tooling.
  MP.NAV_CONFIG = NAV_CONFIG;
})();
