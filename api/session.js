// Session cookie endpoint. Mints HttpOnly cookies that the server can read,
// since the rest of the site stores Supabase auth in localStorage only.
//
// POST { access_token }              -> verify with Supabase, set mp_session (24h)
// POST { beta:true, code, expires }  -> verify code against BETA_CODES env var,
//                                       set mp_beta for the code's TTL; returns
//                                       { ok, expires } so the client mirrors it
//                                       into localStorage 'mp-beta-expires'
// DELETE                             -> clear both cookies
//
// Security: BETA_CODES env var holds a comma-separated allowlist of valid
// codes (case-insensitive, trimmed). Each entry is `code` (defaults to the 7d
// cap) or `code:hours` for a shorter per-code window — e.g. `chart:24` for a
// 24-hour Reddit code. If BETA_CODES is unset or empty, the beta path is
// closed — fails 503 instead of granting blanket access.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON || '';

const SESSION_MAX_AGE = 60 * 60 * 24;          // 24h, mirrors client mp_auth window
const BETA_MAX_AGE_CAP = 60 * 60 * 24 * 7;     // hard cap of 7d for beta cookies

function buildCookie(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join('; ');
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 8s cap so a Supabase stall can't hang cookie-minting until the Vercel
// function times out (same budget as api/_require-auth.js).
const AUTH_FETCH_TIMEOUT_MS = 8000;

// Returns { user } on success, { user: null } on a definite rejection
// (Supabase answered and the token is bad), { user: null, unavailable: true }
// when Supabase couldn't answer (timeout, network error, 5xx, 429) — the
// handler maps `unavailable` to a retryable 503 instead of a 401, so clients
// don't mistake provider downtime for invalid credentials.
async function verifySupabaseToken(token) {
  if (!SUPABASE_URL || !SUPABASE_ANON || !token) return { user: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON,
      },
      signal: controller.signal,
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

// Parse BETA_CODES into a Map of code -> TTL (seconds). Each comma-separated
// entry is either `code` (defaults to the 7d cap) or `code:hours` to give that
// code a shorter window — e.g. `chart:24` for a 24-hour Reddit code. TTLs are
// always clamped to BETA_MAX_AGE_CAP. Codes are matched case-insensitively.
function getValidBetaCodes() {
  const raw = process.env.BETA_CODES || '';
  const map = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    let code = trimmed;
    let ttl = BETA_MAX_AGE_CAP;
    if (idx !== -1) {
      code = trimmed.slice(0, idx).trim();
      const hours = parseFloat(trimmed.slice(idx + 1));
      if (Number.isFinite(hours) && hours > 0) {
        ttl = Math.min(Math.round(hours * 3600), BETA_MAX_AGE_CAP);
      }
    }
    code = code.toLowerCase();
    if (code) map.set(code, ttl);
  }
  return map;
}

// Returns the TTL (seconds) for a valid code, or null if the code is invalid.
function betaCodeTtl(submitted) {
  const code = String(submitted || '').trim().toLowerCase();
  if (!code) return null;
  const valid = getValidBetaCodes();
  return valid.has(code) ? valid.get(code) : null;
}

module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', [clearCookie('mp_session'), clearCookie('mp_beta')]);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (body.access_token) {
    const verify = await verifySupabaseToken(body.access_token);
    if (!verify.user) {
      if (verify.unavailable) {
        return res.status(503).json({ error: 'Auth service temporarily unavailable. Please try again.', retry: true });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
    res.setHeader('Set-Cookie', buildCookie('mp_session', body.access_token, SESSION_MAX_AGE));
    return res.status(200).json({ ok: true, user_id: verify.user.id });
  }

  if (body.beta === true) {
    // Beta path is closed unless the operator has configured BETA_CODES.
    // Fails closed to prevent the previous wide-open backdoor.
    const validCodes = getValidBetaCodes();
    if (!validCodes.size) {
      return res.status(503).json({
        error: 'Beta access is not currently available. Please contact support.'
      });
    }

    const ttl = betaCodeTtl(body.code);
    if (ttl == null) {
      return res.status(401).json({ error: 'Invalid beta code.' });
    }

    // The code's configured TTL is the ceiling. If the client requests an even
    // shorter window, honor that; never let it exceed the code's TTL or the cap.
    let maxAge = ttl;
    if (body.expires) {
      const ms = new Date(body.expires).getTime() - Date.now();
      if (Number.isFinite(ms) && ms > 0) maxAge = Math.min(Math.floor(ms / 1000), ttl);
    }
    const expiresIso = new Date(Date.now() + maxAge * 1000).toISOString();
    res.setHeader('Set-Cookie', buildCookie('mp_beta', '1', maxAge));
    return res.status(200).json({ ok: true, expires: expiresIso });
  }

  return res.status(400).json({ error: 'Missing access_token or beta flag' });
};
