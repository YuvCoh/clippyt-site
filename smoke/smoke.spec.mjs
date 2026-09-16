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
  const save = page.getByRole('button', { name: 'Save Clip' });
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
  expect(html).toMatch(new RegExp(`<meta property="og:url" content="${baseURL}/clip/${SEED_CLIP}"`));
  expect(html).toMatch(/<meta name="twitter:card" content="(player|summary_large_image)"/);
  expect(html).not.toMatch(/<title>ClippYT<\/title>/);
});
