// Password gate for /present (Institutional Presentation Mode).
//
// Deliberately SEPARATE from the /quant terminal gate (api/_require-quant.js)
// and from the product auth stack: a presentation password unlocks ONLY the
// /present page's data endpoint. It never unlocks /quant's feed, the
// dashboard, or ticker pages — and none of those cookies unlock /present.
//
// Mechanics mirror _require-quant.js:
//   - PRESENT_ACCESS_CODES env var: comma-separated allowlist, each entry
//     `code` (default 7d session) or `code:hours`. Case-insensitive, trimmed.
//     If unset, falls back to QUANT_ACCESS_CODES so the page works the moment
//     it deploys; set PRESENT_ACCESS_CODES to give the deck its own password.
//     If neither is set the gate is CLOSED (503).
//   - A correct code mints the mp_present cookie: `exp.sig` where sig =
//     HMAC-SHA256(secret, "mpp1." + exp). HttpOnly + Secure + SameSite=Lax.
//     The "mpp1." prefix keeps the signature distinct from the quant cookie
//     even when both gates share a signing secret.
//   - Signing secret: PRESENT_GATE_SECRET, else QUANT_GATE_SECRET, else the
//     service-role key. No secret → gate closed.

const crypto = require('crypto');

const COOKIE_NAME = 'mp_present';
const DEFAULT_TTL_HOURS = 24 * 7;
const MAX_TTL_HOURS = 24 * 30;

function secret() {
  return (
    process.env.PRESENT_GATE_SECRET ||
    process.env.QUANT_GATE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    ''
  );
}

function rawCodes() {
  return String(process.env.PRESENT_ACCESS_CODES || process.env.QUANT_ACCESS_CODES || '').trim();
}

function isConfigured() {
  return !!(rawCodes() && secret());
}

function validCodes() {
  const map = new Map();
  for (const entry of rawCodes().split(',')) {
    const trimmed = entry.trim().replace(/^["']+|["']+$/g, '');
    if (!trimmed) continue;
    const i = trimmed.lastIndexOf(':');
    let code = trimmed, hours = DEFAULT_TTL_HOURS;
    if (i > 0) {
      const h = Number(trimmed.slice(i + 1));
      if (Number.isFinite(h) && h > 0) { code = trimmed.slice(0, i); hours = h; }
    }
    hours = Math.min(hours, MAX_TTL_HOURS);
    map.set(code.toUpperCase(), Math.round(hours * 3600));
  }
  return map;
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function checkCode(input) {
  if (!input) return null;
  const norm = String(input).trim().toUpperCase();
  let ttl = null;
  for (const [code, t] of validCodes()) {
    if (timingSafeEq(norm, code)) ttl = t;
  }
  return ttl;
}

function sign(expMs) {
  return crypto.createHmac('sha256', secret()).update('mpp1.' + expMs).digest('hex');
}

function mintToken(ttlSeconds) {
  const exp = Date.now() + ttlSeconds * 1000;
  return exp + '.' + sign(exp);
}

function verifyToken(token) {
  if (!token || !secret()) return false;
  const i = String(token).indexOf('.');
  if (i <= 0) return false;
  const exp = Number(token.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return timingSafeEq(token.slice(i + 1), sign(exp));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i < 0) return;
    out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

function buildCookie(token, maxAgeSeconds) {
  return [
    COOKIE_NAME + '=' + token,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds,
  ].join('; ');
}

function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

module.exports = { COOKIE_NAME, isConfigured, checkCode, mintToken, isAuthed, buildCookie, clearCookie };
