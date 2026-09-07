// Session endpoint for /present (Institutional Presentation Mode).
//
//   GET     -> { ok } — does the request carry a valid mp_present cookie?
//   POST    -> { code } body; valid password mints the HttpOnly mp_present
//              cookie for that code's TTL. Invalid → 401. Unconfigured → 503.
//   DELETE  -> clear the cookie (the page's Lock button).
//
// Passwords live ONLY in the PRESENT_ACCESS_CODES env var (falls back to
// QUANT_ACCESS_CODES) — see api/_require-present.js. Attempts are rate-limited
// hard: this is a shared-secret door, not a login form.

const rateLimit = require('./_rate-limit');
const gate = require('./_require-present');

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) { req.destroy(); resolve(null); } });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (_e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

module.exports = async (req, res) => {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET') {
    if (!rateLimit(req, res, 'present-session-get', 60)) return;
    return sendJson(res, 200, { ok: gate.isAuthed(req) });
  }

  if (method === 'DELETE') {
    if (!rateLimit(req, res, 'present-session-get', 60)) return;
    res.setHeader('Set-Cookie', gate.clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  if (!rateLimit(req, res, 'present-session-post', 10)) return;

  if (!gate.isConfigured()) {
    return sendJson(res, 503, {
      error: 'gate_not_configured',
      message: 'Access is not configured. Set PRESENT_ACCESS_CODES in the environment.'
    });
  }

  const body = await readBody(req);
  const code = body && typeof body.code === 'string' ? body.code : '';
  const ttl = gate.checkCode(code);
  if (!ttl) return sendJson(res, 401, { error: 'invalid_code' });

  res.setHeader('Set-Cookie', gate.buildCookie(gate.mintToken(ttl), ttl));
  return sendJson(res, 200, { ok: true, expiresIn: ttl });
};
