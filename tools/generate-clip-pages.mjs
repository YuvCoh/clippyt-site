#!/usr/bin/env node
/**
 * Per-clip link previews for a static host.
 *
 * Writes <out>/clip/<id>/index.html for every public clipp: a copy of the
 * built index.html whose <title>, description, Open Graph and Twitter tags
 * describe THAT clipp (title, start-frame image, range), so the link unfurls
 * properly in WhatsApp / Slack / iMessage / X. The page still boots the SPA.
 *
 *   node scripts/generate-clip-pages.mjs --dist dist \
 *     --supabase-url https://xxx.supabase.co --anon-key eyJ... [--site https://clippyt.com]
 *
 * Env fallbacks: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (also read from .env.production).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, [])
);

async function envFromFile(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const dist = args.dist || 'dist';
const site = (args.site || 'https://clippyt.com').replace(/\/$/, '');
const fileEnv = await envFromFile('.env.production');
const supabaseUrl = args['supabase-url'] || process.env.VITE_SUPABASE_URL || fileEnv.VITE_SUPABASE_URL;
const anonKey = args['anon-key'] || process.env.VITE_SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error('generate-clip-pages: missing Supabase URL / anon key');
  process.exit(1);
}

// oEmbed provider endpoint (Supabase edge function `oembed`)
const oembedEndpoint = args.oembed || process.env.OEMBED_ENDPOINT || `${supabaseUrl}/functions/v1/oembed`;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = s => {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
const setMeta = (html, attr, key, value) => {
  const re = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="[^"]*"\\s*/?>`, 'i');
  const tag = `<meta ${attr}="${key}" content="${esc(value)}" />`;
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
};

// Cap (item 7 of the architecture review): static pages are generated for the
// most recent N public clipps only. Older clipps still work — the SPA
// fallback (404.html) serves them, they just unfurl with the generic card.
// Raise via --limit or CLIP_PAGES_LIMIT when the corpus grows; the practical
// ceiling is the ~1 GB Pages repo and the 20-minute refresh job.
const limit = Math.max(1, parseInt(args.limit || process.env.CLIP_PAGES_LIMIT || '2000', 10) || 2000);

const res = await fetch(
  `${supabaseUrl}/rest/v1/clips?select=id,title,description,thumbnail_url,thumbnail_frame,video_title,video_duration,start_time,end_time,platform,video_id,video_url,is_private,created_at,updated_at&is_private=eq.false&title=neq.${encodeURIComponent('ClippYT smoke test')}&order=created_at.desc&limit=${limit}`,
  { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
);
if (!res.ok) {
  console.error('generate-clip-pages: Supabase query failed', res.status, await res.text());
  process.exit(1);
}
const clips = await res.json();
const base = await fs.readFile(path.join(dist, 'index.html'), 'utf8');

let written = 0;
for (const c of clips) {
  const title = (c.title || 'A clipp').trim();
  const range = `${fmt(c.start_time)} → ${fmt(c.end_time)}`;
  const len = Math.max(0, c.end_time - c.start_time);
  const lenLabel = len >= 60 ? fmt(len) : `${Math.round(len)} s`;
  const vt = (c.video_title || '').trim();
  const fromVideo = vt && vt !== title ? ` from "${vt.slice(0, 90)}"` : '';
  // Prose, not a range string: "A 12-second moment from "Video" (4:10 → 4:22). …"
  const lenWord = len >= 60 ? `${fmt(len)}-long` : `${Math.round(len)}-second`;
  const desc = `A ${lenWord} moment${fromVideo} (${range}).${c.description ? ' ' + c.description.trim().slice(0, 120).replace(/[.!?]+$/, '') + '.' : ''} Plays exactly this part and stops. Made with ClippYT.`;
  const url = `${site}/clip/${c.id}`;
  let image = c.thumbnail_frame || c.thumbnail_url || `${site}/og-image.png`;
  if (!c.thumbnail_frame && c.platform === 'youtube' && c.video_id && /^[A-Za-z0-9_-]{11}$/.test(c.video_id)) {
    // Larger frame than the stored mq thumbnail; same frame index if one was chosen
    const m = (c.thumbnail_url || '').match(/\/vi\/[^/]+\/(1|2|3)\.jpg/);
    image = m ? `https://i.ytimg.com/vi/${c.video_id}/hq${m[1]}.jpg` : `https://i.ytimg.com/vi/${c.video_id}/hqdefault.jpg`;
  }

  let html = base;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)} · ClippYT</title>`);
  html = setMeta(html, 'name', 'description', desc);
  html = setMeta(html, 'property', 'og:type', 'video.other');
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', desc);
  html = setMeta(html, 'property', 'og:image', image);
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  html = setMeta(html, 'name', 'twitter:url', url);
  html = setMeta(html, 'name', 'twitter:title', title);
  html = setMeta(html, 'name', 'twitter:description', desc);
  html = setMeta(html, 'name', 'twitter:image', image);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${esc(url)}" />`);
  if (c.platform === 'youtube' && c.video_id) {
    const embed = `https://www.youtube.com/embed/${c.video_id}?start=${Math.floor(c.start_time)}&end=${Math.ceil(c.end_time)}&autoplay=1`;
    html = setMeta(html, 'property', 'og:video', embed);
    html = setMeta(html, 'property', 'og:video:secure_url', embed);
    html = setMeta(html, 'property', 'og:video:type', 'text/html');
    html = setMeta(html, 'property', 'og:video:width', '1280');
    html = setMeta(html, 'property', 'og:video:height', '720');
    html = setMeta(html, 'name', 'twitter:card', 'player');
    html = setMeta(html, 'name', 'twitter:player', `${site}/embed/${c.id}`);
    html = setMeta(html, 'name', 'twitter:player:width', '1280');
    html = setMeta(html, 'name', 'twitter:player:height', '720');
  }

  // Structured data: VideoObject with a Clip part (start/end offsets). Replaces
  // the site-wide WebApplication block from index.html.
  const iso = s => `PT${Math.max(1, Math.round(s))}S`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: title,
    description: desc,
    thumbnailUrl: [image],
    uploadDate: c.created_at,
    duration: iso(len),
    embedUrl: `${site}/embed/${c.id}`,
    url,
    isPartOf: vt ? { '@type': 'VideoObject', name: vt, url: c.video_url, ...(c.video_duration ? { duration: iso(c.video_duration) } : {}) } : undefined,
    hasPart: {
      '@type': 'Clip',
      name: title,
      startOffset: Math.floor(c.start_time),
      endOffset: Math.ceil(c.end_time),
      url,
    },
    publisher: { '@type': 'Organization', name: 'ClippYT', url: site },
  };
  if (!ld.isPartOf) delete ld.isPartOf;
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  html = /<script type="application\/ld\+json">[\s\S]*?<\/script>/i.test(html)
    ? html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/i, ldTag)
    : html.replace('</head>', `    ${ldTag}\n  </head>`);

  // oEmbed discovery: pasting a clip link into Notion / WordPress / Medium /
  // Slack renders the player (endpoint: Supabase edge function `oembed`).
  const oembedHref = `${oembedEndpoint}?url=${encodeURIComponent(url)}&format=json`;
  html = html.replace('</head>', `    <link rel="alternate" type="application/json+oembed" href="${esc(oembedHref)}" title="${esc(title)}" />\n  </head>`);

  // /clip/<id> (the share link) and /embed/<id> (iframe target) both get a
  // real 200 page instead of the 404.html SPA fallback.
  for (const kind of ['clip', 'embed']) {
    const dir = path.join(dist, kind, c.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), html);
  }
  written++;
}
console.log(`generate-clip-pages: wrote ${written} clip + embed pages under ${dist}/`);

// ---------------------------------------------------------------------------
// Platform landing pages: a crawlable HTML shell per /clip-<platform>-video
// with its own title/description/canonical (the SPA renders the body).
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
let platformPages = [];
for (const candidate of [path.join(here, 'platform-pages.json'), path.join(here, '..', 'src', 'seo', 'platform-pages.json')]) {
  try {
    platformPages = JSON.parse(await fs.readFile(candidate, 'utf8'));
    break;
  } catch {
    /* try next */
  }
}
for (const p of platformPages) {
  const url = `${site}/${p.slug}`;
  let html = base;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(p.title)} · ClippYT</title>`);
  html = setMeta(html, 'name', 'description', p.description);
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'property', 'og:title', p.title);
  html = setMeta(html, 'property', 'og:description', p.description);
  html = setMeta(html, 'name', 'twitter:url', url);
  html = setMeta(html, 'name', 'twitter:title', p.title);
  html = setMeta(html, 'name', 'twitter:description', p.description);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${esc(url)}" />`);
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (p.faq || []).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  const ldTag = `<script type="application/ld+json">${JSON.stringify(faq).replace(/</g, '\\u003c')}</script>`;
  html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/i, m => `${m}\n    ${ldTag}`);
  const dir = path.join(dist, p.slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), html);
}
console.log(`generate-clip-pages: wrote ${platformPages.length} platform landing pages`);

// ---------------------------------------------------------------------------
// Sitemaps: sitemap.xml becomes an index → sitemap-pages.xml (the static
// list from public/) + sitemap-clips.xml (every public clip, with lastmod).
// Idempotent: on the site repo sitemap.xml is already the index.
// ---------------------------------------------------------------------------
const day = s => (s ? new Date(s).toISOString().slice(0, 10) : undefined);
const sitemapPath = path.join(dist, 'sitemap.xml');
let staticSitemap = '';
try {
  staticSitemap = await fs.readFile(sitemapPath, 'utf8');
} catch {
  /* none */
}
if (staticSitemap && !/<sitemapindex/i.test(staticSitemap)) {
  // Add the platform pages to the static page list if they are missing
  let pages = staticSitemap;
  for (const p of platformPages) {
    if (!pages.includes(`${site}/${p.slug}<`)) {
      pages = pages.replace('</urlset>', `  <url><loc>${site}/${p.slug}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>`);
    }
  }
  await fs.writeFile(path.join(dist, 'sitemap-pages.xml'), pages);
}
const clipUrls = clips
  .map(c => `  <url><loc>${site}/clip/${c.id}</loc>${day(c.updated_at || c.created_at) ? `<lastmod>${day(c.updated_at || c.created_at)}</lastmod>` : ''}<changefreq>monthly</changefreq><priority>0.7</priority></url>`)
  .join('\n');
await fs.writeFile(
  path.join(dist, 'sitemap-clips.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${clipUrls}\n</urlset>\n`
);
// lastmod = newest clip, not "now" — keeps the 20-minute refresh job from
// committing a changed sitemap every day with no real change.
const newest = clips.map(c => day(c.updated_at || c.created_at)).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
await fs.writeFile(
  sitemapPath,
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap><loc>${site}/sitemap-pages.xml</loc><lastmod>${newest}</lastmod></sitemap>\n  <sitemap><loc>${site}/sitemap-clips.xml</loc><lastmod>${newest}</lastmod></sitemap>\n</sitemapindex>\n`
);
console.log(`generate-clip-pages: sitemap index + ${clips.length} clip URLs`);
