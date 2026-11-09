/** Staging-only: real invite refusals, handoff, and retained-room recovery. No tokens/codes in reports. */
import { io, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const base = 'https://api-staging.quizball.io';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type State = { lobbyId: string; inviteCode: string; status: string; hostUserId: string; members: { userId: string; isReady: boolean }[] };
type Result = { ok: boolean; code?: string; lobbyId?: string; inviteCode?: string; correlationId: string;
  room?: { roomState: string; gameMode: string }; stateSnapshot?: { waitingLobbyId?: string } };
type Client = { token: string; userId: string; socket: Socket; states: State[]; errors: { code: string; meta?: { roomState?: string } }[]; blocked: { reason: string }[]; auctionId?: string };
const clients: Client[] = [];
const observations: Record<string, unknown>[] = [];
const pending: Promise<void>[] = [];
const references: { case: string; lobbyId: string }[] = []; // Only internal room IDs, for server-log verification.
async function until(check: () => boolean, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error('Expected staging state did not arrive'); await wait(100); }
}
function connect(token: string, userId: string): Client {
  const c: Client = { token, userId, states: [], errors: [], blocked: [], socket: io(base, {
    transports: ['websocket'], auth: { token, games: ['tenable', 'codenames'] }, forceNew: true, reconnection: false,
  }) };
  c.socket.on('lobby:state', s => c.states.push(s));
  c.socket.on('error', e => c.errors.push(e));
  c.socket.on('session:blocked', e => c.blocked.push(e));
  c.socket.on('auction:state', e => { c.auctionId = e.matchId; });
  clients.push(c); return c;
}
async function guest(locale = 'en') {
  const response = await fetch(`${base}/api/v1/guest/session`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-client-instance-id': randomUUID(),
  }, body: JSON.stringify({ locale }) });
  if (!response.ok) throw new Error(`Guest session HTTP ${response.status}`);
  const { token } = await response.json() as { token: string };
  const response2 = await fetch(`${base}/api/v1/guest/principal`, { method: 'POST', headers: { 'x-guest-token': token } });
  if (!response2.ok) throw new Error(`Guest principal HTTP ${response2.status}`);
  const { user_id } = await response2.json() as { user_id: string };
  const c = connect(token, user_id); await until(() => c.socket.connected); await wait(700); return c;
}
async function rpc(c: Client, event: string, data = {}) {
  return await c.socket.timeout(20000).emitWithAck(event, { ...data, correlationId: `room-lifecycle-qa-${randomUUID()}` }) as Result;
}
async function create(c: Client, caseName: string, gameMode = 'auction') {
  const r = await rpc(c, 'lobby:create', { mode: 'friendly', isPublic: false, gameMode });
  if (!r.ok || !r.lobbyId || !r.inviteCode) throw new Error(`Create refused: ${r.code ?? 'missing room'}`);
  await until(() => c.states.some(s => s.lobbyId === r.lobbyId));
  references.push({ case: caseName, lobbyId: r.lobbyId });
  return { id: r.lobbyId, code: r.inviteCode };
}
function state(c: Client, id: string) { return c.states.filter(s => s.lobbyId === id).at(-1); }
async function refused(c: Client, code: string, expectedCode: string, expectedState: string) {
  const before = c.errors.length, beforeBlocked = c.blocked.length;
  const r = await rpc(c, 'lobby:join_by_code', { inviteCode: code });
  if (r.ok || r.code !== expectedCode || r.room?.roomState !== expectedState) throw new Error(`Wrong refusal: ${r.code}/${r.room?.roomState}; expected ${expectedCode}/${expectedState}`);
  await wait(300);
  const emitted = c.errors.slice(before);
  if (emitted.length !== 1 || emitted[0].code !== expectedCode || (expectedCode !== 'LOBBY_FULL' && emitted[0].meta?.roomState !== expectedState)) throw new Error('Error event and join acknowledgement disagree or duplicate');
  if (expectedCode !== 'LOBBY_FULL' && (c.blocked.length !== beforeBlocked + 1 || c.blocked.at(-1)?.reason !== expectedCode)) throw new Error('Blocked-session event disagrees with the refusal');
  return r;
}
async function run(name: string, body: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  try { observations.push({ name, pass: true, ...await body(), elapsedSeconds: (Date.now() - started) / 1000 }); }
  catch (e) { observations.push({ name, pass: false, error: (e as Error).message }); }
  console.log(JSON.stringify(observations.at(-1)));
}

try {
  pending.push(run('five-minute abandonment expires with a traceable reservation reason', async () => {
    const h = await guest(), f = await guest(), room = await create(h, 'reservation_expiry');
    h.socket.disconnect(); await wait(315000);
    const r = await refused(f, room.code, 'LOBBY_NOT_FOUND', 'unknown');
    return { correctCode: r.code, expiredAfterFiveMinutes: true };
  }));
  const host = await guest(), visitor = await guest('es');
  const live = await create(host, 'active_then_ended');
  const own = await create(visitor, 'visitor_existing_room');
  await run('active Auction: accurate refusal, one event, current visitor room preserved', async () => {
    host.socket.emit('lobby:ready', { ready: true, seen: { gameMode: 'auction' } });
    await until(() => !!state(host, live.id)?.members.every(m => m.isReady));
    host.socket.emit('lobby:start', { lobbyId: live.id, locale: 'en', seen: { gameMode: 'auction' } });
    await until(() => state(host, live.id)?.status === 'active' && !!host.auctionId);
    const r = await refused(visitor, live.code, 'LOBBY_GAME_STARTED', 'in_progress');
    if (r.stateSnapshot?.waitingLobbyId !== own.id || state(host, live.id)?.members.length !== 1) throw new Error('Late join changed room memberships');
    return { correctCode: r.code, roomState: r.room?.roomState, visitorRoomPreserved: true, lateVisitorNotAdmitted: true };
  });
  await run('finished Auction: ended refusal, no generic missing-room error', async () => {
    if (!host.auctionId) throw new Error('Auction did not start');
    host.socket.emit('auction:forfeit', { matchId: host.auctionId });
    await wait(2500);
    const r = await refused(visitor, live.code, 'LOBBY_ENDED', 'ended');
    return { correctCode: r.code, roomState: r.room?.roomState };
  });
  await run('unknown invite: honest unknown state and existing room preserved', async () => {
    const r = await refused(visitor, '000000', 'LOBBY_NOT_FOUND', 'unknown');
    if (r.stateSnapshot?.waitingLobbyId !== own.id) throw new Error('Unknown invite evicted current room');
    return { correctCode: r.code, roomState: r.room?.roomState, visitorRoomPreserved: true };
  });
  const gridHost = await guest('ka'), gridFriend = await guest('en');
  const full = await create(gridHost, 'full_grid', 'football_grid');
  const joined = await rpc(gridFriend, 'lobby:join_by_code', { inviteCode: full.code });
  if (!joined.ok) throw new Error(`Setup join refused: ${joined.code}`);
  await run('full waiting room retains its existing full-room refusal', async () => {
    const r = await refused(visitor, full.code, 'LOBBY_FULL', 'open');
    return { correctCode: r.code, roomState: r.room?.roomState };
  });
  await run('explicit leave deletes the abandoned room without a false ended claim', async () => {
    const h = await guest(), room = await create(h, 'explicit_leave');
    await rpc(h, 'lobby:leave');
    const r = await refused(visitor, room.code, 'LOBBY_NOT_FOUND', 'unknown');
    return { correctCode: r.code, roomState: r.room?.roomState };
  });
  await run('disconnect and reconnect preserve the original private room', async () => {
    const h = await guest(), room = await create(h, 'reservation_reconnect');
    h.socket.disconnect(); await wait(22000);
    const returned = connect(h.token, h.userId);
    await until(() => returned.socket.connected && !!state(returned, room.id));
    if (state(returned, room.id)?.hostUserId !== h.userId) throw new Error('Original host was lost');
    await rpc(returned, 'lobby:leave');
    return { originalRoomRestored: true, originalHostRestored: true, pastOld15SecondDeadline: true };
  });
} finally {
  await Promise.all(pending);
  for (const c of clients) {
    if (c.socket.connected) await rpc(c, 'lobby:leave').catch(() => null);
    c.socket.disconnect();
  }
  const report = { target: base, generatedAt: new Date().toISOString(), observations, roomReferences: references,
    pass: observations.length === 7 && observations.every(o => o.pass),
    limitations: ['Synthetic staging guests; no personal messages sent and no physical app switching performed.'] };
  if (process.env.ROOM_LIFECYCLE_REPORT_PATH) {
    await mkdir(dirname(process.env.ROOM_LIFECYCLE_REPORT_PATH), { recursive: true });
    await writeFile(process.env.ROOM_LIFECYCLE_REPORT_PATH, JSON.stringify(report, null, 2));
  }
  if (!report.pass) process.exitCode = 1;
}
