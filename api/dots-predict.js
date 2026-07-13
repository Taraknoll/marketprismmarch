// POST /api/dots-predict
// Embeds the user's narrative locally via @xenova/transformers (ONNX runtime),
// runs a pgvector similarity search against narrative_dots via the
// search_dots_by_embedding RPC, and returns an aggregated bullshit-probability
// + predicted-return forecast.
//
// Required env:
//   SUPABASE_URL                    - project URL
//   SUPABASE_SERVICE_ROLE_KEY       - service role (RPC reads narrative_dots)
//                                     falls back to SUPABASE_ANON if grant exists
//
// Required Supabase objects (apply once from sql/search_dots_by_embedding.sql):
//   - public.search_dots_by_embedding(...) returning narrative_dots rows
//   - read access for the role used by the env key

const { waitUntil } = require('@vercel/functions');

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';  // ONNX export, 384-dim
const DEFAULT_K = 200;
const MAX_AGE_DAYS = 540;

// Cached pipeline — lives across warm Vercel invocations on the same
// instance. First call cold-starts ~3-8s (downloads model weights from HF
// CDN to /tmp); subsequent calls run the embed in ~100-300ms.
let _pipePromise = null;
function getEmbedder() {
  if (_pipePromise) return _pipePromise;
  _pipePromise = (async () => {
    const t0 = Date.now();
    const tj = await import('@xenova/transformers');
    tj.env.allowLocalModels = false;
    tj.env.useFSCache = true;
    tj.env.cacheDir = '/tmp/transformers-cache';
    const pipe = await tj.pipeline('feature-extraction', EMBED_MODEL);
    console.log('[dots-predict] pipeline init took', Date.now() - t0, 'ms');
    return pipe;
  })().catch((e) => {
    _pipePromise = null;  // allow retry on next request
    throw e;
  });
  return _pipePromise;
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (_) { return Promise.resolve({}); }
  }
  return new Promise(function (resolve) {
    let data = '';
    req.on('data', function (c) { data += c; });
    req.on('end', function () {
      try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); }
    });
    req.on('error', function () { resolve({}); });
  });
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function embedQuery(text) {
  const t0 = Date.now();
  const pipe = await getEmbedder();
  // pooling:'mean' + normalize:true matches sentence-transformers/all-MiniLM-L6-v2
  // exactly — same weights, same pooling, same L2 normalization. Output is a
  // Tensor with .data: Float32Array(384).
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(result.data);
  if (vec.length !== 384) {
    throw new Error('Unexpected embedding shape (len=' + vec.length + ')');
  }
  console.log('[dots-predict] embed took', Date.now() - t0, 'ms');
  return vec;
}

async function fetchTickerContext(supabaseUrl, supabaseKey, ticker) {
  if (!ticker) return null;
  const url = supabaseUrl + '/rest/v1/rpc/get_ticker_context';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ ticker_in: ticker })
  });
  if (!r.ok) return null;
  return r.json().catch(function () { return null; });
}

async function fetchRecentNarratives(supabaseUrl, supabaseKey, ticker, n) {
  if (!ticker) return [];
  const url = supabaseUrl + '/rest/v1/rpc/get_recent_narratives';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ ticker_in: ticker, n: n || 8 })
  });
  if (!r.ok) return [];
  const j = await r.json().catch(function () { return []; });
  return Array.isArray(j) ? j : [];
}

async function searchDots(supabaseUrl, supabaseKey, queryVector, sector) {
  const url = supabaseUrl + '/rest/v1/rpc/search_dots_by_embedding';
  const body = {
    query_vector: queryVector,
    k: DEFAULT_K,
    filter_sector: sector || null,
    filter_max_age_days: MAX_AGE_DAYS
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const body = await r.text().catch(function () { return ''; });
    throw new Error('search_dots_by_embedding RPC failed (' + r.status + '): ' + body.slice(0, 300));
  }
  return r.json();
}

function aggregate(neighbors) {
  if (!Array.isArray(neighbors) || !neighbors.length) {
    return { bullshit: null, p5: null, p10: null, p20: null, weights: [], resolved: [] };
  }
  const resolved = neighbors.filter(function (n) { return n.return_5d != null; });
  if (!resolved.length) {
    return { bullshit: null, p5: null, p10: null, p20: null, weights: [], resolved: [] };
  }
  const now = Date.now();
  const weights = resolved.map(function (n) {
    const ageDays = (now - new Date(n.observed_at).getTime()) / 86400000;
    const recencyW = Math.pow(0.5, Math.max(0, ageDays) / 365);
    const sim = Math.max(0, Math.min(1, Number(n.similarity) || 0));
    const simW = sim * sim;
    return recencyW * simW;
  });
  const totalW = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
  function wMean(col) {
    let sum = 0, wSum = 0;
    for (let i = 0; i < resolved.length; i++) {
      const v = resolved[i][col];
      if (v == null || isNaN(Number(v))) continue;
      sum += Number(v) * weights[i];
      wSum += weights[i];
    }
    return wSum > 0 ? sum / wSum : null;
  }
  // Weighted p25/p75 band per horizon — mirrors dot_predictor.weighted_quantile
  // (step function, passed-in weights as the denominator so sparse-coverage
  // horizons still cross the 0.75 threshold). Feeds the aggregator's
  // in_iqr_rate calibration, which was NULL only because this band was never
  // written into response_payload.
  function wQuantile(col, q) {
    const pairs = [];
    for (let i = 0; i < resolved.length; i++) {
      const v = resolved[i][col];
      if (v == null || isNaN(Number(v))) continue;
      pairs.push([Number(v), weights[i]]);
    }
    if (!pairs.length) return null;
    const localTotal = pairs.reduce(function (a, p) { return a + p[1]; }, 0) || 1;
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    let cum = 0;
    for (let i = 0; i < pairs.length; i++) {
      cum += pairs[i][1] / localTotal;
      if (cum >= q) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  }
  function band(col) {
    const lo = wQuantile(col, 0.25);
    const hi = wQuantile(col, 0.75);
    if (lo == null || hi == null) return null;
    return [Math.round(lo * 10000) / 10000, Math.round(hi * 10000) / 10000];
  }
  return {
    bullshit: wMean('bullshit_probability'),
    p5:  wMean('return_5d'),
    p10: wMean('return_10d'),
    p20: wMean('return_20d'),
    p5_band:  band('return_5d'),
    p10_band: band('return_10d'),
    p20_band: band('return_20d'),
    weights: weights,
    resolved: resolved
  };
}

const rateLimit = require('./_rate-limit');

module.exports = async function (req, res) {
  // Cap aggressively — embeds via local ML inference + pgvector search.
  // Most expensive endpoint by CPU/mem. 20/min/IP still lets a homepage
  // visitor try ~3 narratives per minute, plenty for legit exploration.
  if (!rateLimit(req, res, 'dots-predict', 20)) return;

  const startTime = Date.now();
  // Hoisted so the catch block at the bottom can include them in failure logs.
  let body = {};
  let ticker = '';
  let narrativeText = '';
  let queryVector = null;
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON || '';
  try {
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed — POST required.' });
    }

    if (!supabaseUrl || !supabaseKey) {
      return send(res, 500, { error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).' });
    }

    body = await readBody(req);
    ticker = (body.ticker || '').toString().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
    narrativeText = (body.narrativeText || '').toString().trim();

    if (!ticker) return send(res, 400, { error: 'Missing ticker.' });
    if (!narrativeText) return send(res, 400, { error: 'Missing narrativeText.' });
    if (narrativeText.length < 10) return send(res, 400, { error: 'narrativeText too short (need at least a sentence).' });
    if (narrativeText.length > 4000) return send(res, 400, { error: 'narrativeText too long (max 4000 chars).' });

    // 1. Embed locally + fetch ticker context + recent narratives in parallel.
    //    Context and narratives are purely additive (they adorn the response,
    //    never affect retrieval); failures are silent and the search still
    //    returns.
    let context, recentNarratives;
    try {
      const [vec, ctx, recent] = await Promise.all([
        embedQuery(narrativeText),
        fetchTickerContext(supabaseUrl, supabaseKey, ticker).catch(function () { return null; }),
        fetchRecentNarratives(supabaseUrl, supabaseKey, ticker, 8).catch(function () { return []; })
      ]);
      queryVector = vec;
      context = ctx;
      recentNarratives = recent;
    } catch (e) {
      return send(res, 502, { error: 'Embedding failed: ' + (e.message || 'unknown') });
    }

    // 2. Sector hint for the embedding-search filter — use lookup_sector
    //    (from ticker_industry_lookup), which matches narrative_dots.sector
    //    format. The canonical view's sic_sector returns raw SIC titles
    //    ("SEMICONDUCTORS & RELATED DEVICES") that don't match the corpus.
    const sector = context && context.classification && context.classification.lookup_sector || null;

    // 3. RPC similarity search
    let neighbors;
    try {
      neighbors = await searchDots(supabaseUrl, supabaseKey, queryVector, sector);
    } catch (e) {
      const errMsg = e.message || 'Vector search failed.';
      const errPayload = { error: errMsg, stage: 'search_dots_rpc', sector_hint: sector || null };
      waitUntil(logSearchQuery(req, body, ticker, narrativeText, queryVector, errPayload, supabaseUrl, supabaseKey, startTime));
      return send(res, 500, { error: errMsg });
    }
    if (!neighbors || !neighbors.length) {
      const emptyResponse = {
        ticker: ticker,
        narrative_text: narrativeText,
        warning: 'no_similar_dots',
        n_similar_dots: 0,
        n_resolved_neighbors: 0,
        neighbors: [],
        context: context || null,
        recent_narratives: recentNarratives || []
      };
      waitUntil(logSearchQuery(req, body, ticker, narrativeText, queryVector, emptyResponse, supabaseUrl, supabaseKey, startTime));
      return send(res, 200, emptyResponse);
    }

    // 4. Aggregate
    const agg = aggregate(neighbors);

    // 4b. Direction-aware narrative hit rate (over neighbors with
    //     return_5d_narrative). bullish + positive residual = HIT,
    //     bearish + negative residual = HIT, neutral excluded.
    const nowMs = Date.now();
    const hitVals = [];
    const hitWeights = [];
    for (let i = 0; i < neighbors.length; i++) {
      const n = neighbors[i];
      const resid = n.return_5d_narrative;
      if (resid == null) continue;
      const dir = n.narrative_direction == null ? 'bullish' : String(n.narrative_direction).toLowerCase();
      if (dir === 'neutral') continue;
      const r = Number(resid);
      if (isNaN(r)) continue;
      const isHit = (dir === 'bearish') ? (r < 0) : (r > 0);
      const ageDays = n.observed_at ? (nowMs - new Date(n.observed_at).getTime()) / 86400000 : 365;
      const recencyW = Math.pow(0.5, Math.max(0, ageDays) / 365);
      const sim = Math.max(0, Math.min(1, Number(n.similarity) || 0));
      hitVals.push(isHit ? 1.0 : 0.0);
      hitWeights.push(recencyW * sim * sim);
    }
    let narrativeHitRate5d = null;
    let narrativeHitRateNResolved = 0;
    let narrativeHitRateConfidence = 0.0;
    if (hitVals.length > 0) {
      const totalW = hitWeights.reduce(function (s, w) { return s + w; }, 0) || 1.0;
      let wSum = 0;
      for (let i = 0; i < hitVals.length; i++) wSum += hitVals[i] * hitWeights[i];
      narrativeHitRate5d = Math.round((wSum / totalW) * 1000) / 1000;
      narrativeHitRateNResolved = hitVals.length;
      // Confidence saturates at ~80 resolved analogues. Previously /200, which
      // forced ~every search below the 35% verdict floor in computeDecision()
      // and made the Narrative Lab read "WEAK SIGNAL" universally. 80 better
      // matches the typical resolved-neighbor distribution.
      narrativeHitRateConfidence = Math.round(Math.min(hitVals.length / 80.0, 1.0) * 1000) / 1000;
    }

    // 4c. Cluster-conditional hit rate (best-effort — clusterer cron may not
    //     have populated centroids yet, in which case we silently fall back).
    let clusterId = null;
    let clusterHitRate5d = null;
    let clusterNResolved = 0;
    let clusterThesis = null;
    try {
      const rpcHeaders = {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      const nearestResp = await fetch(supabaseUrl + '/rest/v1/rpc/find_nearest_cluster', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({ query_vector: queryVector, filter_ticker: ticker })
      });
      if (nearestResp.ok) {
        const nearest = await nearestResp.json().catch(function () { return null; });
        if (Array.isArray(nearest) && nearest.length > 0 && nearest[0].cluster_id != null) {
          clusterId = nearest[0].cluster_id;
          clusterThesis = nearest[0].thesis_label || null;
          const clusterResp = await fetch(supabaseUrl + '/rest/v1/rpc/search_dots_by_embedding', {
            method: 'POST',
            headers: rpcHeaders,
            body: JSON.stringify({
              query_vector: queryVector,
              k: 100,
              filter_sector: sector || null,
              filter_max_age_days: MAX_AGE_DAYS,
              filter_cluster_id: clusterId
            })
          });
          if (clusterResp.ok) {
            const clusterNbrs = await clusterResp.json().catch(function () { return []; });
            if (Array.isArray(clusterNbrs) && clusterNbrs.length > 0) {
              const cVals = [];
              for (let j = 0; j < clusterNbrs.length; j++) {
                const cn = clusterNbrs[j];
                const cr = cn.return_5d_narrative;
                if (cr == null) continue;
                const cdir = cn.narrative_direction == null ? 'bullish' : String(cn.narrative_direction).toLowerCase();
                if (cdir === 'neutral') continue;
                const crn = Number(cr);
                if (isNaN(crn)) continue;
                const cHit = (cdir === 'bearish') ? (crn < 0) : (crn > 0);
                cVals.push(cHit ? 1.0 : 0.0);
              }
              if (cVals.length > 0) {
                const sum = cVals.reduce(function (s, v) { return s + v; }, 0);
                clusterHitRate5d = Math.round((sum / cVals.length) * 1000) / 1000;
                clusterNResolved = cVals.length;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[dots-predict] cluster lookup failed:', err && err.message || err);
    }

    const clusterBaselineDelta = (clusterHitRate5d != null && narrativeHitRate5d != null)
      ? Math.round((clusterHitRate5d - narrativeHitRate5d) * 1000) / 1000
      : null;

    // 5. Build response
    const round2 = function (v) { return v == null ? null : Math.round(Number(v) * 100) / 100; };
    const responsePayload = {
      ticker: ticker,
      narrative_text: narrativeText,
      sector_hint: sector,
      bullshit_probability: agg.bullshit == null ? null : Math.round(agg.bullshit * 100) / 100,
      narrative_hit_rate_5d:         narrativeHitRate5d,
      narrative_hit_rate_n_resolved: narrativeHitRateNResolved,
      narrative_hit_rate_confidence: narrativeHitRateConfidence,
      cluster_id:                    clusterId,
      cluster_hit_rate_5d:           clusterHitRate5d,
      cluster_n_resolved:            clusterNResolved,
      cluster_thesis_label:          clusterThesis,
      cluster_baseline_delta:        clusterBaselineDelta,
      confidence: Math.min(1, agg.resolved.length / 100),
      n_similar_dots: neighbors.length,
      n_resolved_neighbors: agg.resolved.length,
      predicted_5d_return:  round2(agg.p5),
      predicted_10d_return: round2(agg.p10),
      predicted_20d_return: round2(agg.p20),
      predicted_5d_return_p25_p75:  agg.p5_band,
      predicted_10d_return_p25_p75: agg.p10_band,
      predicted_20d_return_p25_p75: agg.p20_band,
      neighbor_examples: (function () {
        // Dedupe by (ticker, speaker, observed_at, narrative_text) so the
        // same source post indexed twice in narrative_dots doesn't render
        // back-to-back identical cards. Aggregation above is untouched.
        const seen = new Set();
        const out = [];
        for (let i = 0; i < neighbors.length && out.length < 3; i++) {
          const n = neighbors[i];
          const txt = n.narrative_text ? n.narrative_text.slice(0, 200) : '';
          const key = [n.ticker || '', n.speaker_id || '', n.observed_at || '', txt].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            ticker: n.ticker,
            narrative: txt || null,
            observed_at: n.observed_at,
            speaker: n.speaker_id,
            return_5d: n.return_5d,
            return_10d: n.return_10d,
            return_20d: n.return_20d,
            similarity: n.similarity == null ? null : Math.round(Number(n.similarity) * 100) / 100
          });
        }
        return out;
      })(),
      warning: agg.resolved.length > 0 && agg.resolved.length < 30 ? 'sparse_neighborhood' : null,
      context: context || null,
      recent_narratives: recentNarratives || [],
      updated: new Date().toISOString()
    };

    waitUntil(logSearchQuery(req, body, ticker, narrativeText, queryVector, responsePayload, supabaseUrl, supabaseKey, startTime));
    return send(res, 200, responsePayload);
  } catch (err) {
    const errMsg = (err && err.message) || 'Unknown error.';
    if (queryVector && narrativeText && ticker && supabaseUrl && supabaseKey) {
      const errPayload = { error: errMsg, stage: 'handler_uncaught' };
      waitUntil(logSearchQuery(req, body, ticker, narrativeText, queryVector, errPayload, supabaseUrl, supabaseKey, startTime));
    }
    return send(res, 500, { error: errMsg });
  }
};

// Logger for search_query_log (training-data capture). Returns a Promise so
// the caller can hand it to Vercel's waitUntil(), which keeps the lambda
// alive until the insert settles without blocking the user response.
// Never throws — failures are logged to console and swallowed.
async function logSearchQuery(req, body, ticker, narrativeText, queryVector, responsePayload, supabaseUrl, supabaseKey, startTime) {
  try {
    const ua = (req.headers && (req.headers['user-agent'] || req.headers['User-Agent']) || '').toString().toLowerCase();
    let uaClass = 'unknown';
    if (/bot|crawl|spider/.test(ua)) uaClass = 'bot';
    else if (/mobile|iphone|android/.test(ua)) uaClass = 'mobile';
    else if (/ipad|tablet/.test(ua)) uaClass = 'tablet';
    else if (ua) uaClass = 'desktop';

    const normText = (narrativeText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const textHash = require('crypto').createHash('sha256').update(normText).digest('hex');

    const row = {
      ticker: ticker.toUpperCase(),
      narrative_text: narrativeText,
      narrative_text_hash: textHash,
      anonymous_session_id: body.anonymousSessionId || null,
      user_agent_class: uaClass,
      is_logged_in: !!body.userId,
      embedding: '[' + queryVector.join(',') + ']',
      embedding_model: 'sentence-transformers/all-MiniLM-L6-v2',
      candidate_direction: null,
      candidate_cycle_phase: null,
      candidate_market_regime: null,
      candidate_sector: responsePayload.sector_hint || null,
      candidate_dot_hash: null,
      response_payload: responsePayload,
      predicted_hit_rate_5d: responsePayload.narrative_hit_rate_5d != null ? responsePayload.narrative_hit_rate_5d : null,
      predicted_5d_return:   responsePayload.predicted_5d_return  != null ? responsePayload.predicted_5d_return  : null,
      predicted_10d_return:  responsePayload.predicted_10d_return != null ? responsePayload.predicted_10d_return : null,
      predicted_20d_return:  responsePayload.predicted_20d_return != null ? responsePayload.predicted_20d_return : null,
      predictor_version: 'dot_predictor_v1',
      n_neighbors_returned: responsePayload.n_similar_dots != null ? responsePayload.n_similar_dots : 0,
      backend_latency_ms: Date.now() - startTime,
    };

    const r = await fetch(supabaseUrl + '/rest/v1/search_query_log', {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const t = await r.text().catch(function () { return ''; });
      console.warn('[dots-predict] search_query_log insert failed (' + r.status + '): ' + (t || '').slice(0, 300));
    }
  } catch (logErr) {
    console.warn('[dots-predict] search_query_log path failed:', (logErr && logErr.message) || logErr);
  }
}
