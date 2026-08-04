// Dynamic per-ticker Open Graph image (1200x630 PNG) for /stocks/:ticker.
// Renders a branded social card with the ticker, the narrative read, and the
// sentiment / valuation chips so X, LinkedIn, Slack, etc. show a real preview.
//
// Runtime: Edge — required by @vercel/og. Mixing with Node serverless /api/* is
// supported by Vercel. Routed via /stock-og/:ticker -> /api/stock-og?ticker=:ticker.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const ticker = (searchParams.get('ticker') || '').replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();

  let narrative = 'Forensic narrative intelligence on what the market believes.';
  let sentiment = null;
  let verdict = '';
  let fvd = null;

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';

  if (ticker && supabaseUrl && supabaseAnon) {
    try {
      const url = `${supabaseUrl}/rest/v1/narrative_scorecard`
        + `?ticker=eq.${encodeURIComponent(ticker)}`
        + `&order=snapshot_date.desc&limit=1`
        + `&select=narrative,current_sentiment,verdict,fvd_pct`;
      const r = await fetch(url, { headers: { apikey: supabaseAnon, Authorization: `Bearer ${supabaseAnon}` } });
      if (r.ok) {
        const rows = await r.json();
        if (rows.length) {
          narrative = rows[0].narrative || narrative;
          sentiment = rows[0].current_sentiment;
          verdict = rows[0].verdict || '';
          fvd = rows[0].fvd_pct;
        }
      }
    } catch (_) { /* defaults */ }
  }

  const read = narrative.length > 160 ? narrative.slice(0, 157) + '…' : narrative;

  const sNum = sentiment == null ? null : Number(sentiment);
  const sentLabel = sNum == null ? 'Neutral' : (sNum >= 5 ? 'Bullish' : (sNum <= -5 ? 'Bearish' : 'Neutral'));
  const sentColor = sentLabel === 'Bullish' ? '#00DE94' : (sentLabel === 'Bearish' ? '#FF4D4D' : '#00AEFF');

  const vLow = String(verdict).toLowerCase();
  const verdictLabel = vLow.includes('trap') ? 'Narrative Trap'
    : vLow.includes('support') ? 'Structurally Supported'
    : vLow.includes('monitor') ? 'Monitoring'
    : (verdict || 'Monitoring');

  const fvdNum = fvd == null ? null : Number(fvd);
  const fvdChip = fvdNum == null ? null
    : `${fvdNum > 0 ? '+' : ''}${fvdNum.toFixed(1)}% vs fundamental value`;

  const chip = (text, color) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'center',
        fontSize: '24px', fontWeight: 600, fontFamily: 'sans-serif',
        color, padding: '8px 18px', borderRadius: '999px',
        border: `2px solid ${color}55`, background: `${color}1A`,
      },
      children: text,
    },
  });

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px', height: '630px', display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(135deg, #080B11 0%, #111927 100%)',
          padding: '60px 72px', position: 'relative', color: '#FFFFFF', fontFamily: 'sans-serif',
        },
        children: [
          // top accent bar
          { type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, right: 0, height: '6px', display: 'flex', background: 'linear-gradient(90deg, #FFB800, #00AEFF)' } } },
          // eyebrow
          { type: 'div', props: { style: { display: 'flex', fontSize: '20px', letterSpacing: '0.16em', textTransform: 'uppercase', color: '#00AEFF', fontWeight: 600, fontFamily: 'sans-serif', marginBottom: '20px' }, children: 'Market Prism · Narrative Intelligence' } },
          // ticker
          { type: 'div', props: { style: { display: 'flex', fontSize: '110px', fontWeight: 400, letterSpacing: '-0.03em', lineHeight: 1, color: '#FFFFFF', marginBottom: '28px' }, children: ticker || 'Stocks' } },
          // narrative read
          { type: 'div', props: { style: { display: 'flex', fontSize: '40px', lineHeight: 1.25, letterSpacing: '-0.01em', color: '#E8ECF2', fontWeight: 400, maxWidth: '1056px' }, children: read } },
          // spacer
          { type: 'div', props: { style: { flex: 1, display: 'flex' } } },
          // chips row
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }, children: [
            chip(sentLabel + ' narrative', sentColor),
            chip(verdictLabel, '#A0A8B0'),
            fvdChip ? chip(fvdChip, '#FFB800') : null,
          ].filter(Boolean) } },
          // footer
          { type: 'div', props: { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '24px', borderTop: '1px solid rgba(255,255,255,0.10)' }, children: [
            { type: 'div', props: { style: { display: 'flex', fontSize: '26px', fontWeight: 500, color: '#FFFFFF', fontFamily: 'sans-serif' }, children: 'Market Prism' } },
            { type: 'div', props: { style: { display: 'flex', fontSize: '20px', color: '#4A5578', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'sans-serif' }, children: 'marketprism.co' } },
          ] } },
        ],
      },
    },
    {
      width: 1200, height: 630,
      headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800' },
    }
  );
}
