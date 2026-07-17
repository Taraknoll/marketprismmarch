const resolveTemplate = require('./_resolve-template');

// Editorial bylines — kept in sync with the Python generators (AUTHOR_RESEARCH /
// AUTHOR_EARNINGS in generate_mp_blog.py). Adding a new persona means adding it
// here AND updating the generators to use the new author string.
const AUTHORS = {
  'ellis-marrow': {
    name: 'Ellis Marrow',
    role: 'Senior Markets Analyst',
    initials: 'EM',
    bio: 'Ellis Marrow leads narrative research at Market Prism, covering structural market dynamics, sector positioning, and the forensic signals that distinguish supported moves from narrative-driven ones. Prior to Market Prism, Ellis spent over a decade in equity research and quantitative strategy.',
  },
  'reed-calloway': {
    name: 'Reed Calloway',
    role: 'Earnings Desk Editor',
    initials: 'RC',
    bio: 'Reed Calloway runs the Market Prism earnings desk, publishing pre-print setup analysis and post-print forensic reports across every covered ticker. Reed focuses on estimate-vs-actual dispersion, guidance reaction patterns, and how earnings prints test the prevailing market narrative.',
  },
};

module.exports = async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON || '';

    let html = resolveTemplate('_author.html');
    html = html.replace(
      "window.__env = { SUPABASE_URL: '', SUPABASE_ANON: '' };",
      `window.__env = { SUPABASE_URL: '${supabaseUrl}', SUPABASE_ANON: '${supabaseAnon}' };`
    );

    const slug = (req.query && req.query.slug)
      || req.url.split('?')[0].split('/').filter(Boolean).pop()
      || '';

    const author = AUTHORS[slug.toLowerCase()];
    if (!author) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(404).send(html.replace(
        '<title id="page-title">Author — Market Prism</title>',
        '<title>Author not found — Market Prism</title>'
      ));
      return;
    }

    const pageUrl = `https://www.marketprism.co/author/${slug.toLowerCase()}`;
    const seoTitle = `${author.name} — ${author.role} | Market Prism`;
    const seoDesc = author.bio.substring(0, 160);

    html = html.replace(
      '<title id="page-title">Author — Market Prism</title>',
      `<title>${escHtml(seoTitle)}</title>`
    );
    html = html.replace(
      '<meta name="description" id="page-desc" content="">',
      `<meta name="description" content="${escAttr(seoDesc)}">`
    );
    html = html.replace(
      '<link rel="canonical" id="canonical-url" href="https://www.marketprism.co">',
      `<link rel="canonical" href="${escAttr(pageUrl)}">`
    );
    html = html.replace('content="" id="og-title"', `content="${escAttr(seoTitle)}" id="og-title"`);
    html = html.replace('content="" id="og-desc"', `content="${escAttr(seoDesc)}" id="og-desc"`);
    html = html.replace('content="" id="og-url"', `content="${escAttr(pageUrl)}" id="og-url"`);

    html = html.replace(
      '<div class="author-avatar" id="author-initials">AM</div>',
      `<div class="author-avatar" id="author-initials">${escHtml(author.initials)}</div>`
    );
    html = html.replace(
      '<h1 class="author-name" id="author-name">Author</h1>',
      `<h1 class="author-name" id="author-name">${escHtml(author.name)}</h1>`
    );
    html = html.replace(
      '<div class="author-role" id="author-role">Markets Analyst</div>',
      `<div class="author-role" id="author-role">${escHtml(author.role)}</div>`
    );
    html = html.replace(
      '<p class="author-bio" id="author-bio"></p>',
      `<p class="author-bio" id="author-bio">${escHtml(author.bio)}</p>`
    );

    // Inject Person + ProfilePage schema (Google News uses this for byline trust)
    const personSchema = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      'name': author.name,
      'jobTitle': author.role,
      'description': author.bio,
      'url': pageUrl,
      'worksFor': {
        '@type': 'Organization',
        'name': 'Market Prism',
        'url': 'https://www.marketprism.co',
      },
    };
    const profileSchema = {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      'mainEntity': personSchema,
      'url': pageUrl,
    };
    const schemaScripts = [
      `<script type="application/ld+json">${JSON.stringify(personSchema)}</script>`,
      `<script type="application/ld+json">${JSON.stringify(profileSchema)}</script>`,
    ].join('\n');
    html = html.replace('</head>', `${schemaScripts}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Author error: ' + err.message);
  }
};

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Exported so other API functions (e.g. blog-post.js) can resolve author name → slug
module.exports.AUTHORS = AUTHORS;
module.exports.slugForAuthor = function(name) {
  if (!name) return null;
  for (const [slug, a] of Object.entries(AUTHORS)) {
    if (a.name === name) return slug;
  }
  return null;
};
