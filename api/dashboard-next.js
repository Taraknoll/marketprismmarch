// /dashboard-next — passcode-gated NEXT-version dashboard (Narrative Weather).
// Own gate, separate from BETA_CODES: this preview unlocks ONLY this page.
// Env: DASHBOARD_NEXT_CODE (required; fails closed when unset).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'mp_next';
const MAX_AGE = 7 * 24 * 3600;

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

function hasAccess(req) {
  const code = process.env.DASHBOARD_NEXT_CODE || '';
  if (!code) return false;
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mp_next=([^;]+)/);
  return !!(m && m[1] === sha256(code));
}

function gateHtml(wrong) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>MarketPrism — Next</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=DM+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080B11;color:#F5F7FA;font-family:'Inter','DM Sans',system-ui,sans-serif}
  .card{background:#0C1018;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:40px 36px;width:min(380px,90vw);text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  h1{font-size:20px;font-weight:800;margin:0 0 6px} .sub{color:#9CA3AF;font-size:13px;margin-bottom:24px}
  .badge{display:inline-block;background:rgba(0,174,255,.12);color:#00AEFF;border:1px solid rgba(0,174,255,.3);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:.08em;margin-bottom:14px}
  input{width:100%;box-sizing:border-box;background:#181922;border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#F5F7FA;padding:12px 14px;font-size:15px;margin-bottom:12px;outline:none}
  input:focus{border-color:#00AEFF}
  button{width:100%;background:#00AEFF;color:#04121C;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer}
  .err{color:#FF4D4D;font-size:13px;margin-bottom:10px}
</style></head><body><form class="card" method="POST" action="/dashboard-next">
  <div class="badge">NEXT — PREVIEW</div>
  <h1>Narrative Weather</h1>
  <div class="sub">This version is under construction and passcode-protected.</div>
  ${wrong ? '<div class="err">Incorrect passcode.</div>' : ''}
  <input type="password" name="code" placeholder="Passcode" autofocus autocomplete="off">
  <button type="submit">Enter</button>
</form></body></html>`;
}

module.exports = async (req, res) => {
  const code = process.env.DASHBOARD_NEXT_CODE || '';
  res.setHeader('Cache-Control', 'private, no-store');
  if (!code) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('dashboard-next is locked: DASHBOARD_NEXT_CODE env var not configured.');
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let attempt = '';
    try { attempt = (JSON.parse(body).code || ''); }
    catch (e) { attempt = new URLSearchParams(body).get('code') || ''; }
    if (attempt.trim() === code.trim()) {
      res.setHeader('Set-Cookie',
        `${COOKIE}=${sha256(code)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
      res.statusCode = 302;
      res.setHeader('Location', '/dashboard-next');
      return res.end();
    }
    res.statusCode = 401;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(gateHtml(true));
  }

  if (!hasAccess(req)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(gateHtml(false));
  }

  const candidates = [
    path.join(process.cwd(), '_dashboard_next.html'),
    path.join(__dirname, '..', '_dashboard_next.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(p, 'utf8'));
    }
  }
  res.statusCode = 500;
  return res.end('template _dashboard_next.html not found');
};
