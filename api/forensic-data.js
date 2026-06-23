// api/forensic-data.js
// Per-ticker Forensic Dossier data aggregator for the /forensic page.
// Reads the forensic-engine views server-side with the service-role key (some
// are RLS-locked from anon) and returns ONE JSON blob the page renders. Every
// section is independently null-guarded so empty sections collapse, never break.
//
// PERF: v_claim_evidence_match is a heavy full-text-match view (~70s, not
// ticker-prunable) so it is NEVER in the blocking path — the page lazy-loads it
// via ?section=claims. Every other fetch is time-bounded so one slow/hung
// dependency (incl. the optional external Massive call) can't stall the page.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (|| SUPABASE_KEY),
//      MASSIVE_API_KEY (|| MASSIVE_API || POLYGON_API_KEY) [optional]
// Query: ticker (required); section=claims (optional, lazy claim-evidence only)

const rateLimit = require('./_rate-limit');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'forensic-data', 60)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const ticker = (url.searchParams.get('ticker') || '')
      .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
    const section = (url.searchParams.get('section') || '').toLowerCase();
    if (!ticker) return sendJson(res, 400, { error: 'Missing ticker' });

    const SUPA = process.env.SUPABASE_URL || '';
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!SUPA || !KEY) return sendJson(res, 500, { error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).' });

    const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, Accept: 'application/json' };
    const T = encodeURIComponent(ticker);

    // Time-bounded fetch: a non-ok / timed-out response yields [] for THAT
    // section instead of stalling the whole payload.
    const restT = (path, ms) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), ms || 7000);
      return fetch(SUPA + '/rest/v1/' + path, { headers: H, signal: ac.signal })
        .then(r => (r.ok ? r.json() : []))
        .catch(() => [])
        .finally(() => clearTimeout(t));
    };
    const rest = (path) => restT(path, 7000);
    const one = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

    // ── Lazy claim-evidence sub-request (isolated; heavy view) ──────────────
    // Only ticker-keyed. Long cache so once computed it's instant on repeat.
    if (section === 'claims') {
      // mv_claim_evidence_match = materialized v_claim_evidence_match (idx on
      // ticker,match_rank) — ~1.5ms vs ~70s for the live view; refreshed nightly
      // by pg_cron job 'refresh-mv-claim-evidence' (07:00 UTC, CONCURRENTLY).
      const ce = await restT(
        'mv_claim_evidence_match?select=claim_id,snapshot_date,claim_excerpt,claim_type,consensus_direction,paper_title,source,source_url,year,match_score,match_rank' +
        '&ticker=eq.' + T + '&match_rank=lte.5&order=snapshot_date.desc,match_rank.asc&limit=40',
        8000
      );
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return sendJson(res, 200, { ticker: ticker, claim_evidence: Array.isArray(ce) ? ce : [] });
    }

    // 1) Header / hero (one row/cik) — also resolves the cik for cik-keyed views.
    const headerRow = one(await restT(
      'v_xbrl_redflag_latest_plus?select=cik,ticker,company_name,fiscal_year,filed_date,is_delisted,' +
      'beneish_m,accruals_ratio,piotroski_f,altman_z,ohlson_p,gw_intangibles_pct,cfo_ni_gap,' +
      'negative_equity,cash_burn,red_flag_count,red_flag_bits,composite_severity,coverage_pct,is_adjudicable,' +
      'has_restatement,has_auditor_change,has_late_filing,last_restatement,last_auditor_change,last_late_filing,' +
      'regulatory_event_count,regulatory_red_flags&ticker=eq.' + T + '&limit=1', 7000
    ));
    if (!headerRow) return sendJson(res, 404, { error: 'No forensic record', ticker });
    const cik = headerRow.cik;
    const C = encodeURIComponent(String(cik));

    // Optional company profile (server-side key only; never sent to client).
    // Parallelized with the Supabase reads + its own short timeout.
    const MKEY = process.env.MASSIVE_API_KEY || process.env.MASSIVE_API || process.env.POLYGON_API_KEY || '';
    const profilePromise = MKEY ? (function () {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      return fetch('https://api.polygon.io/v3/reference/tickers/' + T + '?apiKey=' + encodeURIComponent(MKEY), { signal: ac.signal })
        .then(r => (r.ok ? r.json() : null)).catch(() => null).finally(() => clearTimeout(t));
    })() : Promise.resolve(null);

    // 2..N) independent sections in parallel (claims is NOT here — lazy-loaded)
    const [factorsArr, timeline, regRows, peerSelfArr, scorecardArr, fvArr, earnArr, research, profileJson] = await Promise.all([
      rest('xbrl_forensic_factors?select=cik,fiscal_year,fy_end_date,filed_date,beneish_m,beneish_flag,dsri,gmi,aqi,sgi,depi,sgai,lvgi,tata,accruals_ratio,accruals_flag,dechow_f,dechow_flag,piotroski_f,piotroski_flag,altman_z,altman_variant,altman_flag,ohlson_o,ohlson_p,ohlson_flag,gw_intangibles_pct,gw_intangibles_flag,cfo_ni_gap,cfo_ni_gap_flag,negative_equity,cash_burn,interest_coverage,coverage_flag,net_debt_ebitda,leverage_flag,dilution_intensity,dilution_flag,cash_runway_years,red_flag_count,red_flag_applic,red_flag_bits,composite_severity,coverage_pct,is_adjudicable&cik=eq.' + C + '&order=fiscal_year.desc&limit=1'),
      rest('v_xbrl_factor_timeline?select=fiscal_year,fy_end_date,red_flag_count,composite_severity,altman_z,accruals_ratio,beneish_m,piotroski_f,cfo_ni_gap,negative_equity,cash_burn,dilution_intensity&cik=eq.' + C + '&fiscal_year=gte.2012&fiscal_year=lte.2026&order=fiscal_year.asc'),
      rest('fdq_outcome_labels?select=label,event_date,form_type,item_code,accession,evidence_url,detected_by&cik=eq.' + C + '&order=event_date.desc'),
      rest('v_forensic_peers?select=cik,ticker,company_name,red_flag_count,flag_key,cohort_size,n_restated,n_auditor_change,n_late_filing,pct_cohort_restated&cik=eq.' + C + '&limit=1'),
      rest('narrative_scorecard?select=ticker,snapshot_date,verdict,nrs,drift_score,fvd,fvd_pct,coordination_score,coordination_class,suspicion_score,suspicion_class,vms,srs,ccp,npi&ticker=eq.' + T + '&order=snapshot_date.desc&limit=1'),
      rest('daily_fair_value?select=ticker,snapshot_date,fair_value,fv_low,fv_high,premium_pct,premium_dollars,verdict,method,pe_used,forward_eps_used,price_close,market_cap,industry_pe_avg&ticker=eq.' + T + '&order=snapshot_date.desc&limit=1'),
      rest('earnings_context?select=ticker,snapshot_date,next_earnings_date,last_earnings_date,days_to_earnings,eps_actual,eps_estimate,earnings_surprise_pct,eps_surprise_pct,revenue_actual,revenue_estimate,revenue_surprise_pct,guidance_direction,guidance_eps_midpoint,guidance_eps_low,guidance_eps_high,guidance_revenue_midpoint,guidance_date,guidance_fiscal_period&ticker=eq.' + T + '&order=snapshot_date.desc&limit=1'),
      // Research library: ticker-keyed (sub_sector = the symbol). Exclude the
      // bulk-scraped empirical/clinical rows — they're off-topic noise tagged to
      // the ticker (e.g. an AI-in-education paper under a streaming name); only
      // the curated claim_types carry vetted, on-topic key_findings.
      rest('scholarly_references?select=id,claim_type,paper_title,authors,year,source,source_url,key_finding,consensus_direction,recency_weight&sub_sector=eq.' + T + '&claim_type=not.in.(empirical_research,clinical_research,clinical_trial_reactions)&order=recency_weight.desc.nullslast,year.desc&limit=30'),
      profilePromise
    ]);

    const factors = one(factorsArr);
    const peerSelf = one(peerSelfArr);
    const scorecard = one(scorecardArr);
    const fair_value = one(fvArr);
    const earnings = one(earnArr);

    // Peer chips: other tickers sharing the exact accounting flag_key profile.
    let peerChips = [];
    if (peerSelf && peerSelf.flag_key) {
      peerChips = await rest('v_forensic_peers?select=ticker,company_name,red_flag_count&flag_key=eq.' + encodeURIComponent(peerSelf.flag_key) + '&ticker=neq.' + T + '&limit=12');
    }

    // Combined severity = noisy-OR of accounting (composite_severity 0..1) and
    // regulatory (reg flags). Softer reg denominator (/4) so accounting still
    // differentiates within the dirty cohort; 3 reg flags alone -> 0.75 (HIGH).
    const cs = (headerRow.composite_severity == null) ? 0 : Number(headerRow.composite_severity);
    const rf = (headerRow.regulatory_red_flags == null) ? 0 : Number(headerRow.regulatory_red_flags);
    const reg_norm = Math.min(rf, 3) / 4;
    const combined_risk = 1 - (1 - cs) * (1 - reg_norm);
    const combined_band = combined_risk >= 0.70 ? 'HIGH' : combined_risk >= 0.45 ? 'ELEVATED' : combined_risk >= 0.20 ? 'MODERATE' : 'LOW';

    // eps_surprise_pct mixed convention: abs<2 => fraction (x100), else already %.
    let eps_surprise_norm = null;
    if (earnings && earnings.eps_surprise_pct != null) {
      const v = Number(earnings.eps_surprise_pct);
      eps_surprise_norm = Math.abs(v) < 2 ? v * 100 : v;
    }

    // EDGAR per-event link: evidence_url is already a complete SEC URL.
    const regulatory_events = (Array.isArray(regRows) ? regRows : []).map((e) => {
      let edgar_url = e.evidence_url || null;
      if (!edgar_url) edgar_url = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + cik + '&type=&dateb=&owner=include&count=40';
      return Object.assign({}, e, { edgar_url });
    });

    // Map the optional Massive/Polygon profile (already fetched in parallel).
    let profile = null;
    if (profileJson && profileJson.results) {
      const r = profileJson.results;
      profile = {
        name: r.name || null,
        sector: r.sic_description || r.sector || null,
        market_cap: (r.market_cap != null) ? r.market_cap : null,
        total_employees: (r.total_employees != null) ? r.total_employees : null,
        description: r.description || null,
        homepage: r.homepage_url || null,
        exchange: r.primary_exchange || null
      };
    }

    const header = Object.assign({}, headerRow, {
      combined_risk: Math.round(combined_risk * 1000) / 1000,
      combined_band: combined_band
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return sendJson(res, 200, {
      ticker: ticker,
      cik: cik,
      header: header,
      factors: factors,
      timeline: Array.isArray(timeline) ? timeline : [],
      regulatory_events: regulatory_events,
      claim_evidence: null,        // lazy-loaded via ?section=claims
      claims_deferred: true,
      peers: { self: peerSelf, chips: Array.isArray(peerChips) ? peerChips : [] },
      scorecard: scorecard,
      fair_value: fair_value,
      earnings: earnings ? Object.assign({}, earnings, { eps_surprise_pct_normalized: eps_surprise_norm }) : null,
      research: Array.isArray(research) ? research : [],
      profile: profile
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unknown error' });
  }
};
