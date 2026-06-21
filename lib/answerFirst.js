/**
 * answerFirst.js
 * Builds the free, answer-first verdict summary injected at the top of the
 * /ticker/:ticker pages (above the Pro-gated forecast banner) and reusable
 * anywhere a plain-English "short answer" verdict read is wanted.
 *
 * Self-contained + theme-aware: styles reference the host page's CSS custom
 * properties (--mp-surface, --mp-text-*, --mp-green, --font-body) so the block
 * adapts to light/dark automatically. Scoped under #mp-answer-first.
 *
 * Provenance chips foreground exactly what a generic LLM can't give: a live
 * price, a daily-refreshed read, and proprietary forensic signals.
 *
 * @param {object} narr  output of narrativeEngine.transformNarrative()
 * @param {object} [opts]
 * @param {function} [opts.esc]   HTML escaper (defaults to a local one)
 * @param {string}   [opts.today] pre-formatted date string
 * @returns {string} HTML (with scoped <style>) or '' when there's no verdict
 */
function buildAnswerFirst(narr, opts) {
  opts = opts || {};
  if (!narr || !narr.tldr) return '';
  const esc = opts.esc || defaultEsc;
  const today = opts.today || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const fam = narr.verdictFamily;
  const accent = ({ bull: '#00DE94', bear: '#FF4D4D', caution: '#FFB800' })[fam] || '#00AEFF';
  const accentBg = ({ bull: 'rgba(0,222,148,0.12)', bear: 'rgba(255,77,77,0.12)', caution: 'rgba(255,184,0,0.12)' })[fam] || 'rgba(0,174,255,0.12)';

  return `
  <div id="mp-answer-first" style="--af-accent:${accent};--af-bg:${accentBg};">
    <style>
    #mp-answer-first{background:var(--mp-surface);border:1px solid var(--mp-border);border-left:4px solid var(--af-accent);border-radius:16px;padding:20px 24px;margin-bottom:16px;font-family:var(--font-body,'Inter',system-ui,sans-serif);position:relative;overflow:hidden;}
    #mp-answer-first .af-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
    #mp-answer-first .af-eyebrow{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mp-text-tertiary);font-weight:600;}
    #mp-answer-first .af-verdict{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 11px;border-radius:999px;color:var(--af-accent);background:var(--af-bg);}
    #mp-answer-first .af-text{font-size:16px;line-height:1.55;color:var(--mp-text-primary);font-weight:500;letter-spacing:-0.01em;margin:0;}
    #mp-answer-first .af-prov{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}
    #mp-answer-first .af-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--mp-text-tertiary);background:var(--mp-surface2,rgba(0,0,0,0.03));border:1px solid var(--mp-border);border-radius:999px;padding:5px 11px;}
    #mp-answer-first .af-dot{width:6px;height:6px;border-radius:50%;background:var(--mp-green);box-shadow:0 0 0 3px rgba(0,222,148,0.18);}
    @media(max-width:768px){#mp-answer-first{padding:16px 18px;}#mp-answer-first .af-text{font-size:15px;}}
    </style>
    <div class="af-top">
      <span class="af-eyebrow">Market Prism verdict</span>
      <span class="af-verdict">${esc(narr.verdictLabel)}</span>
    </div>
    <p class="af-text">${esc(narr.tldr)}</p>
    <div class="af-prov">
      <span class="af-chip"><span class="af-dot"></span>Live price</span>
      <span class="af-chip">Updated ${esc(today)}</span>
      <span class="af-chip">Proprietary forensic signals</span>
    </div>
  </div>`;
}

function defaultEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { buildAnswerFirst };
