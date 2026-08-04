/**
 * narrativeEngine.js
 * Transforms raw Market Prism signal data into human-readable explanations
 * for SEO pages, AEO blocks, and meta descriptions.
 *
 * The verdict taxonomy below mirrors every classification the scorer emits
 * (narrative_scorecard.verdict). Each maps to a "family" that drives tone /
 * badge color and to bespoke copy so no real verdict ever falls through to a
 * vague "no definitive classification" answer.
 */

/* ── Verdict taxonomy ───────────────────────────────────────────────────────
 * key      — stable internal id used by copy switches
 * family   — bear | caution | neutral | bull  (drives sentiment + badge color)
 * label    — human display label
 */
const VERDICT_MAP = {
  'narrative trap':               { key: 'trap',         family: 'bear',    label: 'Narrative Trap' },
  'near-trap watch':              { key: 'near_trap',    family: 'caution', label: 'Near-Trap Watch' },
  'near trap watch':              { key: 'near_trap',    family: 'caution', label: 'Near-Trap Watch' },
  'exhausted narrative':          { key: 'exhausted',    family: 'bear',    label: 'Exhausted Narrative' },
  'narrative risk':               { key: 'risk',         family: 'caution', label: 'Narrative Risk' },
  'coordinated watch':            { key: 'coordinated',  family: 'caution', label: 'Coordinated Watch' },
  'omission cascade':             { key: 'omission',     family: 'bear',    label: 'Omission Cascade' },
  'air pocket short':             { key: 'air_pocket',   family: 'bear',    label: 'Air Pocket Short' },
  'drift compression short':      { key: 'drift_short',  family: 'bear',    label: 'Drift Compression Short' },
  'overvalued stable':            { key: 'overvalued',   family: 'caution', label: 'Overvalued Stable' },
  'unverified premium':           { key: 'unverified',   family: 'caution', label: 'Unverified Premium' },
  'regime uncertainty':           { key: 'regime',       family: 'neutral', label: 'Regime Uncertainty' },
  'monitoring':                   { key: 'monitoring',   family: 'neutral', label: 'Monitoring' },
  'structurally supported':       { key: 'supported',    family: 'bull',    label: 'Structurally Supported' },
  'accumulate':                   { key: 'accumulate',   family: 'bull',    label: 'Accumulate' },
  'high conviction continuation': { key: 'continuation', family: 'bull',    label: 'High Conviction Continuation' },
};

// Per-verdict copy. `phrase` slots into the summary; `classify` is the verdict
// explainer lead; `outlook` is the what-happens-next lead.
const VERDICT_COPY = {
  trap: {
    phrase:   t => `${t} is flashing a narrative trap`,
    classify: t => `Market Prism's forensic engine classifies ${t} as a Narrative Trap — the market story has run well ahead of what the fundamentals can support.`,
    outlook:  t => `Narrative traps tend to resolve to the downside as the gap between story and reality closes. The tell is narrative energy rolling over — price typically follows within a few weeks.`,
  },
  near_trap: {
    phrase:   t => `${t} is on a near-trap watch`,
    classify: t => `Market Prism has ${t} on Near-Trap Watch — the story is stretching ahead of fundamentals but hasn't fully decoupled yet.`,
    outlook:  t => `This is the stage before a trap fully forms. If narrative energy keeps climbing without fundamental confirmation, downside risk builds quickly.`,
  },
  exhausted: {
    phrase:   t => `${t}'s narrative looks exhausted`,
    classify: t => `Market Prism classifies ${t} as an Exhausted Narrative — the story that powered the move has burned through most of its attention and momentum.`,
    outlook:  t => `When a narrative exhausts, the marginal buyer disappears. Price tends to drift lower or stall until a genuinely new catalyst resets the story.`,
  },
  risk: {
    phrase:   t => `${t} is carrying elevated narrative risk`,
    classify: t => `Market Prism flags ${t} as Narrative Risk — the supporting story has structural weak points that raise the odds of a sharp repricing.`,
    outlook:  t => `Elevated narrative risk means the move is fragile. Watch for the first crack in the story — these names tend to reprice faster than the fundamentals change.`,
  },
  coordinated: {
    phrase:   t => `${t} is under coordinated watch`,
    classify: t => `Market Prism has ${t} on Coordinated Watch — the spread of its narrative shows the fingerprints of organized, synchronized promotion rather than organic discovery.`,
    outlook:  t => `Coordinated narratives can run hot in the short term, but they unwind fast once the coordination fades. Treat strength here as borrowed, not earned.`,
  },
  omission: {
    phrase:   t => `${t} is showing an omission cascade`,
    classify: t => `Market Prism flags ${t} for an Omission Cascade — the bullish story is being sustained by what is being left out, not by what is being said.`,
    outlook:  t => `Omission cascades are a late-stage warning. Once the missing piece surfaces, these narratives tend to correct abruptly.`,
  },
  air_pocket: {
    phrase:   t => `${t} is sitting over an air pocket`,
    classify: t => `Market Prism classifies ${t} as an Air Pocket Short — there's little real demand beneath the current price to catch a decline.`,
    outlook:  t => `Air pockets resolve fast. With thin support below, ${t} is vulnerable to a quick, gappy move lower on any negative catalyst.`,
  },
  drift_short: {
    phrase:   t => `${t} is in drift-compression`,
    classify: t => `Market Prism classifies ${t} as a Drift Compression Short — volatility has compressed while the underlying narrative quietly weakens.`,
    outlook:  t => `Compression like this tends to release directionally. With the story softening underneath, the path of least resistance skews lower.`,
  },
  overvalued: {
    phrase:   t => `${t} looks overvalued but stable`,
    classify: t => `Market Prism classifies ${t} as Overvalued Stable — the price sits above what the narrative justifies, but the story isn't actively breaking down.`,
    outlook:  t => `Overvalued-but-stable names can hold a premium for a while. The risk is asymmetric: limited upside, with a long way to fall if the story cracks.`,
  },
  unverified: {
    phrase:   t => `${t} is trading on an unverified premium`,
    classify: t => `Market Prism flags ${t} as Unverified Premium — the market is paying up for a story Market Prism can't yet confirm in the data.`,
    outlook:  t => `Unverified premiums live or die on the next data point. Confirmation extends the move; a miss tends to puncture it quickly.`,
  },
  regime: {
    phrase:   t => `${t} is caught in regime uncertainty`,
    classify: t => `Market Prism classifies ${t} as Regime Uncertainty — the broader market backdrop is shifting, and ${t}'s narrative hasn't settled into a clear direction.`,
    outlook:  t => `In an uncertain regime, ${t} will likely take its cues from the macro tape. Wait for the regime to resolve before trusting the move.`,
  },
  monitoring: {
    phrase:   t => `${t} is in a watch-and-wait state`,
    classify: t => `Market Prism has ${t} in Monitoring — signals are mixed and the narrative direction hasn't resolved one way or the other yet.`,
    outlook:  t => `${t} is at a decision point. The signals to watch: narrative energy direction, fundamental-value convergence, and any shift in institutional positioning.`,
  },
  supported: {
    phrase:   t => `${t} is structurally supported`,
    classify: t => `Market Prism classifies ${t} as Structurally Supported — the narrative is backed by verifiable fundamental data, not just momentum.`,
    outlook:  t => `Structural support means recent weakness reads more like noise than a regime change. The story still has a foundation under it.`,
  },
  accumulate: {
    phrase:   t => `${t} is in an accumulation signal`,
    classify: t => `Market Prism classifies ${t} as Accumulate — the narrative and positioning data point to quiet building of conviction beneath the surface.`,
    outlook:  t => `Accumulation patterns favor patience. The setup suggests strength is being built, not distributed — though sizing should still respect market-wide risk.`,
  },
  continuation: {
    phrase:   t => `${t} is in high-conviction continuation`,
    classify: t => `Market Prism classifies ${t} as High Conviction Continuation — the narrative is intact, energy is sustained, and the trend has structural backing.`,
    outlook:  t => `Continuation signals favor the existing trend. The thesis is doing what it should — the risk is complacency, not collapse.`,
  },
  neutral: {
    phrase:   t => `${t} is in a transitional narrative state`,
    classify: t => `${t} is under active forensic observation. Its current signals haven't locked into a definitive classification yet.`,
    outlook:  t => `${t} is in a transitional phase. The signals to watch: narrative energy direction, fundamental-value convergence, and institutional positioning.`,
  },
};

/**
 * Convert raw scorecard + trade data into natural language outputs.
 * @param {object} data
 * @param {string} data.ticker
 * @param {number} [data.vms]            Volatility-momentum score
 * @param {number} [data.energy]         Energy remaining (0-100)
 * @param {number} [data.fvd]            Fundamental value deviation %
 * @param {string} [data.label]          Raw label e.g. "NARRATIVE_TRAP"
 * @param {string} [data.verdict]        Raw verdict e.g. "Exhausted Narrative"
 * @param {number} [data.coordination]   Coordination score
 * @param {number} [data.decay]          Decay rate
 * @param {number} [data.changePct]      Price change %
 * @param {string} [data.direction]      "LONG" | "SHORT"
 * @param {string} [data.narrative]      Narrative description
 * @param {number} [data.suspicion]      Suspicion score
 * @param {number} [data.rbi]            Reality-Belief index (0-100)
 * @param {string} [data.rbiZone]        reality | plausible | risky | belief
 * @param {string} [data.companyName]    Display company name
 * @returns {object} Natural language outputs
 */
function transformNarrative(data) {
  const t = data.ticker || 'This stock';
  const fvd = numOrNull(data.fvd);
  const energy = numOrNull(data.energy);
  const vms = numOrNull(data.vms);
  const decay = numOrNull(data.decay);
  const coordination = numOrNull(data.coordination);
  const direction = (data.direction || '').toUpperCase();
  const rbi = numOrNull(data.rbi);
  const rbiZone = (data.rbiZone || '').toLowerCase();

  const vk = normalizeVerdict(data.verdict || data.label || '');
  const family = verdictFamily(vk);

  return {
    verdictKey: vk,
    verdictFamily: family,
    verdictLabel: verdictLabel(data.verdict || data.label || ''),
    tldr: buildTldr(t, vk, family, fvd, energy, rbi, rbiZone),
    summary: buildSummary(t, vk, family, fvd, energy, vms),
    whyMoving: buildWhyMoving(t, vk, family, data),
    isOvervalued: buildOvervalued(t, fvd, vk, family, rbi, rbiZone),
    verdictExplain: buildVerdictExplain(t, vk, energy, decay, coordination),
    whatsNext: buildWhatsNext(t, vk, family, energy, decay, direction, fvd),
    metaDescription: buildMetaDescription(t, vk, family, fvd, energy),
  };
}

function normalizeVerdict(v) {
  const s = String(v || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (VERDICT_MAP[s]) return VERDICT_MAP[s].key;
  // Fuzzy fallback for unseen label variants.
  if (s.includes('trap') && s.includes('near')) return 'near_trap';
  if (s.includes('trap')) return 'trap';
  if (s.includes('exhaust')) return 'exhausted';
  if (s.includes('omission')) return 'omission';
  if (s.includes('air pocket')) return 'air_pocket';
  if (s.includes('drift')) return 'drift_short';
  if (s.includes('coordinat')) return 'coordinated';
  if (s.includes('overvalued')) return 'overvalued';
  if (s.includes('unverified')) return 'unverified';
  if (s.includes('regime')) return 'regime';
  if (s.includes('continuation')) return 'continuation';
  if (s.includes('accumulate')) return 'accumulate';
  if (s.includes('support')) return 'supported';
  if (s.includes('risk')) return 'risk';
  if (s.includes('monitor')) return 'monitoring';
  return 'neutral';
}

function verdictFamily(key) {
  for (const k in VERDICT_MAP) if (VERDICT_MAP[k].key === key) return VERDICT_MAP[k].family;
  return 'neutral';
}

function verdictLabel(raw) {
  const s = String(raw || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (VERDICT_MAP[s]) return VERDICT_MAP[s].label;
  const key = normalizeVerdict(raw);
  for (const k in VERDICT_MAP) if (VERDICT_MAP[k].key === key) return VERDICT_MAP[k].label;
  return 'Monitoring';
}

function copy(vk) {
  return VERDICT_COPY[vk] || VERDICT_COPY.neutral;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return null;
  return `${Math.abs(n).toFixed(1)}%`;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize to a single sentence with exactly one terminal punctuation mark.
function ensureSentence(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (!s) return s;
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

// Reject upstream boilerplate that isn't a real narrative.
function cleanNarrative(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (v.length < 15) return null;
  if (/publicly traded company|observable stock price|stock price,?\s*quote|quote,?\s*news/i.test(v)) return null;
  return v;
}

/**
 * Answer-first TL;DR — the single line that directly answers the searcher and
 * is the best candidate for AI Overviews / featured snippets. Adapts to the
 * verdict family so a "why is X down" page with a bullish verdict reads as a
 * compelling contrarian hook rather than a contradiction.
 */
function buildTldr(t, vk, family, fvd, energy, rbi, rbiZone) {
  const c = copy(vk);
  const energyClause =
    energy == null ? '' :
    energy < 40 ? ` Narrative energy has faded to ${energy.toFixed(0)}%, so there's little fresh fuel behind the move.` :
    energy > 70 ? ` Narrative energy is still elevated at ${energy.toFixed(0)}%.` :
    ` Narrative energy is cooling at ${energy.toFixed(0)}%.`;

  if (family === 'bear') {
    return ensureSentence(`The short answer: ${c.phrase(t)}, and the data says the weakness is structural, not random.`) + energyClause;
  }
  if (family === 'caution') {
    return ensureSentence(`The short answer: ${c.phrase(t)} — the move is fragile and worth watching closely.`) + energyClause;
  }
  if (family === 'bull') {
    return ensureSentence(`The short answer: any recent dip in ${t} is running against the grain — Market Prism still reads the underlying narrative as ${verdictLabel(vk).toLowerCase()}.`) +
      (rbi != null && rbiZone ? ` Its Reality-Belief index sits at ${Math.round(rbi)}/100 (${rbiZone} zone).` : '');
  }
  // neutral
  return ensureSentence(`The short answer: there's no single catalyst — ${c.phrase(t)}.`) + energyClause;
}

function buildSummary(t, vk, family, fvd, energy, vms) {
  const c = copy(vk);
  const parts = [c.phrase(t)];

  if (fvd != null && Math.abs(fvd) >= 1) {
    parts.push(`trading ${fmtPct(fvd)} ${fvd > 0 ? 'above' : 'below'} estimated fundamental value`);
  }
  if (energy != null) {
    if (family === 'bull' && energy > 50) parts.push('backed by sustained narrative energy');
    else if (energy > 60) parts.push('on narrative energy that may not be sustainable');
    else if (energy < 40) parts.push('with weakening narrative momentum');
  }

  let s = parts.join(', ') + '.';
  if (family === 'bear') s += ' Historically, this pattern is associated with downside risk.';
  return s;
}

function buildWhyMoving(t, vk, family, data) {
  const parts = [];
  const narrative = cleanNarrative(data.narrative);
  if (narrative) {
    parts.push(`The story driving ${t} right now: ${ensureSentence(narrative)}`);
  }

  const changePct = numOrNull(data.changePct);
  if (changePct != null) {
    parts.push(`The stock is ${changePct >= 0 ? 'up' : 'down'} ${fmtPct(changePct)} in the current session.`);
  }

  const coordination = numOrNull(data.coordination);
  if (coordination != null && coordination > 50) {
    parts.push('Elevated coordination signals point to concentrated positioning or organized narrative activity.');
  }

  const vms = numOrNull(data.vms);
  if (vms != null && vms > 60) {
    parts.push(`High volatility-momentum readings (${vms.toFixed(0)}) indicate significant narrative-driven price displacement.`);
  }

  const suspicion = numOrNull(data.suspicion);
  if (suspicion != null && suspicion > 40) {
    parts.push('Forensic indicators flag elevated narrative-manipulation risk.');
  }

  // Anchor in the verdict only when there's nothing else to say, so the section
  // never reads as filler but also never duplicates the verdict explainer that
  // appears later on the same page.
  if (parts.length === 0) {
    parts.push(copy(vk).classify(t));
  }

  return parts.join(' ');
}

function buildOvervalued(t, fvd, vk, family, rbi, rbiZone) {
  // No fundamental-value baseline (e.g. recent IPOs): fall back to the Reality-Belief
  // index instead of an "unavailable" dead end.
  if (fvd == null) {
    if (rbi != null && rbiZone) {
      const zoneCopy = {
        reality: `Its price is currently well grounded in reality — the Reality-Belief index sits at ${Math.round(rbi)}/100, meaning the move reflects what the company is actually doing more than hype.`,
        plausible: `Its narrative runs slightly ahead of fundamentals — the Reality-Belief index sits at ${Math.round(rbi)}/100, still within a defensible range.`,
        risky: `Belief is starting to outpace fundamentals — the Reality-Belief index sits at ${Math.round(rbi)}/100, an elevated-risk reading.`,
        belief: `Its price is driven mostly by belief — the Reality-Belief index sits at ${Math.round(rbi)}/100, detached from underlying fundamentals.`,
      };
      return `${t} doesn't yet have a stable fundamental-value baseline, so Market Prism reads valuation through narrative instead. ${zoneCopy[rbiZone] || `The Reality-Belief index sits at ${Math.round(rbi)}/100.`}`;
    }
    return `${t} doesn't yet have a stable fundamental-value baseline — common for newly public or thinly covered names. Watch the narrative and positioning signals below for valuation context until fundamentals settle.`;
  }

  const parts = [];
  if (fvd > 20) {
    parts.push(`${t} is trading ${fmtPct(fvd)} above its estimated fundamental value, a level that flags significant overvaluation risk.`);
  } else if (fvd > 0) {
    parts.push(`${t} is trading ${fmtPct(fvd)} above estimated fundamental value — a modest premium that may or may not be justified by growth expectations.`);
  } else if (fvd > -10) {
    parts.push(`${t} is trading near estimated fundamental value (${fmtPct(fvd)} deviation), suggesting balanced pricing.`);
  } else {
    parts.push(`${t} appears undervalued, trading ${fmtPct(fvd)} below estimated fundamental value.`);
  }

  if (family === 'bear' && fvd > 0) {
    parts.push('Paired with the current narrative signals, this premium looks driven by story momentum more than fundamentals.');
  } else if (family === 'bull' && fvd > 0) {
    parts.push('Structural support in the narrative suggests the premium may be at least partially earned.');
  }
  return parts.join(' ');
}

function buildVerdictExplain(t, vk, energy, decay, coordination) {
  const parts = [copy(vk).classify(t)];

  if (energy != null) {
    if (energy > 70) parts.push(`Narrative energy remains elevated at ${energy.toFixed(0)}%, so the story still has momentum.`);
    else if (energy > 40) parts.push(`Narrative energy is moderating at ${energy.toFixed(0)}%, an early sign of fatigue.`);
    else parts.push(`Narrative energy has declined to ${energy.toFixed(0)}%, suggesting the thesis is losing traction.`);
  }
  if (decay != null && decay > 5) {
    parts.push(`An elevated decay rate (${decay.toFixed(1)}%) signals accelerating narrative deterioration.`);
  }
  if (coordination != null && coordination > 60) {
    parts.push(`A high coordination score (${coordination.toFixed(0)}) points to organized narrative propagation.`);
  }
  return parts.join(' ');
}

function buildWhatsNext(t, vk, family, energy, decay, direction, fvd) {
  const parts = [copy(vk).outlook(t)];

  if (fvd != null && Math.abs(fvd) > 30) {
    parts.push(`The ${fmtPct(fvd)} fundamental-value deviation is extreme and, historically, tends to revert within 30–60 trading days.`);
  }
  if (decay != null && decay > 8) {
    parts.push('Rapid narrative decay is a leading indicator — price tends to follow narrative deterioration with a 5–15 day lag.');
  }
  if (family === 'bull' && direction === 'SHORT') {
    parts.push('That said, current positioning signals temper near-term upside — watch for a shift in narrative energy.');
  }
  return parts.join(' ');
}

function buildMetaDescription(t, vk, family, fvd, energy) {
  const parts = [`${t}:`, `${verdictLabel(vk)}.`];
  if (fvd != null) parts.push(`${fvd > 0 ? '+' : ''}${fvd.toFixed(1)}% fundamental-value deviation.`);
  if (energy != null) parts.push(`Narrative energy ${energy.toFixed(0)}%.`);
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
    { question: `Why is ${ticker} stock moving today?`, answer: narrativeOutput.whyMoving },
    { question: `Is ${ticker} overvalued right now?`, answer: narrativeOutput.isOvervalued },
    { question: `What is Market Prism's verdict on ${ticker}?`, answer: narrativeOutput.verdictExplain },
    { question: `What happens next for ${ticker}?`, answer: narrativeOutput.whatsNext },
    {
      question: `Should I buy ${ticker} stock?`,
      answer: `Market Prism does not provide buy or sell recommendations. Our forensic analysis shows: ${narrativeOutput.summary} Investors should use this signal intelligence alongside their own due diligence and professional financial advice.`,
    },
  ];
}

module.exports = { transformNarrative, generateFAQ, normalizeVerdict, verdictFamily, verdictLabel };
