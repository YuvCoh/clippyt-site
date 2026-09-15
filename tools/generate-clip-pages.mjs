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

const res = await fetch(
  `${supabaseUrl}/rest/v1/clips?select=id,title,description,thumbnail_url,start_time,end_time,platform,video_id,video_url,is_private&is_private=eq.false&order=created_at.desc&limit=5000`,
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
  const desc = `${range} · ${lenLabel} · ${c.description ? c.description.trim().slice(0, 120) + ' · ' : ''}Plays exactly this moment. Made with ClippYT.`;
  const url = `${site}/clip/${c.id}`;
  let image = c.thumbnail_url || `${site}/og-image.png`;
  if (c.platform === 'youtube' && c.video_id && /^[A-Za-z0-9_-]{11}$/.test(c.video_id)) {
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
