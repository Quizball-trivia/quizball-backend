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
  version: number;
  state: string;
  index: number;
  score: number;
  current: { ref: string; points: number; open: string[]; clues: Record<string, unknown> } | null;
  resolved: Array<{ ref: string; solved: boolean; points: number; card: { name: string } }>;
  finished: { playId: string; score: number; sent: boolean } | null;
}

describe.skipIf(!hasTestDb)('Freecroco Card Detective on real Postgres', { timeout: 30_000 }, () => {
  let env: G1Env;
  let service: typeof import('../../../../src/modules/partners/games/card-detective/cd-partner.service.js');
  let publicIds: string[] = [];

  beforeAll(async () => {
    env = await setupG1Env(db, 'cd');
    service = await import('../../../../src/modules/partners/games/card-detective/cd-partner.service.js');
    await env.seedCards(12);
    // Today's public Card Detective set, and a second card of one of its players (same name, other edition).
    publicIds = await env.seedCards(3, 'Public');
    const [twin] = await env.sql<{ id: string }[]>`
      INSERT INTO fifa_cards (source_key, edition, edition_label, name, accepted, overall, position, nation, nation_code,
        league, club, pac, sho, pas, dri, def, phy, difficulty)
      SELECT 'test:twin', 'fc23', 'FC 23', name, accepted, 79, position, nation, nation_code, league, club,
        pac, sho, pas, dri, def, phy, difficulty FROM fifa_cards WHERE id = ${publicIds[0]}
      RETURNING id`;
    publicIds.push(twin.id);
    await env.sql`INSERT INTO daily_card_detective_sets (challenge_day, card_ids)
      VALUES ((now() AT TIME ZONE 'UTC')::date, ${env.sql.array(publicIds.slice(0, 3))}::uuid[])`;
    // FIFA Cards is live but nobody has opened it today: partner deals must not create its set.
    await env.sql`INSERT INTO daily_challenge_configs (challenge_type, is_active, settings)
      VALUES ('fifaCards', true, ${env.sql.json({ cardCount: 2 })}), ('cardDetective', true, ${env.sql.json({ cardCount: 3 })})`;
  }, 60_000);
  afterAll(async () => env?.close(), 60_000);

  const as = (access: string) => ({
    get: (path: string) => request(env.app).get(`/partner/v1/games/card-detective/${path}`).set('authorization', `Bearer ${access}`),
    post: (path: string, body: object = {}) =>
      request(env.app).post(`/partner/v1/games/card-detective/${path}`).set('authorization', `Bearer ${access}`).send(body),
  });
  const start = async (access: string): Promise<State> => {
    const res = await as(access).post('start', { clientNonce: `nonce${Math.random().toString(36).slice(2, 12)}` });
    expect(res.status).toBe(201);
    return res.body;
  };
  const nameOf = async (playId: string, ref: string) => {
    const [row] = await env.sql<{ name: string }[]>`
      SELECT c->'card'->>'name' AS name FROM partner_card_detective_plays, jsonb_array_elements(cards) c
      WHERE play_id = ${playId} AND c->>'ref' = ${ref}`;
    return row.name;
  };
  const dealtCardIds = async (playId: string) =>
    (await env.sql<{ id: string }[]>`
      SELECT c->>'cardId' AS id FROM partner_card_detective_plays, jsonb_array_elements(cards) c WHERE play_id = ${playId}`).map((r) => r.id);

  const publicSets = () => env.sql`
    SELECT 'cd' AS game, challenge_day::text, card_ids FROM daily_card_detective_sets
    UNION ALL SELECT 'fifa', challenge_day::text, card_ids FROM daily_fifa_card_sets ORDER BY 1, 2`;

  it('accepted and refused starts leave the public daily sets untouched', async () => {
    const before = await publicSets();
    const player = await env.launch();
    const play = await start(player.access);
    await as(player.access).post(`plays/${play.playId}/finish`);
    expect((await as(player.access).post('start', { clientNonce: 'refused-start-1' })).body.error.code).toBe('quota_exhausted');
    expect(await publicSets()).toEqual(before);
  });

  it('accepts only the partner token', async () => {
    expect((await request(env.app).post('/partner/v1/games/card-detective/start').send({ clientNonce: 'abcdefgh1' })).status).toBe(401);
  });

  it('deals 10 cards, never from today\'s public sets, and discloses only the free clues', async () => {
    const player = await env.launch();
    const play = await start(player.access);
    expect(play).toMatchObject({ cardCount: 10, index: 0, score: 0, state: 'active', resolved: [], finished: null });
    expect(play.current!.ref).toMatch(/^[0-9a-f]{16}$/);
    expect(play.current!.open).toHaveLength(3);
    expect(Object.keys(play.current!.clues).sort()).toEqual([...play.current!.open].sort());
    expect(JSON.stringify(play)).not.toMatch(/Testplayer|FC 24|cardId|accepted|faceUrl/);
    const dealt = await dealtCardIds(play.playId);
    expect(new Set(dealt).size).toBe(10);
    expect(dealt.filter((id) => publicIds.includes(id))).toEqual([]);

    // A second start returns the open play.
    expect((await start(player.access)).playId).toBe(play.playId);
  });

  it('charges clues and wrong guesses on the server and scores what is left on solved cards', async () => {
    const player = await env.launch();
    let play = await start(player.access);
    const path = (action: string) => `plays/${play.playId}/${action}`;
    const ref = play.current!.ref;

    let res = await as(player.access).post(path('reveal'), { ref, clue: 'rating', version: play.version });
    expect(res.status).toBe(200);
    play = res.body;
    expect(play.current).toMatchObject({ points: 75, clues: { rating: 80 } });
    // Already open, stale version: refused, nothing charged.
    expect((await as(player.access).post(path('reveal'), { ref, clue: 'rating', version: play.version })).status).toBe(400);
    const stale = await as(player.access).post(path('reveal'), { ref, clue: 'club', version: play.version - 1 });
    expect(stale.body.error.code).toBe('stale_version');

    res = await as(player.access).post(path('guess'), { ref, name: 'Nobody Atall', version: play.version });
    expect(res.body.correct).toBe(false);
    play = res.body.state;
    expect(play.current!.points).toBe(60);
    // 60 → league 15 → 45 → nation 10 → 35 → two wrong names → 5: the 20-point club is out of reach.
    for (const clue of ['league', 'nation']) {
      play = (await as(player.access).post(path('reveal'), { ref, clue, version: play.version })).body;
    }
    for (let i = 0; i < 2; i += 1) play = (await as(player.access).post(path('guess'), { ref, name: 'Wrong Name', version: play.version })).body.state;
    expect(play.current!.points).toBe(5);
    const tooDear = await as(player.access).post(path('reveal'), { ref, clue: 'club', version: play.version });
    expect(tooDear.status).toBe(400);
    expect(tooDear.body.error.code).toBe('invalid_request');
    // A further wrong name floors the card at 0.
    play = (await as(player.access).post(path('guess'), { ref, name: 'Wrong Name', version: play.version })).body.state;
    expect(play.current!.points).toBe(0);

    // Solve card 1 for 0, card 2 for its full 100, give up on the rest.
    res = await as(player.access).post(path('guess'), { ref, name: await nameOf(play.playId, ref), version: play.version });
    expect(res.body.correct).toBe(true);
    play = res.body.state;
    expect(play.resolved[0]).toMatchObject({ solved: true, points: 0, card: { name: await nameOf(play.playId, ref) } });
    const second = play.current!.ref;
    play = (await as(player.access).post(path('guess'), { ref: second, name: await nameOf(play.playId, second), version: play.version })).body.state;
    expect(play.score).toBe(100);
    while (play.current) {
      play = (await as(player.access).post(path('skip'), { ref: play.current.ref, version: play.version })).body;
    }
    expect(play).toMatchObject({ state: 'finished', score: 100, finished: { score: 100, sent: true } });
    expect(play.resolved).toHaveLength(10);

    const events = await env.events(player.externalId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ game_id: 'card-detective', score: 100, play_id: play.playId });
    const [user] = await env.sql`SELECT coins, total_xp FROM users WHERE id = ${player.userId}`;
    expect(user).toEqual({ coins: 0, total_xp: 0 });
    expect((await as(player.access).post(path('skip'), { ref: second, version: play.version })).status).toBe(409);
    const refused = await as(player.access).post('start', { clientNonce: 'second-play-1' });
    expect(refused.body.error.code).toBe('quota_exhausted');
  });

  it('a lost final response is recovered through the play itself, finished state included', async () => {
    const player = await env.launch();
    let play = await start(player.access);
    while (play.current) {
      const last = play;
      play = (await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current.ref, version: play.version })).body;
      if (!play.current) {
        // The client retries the final skip it never heard back from: refused, then reconciled by id.
        const retry = await as(player.access).post(`plays/${play.playId}/skip`, { ref: last.current!.ref, version: last.version });
        expect(retry.status).toBe(409);
      }
    }
    const byId = await as(player.access).get(`plays/${play.playId}`);
    expect(byId.body).toMatchObject({ state: 'finished', finished: { playId: play.playId, score: 0, sent: true } });
    const other = await env.launch();
    expect((await as(other.access).get(`plays/${play.playId}`)).status).toBe(404);
  });

  const REDACTED = (playId: string) => expect.objectContaining({
    playId, state: 'finished', score: 0, current: null, resolved: [], finished: { playId, score: 0, sent: false },
  });
  const noIdentities = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/Testplayer|Public|Testland|Test FC|Test League|FC 24/);

  it('after a block and an unblock, GET, finish and the same-nonce start show nothing of the play; it stays used', async () => {
    const player = await env.launch();
    const nonce = 'cancel-nonce-0001';
    let play = (await as(player.access).post('start', { clientNonce: nonce })).body as State;
    // Resolve two cards so there are identities a careless view would show.
    for (let i = 0; i < 2; i += 1) {
      play = (await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version })).body;
    }
    expect(play.resolved).toHaveLength(2);
    await env.blockAndUnblock(player.playerId);
    expect((await as(player.access).get('current')).body).toEqual({ play: null });
    const byId = await as(player.access).get(`plays/${play.playId}`);
    expect(byId.body).toEqual(REDACTED(play.playId));
    noIdentities(byId.body);
    const finish = await as(player.access).post(`plays/${play.playId}/finish`);
    expect(finish.body).toEqual(REDACTED(play.playId));
    const skip = await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version });
    expect(skip.body).toEqual(REDACTED(play.playId));
    const again = await as(player.access).post('start', { clientNonce: nonce });
    expect(again.body).toEqual(REDACTED(play.playId));
    noIdentities(again.body);
    expect((await as(player.access).post('start', { clientNonce: 'after-cancel-1' })).body.error.code).toBe('quota_exhausted');
    expect(await env.events(player.externalId)).toHaveLength(0);
  });

  describe('a block landing while an action is in flight', () => {
    it('the final skip reveals no identity and sends no event', async () => {
      const player = await env.launch();
      let play = await start(player.access);
      while (play.index < play.cardCount - 1) {
        play = (await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version })).body;
      }
      const res = await env.blockDuring(player.playerId, () =>
        as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version }));
      expect(res.body).toEqual(REDACTED(play.playId));
      noIdentities(res.body);
      const [row] = await env.sql`SELECT current_index FROM partner_card_detective_plays WHERE play_id = ${play.playId}`;
      expect(row.current_index).toBe(play.cardCount - 1);
      expect(await env.events(player.externalId)).toHaveLength(0);
    });

    it('a non-final skip and a right guess reveal no identity', async () => {
      const player = await env.launch();
      const play = await start(player.access);
      const name = await nameOf(play.playId, play.current!.ref);
      const res = await env.blockDuring(player.playerId, () =>
        as(player.access).post(`plays/${play.playId}/guess`, { ref: play.current!.ref, name, version: play.version }));
      expect(res.body).toEqual({ correct: false, state: REDACTED(play.playId) });
      noIdentities(res.body);
      const other = await env.launch();
      const second = await start(other.access);
      const skip = await env.blockDuring(other.playerId, () =>
        as(other.access).post(`plays/${second.playId}/skip`, { ref: second.current!.ref, version: second.version }));
      expect(skip.body).toEqual(REDACTED(second.playId));
      expect(await env.events(player.externalId)).toHaveLength(0);
      expect(await env.events(other.externalId)).toHaveLength(0);
    });

    it('GET and finish reveal nothing', async () => {
      const player = await env.launch();
      let play = await start(player.access);
      play = (await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version })).body;
      const principal = { playerId: player.playerId, userId: player.userId, language: 'en' } as never;
      const viewed = await env.blockDuring(player.playerId, () => service.partnerCardDetectiveService.get(principal, play.playId));
      expect(viewed).toEqual(REDACTED(play.playId));
      const other = await env.launch();
      const second = await start(other.access);
      const finished = await env.blockDuring(other.playerId, () =>
        service.partnerCardDetectiveService.finish({ playerId: other.playerId, userId: other.userId, language: 'en' } as never, second.playId));
      expect(finished).toEqual(REDACTED(second.playId));
      expect(await env.events(other.externalId)).toHaveLength(0);
    });
  });

  it('leaving early ends the play with the points banked', async () => {
    const player = await env.launch();
    let play = await start(player.access);
    play = (await as(player.access).post(`plays/${play.playId}/guess`, { ref: play.current!.ref, name: await nameOf(play.playId, play.current!.ref), version: play.version })).body.state;
    const done = await as(player.access).post(`plays/${play.playId}/finish`);
    expect(done.body).toMatchObject({ state: 'finished', finished: { score: 100 } });
    expect((await env.events(player.externalId)).map((e) => e.score)).toEqual([100]);
  });

  it('the sweeper settles an idle play at its idle deadline', async () => {
    const player = await env.launch();
    const play = await start(player.access);
    await as(player.access).post(`plays/${play.playId}/skip`, { ref: play.current!.ref, version: play.version });
    const deadline = new Date(Date.now() - 2_000);
    await env.sql`UPDATE partner_card_detective_plays SET idle_deadline = ${deadline} WHERE play_id = ${play.playId}`;
    expect(await service.partnerCardDetectiveService.sweepIdle()).toBeGreaterThanOrEqual(1);
    expect(await service.partnerCardDetectiveService.sweepIdle()).toBe(0);
    const events = await env.events(player.externalId);
    expect(events).toHaveLength(1);
    expect(events[0].score).toBe(0);
    expect(new Date(events[0].occurred_at).getTime()).toBe(deadline.getTime());
    expect((await as(player.access).get('current')).body).toEqual({ play: null });
  });

  it('an action after the idle deadline ends the play there instead of scoring', async () => {
    const player = await env.launch();
    let play = await start(player.access);
    play = (await as(player.access).post(`plays/${play.playId}/guess`, { ref: play.current!.ref, name: await nameOf(play.playId, play.current!.ref), version: play.version })).body.state;
    const deadline = new Date(Date.now() - 2_000);
    await env.sql`UPDATE partner_card_detective_plays SET idle_deadline = ${deadline} WHERE play_id = ${play.playId}`;
    const late = await as(player.access).post(`plays/${play.playId}/guess`, { ref: play.current!.ref, name: await nameOf(play.playId, play.current!.ref), version: play.version });
    expect(late.body).toMatchObject({ correct: false, state: { state: 'finished', finished: { score: 100 } } });
    const events = await env.events(player.externalId);
    expect(events.map((e) => e.score)).toEqual([100]);
    expect(new Date(events[0].occurred_at).getTime()).toBe(deadline.getTime());
  });
});
