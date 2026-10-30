import 'express-async-errors';
import request from 'supertest';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasTestDb, setupG1Env, type G1Env } from '../guess-the-goal/g1-test-env.js';

const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isReady: true, ping: async () => 'PONG' }),
}));

interface State {
  playId: string;
  step: 'card1' | 'between' | 'card2' | 'done';
  deadline: string | null;
  score: number;
  card: { id: string; options: unknown[] } | null;
  results: Array<{ pick: number | null; right: boolean; points: number; fake: number; timedOut: boolean; card: { id: string } }>;
  finished: { playId: string; score: number; sent: boolean } | null;
}

// Every generated card's fake is option 2.
const FAKE = 2;
const WRONG = 0;

describe.skipIf(!hasTestDb)('Freecroco Fake Fact on real Postgres', { timeout: 30_000 }, () => {
  let env: G1Env;
  let service: typeof import('../../../../src/modules/partners/games/fake-fact/fake-fact.service.js');

  beforeAll(async () => {
    env = await setupG1Env(db, 'ff');
    service = await import('../../../../src/modules/partners/games/fake-fact/fake-fact.service.js');
    await env.seedFakeFactCards(6, 'easy');
    await env.seedFakeFactCards(6, 'medium');
    await env.seedFakeFactCards(6, 'hard');
  }, 60_000);
  afterAll(async () => env?.close(), 60_000);

  const as = (access: string) => ({
    get: (path: string) => request(env.app).get(`/partner/v1/games/fake-fact/${path}`).set('authorization', `Bearer ${access}`),
    post: (path: string, body: object = {}) =>
      request(env.app).post(`/partner/v1/games/fake-fact/${path}`).set('authorization', `Bearer ${access}`).send(body),
  });
  const start = async (access: string): Promise<State> => {
    const res = await as(access).post('start', { client_nonce: `nonce${Math.random().toString(36).slice(2, 12)}` });
    expect(res.status).toBe(201);
    return res.body;
  };
  const answer = async (access: string, playId: string, card: 0 | 1, option: number) => {
    const res = await as(access).post(`plays/${playId}/answer`, { card, option });
    expect(res.status).toBe(200);
    return res.body as State;
  };
  const pastDeadline = (playId: string) =>
    env.sql`UPDATE partner_fake_fact_plays SET deadline = clock_timestamp() - interval '5 seconds' WHERE play_id = ${playId}`;

  it('scores 140 for both cards right, as one event, and never sends a card\'s answer before it is settled', async () => {
    const p = await env.launch();
    const started = await start(p.access);
    expect(started.step).toBe('card1');
    expect(started.card).not.toBeNull();
    expect(JSON.stringify(started)).not.toMatch(/"fake"|explain/);

    const afterMain = await answer(p.access, started.playId, 0, FAKE);
    expect(afterMain).toMatchObject({ step: 'between', score: 100, card: null, finished: null });
    expect(afterMain.results).toMatchObject([{ pick: FAKE, right: true, points: 100, fake: FAKE }]);

    const bonus = (await as(p.access).post(`plays/${started.playId}/next`)).body as State;
    expect(bonus.step).toBe('card2');
    expect(bonus.card!.id).not.toBe(started.card!.id);
    expect(JSON.stringify(bonus.card)).not.toMatch(/"fake"|explain/);

    const done = await answer(p.access, started.playId, 1, FAKE);
    expect(done).toMatchObject({ step: 'done', score: 140, finished: { score: 140, sent: true } });
    expect(await env.events(p.externalId)).toMatchObject([{ game_id: 'fake-fact', score: 140 }]);
  });

  it('a wrong card 1 ends the play with 0; a wrong bonus keeps the 100', async () => {
    const a = await env.launch();
    const playA = await start(a.access);
    expect(await answer(a.access, playA.playId, 0, WRONG)).toMatchObject({ step: 'done', finished: { score: 0, sent: true } });
    expect(await env.events(a.externalId)).toMatchObject([{ game_id: 'fake-fact', score: 0 }]);
    // A wrong first answer never opens the bonus.
    expect((await as(a.access).post(`plays/${playA.playId}/next`)).status).toBe(409);

    const b = await env.launch();
    const playB = await start(b.access);
    await answer(b.access, playB.playId, 0, FAKE);
    await as(b.access).post(`plays/${playB.playId}/next`);
    expect(await answer(b.access, playB.playId, 1, WRONG)).toMatchObject({ finished: { score: 100 } });
  });

  it('a retried answer gets the stored result; a different second answer to the same card is refused', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await answer(p.access, play.playId, 0, FAKE);
    expect(await answer(p.access, play.playId, 0, FAKE)).toMatchObject({ step: 'between', score: 100 });
    expect((await as(p.access).post(`plays/${play.playId}/answer`, { card: 0, option: WRONG })).status).toBe(409);
    // Answering the bonus before it is opened is stale.
    expect((await as(p.access).post(`plays/${play.playId}/answer`, { card: 1, option: FAKE })).status).toBe(409);
    expect(await env.events(p.externalId)).toHaveLength(0);
  });

  it('time out: card 1 scores 0 and a bonus left open keeps 100, both dated at the deadline', async () => {
    const a = await env.launch();
    const playA = await start(a.access);
    await pastDeadline(playA.playId);
    const late = await answer(a.access, playA.playId, 0, FAKE);
    expect(late).toMatchObject({ step: 'done', finished: { score: 0 } });
    expect(late.results).toMatchObject([{ pick: null, timedOut: true, points: 0 }]);

    const b = await env.launch();
    const playB = await start(b.access);
    await answer(b.access, playB.playId, 0, FAKE);
    await as(b.access).post(`plays/${playB.playId}/next`);
    await pastDeadline(playB.playId);
    expect(await service.partnerFakeFactService.sweepOverdue()).toBeGreaterThanOrEqual(1);
    const [deadline] = await env.sql<{ deadline: Date }[]>`SELECT deadline FROM partner_fake_fact_plays WHERE play_id = ${playB.playId}`;
    const [event] = await env.events(b.externalId);
    expect(event).toMatchObject({ game_id: 'fake-fact', score: 100 });
    expect(event.occurred_at.getTime()).toBe(deadline.deadline.getTime());
  });

  it('an answer inside the 1 s grace still counts', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await env.sql`UPDATE partner_fake_fact_plays SET deadline = clock_timestamp() - interval '400 milliseconds' WHERE play_id = ${play.playId}`;
    expect(await answer(p.access, play.playId, 0, FAKE)).toMatchObject({ step: 'between', score: 100 });
  });

  it('a bonus never opened ends with the 100, and its card is neither revealed nor counted as shown', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await answer(p.access, play.playId, 0, FAKE);
    await pastDeadline(play.playId);
    const ended = (await as(p.access).get(`plays/${play.playId}`)).body as State;
    expect(ended).toMatchObject({ step: 'done', finished: { score: 100 } });
    const [row] = await env.sql<{ card_ids: string[]; shown_ids: string[] }[]>`
      SELECT card_ids, shown_ids FROM partner_fake_fact_plays WHERE play_id = ${play.playId}`;
    expect(row.shown_ids).toEqual([row.card_ids[0]]);
    expect(JSON.stringify(ended)).not.toContain(row.card_ids[1]);
  });

  it('a block landing during a read reveals nothing of the open card', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    const res = await env.blockDuring(p.playerId, () => as(p.access).get(`plays/${play.playId}`));
    if (res.status === 200) expect(res.body).toMatchObject({ step: 'done', card: null, results: [], finished: { sent: false } });
    expect(await env.events(p.externalId)).toHaveLength(0);
  });

  it('opening the bonus has no late grace: past its 2 minutes the play ends with the 100', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await answer(p.access, play.playId, 0, FAKE);
    await env.sql`UPDATE partner_fake_fact_plays SET deadline = clock_timestamp() - interval '400 milliseconds' WHERE play_id = ${play.playId}`;
    const res = await as(p.access).post(`plays/${play.playId}/next`);
    expect(res.body).toMatchObject({ step: 'done', card: null, finished: { score: 100 } });
  });

  it('reopening the game after its time ran out shows how it ended, not a fresh start', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await answer(p.access, play.playId, 0, FAKE);
    await as(p.access).post(`plays/${play.playId}/next`);
    await pastDeadline(play.playId);
    const current = (await as(p.access).get('current')).body as { play: State | null };
    expect(current.play).toMatchObject({ playId: play.playId, step: 'done', finished: { score: 100, sent: true } });
    expect(current.play!.results).toHaveLength(2);
  });

  it('when the sweeper settled the play first, current still offers its result as `last`', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    await answer(p.access, play.playId, 0, FAKE);
    await pastDeadline(play.playId);
    await service.partnerFakeFactService.sweepOverdue();
    const current = (await as(p.access).get('current')).body as { play: State | null; last: State | null };
    expect(current.play).toBeNull();
    expect(current.last).toMatchObject({ playId: play.playId, step: 'done', finished: { score: 100, sent: true } });
  });

  it('keeps scanning past cards it cannot use', async () => {
    // Broken payloads (schema-invalid) sort among the valid ones; a deal must still find a valid card.
    for (let i = 0; i < 120; i += 1) {
      await env.sql`INSERT INTO room_pool (game, item_id, difficulty, payload)
        VALUES ('dato_falso', ${`ff-broken-${i}`}, ${i % 2 ? 'easy' : 'medium'}, ${env.sql.json({ id: `ff-broken-${i}` })})`;
    }
    try {
      for (let i = 0; i < 3; i += 1) {
        const p = await env.launch();
        const play = await start(p.access);
        expect(play.card).not.toBeNull();
      }
    } finally {
      await env.sql`DELETE FROM room_pool WHERE item_id LIKE 'ff-broken-%'`;
    }
  });

  it('a block mid-play cancels it: no event, nothing of the card revealed', async () => {
    const p = await env.launch();
    const play = await start(p.access);
    const res = await env.blockDuring(p.playerId, () => as(p.access).post(`plays/${play.playId}/answer`, { card: 0, option: FAKE }));
    if (res.status === 200) {
      expect(res.body).toMatchObject({ step: 'done', results: [], finished: { score: 0, sent: false } });
      expect(JSON.stringify(res.body)).not.toMatch(/"fake"|explain/);
    }
    expect(await env.events(p.externalId)).toHaveLength(0);
  });

  it('one play a day; a retried start returns the open play', async () => {
    const p = await env.launch();
    const nonce = 'retry-nonce-123';
    const first = (await as(p.access).post('start', { client_nonce: nonce })).body as State;
    const again = (await as(p.access).post('start', { client_nonce: nonce })).body as State;
    expect(again.playId).toBe(first.playId);
    await answer(p.access, first.playId, 0, WRONG);
    expect((await as(p.access).post('start', { client_nonce: 'another-nonce-1' })).status).toBe(409);
  });

  it('deals cards the player has not been shown first, the bonus from medium or hard, never the same footballer', async () => {
    const p = await env.launch();
    await env.setLimit('fake-fact', 6);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const play = await start(p.access);
      const [row] = await env.sql<{ card_ids: string[]; cards: Array<{ difficulty: string; player: { id: string } }> }[]>`
        SELECT card_ids, cards FROM partner_fake_fact_plays WHERE play_id = ${play.playId}`;
      // Answered wrong below: only card 1 was shown, so only it may never come back while unseen ones remain.
      expect(['easy', 'medium']).toContain(row.cards[0].difficulty);
      expect(['medium', 'hard']).toContain(row.cards[1].difficulty);
      expect(row.cards[0].player.id).not.toBe(row.cards[1].player.id);
      expect(seen.has(row.card_ids[0])).toBe(false);
      seen.add(row.card_ids[0]);
      await answer(p.access, play.playId, 0, WRONG);
    }
    await env.setLimit('fake-fact', 1);
  });
});
