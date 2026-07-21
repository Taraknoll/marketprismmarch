// Public email-capture endpoint — proxies the blog beta CTA and the
// signal-charts launch capture to Supabase server-side.
//
//   POST /api/signup  { list: 'beta'|'launch', email, source?, slug?, referrer? }
//
// Why a proxy: migration 20260623235031 revoked anon/authenticated INSERT
// across the public schema, so the old direct-from-browser REST inserts
// 401/403 at PostgREST even though the permissive INSERT policies still
// exist. Rather than re-granting anon INSERT (open spam surface), the
// frontend stays read-only and this route does the write with the
// service-role key behind validation + per-IP rate limiting.
//
//   list: 'beta'   → public.beta_signups   (email, source, slug, referrer, user_agent)
//   list: 'launch' → public.email_signups  (email, source)
//
// A repeat email is success (200) — "already on the list" is not an error.
//
// Errors:
//   400 { error: 'invalid_list' | 'invalid_email' }
//   429 rate-limited (per _rate-limit.js)
//   500 { error: 'server_error', detail }

const rateLimit = require('./_rate-limit');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Prefer headers mirror what the old client-side inserts sent, so duplicate
// handling matches each table's constraints (beta_signups surfaces dupes as
// 409, email_signups swallows them via ignore-duplicates).
const LISTS = {
  beta:   { table: 'beta_signups',  prefer: 'return=minimal' },
  launch: { table: 'email_signups', prefer: 'resolution=ignore-duplicates,return=minimal' }
};

function sendJson(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function cleanStr(v, max){
  if (typeof v !== 'string') return null;
  let s = '';
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    s += (code < 32 || code === 127) ? ' ' : ch; // control chars -> space
  }
  s = s.trim().slice(0, max);
  return s || null;
}

async function parseJsonBody(req){
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  // Fall back to streaming the raw body (some Vercel runtimes don't pre-parse).
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'signup', 10)) return;

  if ((req.method || '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return sendJson(res, 500, { error: 'server_error', detail: 'supabase_not_configured' });
  }

  const body = await parseJsonBody(req);
  const list = LISTS[String((body && body.list) || '')];
  if (!list) return sendJson(res, 400, { error: 'invalid_list' });

  const email = String((body && body.email) || '').trim().toLowerCase().slice(0, 320);
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'invalid_email' });

  const row = { email };
  // Omit source when blank rather than sending null: email_signups.source is
  // NOT NULL with a 'hero' default, and an explicit null would override that
  // default and fail the insert. (beta_signups.source is nullable, so omitting
  // is equally fine there.)
  const source = cleanStr(body.source, 80);
  if (source) row.source = source;
  if (list.table === 'beta_signups') {
    row.slug       = cleanStr(body.slug, 200);
    row.referrer   = cleanStr(body.referrer, 500);
    row.user_agent = cleanStr(req.headers && req.headers['user-agent'], 500);
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${list.table}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: list.prefer
      },
      body: JSON.stringify(row)
    });
    // 409 = unique-violation on a repeat email → already on the list.
    if (r.ok || r.status === 409) return sendJson(res, 200, { ok: true });
    // Log the upstream body server-side (visible in Vercel logs) but never echo
    // it to the public client — a PostgREST error body can leak table/column/
    // constraint names and permission state. Surface only the status, matching
    // the status-only detail api/watchlist.js returns.
    const upstream = (await r.text().catch(() => '')).slice(0, 300);
    console.error(`signup insert failed: table=${list.table} status=${r.status} body=${upstream}`);
    return sendJson(res, 500, { error: 'server_error', detail: `supabase_insert_failed:${r.status}` });
  } catch (err) {
    console.error('signup proxy error:', (err && err.message) || err);
    return sendJson(res, 500, { error: 'server_error', detail: 'insert_failed' });
  }
};
