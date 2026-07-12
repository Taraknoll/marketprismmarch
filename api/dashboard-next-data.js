// /dashboard-next-data — aggregated payload for the NEXT dashboard.
// Gated by the same mp_next passcode cookie as /dashboard-next (NOT the site
// beta cookie — this preview is isolated). Service-role key stays server-side;
// the browser only ever sees this JSON.
const crypto = require('crypto');

const SUPA = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function hasAccess(req) {
  const code = process.env.DASHBOARD_NEXT_CODE || '';
  if (!code) return false;
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mp_next=([^;]+)/);
  return !!(m && m[1] === sha256(code));
}

async function sfetch(q) {
  const r = await fetch(`${SUPA}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status} on ${q.split('?')[0]}`);
  return r.json();
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json');
  if (!hasAccess(req)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  try {
    const latest = await sfetch('narrative_scorecard?select=snapshot_date&order=snapshot_date.desc&limit=1');
    const date = latest[0] && latest[0].snapshot_date;
    if (!date) throw new Error('no scorecard rows');

    const [rows, cfg, ec] = await Promise.all([
      sfetch(`narrative_scorecard?select=ticker,verdict,verdict_confidence,walsh_regime,wks_score,narrative_mass,drift_score,coordination_score,coordination_class,suspicion_class,fvd_pct,vms,srs,nrs,narrative_tone,current_price&snapshot_date=eq.${date}&limit=500`),
      sfetch('ticker_valuation_config?select=ticker,sector&active=eq.true&limit=500'),
      sfetch(`earnings_context?select=ticker,days_to_earnings&snapshot_date=eq.${date}&limit=500`),
    ]);

    const secOf = {}; cfg.forEach((c) => { secOf[c.ticker] = c.sector || 'Other'; });
    const d2eOf = {}; ec.forEach((e) => { d2eOf[e.ticker] = num(e.days_to_earnings); });

    const tickers = rows.map((r) => {
      const conf = num(r.verdict_confidence);
      const ember = r.walsh_regime === 'EXHAUSTING' && conf !== null && conf >= 55;
      return {
        t: r.ticker,
        sec: secOf[r.ticker] || 'Other',
        v: r.verdict, conf,
        regime: r.walsh_regime,
        wks: num(r.wks_score), mass: num(r.narrative_mass),
        drift: num(r.drift_score), coord: num(r.coordination_score),
        coordCls: r.coordination_class, suspCls: r.suspicion_class,
        fvd: num(r.fvd_pct), vms: num(r.vms), srs: num(r.srs), nrs: num(r.nrs),
        tone: r.narrative_tone, price: num(r.current_price),
        d2e: d2eOf[r.ticker] !== undefined ? d2eOf[r.ticker] : null,
        ember,
      };
    });

    const bySec = {};
    tickers.forEach((x) => {
      const s = (bySec[x.sec] = bySec[x.sec] || { name: x.sec, n: 0, wksSum: 0, wksN: 0, embers: 0, exhausting: 0, traps: 0, risks: 0 });
      s.n += 1;
      if (x.wks !== null) { s.wksSum += x.wks; s.wksN += 1; }
      if (x.ember) s.embers += 1;
      if (x.regime === 'EXHAUSTING') s.exhausting += 1;
      if (x.v === 'Narrative Trap') s.traps += 1;
      if (x.v === 'Narrative Risk') s.risks += 1;
    });
    const sectors = Object.values(bySec)
      .map((s) => ({ name: s.name, n: s.n, wks: s.wksN ? +(s.wksSum / s.wksN).toFixed(2) : null, embers: s.embers, exhausting: s.exhausting, traps: s.traps, risks: s.risks }))
      .sort((a, b) => (b.wks ?? -999) - (a.wks ?? -999));

    res.statusCode = 200;
    res.end(JSON.stringify({ date, count: tickers.length, sectors, tickers }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
