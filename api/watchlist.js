// Per-user ticker watchlist endpoint. Backed by public.user_watchlists with
// RLS (auth.uid() = user_id), so we proxy each call to Supabase REST using
// the caller's JWT — RLS does the security work.
//
//   GET    /api/watchlist                → list this user's saved tickers
//   POST   /api/watchlist  { ticker }    → add (idempotent; 200 if exists)
//   DELETE /api/watchlist?ticker=NVDA    → remove
//
// Access: ANY logged-in user — subscribed or not. The watchlist is a
// free perk of having an account, so we call requireAuth with
// { subscriptionOptional: true }, which skips the subscription gate while
// still requiring a valid Supabase session (mp_session JWT). RLS
// (auth.uid() = user_id) does the per-user security. Beta-cookie-only
// callers have no JWT/user_id, so there's no row for them — they get 403.
//
// Errors:
//   401 { error: 'login_required' }         — no session
//   403 { error: 'watchlist_requires_login' } — beta-cookie-only, no user_id
//   400 { error: 'invalid_ticker' }         — bad shape
//   500 { error: 'server_error', detail }   — Supabase / config blew up

const requireAuth = require('./_require-auth');
const rateLimit   = require('./_rate-limit');

const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON || '';

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

function sendJson(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function normalizeTicker(raw){
  const t = String(raw || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  return TICKER_RE.test(t) ? t : null;
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

async function supabaseGetList(userId, jwt){
  const url = `${SUPABASE_URL}/rest/v1/user_watchlists`
    + `?select=ticker,added_at,note`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + `&order=added_at.desc`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${jwt}` }
  });
  if (!r.ok) throw new Error('supabase_select_failed:' + r.status);
  return await r.json();
}

async function supabaseInsert(userId, ticker, jwt){
  const url = `${SUPABASE_URL}/rest/v1/user_watchlists`
    + `?on_conflict=user_id,ticker`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation'
    },
    body: JSON.stringify([{ user_id: userId, ticker }])
  });
  if (!r.ok) throw new Error('supabase_insert_failed:' + r.status);
  return await r.json();
}

async function supabaseDelete(userId, ticker, jwt){
  const url = `${SUPABASE_URL}/rest/v1/user_watchlists`
    + `?user_id=eq.${encodeURIComponent(userId)}`
    + `&ticker=eq.${encodeURIComponent(ticker)}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${jwt}` }
  });
  if (!r.ok) throw new Error('supabase_delete_failed:' + r.status);
}

module.exports = async (req, res) => {
  if (!rateLimit(req, res, 'watchlist', 120)) return;

  if (!SUPABASE_URL || !SUPABASE_ANON) {
    return sendJson(res, 500, { error: 'server_error', detail: 'supabase_not_configured' });
  }

  const method = (req.method || 'GET').toUpperCase();

  // Watchlist is open to ANY logged-in user, subscribed or not — it's a free
  // account perk. subscriptionOptional skips the sub gate but still requires a
  // valid Supabase session; RLS handles per-user isolation.
  const auth = await requireAuth(req, res, { jsonOnly: true, subscriptionOptional: true });
  if (!auth) return; // requireAuth already responded with 401

  const user = auth.user;
  const jwt  = auth.jwt;
  if (!user || !jwt) {
    // Beta-cookie-only callers have no JWT and no user_id — there's no row
    // for them to read or write. Tell them politely.
    return sendJson(res, 403, { error: 'watchlist_requires_login', detail: 'beta_only_session' });
  }

  try {
    if (method === 'GET') {
      const rows = await supabaseGetList(user.id, jwt);
      return sendJson(res, 200, { items: rows });
    }

    if (method === 'POST') {
      const body = await parseJsonBody(req);
      const ticker = normalizeTicker(body && body.ticker);
      if (!ticker) return sendJson(res, 400, { error: 'invalid_ticker' });
      await supabaseInsert(user.id, ticker, jwt);
      return sendJson(res, 200, { ok: true, ticker });
    }

    if (method === 'DELETE') {
      const url = new URL(req.url, 'http://localhost');
      const ticker = normalizeTicker(url.searchParams.get('ticker'));
      if (!ticker) return sendJson(res, 400, { error: 'invalid_ticker' });
      await supabaseDelete(user.id, ticker, jwt);
      return sendJson(res, 200, { ok: true, ticker });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    return sendJson(res, 500, { error: 'server_error', detail: String(err && err.message || err) });
  }
};
