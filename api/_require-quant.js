// Shared access-code gate for the standalone /quant terminal (institutional
// evaluation surface). Deliberately SEPARATE from the product auth stack
// (_require-auth.js / mp_session / mp_beta): a quant cookie unlocks ONLY the
// /quant page's data endpoint, never the dashboard, ticker pages, or any
// other gated route — and vice versa.
//
// Mechanics mirror api/session.js's beta-code pattern:
//   - QUANT_ACCESS_CODES env var: comma-separated allowlist, each entry
//     `code` (default 7d session) or `code:hours` for a custom session TTL.
//     Codes match case-insensitively, trimmed. If the var is unset or empty
//     the gate is CLOSED (503) — same fail-closed stance as BETA_CODES.
//     No code ever lives in the repo.
//   - A correct code mints the mq_session cookie: `exp.sig` where sig =
//     HMAC-SHA256(secret, "mq1." + exp). HttpOnly + Secure + SameSite=Lax,
//     so the browser carries it to /api/quant-data automatically and page
//     scripts can never read it.
//   - Signing secret: QUANT_GATE_SECRET if set, else the service-role key
//     (already present in this project's env). No secret → gate closed.

const crypto = require('crypto');

const COOKIE_NAME = 'mq_session';
const DEFAULT_TTL_HOURS = 24 * 7;      // 7d — sized for an evaluation window
const MAX_TTL_HOURS = 24 * 30;         // hard cap, mirrors session.js's spirit

function secret() {
  return (
    process.env.QUANT_GATE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    ''
  );
}

// True when both halves of the gate are configured (codes + signing secret).
function isConfigured() {
  return !!(String(process.env.QUANT_ACCESS_CODES || '').trim() && secret());
}

// Map of UPPERCASED code -> session TTL seconds.
function validCodes() {
  const raw = process.env.QUANT_ACCESS_CODES || '';
  const map = new Map();
  for (const entry of String(raw).split(',')) {
    // Tolerate quote-wrapped entries — a pasted `"code1","code2"` value
    // should still match the bare codes users type at the gate.
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
    // Equal-length compare against self keeps timing flat on length mismatch.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Returns the session TTL (seconds) for a valid code, or null.
function checkCode(input) {
  if (!input) return null;
  const norm = String(input).trim().toUpperCase();
  let ttl = null;
  // Constant-shape scan: compare against every entry, no early exit.
  for (const [code, t] of validCodes()) {
    if (timingSafeEq(norm, code)) ttl = t;
  }
  return ttl;
}

function sign(expMs) {
  return crypto.createHmac('sha256', secret()).update('mq1.' + expMs).digest('hex');
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

// True when the request carries a valid, unexpired quant cookie.
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
