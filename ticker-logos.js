/* ─────────────────────────────────────────────────────────────────────────────
   MARKET PRISM — TICKER LOGO SYSTEM
   Google Favicon API (free, no key needed).
   Covers every ticker element across all four pages.
   ───────────────────────────────────────────────────────────────────────────── */

var MP_DOMAINS = {
  // Semiconductors
  NVDA:'nvidia.com',AMD:'amd.com',INTC:'intel.com',AVGO:'broadcom.com',
  QCOM:'qualcomm.com',TSM:'tsmc.com',MRVL:'marvell.com',AMAT:'appliedmaterials.com',
  LRCX:'lamresearch.com',TXN:'ti.com',SNPS:'www.synopsys.com',CDNS:'cadence.com',
  MU:'micron.com',ARM:'arm.com',SMCI:'supermicro.com',
  // Software / Cloud
  AAPL:'apple.com',MSFT:'microsoft.com',GOOGL:'google.com',META:'meta.com',
  AMZN:'amazon.com',ADBE:'adobe.com',CRM:'salesforce.com',ORCL:'oracle.com',
  NFLX:'netflix.com',INTU:'intuit.com',NOW:'servicenow.com',WDAY:'workday.com',
  PANW:'panw.com',CRWD:'crowdstrike.com',PLTR:'palantir.com',
  IBM:'ibm.com',HPQ:'hp.com',DELL:'dell.com',MSTR:'microstrategy.com',
  SHOP:'shopify.com',SNOW:'snowflake.com',SQ:'squareup.com',
  // Consumer Tech / Social
  SPOT:'spotify.com',RDDT:'reddit.com',SNAP:'snap.com',RBLX:'roblox.com',
  TTWO:'take2games.com',COIN:'coinbase.com',HOOD:'robinhood.com',SOFI:'sofi.com',
  DASH:'doordash.com',UBER:'uber.com',ABNB:'airbnb.com',BKNG:'booking.com',
  OPEN:'opendoor.com',PTON:'onepeloton.com',GME:'gamestop.com',DJT:'tmtgcorp.com',
  // Finance
  JPM:'jpmorganchase.com',GS:'goldmansachs.com',V:'visa.com',MA:'mastercard.com',
  WFC:'wellsfargo.com',BAC:'bankofamerica.com',MS:'morganstanley.com',
  PYPL:'paypal.com','BRK.B':'brk.com',OWL:'blueowl.com',
  // Consumer / Retail
  COST:'costco.com',WMT:'walmart.com',TGT:'target.com',HD:'homedepot.com',
  LOW:'lowes.com',MCD:'mcdonalds.com',SBUX:'starbucks.com',NKE:'nike.com',
  CMG:'chipotle.com',KO:'coca-cola.com',PEP:'pepsico.com',GIS:'generalmills.com',
  KHC:'kraftheinz.com',MDLZ:'mondelezinternational.com',TSN:'tysonfoods.com',
  BUD:'ab-inbev.com',BYND:'beyondmeat.com',KVUE:'kenvue.com',
  // Healthcare / Pharma
  JNJ:'jnj.com',LLY:'lilly.com',PFE:'pfizer.com',MRK:'merck.com',
  ABBV:'abbvie.com',UNH:'unitedhealthgroup.com',DHR:'investors.danaher.com',
  TMO:'thermofisher.com',ABT:'abbott.com',NVO:'novonordisk.com',
  HIMS:'forhims.com',IBRX:'immunitybio.com',NBIS:'nebius.com',
  // Auto / Transport
  TSLA:'tesla.com',GM:'gm.com',F:'ford.com',RIVN:'rivian.com',NIO:'nio.com',
  LCID:'lucidmotors.com',TM:'toyota.com',HMC:'honda.com',RACE:'ferrari.com',
  UAL:'united.com',UPS:'ups.com',
  // Energy
  XOM:'exxonmobil.com',CVX:'chevron.com',COP:'www.conocophillips.com',
  EOG:'eogresources.com',OXY:'oxy.com',HAL:'halliburton.com',SLB:'slb.com',
  VST:'vistraenergy.com',CEG:'constellationenergy.com',NEE:'nexteraenergy.com',
  DUK:'duke-energy.com',SO:'southerncompany.com',ENPH:'enphase.com',
  FSLR:'firstsolar.com',OKLO:'oklo.com',SMR:'nuscalepower.com',
  CCJ:'cameco.com',LEU:'centrusenergy.com',
  // Materials / Mining
  FCX:'fcx.com',NEM:'newmont.com',GOLD:'barrick.com',AA:'alcoa.com',
  CLF:'clevelandcliffs.com',MP:'mpmaterials.com',SCCO:'southerncoppercorp.com',
  BHP:'bhp.com',RIO:'riotinto.com',VALE:'vale.com',MOS:'mosaicco.com',
  BG:'bunge.com',ADM:'adm.com',
  // Industrials
  GE:'ge.com',CAT:'caterpillar.com',DE:'deere.com',EMR:'emerson.com',
  VRT:'vertiv.com',RTX:'rtx.com',LMT:'lockheedmartin.com',BA:'boeing.com',
  URI:'unitedrentals.com',PWR:'quanta.com',MLM:'martinmarietta.com',
  VMC:'vulcanmaterials.com',WM:'wm.com',ACM:'aecom.com',
  J:'jacobs.com',TTEK:'tetratech.com',STN:'www.stantec.com',
  // Real Estate
  AMT:'americantower.com',PLD:'prologis.com',DHI:'dhi.com',
  // Utilities / Water / Chemicals
  AWK:'amwater.com',WTRG:'essential.co',CWT:'californiawater.com',
  AWR:'gswater.com',XYL:'xylem.com',PNR:'pentair.com',ECL:'ecolab.com',
  APD:'airproducts.com',LIN:'linde.com',VEOEY:'veolia.com',
  // Media
  DIS:'disney.com',CMCSA:'corporate.comcast.com',SONY:'sony.com',
  // Telecom
  VZ:'verizon.com',TMUS:'t-mobile.com',
  // Storage / Hardware
  STX:'seagate.com',WDC:'westerndigital.com',
  // Misc
  ASTS:'ast-science.com',
  // ETF
  SPY:'ssga.com',
  // ── Newer coverage tickers ──
  DDOG:'datadoghq.com',NET:'cloudflare.com',ZM:'zoom.us',DOCU:'docusign.com',
  PINS:'pinterest.com',LYFT:'lyft.com',FDX:'fedex.com',HON:'honeywell.com',PG:'pg.com',
  ALAB:'asteralabs.com',ANET:'arista.com',APLD:'applieddigital.com',ASML:'asml.com',
  CLS:'celestica.com',COHR:'coherent.com',CRDO:'credosemi.com',CRWV:'coreweave.com',
  CIEN:'ciena.com',KLAC:'kla.com',LITE:'lumentum.com',NOK:'nokia.com',SKHY:'skhynix.com',
  ERIC:'ericsson.com',DLR:'digitalrealty.com',EQIX:'equinix.com',IRM:'ironmountain.com',
  APP:'applovin.com',PATH:'uipath.com',SOUN:'soundhound.com',IONQ:'ionq.com',
  RGTI:'rigetti.com',QUBT:'quantumcomputinginc.com',TEM:'tempus.com',
  CIFR:'ciphermining.com',WULF:'terawulf.com',AFRM:'affirm.com',KLAR:'klarna.com',
  DKNG:'draftkings.com',CVNA:'carvana.com',CELH:'celsius.com',RUM:'rumble.com',
  SECZ:'securitize.io',BABA:'alibabagroup.com',BIDU:'baidu.com',PDD:'temu.com',
  RKLB:'rocketlabusa.com',LUNR:'intuitivemachines.com',SPCX:'spacex.com',IRDM:'iridium.com',
  JOBY:'jobyaviation.com',HWM:'howmet.com',BE:'bloomenergy.com',CVE:'cenovus.com',
  SU:'suncor.com',PSX:'phillips66.com',DINO:'hfsinclair.com',ECO:'okeanisecotankers.com',
  INSW:'intlseas.com',TNK:'teekay.com',ETN:'eaton.com',GEV:'gevernova.com',
  FERG:'ferguson.com',FIX:'comfortsystemsusa.com',MOD:'modine.com',XPO:'xpo.com',
  CRS:'carpentertechnology.com',BSP:'trimble.com',ISRG:'intuitive.com',T:'att.com',
};

var LOGO_COLORS = [
  ['rgba(26,110,255,.18)','#5B9FFF'],['rgba(0,229,180,.15)','#00C49A'],
  ['rgba(239,159,39,.15)','#D4A020'],['rgba(255,107,107,.15)','#FF7070'],
  ['rgba(123,97,255,.15)','#9F87FF'],['rgba(0,194,255,.14)','#00B8E8'],
];
function _logoColorIdx(t){return(t.charCodeAt(0)+t.charCodeAt(t.length-1))%LOGO_COLORS.length;}

/* Returns a Google Favicon URL or null */
function mpLogoUrl(ticker, size) {
  var d = MP_DOMAINS[ticker];
  return d ? 'https://www.google.com/s2/favicons?domain=' + d + '&sz=' + (size || 64) : null;
}

/* Builds an <img> element, returns null if no domain */
function mpLogoImg(ticker, px) {
  var url = mpLogoUrl(ticker, Math.max((px || 20) * 2, 64)); // 2x for retina
  if (!url) return null;
  var img = document.createElement('img');
  img.src = url;
  img.alt = ticker;
  img.className = 'mp-logo-img';
  img.style.cssText = 'width:' + (px||20) + 'px;height:' + (px||20) + 'px;object-fit:contain;flex-shrink:0;border-radius:3px;display:block;';
  img.onerror = function() {
    var lc = LOGO_COLORS[_logoColorIdx(ticker)];
    var fb = document.createElement('span');
    fb.className = 'mp-logo-img';
    fb.style.cssText = 'width:'+(px||20)+'px;height:'+(px||20)+'px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:'+Math.max(Math.round((px||20)*0.42),7)+'px;font-weight:600;font-family:var(--font-body,sans-serif);background:'+lc[0]+';color:'+lc[1]+';line-height:1;letter-spacing:.01em;';
    fb.textContent = ticker.length<=3?ticker:ticker.slice(0,3);
    if (this.parentNode) this.parentNode.replaceChild(fb, this);
  };
  return img;
}

/* Wraps an element's content with logo + text in a flex row.
   Skips if already has a logo or ticker looks invalid. */
function injectLogo(el, px) {
  if (!el || el.querySelector('.mp-logo-img')) return;
  var ticker = (el.dataset.ticker || el.textContent || '').trim().replace(/[^A-Z0-9\.]/g,'');
  if (!ticker || ticker.length > 6) return;
  var logo = mpLogoImg(ticker, px || 16);
  if (!logo) return;
  el.style.display = 'inline-flex';
  el.style.alignItems = 'center';
  el.style.gap = '5px';
  el.insertBefore(logo, el.firstChild);
}

/* ─── PAGE-SPECIFIC INJECTION MAPS ──────────────────────────────────────────
   Each entry: [CSS selector, logo size in px]
   ─────────────────────────────────────────────────────────────────────────── */
var INJECT_MAP = [
  // _home.html
  ['.tk-s',            14],  // ticker tape
  ['.dp-card-ticker',  16],  // dashboard mini cards
  ['.dp-ticker',       24],  // ticker detail preview hero

  // _home.html + _template.html
  ['.tc-ticker',       16],  // trading card ticker label

  // _template.html (daily briefing)
  ['.dpi-tk',          14],  // instrument strip (SPY, QQQ, VIX etc)
  ['.daily-otk',       14],  // options table tickers
  ['.daily-ntk',       14],  // news feed tickers
  ['.snap-sym',        14],  // snapshot table tickers
  ['.lh-ticker',       14],  // love/hate ticker badges
  ['.slot-ticker',     14],  // video slot tickers
  ['.tc-card-exp-ticker', 18], // expanded trading card ticker

  // _ticker.html
  ['.hero-ticker',     28],  // main ticker hero heading
  ['.nav-ticker',      14],  // sidebar/nav ticker breadcrumb
  ['.par-ticker',      14],  // peer comparisons
  ['.tk-feed-ticker',  14],  // story feed ticker header

  // _heatmap.html
  ['.cell-ticker',     12],  // heatmap cell ticker
  ['.tt-ticker',       18],  // heatmap tooltip ticker

  // Universal catch-all
  ['[data-ticker]',    16],
];

function mpInjectAll() {
  var seen = new WeakSet();
  INJECT_MAP.forEach(function(entry) {
    var sel = entry[0], px = entry[1];
    document.querySelectorAll(sel).forEach(function(el) {
      if (seen.has(el)) return;
      seen.add(el);
      injectLogo(el, px);
    });
  });
}

/* ─── MUTATION OBSERVER — catches dynamically rendered tickers ───────────── */
var _observer = new MutationObserver(function(mutations) {
  var dirty = false;
  mutations.forEach(function(m) {
    if (m.addedNodes.length) dirty = true;
  });
  if (dirty) mpInjectAll();
});

function mpStart() {
  mpInjectAll();
  _observer.observe(document.body, { childList: true, subtree: true });
}

/* ─── BOOT ───────────────────────────────────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mpStart);
} else {
  mpStart();
}

/* Expose globally for manual calls after dynamic renders */
window.mpInjectAll  = mpInjectAll;
window.mpLogoUrl    = mpLogoUrl;
window.mpLogoImg    = mpLogoImg;
window.MP_DOMAINS   = MP_DOMAINS;
