// A staging-only, disposable guest fixture. Never edits existing players,
// catalogue rows, awards or production. Removes only the two guests it mints.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { stagingTarget } from './staging-target.ts';
import { hostedGoalVideoUrl } from '../src/modules/guess-the-goal/guess-the-goal.video.ts';

const [flag, envFile, phase, output] = process.argv.slice(2);
assert.equal(flag, '--env-file');
assert.ok(envFile && output && ['baseline', 'verify'].includes(phase), 'Require --env-file <private file> baseline|verify <aggregate output>');
const env = dotenv.parse(readFileSync(envFile));
const url = env.STAGING_DATABASE_URL ?? env.DATABASE_URL;
assert.equal(stagingTarget(url), 'staging');
assert.equal(new URL(env.SUPABASE_URL).origin, 'https://nsdfiprfmhdqhbfxfwpv.supabase.co');
const api = 'https://api-staging.quizball.io';
const db = postgres(url, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
const owned = [];
const checks = [];
const evidence = { at: new Date().toISOString(), phase, api, productionTouched: false, catalogueEdits: 0, accountsCreated: 0, rewardGrants: 0, checks };

async function request(path, token, body, method = body === undefined ? 'GET' : 'POST') {
  assert.ok(path.startsWith('/'));
  const response = await fetch(api + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Quizball-staging-hosted-video-QA/1.0',
      ...(token ? { 'x-guest-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { response, data };
}
async function ok(path, token, body) {
  const result = await request(path, token, body);
  assert.ok(result.response.ok, `${path}: HTTP ${result.response.status}`);
  if (path.includes('/guess-the-goal/')) assert.match(result.response.headers.get('cache-control') ?? '', /no-store/);
  return result.data;
}
function assertClip(outcome, expected) {
  assert.equal(outcome.video_url, expected);
  assert.equal(outcome.clip_start_s, null);
  assert.equal(outcome.clip_end_s, null);
  assert.equal(JSON.stringify(outcome).includes('youtu'), false);
}
function assertNoRewards(outcome) {
  assert.equal(outcome.awards.coins, 0);
  assert.equal(outcome.awards.xp, 0);
  assert.equal(outcome.awards.first_solve, false);
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const state = async (id, guestId) => {
  const rows = await db`SELECT * FROM public.guess_the_goal_sessions WHERE id=${id} AND guest_id=${guestId}`;
  assert.equal(rows.length, 1);
  return rows[0];
};

try {
  assert.equal((await request('/health')).response.status, 200);
  const base = '/api/v1/guess-the-goal';
  for (let i = 0; i < 2; i++) {
    const guest = await ok('/api/v1/guest/session', undefined, { locale: 'en' });
    assert.match(guest.token, /^[a-f0-9]{64}$/);
    assert.match(guest.guest_id, /^[a-f0-9-]{36}$/);
    owned.push({ id: guest.guest_id, token: guest.token });
  }
  const [guest, other] = owned;
  const nonce = `hosted-video-qa-${randomUUID()}`;
  const started = await ok(`${base}/sessions`, guest.token, { client_nonce: nonce });
  const sessionId = started.session_id;
  assert.equal(started.outcome, undefined);
  assert.equal(JSON.stringify(started).includes('is_correct'), false);
  const initial = await state(sessionId, guest.id);
  const [goal] = await db`SELECT mirrored_url, clip_start_s, clip_end_s FROM public.goal_choreographies WHERE id=${initial.goal_id} AND status='published'`;
  const expected = hostedGoalVideoUrl(goal?.mirrored_url);
  assert.ok(expected, 'Fixture goal must already have its real hosted clip');
  assert.equal(goal.clip_start_s, null);
  assert.equal(goal.clip_end_s, null);
  // Recreate only this newly minted guest's legacy media metadata; no answer,
  // timing/scoring or existing session changes. Never patch a catalogue row.
  const patched = await db`UPDATE public.guess_the_goal_sessions
    SET goal_snapshot=goal_snapshot || ${db.json({ mirrored_url: null, video_url: 'https://www.youtube.com/watch?v=legacy-qa', clip_start_s: 150, clip_end_s: 184 })}
    WHERE id=${sessionId} AND guest_id=${guest.id} AND state='active' RETURNING id`;
  assert.equal(patched.length, 1);
  const legacy = await state(sessionId, guest.id);
  const right = legacy.goal_snapshot.options.find((o) => o.is_correct).id;
  const guessed = await ok(`${base}/sessions/${sessionId}/guess`, guest.token, { option_id: right });
  assertNoRewards(guessed);
  if (phase === 'baseline') {
    assert.equal(guessed.video_url, 'https://www.youtube.com/watch?v=legacy-qa');
    checks.push({ check: 'legacy_source_link_reproduced', passed: true, hosted: false });
  } else {
    assertClip(guessed, expected);
    assert.equal(guessed.points, initial.max_points);
    checks.push({ check: 'active_legacy_guess_uses_hosted_clip', passed: true, pointsUnchanged: true, staleSourceWindowRemoved: true });
    const settled = await state(sessionId, guest.id);
    assert.deepEqual(settled.goal_snapshot, legacy.goal_snapshot);
    const retry = await ok(`${base}/sessions/${sessionId}/guess`, guest.token, { option_id: right });
    assertClip(retry, expected);
    assertNoRewards(retry);
    assertClip((await ok(`${base}/sessions/current`, guest.token)).outcome, expected);
    assertClip((await ok(`${base}/sessions`, guest.token, { client_nonce: nonce })).outcome, expected);
    assert.equal(hash(await state(sessionId, guest.id)), hash(settled));
    checks.push({ check: 'resume_nonce_and_guess_retries_preserve_stored_row', passed: true });
    const gallery = await ok(`${base}/gallery`, guest.token);
    assert.equal(gallery.goals.length, 1);
    assertClip(gallery.goals[0], expected);
    checks.push({ check: 'solved_gallery_uses_hosted_clip', passed: true });
    const denied = await request(`${base}/sessions/${sessionId}/guess`, other.token, { option_id: right });
    assert.equal(denied.response.status, 404);
    checks.push({ check: 'different_guest_cannot_read_or_settle_fixture', passed: true, status: 404 });
    if (legacy.goal_snapshot.bonus) {
      const option_id = legacy.goal_snapshot.bonus.options.find((o) => o.is_correct).id;
      assertNoRewards(await ok(`${base}/sessions/${sessionId}/bonus`, guest.token, { option_id }));
      const completed = await state(sessionId, guest.id);
      assertClip(await ok(`${base}/sessions/${sessionId}/guess`, guest.token, { option_id: right }), expected);
      assert.equal(hash(await state(sessionId, guest.id)), hash(completed));
      checks.push({ check: 'completed_guess_replay_after_bonus', passed: true });
    }
    const clips = await db`SELECT mirrored_url FROM public.goal_choreographies WHERE status='published'`;
    for (const clip of clips) {
      const url = hostedGoalVideoUrl(clip.mirrored_url);
      assert.ok(url);
      const response = await fetch(url, { headers: { Range: 'bytes=0-31' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 206);
      assert.match(response.headers.get('content-type') ?? '', /video\/mp4/i);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
    }
    checks.push({ check: 'published_hosted_clips_range_playback', passed: true, clips: clips.length, status: 206 });
  }
} finally {
  // Exact fixture ownership + token hash prevents ever deleting someone else's guest.
  for (const guest of owned) {
    const rows = await db`DELETE FROM public.guest_sessions WHERE id=${guest.id}
      AND token_hash=${createHash('sha256').update(guest.token).digest('hex')} RETURNING id`;
    assert.equal(rows.length, 1);
  }
  evidence.disposableGuestsRemoved = owned.length;
  await db.end({ timeout: 5 });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
