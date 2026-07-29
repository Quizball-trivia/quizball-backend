/**
 * The zero-accepts invariant, proven against a REAL database (§1.12).
 *
 * The service-level guard in `acceptChallenge` is covered by unit tests, but
 * the last-layer guard lives inside the `updateStatus` SQL — and a predicate
 * that exists only in a template string is worth executing at least once. If
 * the `${status}::text <> 'accepted'` cast or the correlated `i.to_user_id`
 * reference were wrong, the unit tests would still pass while production
 * silently accepted challenges for bots.
 *
 * Asserts both directions: a bot target cannot reach 'accepted', a human can,
 * and the non-accept statuses the decline worker depends on stay available for
 * bots.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import '../setup.js';

import { sql } from '../../src/db/index.js';
import { lobbyChallengeInvitationsRepo } from '../../src/modules/lobbies/lobby-challenge-invitations.repo.js';

const SUFFIX = `pr12guard${Date.now()}`;
const lobbyId = randomUUID();

// `lobby_challenge_pending_pair_idx` allows only ONE pending invite per
// (from,to) pair, so each case gets its own freshly-minted pair rather than
// reusing two fixed users.
interface Pair { humanId: string; botId: string; }
const pairs: Pair[] = [];

function newPair(): Pair {
  const pair = { humanId: randomUUID(), botId: randomUUID() };
  pairs.push(pair);
  return pair;
}

async function seedPair(pair: Pair, index: number): Promise<void> {
  await sql`
    INSERT INTO users (id, nickname, is_ai, ai_kind)
    VALUES
      (${pair.humanId}, ${`human_${index}_${SUFFIX}`}, false, NULL),
      (${pair.botId}, ${`bot_${index}_${SUFFIX}`}, true, 'persistent')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM lobby_challenge_invitations WHERE lobby_id = ${lobbyId}`;
  await sql`DELETE FROM lobbies WHERE id = ${lobbyId}`;
  const ids = pairs.flatMap((p) => [p.humanId, p.botId]);
  if (ids.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
  }
}

/**
 * A fresh pending invite aimed at the given side of a brand-new user pair.
 * Returns the invitation id.
 */
async function pendingInvite(target: 'bot' | 'human'): Promise<string> {
  const pair = newPair();
  await seedPair(pair, pairs.length);
  const toUserId = target === 'bot' ? pair.botId : pair.humanId;
  const fromUserId = target === 'bot' ? pair.humanId : pair.botId;
  const row = await lobbyChallengeInvitationsRepo.create({
    lobbyId,
    fromUserId,
    toUserId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return row.id;
}

describe('updateStatus — zero-accepts invariant in SQL', () => {
  beforeAll(async () => {
    const host = newPair();
    await seedPair(host, 0);
    await sql`
      INSERT INTO lobbies (id, mode, host_user_id, invite_code, status)
      VALUES (${lobbyId}, 'friendly', ${host.humanId}, ${SUFFIX.slice(0, 6).toUpperCase()}, 'waiting')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('refuses to mark a BOT-targeted challenge accepted', async () => {
    const id = await pendingInvite('bot');

    const result = await lobbyChallengeInvitationsRepo.updateStatus(id, 'accepted');

    expect(result).toBeNull();
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM lobby_challenge_invitations WHERE id = ${id}
    `;
    // Still pending: the write was refused, not silently applied.
    expect(row?.status).toBe('pending');
  });

  it('DOES let the decline worker mark a bot-targeted challenge declined', async () => {
    const id = await pendingInvite('bot');

    const result = await lobbyChallengeInvitationsRepo.updateStatus(id, 'declined');

    expect(result?.status).toBe('declined');
  });

  it('leaves expired and canceled available for bot targets too', async () => {
    const expiredId = await pendingInvite('bot');
    expect((await lobbyChallengeInvitationsRepo.updateStatus(expiredId, 'expired'))?.status)
      .toBe('expired');

    const canceledId = await pendingInvite('bot');
    expect((await lobbyChallengeInvitationsRepo.updateStatus(canceledId, 'canceled'))?.status)
      .toBe('canceled');
  });

  it('still accepts a HUMAN-targeted challenge — the guard must not block real players', async () => {
    const id = await pendingInvite('human');

    const result = await lobbyChallengeInvitationsRepo.updateStatus(id, 'accepted');

    expect(result?.status).toBe('accepted');
  });

  it('keeps the pending-only CAS: a settled invite cannot be re-flipped', async () => {
    const id = await pendingInvite('human');
    await lobbyChallengeInvitationsRepo.updateStatus(id, 'declined');

    // Second writer (another replica) loses cleanly.
    expect(await lobbyChallengeInvitationsRepo.updateStatus(id, 'accepted')).toBeNull();
    expect(await lobbyChallengeInvitationsRepo.updateStatus(id, 'declined')).toBeNull();
  });
});
