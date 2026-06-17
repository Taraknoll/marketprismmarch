// Dynamic Open Graph image generator (1200x630 PNG).
//
// Generates a per-article social card with the title, ticker badge, tag, and
// brand mark. Used as og:image and twitter:image for blog posts so Google News,
// Twitter/X, LinkedIn, Slack, etc. all show a real branded preview rather than
// falling back to the publication logo.
//
// Runtime: Edge — required by @vercel/og. The rest of /api/* uses Node
// serverless functions; mixing the two is supported by Vercel.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const slug = (searchParams.get('slug') || '').trim();

  let title = 'Market Prism — Intelligence Journal';
  let ticker = '';
  let tag = 'Research';

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnon = process.env.SUPABASE_ANON || '';

  if (slug && supabaseUrl && supabaseAnon) {
    try {
      const apiUrl = `${supabaseUrl}/rest/v1/blog_posts`
        + `?slug=eq.${encodeURIComponent(slug)}`
        + `&status=eq.published`
        + `&select=title,ticker,tag&limit=1`;
      const r = await fetch(apiUrl, {
        headers: { apikey: supabaseAnon, Authorization: `Bearer ${supabaseAnon}` },
      });
      if (r.ok) {
        const rows = await r.json();
        if (rows.length) {
          title = rows[0].title || title;
          ticker = rows[0].ticker && rows[0].ticker !== 'MP' ? rows[0].ticker : '';
          tag = rows[0].tag || tag;
        }
      }
    } catch (_) { /* fall through to defaults */ }
  }

  // Truncate over-long titles so they fit two lines comfortably
  const renderedTitle = title.length > 130 ? title.slice(0, 127) + '…' : title;

  // Tag-driven accent colour (matches site palette)
  const accent = tag === 'Earnings' ? '#FFB800'
    : tag === 'Post-Earnings' ? '#00DE94'
    : tag === 'Market Intel' ? '#00AEFF'
    : '#00AEFF';

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #0B0F14 0%, #131920 100%)',
          padding: '64px 72px',
          position: 'relative',
          fontFamily: 'sans-serif',
          color: '#F5F7FA',
        },
        children: [
          // Top accent bar
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: '6px',
                background: `linear-gradient(90deg, ${accent}, #00AEFF)`,
                display: 'flex',
              },
            },
          },
          // Header row: tag + ticker
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '20px',
                marginBottom: '36px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '22px',
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: accent,
                      fontWeight: 600,
                      fontFamily: 'sans-serif',
                      display: 'flex',
                    },
                    children: tag,
                  },
                },
                ticker && {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '24px',
                      fontWeight: 700,
                      color: '#F5F7FA',
                      letterSpacing: '0.04em',
                      padding: '6px 18px',
                      borderRadius: '8px',
                      border: '2px solid rgba(255,255,255,0.16)',
                      fontFamily: 'sans-serif',
                      display: 'flex',
                    },
                    children: ticker,
                  },
                },
              ].filter(Boolean),
            },
          },
          // Title
          {
            type: 'div',
            props: {
              style: {
                fontSize: '64px',
                lineHeight: 1.12,
                letterSpacing: '-0.02em',
                color: '#F5F7FA',
                fontWeight: 400,
                maxWidth: '1056px',
                display: 'flex',
              },
              children: renderedTitle,
            },
          },
          // Spacer
          { type: 'div', props: { style: { flex: 1, display: 'flex' } } },
          // Footer row: brand
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: '28px',
                borderTop: '1px solid rgba(255,255,255,0.08)',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '28px',
                            color: '#F5F7FA',
                            fontWeight: 500,
                            letterSpacing: '-0.01em',
                            fontFamily: 'sans-serif',
                            display: 'flex',
                          },
                          children: 'Market Prism',
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '16px',
                            color: '#A0A8B0',
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            fontFamily: 'sans-serif',
                            display: 'flex',
                          },
                          children: 'Intelligence Journal',
                        },
                      },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '14px',
                      color: '#4A5578',
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      fontFamily: 'sans-serif',
                      display: 'flex',
                    },
                    children: 'marketprism.co',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      },
    }
  );
}
