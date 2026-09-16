#!/usr/bin/env node
/**
 * RLS policy matrix (QA review item 8). Runs nightly from the public site
 * repo and after every migration. Uses only the public anon key plus two
 * dedicated test accounts (rls-test-a / rls-test-b, no admin role).
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… RLS_TEST_PASSWORD=… node tools/rls-check.mjs
 *
 * Every clip it creates is titled 'ClippYT smoke test' so the hourly pg_cron
 * sweep removes them; it also deletes what it can itself.
 */
const URL_ = process.env.SUPABASE_URL || 'https://mkxcxogebotrmipqunwl.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY;
const PW = process.env.RLS_TEST_PASSWORD;
if (!ANON || !PW) {
  console.error('rls-check: SUPABASE_ANON_KEY and RLS_TEST_PASSWORD are required');
  process.exit(2);
}
const TITLE = 'ClippYT smoke test';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const rest = async (path, { method = 'GET', token = ANON, body, prefer } = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* empty body */
  }
  return { status: r.status, data };
};
const login = async email => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(d)}`);
  return { token: d.access_token, id: d.user.id };
};
const clipRow = (owner, extra = {}) => ({
  owner_id: owner,
  title: TITLE,
  description: 'rls matrix',
  video_url: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
  platform: 'youtube',
  video_id: 'UF8uR6Z6KLc',
  start_time: 0,
  end_time: 2,
  thumbnail_url: '',
  is_private: false,
  settings: { muted: false, controls: true, autoplay: false, rel: false },
  ...extra,
});

const A = await login('rls-test-a@clippyt.com');
const B = await login('rls-test-b@clippyt.com');
const created = [];

// 1. anon can create a public clip and read it back
let r = await rest('clips', { method: 'POST', body: clipRow(null), prefer: 'return=representation' });
const anonClip = r.status === 201 && r.data?.[0]?.id;
check('anon can insert a public clip (and RETURNING passes the SELECT policy)', !!anonClip, `status ${r.status}`);
if (anonClip) created.push(anonClip);

// 2. anon cannot update an ownerless clip
r = await rest(`clips?id=eq.${anonClip}`, { method: 'PATCH', body: { title: 'hacked' }, prefer: 'return=representation' });
check('anon cannot update an ownerless clip', r.status < 300 && Array.isArray(r.data) && r.data.length === 0, `status ${r.status}, rows ${r.data?.length}`);

// 3. a user creates a clip; another user cannot update it; the owner can
r = await rest('clips', { method: 'POST', token: A.token, body: clipRow(A.id), prefer: 'return=representation' });
const aClip = r.status === 201 && r.data?.[0]?.id;
check('user A can insert own clip', !!aClip, `status ${r.status}`);
if (aClip) created.push(aClip);
r = await rest(`clips?id=eq.${aClip}`, { method: 'PATCH', token: B.token, body: { title: 'hacked' }, prefer: 'return=representation' });
check("user B cannot update A's clip", r.status < 300 && r.data?.length === 0, `status ${r.status}, rows ${r.data?.length}`);
r = await rest(`clips?id=eq.${aClip}`, { method: 'PATCH', token: A.token, body: { description: 'edited by owner' }, prefer: 'return=representation' });
check('user A can update own clip', r.status < 300 && r.data?.[0]?.description === 'edited by owner', `status ${r.status}`);

// 4. private clips are invisible to others and to anon
r = await rest('clips', { method: 'POST', token: A.token, body: clipRow(A.id, { is_private: true }), prefer: 'return=representation' });
const privClip = r.status === 201 && r.data?.[0]?.id;
check('user A can insert a private clip', !!privClip, `status ${r.status}`);
if (privClip) created.push(privClip);
r = await rest(`clips?id=eq.${privClip}&select=id`, { token: B.token });
check("user B cannot see A's private clip", r.status === 200 && r.data?.length === 0, `rows ${r.data?.length}`);
r = await rest(`clips?id=eq.${privClip}&select=id`);
check("anon cannot see A's private clip", r.status === 200 && r.data?.length === 0, `rows ${r.data?.length}`);
r = await rest(`clips?id=eq.${privClip}&select=id`, { token: A.token });
check('user A can see own private clip', r.status === 200 && r.data?.length === 1, `rows ${r.data?.length}`);

// 5. view counter guard: two hits within 5 s count once
await rest('rpc/increment_clip_views', { method: 'POST', body: { clip_id: anonClip } });
await rest('rpc/increment_clip_views', { method: 'POST', body: { clip_id: anonClip } });
r = await rest(`clips?id=eq.${anonClip}&select=view_count`);
check('increment_clip_views ignores a repeat hit within 5 s', r.data?.[0]?.view_count === 1, `view_count ${r.data?.[0]?.view_count}`);

// 6. loop_stats is admin-only
r = await rest('rpc/loop_stats', { method: 'POST', body: { days: 7 } });
check('anon cannot call loop_stats', r.status >= 400, `status ${r.status}`);
r = await rest('rpc/loop_stats', { method: 'POST', token: A.token, body: { days: 7 } });
check('non-admin user gets no loop_stats rows', r.status < 300 && Array.isArray(r.data) && r.data.length === 0, `status ${r.status}, rows ${r.data?.length}`);

// 7. loop_events: anyone can insert, nobody can read
r = await rest('loop_events', { method: 'POST', body: { event: 'recipient_view', clip_id: anonClip, platform: 'youtube', session_id: 'rls-check' }, prefer: 'return=minimal' });
check('anon can log a loop event', r.status === 201, `status ${r.status}`);
r = await rest('loop_events?select=id&limit=1');
check('anon cannot read loop events', r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0), `status ${r.status}`);

// 8. profiles: cannot escalate own admin_role
r = await rest(`profiles?id=eq.${A.id}`, { method: 'PATCH', token: A.token, body: { admin_role: 'super_admin' }, prefer: 'return=representation' });
const escalated = r.status < 300 && r.data?.[0]?.admin_role === 'super_admin';
check('user cannot grant themselves admin_role', !escalated, `status ${r.status}, admin_role ${r.data?.[0]?.admin_role}`);
if (escalated) await rest(`profiles?id=eq.${A.id}`, { method: 'PATCH', token: A.token, body: { admin_role: null } });

// 9. user_preferences are private to their owner
await rest('user_preferences', { method: 'POST', token: A.token, body: { user_id: A.id, theme: 'dark' }, prefer: 'resolution=merge-duplicates,return=minimal' });
r = await rest(`user_preferences?user_id=eq.${A.id}&select=theme`, { token: B.token });
check("user B cannot read A's preferences", r.status === 200 && r.data?.length === 0, `rows ${r.data?.length}`);

// cleanup (owner deletes own; anon clip is swept by pg_cron via its title)
for (const id of created) await rest(`clips?id=eq.${id}`, { method: 'DELETE', token: A.token });
await rest(`user_preferences?user_id=eq.${A.id}`, { method: 'DELETE', token: A.token });

const failed = results.filter(x => !x.ok);
console.log(`\nrls-check: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
