/**
 * narrativeEngine.js
 * Transforms raw Market Prism signal data into human-readable explanations
 * for SEO pages, AEO blocks, and meta descriptions.
 */

/**
 * Convert raw scorecard + trade data into a natural language summary.
 * @param {object} data
 * @param {string} data.ticker
 * @param {number} [data.vms]              - Volatility-momentum score
 * @param {number} [data.energy]           - Energy remaining (0-100)
 * @param {number} [data.fvd]             - Fair value deviation %
 * @param {string} [data.label]           - e.g. "NARRATIVE_TRAP", "STRUCTURALLY_SUPPORTED"
 * @param {string} [data.verdict]         - e.g. "Narrative Trap", "Structurally Supported"
 * @param {number} [data.coordination]    - Coordination score
 * @param {number} [data.decay]           - Decay rate
 * @param {number} [data.price]           - Current price
 * @param {number} [data.changePct]       - Price change %
 * @param {string} [data.direction]       - "LONG" or "SHORT"
 * @param {string} [data.narrative]       - Narrative description
 * @param {number} [data.suspicion]       - Suspicion score
 * @param {string} [data.sector]          - Sector name
 * @returns {object} Natural language outputs
 */
function transformNarrative(data) {
  const t = data.ticker || 'This stock';
  const fvd = data.fvd;
  const energy = data.energy;
  const vms = data.vms;
  const verdict = normalizeVerdict(data.verdict || data.label || '');
  const decay = data.decay;
  const coordination = data.coordination;
  const direction = (data.direction || '').toUpperCase();
  const suspicion = data.suspicion;

  return {
    summary: buildSummary(t, verdict, fvd, energy, vms),
    whyMoving: buildWhyMoving(t, data),
    isOvervalued: buildOvervalued(t, fvd, verdict, vms),
    verdictExplain: buildVerdictExplain(t, verdict, energy, decay, coordination),
    whatsNext: buildWhatsNext(t, verdict, energy, decay, direction, fvd),
    metaDescription: buildMetaDescription(t, verdict, fvd, energy),
  };
}

function normalizeVerdict(v) {
  const s = v.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (s.includes('trap')) return 'narrative_trap';
  if (s.includes('support')) return 'structurally_supported';
  if (s.includes('monitor')) return 'monitoring';
  return 'neutral';
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return null;
  return `${Math.abs(n).toFixed(1)}%`;
}

// Normalize to a single sentence with exactly one terminal punctuation mark
// (prevents "...history.." when the source already ends in a period).
function ensureSentence(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (!s) return s;
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

// Reject upstream boilerplate that isn't a real narrative — e.g. "RDDT is a
// publicly traded company with observable stock price, quote, news, and
// history." — so we never present filler as the story driving the stock.
function cleanNarrative(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (v.length < 15) return null;
  if (/publicly traded company|observable stock price|stock price,?\s*quote|quote,?\s*news/i.test(v)) return null;
  return v;
}

function buildSummary(ticker, verdict, fvd, energy, vms) {
  const parts = [];

  if (verdict === 'narrative_trap') {
    parts.push(`${ticker} appears to be in a narrative trap`);
    if (fvd != null && fvd > 0) {
      parts.push(`trading ${fmtPct(fvd)} above estimated fair value`);
    }
    if (energy != null) {
      if (energy > 60) {
        parts.push('with elevated narrative energy that may not be sustainable');
      } else {
        parts.push('with weakening narrative momentum');
      }
    }
    parts.push('\u2014 a pattern historically associated with downside risk');
  } else if (verdict === 'structurally_supported') {
    parts.push(`${ticker} shows structural support in its current narrative`);
    if (fvd != null && fvd < 0) {
      parts.push(`trading ${fmtPct(fvd)} below estimated fair value`);
    } else if (fvd != null) {
      parts.push(`with a ${fmtPct(fvd)} fair value deviation`);
    }
    if (energy != null && energy > 50) {
      parts.push('backed by sustained narrative energy');
    }
  } else {
    parts.push(`${ticker} is in a transitional narrative state`);
    if (fvd != null) {
      parts.push(`with a ${fmtPct(fvd)} fair value deviation`);
    }
    if (energy != null) {
      parts.push(`and ${energy > 50 ? 'moderate-to-high' : 'fading'} narrative energy`);
    }
  }

  return parts.join(', ') + '.';
}

function buildWhyMoving(ticker, data) {
  const parts = [];

  const narrative = cleanNarrative(data.narrative);
  if (narrative) {
    parts.push(`The story driving ${ticker} right now: ${ensureSentence(narrative)}`);
  }

  if (data.changePct != null) {
    const dir = data.changePct >= 0 ? 'up' : 'down';
    parts.push(`The stock is ${dir} ${fmtPct(data.changePct)} in the current session.`);
  }

  if (data.coordination != null && data.coordination > 50) {
    parts.push('Elevated coordination signals suggest institutional activity or concentrated positioning.');
  }

  if (data.vms != null && data.vms > 60) {
    parts.push(`High volatility-momentum readings (${data.vms.toFixed(0)}) indicate significant narrative-driven price displacement.`);
  }

  if (data.suspicion != null && data.suspicion > 40) {
    parts.push('Forensic indicators flag elevated narrative manipulation risk.');
  }

  if (parts.length === 0) {
    parts.push(`${ticker} is experiencing normal market activity without strong directional narrative signals.`);
  }

  return parts.join(' ');
}

function buildOvervalued(ticker, fvd, verdict, vms) {
  if (fvd == null) {
    return `Fair value deviation data for ${ticker} is currently unavailable. Monitor fundamental signals for updated valuation context.`;
  }

  const parts = [];

  if (fvd > 20) {
    parts.push(`${ticker} is trading ${fmtPct(fvd)} above its estimated fair value, suggesting significant overvaluation risk.`);
  } else if (fvd > 0) {
    parts.push(`${ticker} is trading ${fmtPct(fvd)} above estimated fair value \u2014 a modest premium that may or may not be justified by growth expectations.`);
  } else if (fvd > -10) {
    parts.push(`${ticker} is trading near its estimated fair value (${fmtPct(fvd)} deviation), suggesting balanced pricing.`);
  } else {
    parts.push(`${ticker} appears undervalued, trading ${fmtPct(fvd)} below estimated fair value.`);
  }

  if (verdict === 'narrative_trap' && fvd > 0) {
    parts.push('Combined with narrative trap signals, this overvaluation may indicate price inflation driven by story momentum rather than fundamentals.');
  } else if (verdict === 'structurally_supported' && fvd > 0) {
    parts.push('However, structural support in the narrative suggests this premium may be at least partially justified.');
  }

  return parts.join(' ');
}

function buildVerdictExplain(ticker, verdict, energy, decay, coordination) {
  const parts = [];

  if (verdict === 'narrative_trap') {
    parts.push(`Market Prism's forensic analysis classifies ${ticker} as a Narrative Trap \u2014 the market story has outpaced fundamental reality.`);
  } else if (verdict === 'structurally_supported') {
    parts.push(`Market Prism's analysis classifies ${ticker} as Structurally Supported \u2014 the narrative is backed by verifiable fundamental data.`);
  } else if (verdict === 'monitoring') {
    parts.push(`${ticker} is currently in Monitoring status \u2014 signals are mixed and the narrative direction has not yet resolved.`);
  } else {
    parts.push(`${ticker} is under active forensic observation with no definitive narrative classification at this time.`);
  }

  if (energy != null) {
    if (energy > 70) {
      parts.push(`Narrative energy remains elevated at ${energy.toFixed(0)}%, indicating the story still has momentum.`);
    } else if (energy > 40) {
      parts.push(`Narrative energy is moderating at ${energy.toFixed(0)}%, showing early signs of fatigue.`);
    } else {
      parts.push(`Narrative energy has declined to ${energy.toFixed(0)}%, suggesting the thesis is losing traction.`);
    }
  }

  if (decay != null && decay > 5) {
    parts.push(`Elevated decay rate (${decay.toFixed(1)}%) signals accelerating narrative deterioration.`);
  }

  if (coordination != null && coordination > 60) {
    parts.push(`High coordination score (${coordination.toFixed(0)}) suggests organized narrative propagation.`);
  }

  return parts.join(' ');
}

function buildWhatsNext(ticker, verdict, energy, decay, direction, fvd) {
  const parts = [];

  if (verdict === 'narrative_trap') {
    if (energy != null && energy < 40) {
      parts.push(`With declining narrative energy and trap classification, ${ticker} faces elevated risk of a mean-reversion move toward fair value.`);
    } else {
      parts.push(`${ticker}'s narrative trap status suggests caution. While momentum may persist short-term, structural fragility increases the probability of a correction.`);
    }
  } else if (verdict === 'structurally_supported') {
    if (direction === 'LONG') {
      parts.push(`${ticker}'s structural support and long bias suggest continued upside potential, though position sizing should account for market-wide risk.`);
    } else {
      parts.push(`Despite structural support, current positioning signals suggest limited near-term upside. Watch for narrative energy shifts.`);
    }
  } else {
    parts.push(`${ticker} is in a transitional phase. Key signals to monitor: narrative energy direction, fair value convergence, and institutional positioning changes.`);
  }

  if (fvd != null && Math.abs(fvd) > 30) {
    parts.push(`The ${fmtPct(fvd)} fair value deviation is extreme and historically tends to revert within 30\u201360 trading days.`);
  }

  if (decay != null && decay > 8) {
    parts.push('Rapid narrative decay is a leading indicator \u2014 price tends to follow narrative deterioration with a 5\u201315 day lag.');
  }

  return parts.join(' ');
}

function buildMetaDescription(ticker, verdict, fvd, energy) {
  const parts = [`${ticker} analysis:`];

  if (verdict === 'narrative_trap') {
    parts.push('Narrative Trap detected.');
  } else if (verdict === 'structurally_supported') {
    parts.push('Structurally Supported.');
  }

  if (fvd != null) {
    parts.push(`${fvd > 0 ? '+' : ''}${fvd.toFixed(1)}% fair value deviation.`);
  }

  if (energy != null) {
    parts.push(`Energy: ${energy.toFixed(0)}%.`);
  }

  parts.push('Forensic narrative intelligence from Market Prism.');

  return parts.join(' ').substring(0, 160);
}

/**
 * Generate FAQ items for a ticker based on its data.
 * @param {string} ticker
 * @param {object} narrativeOutput - output from transformNarrative()
 * @returns {Array<{question: string, answer: string}>}
 */
function generateFAQ(ticker, narrativeOutput) {
  return [
    {
      question: `Why is ${ticker} stock moving today?`,
      answer: narrativeOutput.whyMoving,
    },
    {
      question: `Is ${ticker} overvalued right now?`,
      answer: narrativeOutput.isOvervalued,
    },
    {
      question: `What is Market Prism's verdict on ${ticker}?`,
      answer: narrativeOutput.verdictExplain,
    },
    {
      question: `Is ${ticker} a narrative trap?`,
      answer: narrativeOutput.verdictExplain,
    },
    {
      question: `Should I buy ${ticker} stock?`,
      answer: `Market Prism does not provide buy or sell recommendations. Our forensic analysis shows: ${narrativeOutput.summary} Investors should use this signal intelligence alongside their own due diligence and professional financial advice.`,
    },
  ];
}

module.exports = { transformNarrative, generateFAQ };
