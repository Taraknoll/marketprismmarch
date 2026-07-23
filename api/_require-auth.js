// Shared auth gate. Every gated route (dashboard, ticker pages, heatmap,
// methodology, case studies, signal studies, etc.) runs this first. If the
// request lacks both a valid Supabase session cookie (mp_session) and the
// short-lived beta cookie (mp_beta), the request is 302'd to /login with
// ?next= preserved so login flow can return the user to where they tried to go.
//
// Env-controlled subscription enforcement (kill switch):
//   ENFORCE_SUBSCRIPTION = "true"  → require active/trialing subscription
//                                    for mp_session users (mp_beta still
//                                    bypasses, by design)
//   ENFORCE_SUBSCRIPTION = unset/"" → legacy behavior: any logged-in user passes
//   ADMIN_USER_IDS = "uuid1,uuid2"  → comma-separated UUIDs that bypass the
//                                    subscription check (use sparingly; meant
//                                    for the operator's own accounts during
//                                    rollout)
//
// Helper returns:
//   - false  -> already responded; the route handler must return immediately.
//   - { user, hasBeta, subscription } -> request is authorized; route may continue.
//
// Pattern in each route:
//   const requireAuth = require('./_require-auth');
//   module.exports = async (req, res) => {
//     const auth = await requireAuth(req, res);
//     if (!auth) return;
//     // ... existing handler
//   };
//
// JSON mode: pass { jsonOnly: true } for /api/* endpoints called via fetch().
// Unauthorized requests get JSON 401/402 instead of 302 redirects, so the
// client can react in-page (e.g. show an "Upgrade" prompt) instead of being
// bounced through /login.
//
// Provider-slowness hardening: both critical Supabase calls (token verify,
// subscription read) run under an 8s AbortController, and their failures are
// split into "definite" (Supabase answered: token bad / no subscription row)
// vs "unavailable" (timeout, network error, 5xx, 429). Degraded policy:
//   - verify unavailable       -> 302 /login?reason=auth_unavailable (jsonOnly:
//                                 503). Bounded bounce with a retry hint; the
//                                 login page suppresses its already-logged-in
//                                 auto-redirect on this flag so a user with a
//                                 live local session doesn't ping-pong
//                                 /login -> gate -> /login.
//   - subscription unavailable -> FAIL OPEN for the already-verified user
//                                 (identity is proven; don't bounce a paying
//                                 customer to /pricing because our provider is
//                                 slow). Definite "no active subscription"
//                                 still bounces to /pricing as before.

const AUTH_FETCH_TIMEOUT_MS = 8000;

function parseCookies(header){
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i < 0) return;
    out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return out;
}

// Returns { user } on success, { user: null } on a definite rejection
// (Supabase answered and the token is bad), { user: null, unavailable: true }
// when Supabase couldn't answer (timeout, network error, 5xx, 429) — callers
// use `unavailable` to avoid treating provider downtime as "logged out".
async function verifySupabaseToken(token, supabaseUrl, supabaseAnon){
  if (!supabaseUrl || !supabaseAnon || !token) return { user: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnon },
      signal: controller.signal
    });
    if (r.status >= 500 || r.status === 429) return { user: null, unavailable: true };
    if (!r.ok) return { user: null };
    const u = await r.json();
    return { user: u && u.id ? u : null };
  } catch (_e) {
    return { user: null, unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

// In-memory subscription cache, per Vercel function instance. 30-second TTL.
// Cold starts re-fetch; not a correctness issue, just a small extra hop.
// This caps the dashboard's auth-overhead on warm instances at ~50ms (one JWT
// verify) for repeat requests within 30s, instead of doubling to ~100ms with
// the new subscription fetch on every request.
const SUB_CACHE = new Map();
const SUB_CACHE_TTL_MS = 30 * 1000;

// Returns { ok, sub }. ok=true means Supabase gave a definite answer (sub may
// still be null = genuinely no subscription row); ok=false means it couldn't
// answer (timeout, network error, non-2xx) and the caller fails OPEN for an
// already-verified user. Both outcomes are cached for the TTL, so a saturated
// provider costs at most one 8s stall per user per instance per 30s window.
async function getActiveSubscription(userId, supabaseUrl, supabaseAnon, jwt){
  if (!userId || !supabaseUrl || !supabaseAnon || !jwt) return { ok: false, sub: null };
  const cached = SUB_CACHE.get(userId);
  const now = Date.now();
  if (cached && now - cached.t < SUB_CACHE_TTL_MS) return { ok: cached.ok !== false, sub: cached.sub };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    // RLS policy "Users see own subscriptions" (auth.uid() = user_id) means
    // this query returns at most the caller's own row.
    const url = `${supabaseUrl}/rest/v1/subscriptions`
      + `?select=status,current_period_end`
      + `&user_id=eq.${encodeURIComponent(userId)}`
      + `&order=current_period_end.desc.nullslast`
      + `&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: supabaseAnon, Authorization: `Bearer ${jwt}` },
      signal: controller.signal
    });
    if (!r.ok) {
      // Non-2xx here is a provider/config problem, not "no subscription" —
      // RLS denials come back as 200 with an empty array.
      SUB_CACHE.set(userId, { t: now, sub: null, ok: false });
      return { ok: false, sub: null };
    }
    const rows = await r.json();
    const sub = (rows && rows[0]) || null;
    SUB_CACHE.set(userId, { t: now, sub, ok: true });
    // Cap cache size to keep memory bounded on long-lived instances.
    if (SUB_CACHE.size > 2000) {
      const firstKey = SUB_CACHE.keys().next().value;
      if (firstKey) SUB_CACHE.delete(firstKey);
    }
    return { ok: true, sub };
  } catch (_e) {
    SUB_CACHE.set(userId, { t: now, sub: null, ok: false });
    return { ok: false, sub: null };
  } finally {
    clearTimeout(timer);
  }
}

function isAdminUser(userId){
  const raw = process.env.ADMIN_USER_IDS || '';
  if (!raw) return false;
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(userId);
}

// Self-heal: ask the Supabase edge function to query Stripe directly and
// upsert the canonical subscription row. Returns the sub-like object on
// success (active or trialing), null otherwise. Used as a last-chance rescue
// before bouncing a paying user to /pricing — covers the case where the
// Stripe webhook silently missed an event (race, misconfigured endpoint,
// dropped delivery). Capped to one attempt per user per SUB_CACHE TTL via
// the caching pattern below.
async function attemptSubscriptionRepair(supabaseUrl, supabaseAnon, jwt){
  if (!supabaseUrl || !supabaseAnon || !jwt) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${supabaseUrl}/functions/v1/repair-subscription`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': supabaseAnon,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.ok || !data.active) return null;
    return {
      status: data.status,
      current_period_end: data.current_period_end || null,
    };
  } catch (_e) {
    return null;
  }
}

function isSubscriptionActive(sub){
  if (!sub) return false;
  const status = String(sub.status || '').toLowerCase();
  if (status !== 'active' && status !== 'trialing') return false;
  // Optional belt-and-suspenders: if current_period_end is in the past,
  // treat as expired even if status hasn't been webhook-updated yet.
  if (sub.current_period_end) {
    const t = new Date(sub.current_period_end).getTime();
    if (Number.isFinite(t) && t < Date.now()) return false;
  }
  return true;
}

function sendJson(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function requireAuth(req, res, options){
  const opts = options || {};
  const jsonOnly = !!opts.jsonOnly;
  const supabaseUrl  = process.env.SUPABASE_URL  || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';
  const enforceSub   = String(process.env.ENFORCE_SUBSCRIPTION || '').toLowerCase() === 'true';

  const cookies = parseCookies(req.headers && req.headers.cookie);
  const hasBeta = cookies.mp_beta === '1';
  let authVerify = { user: null };
  if (cookies.mp_session) {
    authVerify = await verifySupabaseToken(cookies.mp_session, supabaseUrl, supabaseAnon);
  }
  const user = authVerify.user;

  // Beta cookie holders bypass the subscription check by design — beta is for
  // testers/press/operators with a valid code. (The code itself is now
  // server-validated in api/session.js, so this is no longer a wide door.)
  if (hasBeta) {
    return { user: user, hasBeta: true, subscription: null, jwt: cookies.mp_session || null };
  }

  // Logged-in path. Enforce subscription only if the kill switch is on.
  if (user) {
    if (!enforceSub || opts.subscriptionOptional) {
      // Legacy behavior — preserved while the kill switch is off so this
      // ships without locking anyone out. Also the path for routes that opt
      // in via { subscriptionOptional: true } (e.g. the watchlist), which are
      // meant to work for ANY logged-in user, subscribed or not.
      return { user: user, hasBeta: false, subscription: null, jwt: cookies.mp_session };
    }

    if (isAdminUser(user.id)) {
      return { user: user, hasBeta: false, subscription: { status: 'admin_allowlist' }, jwt: cookies.mp_session };
    }

    const subResult = await getActiveSubscription(user.id, supabaseUrl, supabaseAnon, cookies.mp_session);
    if (isSubscriptionActive(subResult.sub)) {
      return { user: user, hasBeta: false, subscription: subResult.sub, jwt: cookies.mp_session };
    }

    if (!subResult.ok) {
      // Supabase couldn't answer the subscription lookup. This user's identity
      // is already verified, so fail OPEN on the subscription check only —
      // don't bounce a (probably paying) customer to /pricing over provider
      // slowness, and skip the repair call (it hits the same stalled provider).
      // Blast radius is bounded: the 30s SUB_CACHE keeps re-checking, so the
      // paywall reasserts itself as soon as Supabase answers again.
      console.warn('[require-auth] subscription check unavailable — failing open for verified user', user.id);
      return { user: user, hasBeta: false, subscription: { status: 'unknown_degraded', degraded: true }, jwt: cookies.mp_session };
    }

    // Last-chance self-heal: ask Stripe directly. Covers the case where the
    // webhook silently missed an event and a real paying customer would
    // otherwise be wrongly bounced to /pricing.
    const repaired = await attemptSubscriptionRepair(supabaseUrl, supabaseAnon, cookies.mp_session);
    if (repaired) {
      // Populate SUB_CACHE so subsequent requests within the TTL don't
      // re-hit the repair endpoint.
      SUB_CACHE.set(user.id, { t: Date.now(), sub: repaired, ok: true });
      return { user: user, hasBeta: false, subscription: repaired, jwt: cookies.mp_session };
    }

    // Logged in but no active subscription.
    if (jsonOnly) {
      sendJson(res, 402, { error: 'subscription_required', upgrade_url: '/pricing?reason=subscription_required' });
      return false;
    }
    res.statusCode = 302;
    res.setHeader('Location', '/pricing?reason=subscription_required');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return false;
  }

  // Session cookie present but Supabase couldn't answer the verify call
  // (timeout/network/5xx) — NOT a rejected token. Redirect to /login with a
  // reason flag instead of silently treating provider downtime as "logged
  // out": the login page shows its outage banner + a retry hint, and
  // suppresses its already-logged-in auto-redirect for this flag (otherwise a
  // user with a live local session would ping-pong /login -> gate -> /login).
  if (authVerify.unavailable) {
    console.warn('[require-auth] auth verify unavailable — bounced to /login with retry hint');
    if (jsonOnly) {
      sendJson(res, 503, { error: 'auth_unavailable', retry: true });
      return false;
    }
    const nextPath = opts.next || (req.url || '/dashboard');
    res.statusCode = 302;
    res.setHeader('Location', '/login?next=' + encodeURIComponent(nextPath) + '&reason=auth_unavailable');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return false;
  }

  // Not authorized at all.
  if (jsonOnly) {
    sendJson(res, 401, { error: 'login_required' });
    return false;
  }
  const nextPath = opts.next || (req.url || '/dashboard');
  res.statusCode = 302;
  res.setHeader('Location', '/login?next=' + encodeURIComponent(nextPath));
  res.setHeader('Cache-Control', 'no-store');
  res.end();
  return false;
};
