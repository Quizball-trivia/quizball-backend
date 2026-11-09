import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';

const target = process.env.INVITE_ROOM_TEST_DATABASE_URL;
const suite = target ? describe : describe.skip;
suite('invite descriptor SQL (isolated local Postgres)', () => {
  let db: ReturnType<typeof postgres>, room: string;
  beforeAll(async () => {
    const url = new URL(target!);
    if (url.hostname !== '127.0.0.1' || url.port !== '55519' || url.pathname !== '/rehearsal_invite_room_info' || process.env.DATABASE_URL !== target) throw new Error('Isolated invite-room fixture required');
    db = postgres(target!, { max: 1 });
    await db`CREATE TABLE users (id uuid PRIMARY KEY, nickname text)`;
    await db`CREATE TABLE lobbies (id uuid PRIMARY KEY, invite_code text, mode text, status text, game_mode text, duel_game text, room_game text, host_user_id uuid REFERENCES users(id))`;
    await db`CREATE TABLE matches (id uuid PRIMARY KEY, lobby_id uuid REFERENCES lobbies(id), status text)`;
    const host = randomUUID(); room = randomUUID();
    await db`INSERT INTO users VALUES (${host}, 'Staging QA')`;
    await db`INSERT INTO lobbies VALUES (${room}, 'ABC123', 'friendly', 'closed', 'friendly_possession', null, null, ${host})`;
    await db`INSERT INTO matches VALUES (${randomUUID()}, ${room}, 'active')`;
  });
  afterAll(async () => { if (db) { await db`DROP TABLE matches,lobbies,users`; await db.end(); } });
  it('a closed Classic lobby can still have a live linked game', async () => {
    expect(await lobbiesRepo.findFriendlyRoomByInviteCode('ABC123')).toMatchObject({ status: 'closed', has_active_match: true, game_mode: 'friendly_possession' });
  });
  it('completed and abandoned matches do not masquerade as games in progress', async () => {
    for (const status of ['completed', 'abandoned']) {
      await db`UPDATE matches SET status=${status} WHERE lobby_id=${room}`;
      expect(await lobbiesRepo.findFriendlyRoomByInviteCode('ABC123')).toMatchObject({ status: 'closed', has_active_match: false });
    }
  });
  it('a genuinely missing invite stays unknown', async () => {
    expect(await lobbiesRepo.findFriendlyRoomByInviteCode('000000')).toBeNull();
  });
});
