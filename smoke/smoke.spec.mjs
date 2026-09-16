// Three journeys that must never break on clippyt.com:
//   1. paste → mark → save (creates an anonymous clip titled exactly
//      'ClippYT smoke test'; a DB trigger makes it private/hidden and a
//      pg_cron job deletes it within the hour)
//   2. a shared link plays (player iframe mounts on /clip/<id>)
//   3. the static preview page carries the right Open Graph tags
import { test, expect } from '@playwright/test';

const SEED_CLIP = process.env.SMOKE_SEED_CLIP || 'a0000000-0000-4000-8000-000000000001';
const VIDEO_URL = process.env.SMOKE_VIDEO_URL || 'https://www.youtube.com/watch?v=UF8uR6Z6KLc';
const SMOKE_TITLE = 'ClippYT smoke test';
// Canonical/OG URLs are always the public site, even when the pages are served from a local preview.
const SITE = process.env.SMOKE_SITE || 'https://clippyt.com';

test.describe.configure({ mode: 'serial' });

// If YouTube ever blocks the Actions runner IPs from embedding, set the repo
// variable SMOKE_PLAYER=off to keep the OG check while skipping player tests.
const playerTests = process.env.SMOKE_PLAYER !== 'off';

test('paste → mark → save', async ({ page }) => {
  test.skip(!playerTests, 'SMOKE_PLAYER=off');
  await page.goto('/');
  const link = page.getByLabel('Video link');
  await expect(link).toBeVisible();
  await link.fill(VIDEO_URL);

  // The player mounts (YouTube iframe inside the player container)
  // (the YouTube API replaces the container div with the iframe itself)
  const iframe = page.locator('main iframe').first();
  await expect(iframe).toBeVisible({ timeout: 45_000 });

  // Mark buttons enable once the video can play
  const endHere = page.getByRole('button', { name: /Set end here/ });
  await expect(endHere).toBeEnabled({ timeout: 45_000 });
  await endHere.click();

  // Save
  await page.getByLabel('Clip title').fill(SMOKE_TITLE);
  const save = page.getByRole('button', { name: 'Save Clipp' });
  await expect(save).toBeEnabled();
  await save.click();

  // Lands on the clip page with a share action
  await expect(page).toHaveURL(/\/clip\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
});

test('shared link plays', async ({ page }) => {
  test.skip(!playerTests, 'SMOKE_PLAYER=off');
  await page.goto(`/clip/${SEED_CLIP}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  const iframe = page.locator('main iframe').first();
  await expect(iframe).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
});

test('preview page has Open Graph tags', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/clip/${SEED_CLIP}/`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/<meta property="og:title" content="[^"]+"/);
  expect(html).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+"/);
  expect(html).toMatch(new RegExp(`<meta property="og:url" content="${SITE}/clip/${SEED_CLIP}"`));
  expect(html).toMatch(/<meta name="twitter:card" content="(player|summary_large_image)"/);
  expect(html).not.toMatch(/<title>ClippYT<\/title>/);
});

test('SEO surfaces: sitemap index, platform page, VideoObject, oEmbed', async ({ request, baseURL }) => {
  const idx = await request.get(`${baseURL}/sitemap.xml`);
  expect(idx.status()).toBe(200);
  const idxXml = await idx.text();
  expect(idxXml).toContain('<sitemapindex');
  expect(idxXml).toContain('/sitemap-clips.xml');

  const clips = await request.get(`${baseURL}/sitemap-clips.xml`);
  expect(clips.status()).toBe(200);
  expect(await clips.text()).toContain(`/clip/${SEED_CLIP}`);

  const yt = await request.get(`${baseURL}/clip-youtube-video/`);
  expect(yt.status()).toBe(200);
  const ytHtml = await yt.text();
  expect(ytHtml).toMatch(/<link rel="canonical" href="[^"]*\/clip-youtube-video"/);
  expect(ytHtml).toContain('"@type":"FAQPage"');

  const clipHtml = await (await request.get(`${baseURL}/clip/${SEED_CLIP}/`)).text();
  expect(clipHtml).toContain('"@type":"VideoObject"');
  expect(clipHtml).toContain('"@type":"Clip"');
  const m = clipHtml.match(/type="application\/json\+oembed" href="([^"]+)"/);
  expect(m).not.toBeNull();
  const oembed = await request.get(m[1].replace(/&amp;/g, '&'));
  expect(oembed.status()).toBe(200);
  const body = await oembed.json();
  expect(body.type).toBe('video');
  expect(body.html).toContain(`/embed/${SEED_CLIP}`);
});

// ---------------------------------------------------------------------------
// QA review items 4: the platforms automation cannot *play* still have to
// mount, and the trim page's Preview must never run past the end handle.
// ---------------------------------------------------------------------------
const VIMEO_CLIP = process.env.SMOKE_VIMEO_CLIP || 'bd900798-a2fe-464f-8421-962d8e8a1249';
const DAILYMOTION_CLIP = process.env.SMOKE_DAILYMOTION_CLIP || '4290b782-b6b0-465f-97b8-39b37febd2f7';

for (const [name, id] of [['Vimeo', VIMEO_CLIP], ['Dailymotion', DAILYMOTION_CLIP]]) {
  test(`${name} clip page mounts its player without an error`, async ({ page }) => {
    test.skip(!playerTests, 'SMOKE_PLAYER=off');
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`/clip/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    // The platform iframe must be present within the player box
    await expect(page.locator('main iframe').first()).toBeVisible({ timeout: 45_000 });
    // No error toast and no uncaught exception within 10 s of mounting
    await page.waitForTimeout(10_000);
    await expect(page.getByRole('alert').filter({ hasText: /fail|error|unavailable/i })).toHaveCount(0);
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}

test('trim page: Preview never runs past the end handle', async ({ page }) => {
  test.skip(!playerTests, 'SMOKE_PLAYER=off');
  // Deep link: start at 0:05 on a video the seed clip uses
  await page.goto(`/?u=${encodeURIComponent(VIDEO_URL)}&t=5`);
  const endHere = page.getByRole('button', { name: /Set end here/ });
  await expect(endHere).toBeEnabled({ timeout: 60_000 });

  // Make a 3-second selection: End here is "now" (0:05 after the deep link),
  // so nudge the end later three times with the +1s control.
  const later = page.getByRole('button', { name: /End later by 1 second/ });
  await expect(later).toBeVisible();
  await later.click();
  await later.click();
  await later.click();

  await page.getByRole('button', { name: 'Loop selection' }).click();
  // The selection summary shows "m:ss → m:ss"; read the end handle.
  const summary = page.locator('text=/\\d+:\\d\\d\\s*→\\s*\\d+:\\d\\d/').first();
  await expect(summary).toBeVisible();
  const endText = (await summary.innerText()).match(/→\s*(\d+):(\d\d)/);
  expect(endText).not.toBeNull();
  const endSec = Number(endText[1]) * 60 + Number(endText[2]);

  // Sample the playhead for 12 s; it must stay ≤ end handle (+1 s coarse tick).
  const playhead = page.getByLabel('Playhead');
  let maxSeen = 0;
  for (let i = 0; i < 12; i++) {
    const t = (await playhead.innerText()).match(/(\d+):(\d\d)/);
    if (t) maxSeen = Math.max(maxSeen, Number(t[1]) * 60 + Number(t[2]));
    await page.waitForTimeout(1000);
  }
  expect(maxSeen, `playhead reached ${maxSeen}s, end handle is ${endSec}s`).toBeLessThanOrEqual(endSec + 1);
});
