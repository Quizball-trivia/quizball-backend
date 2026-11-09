import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';

const target = process.env.ROOM_RESERVATION_TEST_DATABASE_URL;
const suite = target ? describe : describe.skip;
suite('waiting disconnect persistence (isolated local Postgres)', () => {
  let db: ReturnType<typeof postgres>;
  let room: string;
  let host: string;
  let migration: string;
  beforeAll(async () => {
    const url = new URL(target!);
    if (url.hostname !== '127.0.0.1' || url.port !== '55519' || !url.pathname.startsWith('/rehearsal_')) {
      throw new Error('Reservation tests require the isolated local rehearsal database');
    }
    if (process.env.DATABASE_URL !== target) throw new Error('Repository and fixture must use the same isolated database');
    db = postgres(target!, { max: 4, onnotice: () => {} });
    await db.unsafe(`CREATE TABLE IF NOT EXISTS lobbies (
      id uuid PRIMARY KEY, status text NOT NULL, mode text NOT NULL,
      is_public boolean NOT NULL, host_user_id uuid NOT NULL
    ); CREATE TABLE IF NOT EXISTS lobby_members (
      lobby_id uuid REFERENCES lobbies(id) ON DELETE CASCADE, user_id uuid,
      is_ready boolean NOT NULL, joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(lobby_id,user_id)
    )`);
    migration = await readFile(new URL('../../supabase/migrations/20261109085848_waiting_lobby_disconnect_reservations.sql', import.meta.url), 'utf8');
    await db.unsafe(migration);
    const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
    const indexFile = (await readdir(migrationDir)).find(name => name.endsWith('_waiting_lobby_disconnect_due_index.sql'))!;
    await db.unsafe(await readFile(new URL(indexFile, migrationDir), 'utf8'));
  });
  beforeEach(async () => {
    await db`TRUNCATE lobby_members,lobbies`;
    room = randomUUID(); host = randomUUID();
    await db`INSERT INTO lobbies VALUES (${room},'waiting','friendly',false,${host})`;
    await db`INSERT INTO lobby_members(lobby_id,user_id,is_ready) VALUES(${room},${host},true)`;
  });
  afterAll(async () => { await db?.end(); });

  it('persists a five-minute reservation and immediately clears Ready', async () => {
    const before = Date.now();
    const lease = await lobbiesRepo.reserveWaitingDisconnect(room, host, randomUUID(), 300_000);
    expect(lease).not.toBeNull();
    expect(new Date(lease!.expires_at).getTime() - before).toBeGreaterThanOrEqual(299_000);
    expect(new Date(lease!.expires_at).getTime() - before).toBeLessThan(302_000);
    expect(await lobbiesRepo.countReadyMembers(room)).toBe(0);
    expect(await lobbiesRepo.hasWaitingDisconnectReservation(room)).toBe(true);
  });
  it('cannot remove a participant before expiry', async () => {
    const token = randomUUID();
    await lobbiesRepo.reserveWaitingDisconnect(room, host, token, 300_000);
    expect(await lobbiesRepo.removeWaitingDisconnectedMember(room, host, token)).toBe(false);
    expect(await lobbiesRepo.countMembers(room)).toBe(1);
  });
  it('invalidates an old cleanup after reconnect and another disconnect', async () => {
    const old = randomUUID(), current = randomUUID();
    await lobbiesRepo.reserveWaitingDisconnect(room, host, old, 1);
    await lobbiesRepo.clearWaitingDisconnect(room, host);
    await lobbiesRepo.reserveWaitingDisconnect(room, host, current, 300_000);
    expect(await lobbiesRepo.removeWaitingDisconnectedMember(room, host, old)).toBe(false);
    expect((await lobbiesRepo.getWaitingDisconnect(room, host))?.token).toBe(current);
  });
  it('expires only the matching due membership and closes only an empty waiting room', async () => {
    const token = randomUUID();
    await lobbiesRepo.reserveWaitingDisconnect(room, host, token, 300_000);
    await db`UPDATE lobby_members SET waiting_disconnect_expires_at=now()-interval '1 second'`;
    expect((await lobbiesRepo.listDueWaitingDisconnects()).length).toBe(1);
    expect(await lobbiesRepo.removeWaitingDisconnectedMember(room, host, token)).toBe(true);
    expect(await lobbiesRepo.deleteEmptyWaitingLobby(room)).toBe(true);
  });
  it('preserves the friend and their room when the absent host expires', async () => {
    const friend = randomUUID(), token = randomUUID();
    await db`INSERT INTO lobby_members(lobby_id,user_id,is_ready) VALUES(${room},${friend},false)`;
    await lobbiesRepo.reserveWaitingDisconnect(room, host, token, 300_000);
    await db`UPDATE lobby_members SET waiting_disconnect_expires_at=now()-interval '1 second' WHERE user_id=${host}`;
    expect(await lobbiesRepo.removeWaitingDisconnectedMember(room, host, token)).toBe(true);
    expect(await lobbiesRepo.deleteEmptyWaitingLobby(room)).toBe(false);
    expect(await lobbiesRepo.countMembers(room)).toBe(1);
  });
  it('refuses stale waiting cleanup after activation, including empty-room deletion', async () => {
    const token = randomUUID();
    await lobbiesRepo.reserveWaitingDisconnect(room, host, token, 300_000);
    await db`UPDATE lobby_members SET waiting_disconnect_expires_at=now()-interval '1 second'`;
    await db`UPDATE lobbies SET status='active' WHERE id=${room}`;
    expect(await lobbiesRepo.removeWaitingDisconnectedMember(room, host, token)).toBe(false);
    expect(await lobbiesRepo.deleteEmptyWaitingLobby(room)).toBe(false);
    expect(await lobbiesRepo.countMembers(room)).toBe(1);
  });
  it('re-reads activation after waiting for the current room transaction', async () => {
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const go = new Promise<void>(resolve => { release = resolve; });
    const activation = db.begin(async tx => {
      await tx`SELECT id FROM lobbies WHERE id=${room} FOR UPDATE`;
      locked(); await go;
      await tx`UPDATE lobbies SET status='active' WHERE id=${room}`;
    });
    await acquired;
    const reservation = lobbiesRepo.reserveWaitingDisconnect(room, host, randomUUID(), 300_000);
    await new Promise(resolve => setTimeout(resolve, 25)); release(); await activation;
    expect(await reservation).toBeNull();
    const [member] = await db`SELECT is_ready,waiting_disconnect_token FROM lobby_members WHERE lobby_id=${room}`;
    expect(member.is_ready).toBe(true); expect(member.waiting_disconnect_token).toBeNull();
  });
  it('does not delete a friend who joined while empty-room cleanup waited on their FK lock', async () => {
    await db`DELETE FROM lobby_members WHERE lobby_id=${room}`;
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const go = new Promise<void>(resolve => { release = resolve; });
    const join = db.begin(async tx => {
      await tx`INSERT INTO lobby_members(lobby_id,user_id,is_ready) VALUES(${room},${randomUUID()},false)`;
      locked(); await go;
    });
    await acquired;
    const cleanup = lobbiesRepo.deleteEmptyWaitingLobby(room);
    await new Promise(resolve => setTimeout(resolve, 25)); release(); await join;
    expect(await cleanup).toBe(false);
    expect(await lobbiesRepo.countMembers(room)).toBe(1);
  });
  it('can replay the migration without changing existing reservations', async () => {
    const token = randomUUID();
    await lobbiesRepo.reserveWaitingDisconnect(room, host, token, 300_000);
    await db.unsafe(migration);
    expect((await lobbiesRepo.getWaitingDisconnect(room, host))?.token).toBe(token);
  });
});
