/** Staging-only real-network invite/reconnect checks. Tokens and room codes stay in memory. */
import { io, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const base = process.env.STAGING_URL ?? 'https://api-staging.quizball.io';
if (new URL(base).origin !== 'https://api-staging.quizball.io') throw new Error('This harness only targets QuizBall staging');
const phase = process.argv.includes('--red') ? 'red' : 'green';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type State = { lobbyId: string; inviteCode: string; hostUserId: string; status: string; settings: { gameMode: string }; members: Array<{ userId: string; isReady: boolean }> };
type Client = { token: string; userId: string; socket: Socket; states: State[] };
const clients: Client[] = [];
const observations: Array<Record<string, unknown>> = [];
async function until(check: () => boolean, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error('Timed out waiting for expected staging state'); await wait(100); }
}
function open(token: string, userId: string): Client {
  const c: Client = { token, userId, states: [], socket: io(base, {
    transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false,
  }) };
  c.socket.on('lobby:state', s => c.states.push(s));
  clients.push(c); return c;
}
async function guest(): Promise<Client> {
  const mint = await fetch(`${base}/api/v1/guest/session`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-instance-id': randomUUID() }, body: JSON.stringify({ locale: 'en' }),
  });
  if (!mint.ok) throw new Error(`Staging guest mint failed: HTTP ${mint.status}`);
  const { token } = await mint.json() as { token: string };
  const principal = await fetch(`${base}/api/v1/guest/principal`, { method: 'POST', headers: { 'x-guest-token': token } });
  if (!principal.ok) throw new Error(`Staging guest principal failed: HTTP ${principal.status}`);
  const { user_id: userId } = await principal.json() as { user_id: string };
  const c = open(token, userId); await until(() => c.socket.connected); await wait(1_000); return c;
}
async function rpc(c: Client, event: string, payload: Record<string, unknown> = {}) {
  return await c.socket.timeout(20_000).emitWithAck(event, { ...payload, correlationId: `reservation-qa-${randomUUID()}` }) as { ok: boolean; code?: string; lobbyId?: string; inviteCode?: string };
}
async function create(c: Client, isPublic = false) {
  const r = await rpc(c, 'lobby:create', { mode: 'friendly', gameMode: 'auction', isPublic });
  if (!r.ok || !r.lobbyId || !r.inviteCode) throw new Error(`Staging room create refused: ${r.code ?? 'missing room'}`);
  await until(() => c.states.some(s => s.lobbyId === r.lobbyId));
  return { id: r.lobbyId, code: r.inviteCode };
}
async function join(c: Client, room: { code: string }) { return rpc(c, 'lobby:join_by_code', { inviteCode: room.code }); }
async function leave(c: Client) { if (c.socket.connected) await rpc(c, 'lobby:leave').catch(() => null); }
function state(c: Client, id: string) { return c.states.filter(s => s.lobbyId === id).at(-1); }
async function run(name: string, body: () => Promise<Record<string, unknown>>) {
  const start = Date.now();
  try { const details = await body(); observations.push({ name, pass: true, elapsedSeconds: (Date.now() - start) / 1000, ...details }); }
  catch (e) { observations.push({ name, pass: false, elapsedSeconds: (Date.now() - start) / 1000, error: (e as Error).message }); }
  console.log(JSON.stringify(observations.at(-1)));
}
async function resume(c: Client) {
  const next = open(c.token, c.userId); await until(() => next.socket.connected); return next;
}
async function privateReturn(delay: number) {
  const host = await guest(), friend = await guest(), room = await create(host);
  host.socket.disconnect(); await wait(delay);
  const j = await join(friend, room);
  if (!j.ok || j.lobbyId !== room.id) throw new Error(`Original invite failed after absence: ${j.code}`);
  const returned = await resume(host);
  await until(() => !!state(returned, room.id)?.members.some(m => m.userId === host.userId));
  const s = state(returned, room.id)!;
  if (s.hostUserId !== host.userId || s.settings.gameMode !== 'auction' || s.members.length !== 2) throw new Error('Room, original host or settings were not restored');
  await leave(friend); await leave(returned);
  return { originalRoomRestored: true, originalHostRestored: true, settingsPreserved: true, guestInviteAccepted: true };
}

try {
  if (phase === 'red') {
    await run('baseline private invite after 22 seconds disconnected', async () => {
      const h = await guest(), f = await guest(), room = await create(h);
      h.socket.disconnect(); await wait(22_000);
      const r = await join(f, room);
      if (r.ok || r.code !== 'LOBBY_NOT_FOUND') throw new Error('Expected pre-fix room deletion was not reproduced');
      return { expectedFailureObserved: true, code: r.code };
    });
  } else {
    // Independent guest pairs make the long real-time checks safe to run concurrently.
    await Promise.all([
      run('private invite and host restore after 30 seconds', () => privateReturn(30_000)),
      run('private invite and host restore after two minutes', () => privateReturn(120_000)),
      run('abandoned private room expires after five minutes', async () => {
        const h = await guest(), f = await guest(), room = await create(h);
        h.socket.disconnect(); await wait(315_000);
        const r = await join(f, room);
        if (r.ok || r.code !== 'LOBBY_NOT_FOUND') throw new Error('Genuinely abandoned private room did not expire');
        return { expiredAfterFiveMinutes: true };
      }),
      run('reconnect invalidates the first private cleanup deadline', async () => {
        const h = await guest(), f = await guest(), room = await create(h);
        h.socket.disconnect(); const started = Date.now(); await wait(5_000);
        const returned = await resume(h); await until(() => !!state(returned, room.id));
        await wait(15_000); returned.socket.disconnect(); const second = Date.now();
        await wait(Math.max(0, started + 305_000 - Date.now()));
        const r = await join(f, room);
        if (!r.ok) throw new Error(`Obsolete first cleanup destroyed the invite: ${r.code}`);
        await until(() => !!state(f, room.id)?.members.some(m => m.userId === h.userId));
        await wait(Math.max(0, second + 315_000 - Date.now()));
        await until(() => !state(f, room.id)?.members.some(m => m.userId === h.userId), 35_000);
        if (state(f, room.id)?.members.length !== 1) throw new Error('Expiry did not preserve the friend');
        await leave(f); return { survivedOldDeadline: true, expiredOnlyAfterNewDeadline: true, remainingFriendPreserved: true };
      }),
      run('public cleanup and explicit private leave stay immediate', async () => {
        let h = await guest(); const f = await guest(); let room = await create(h, true);
        h.socket.disconnect(); await wait(22_000);
        let r = await join(f, room); if (r.ok || r.code !== 'LOBBY_NOT_FOUND') throw new Error('Public room cleanup changed');
        h = await resume(h); await wait(1_000); room = await create(h); await leave(h);
        r = await join(f, room); if (r.ok || r.code !== 'LOBBY_NOT_FOUND') throw new Error('Explicit leave retained an abandoned room');
        return { public15SecondPolicyPreserved: true, explicitLeavePreserved: true };
      }),
      run('one disconnected tab does not remove a still-connected host', async () => {
        const h = await guest(), f = await guest(), room = await create(h), otherTab = await resume(h);
        await until(() => !!state(otherTab, room.id)); h.socket.disconnect(); await wait(22_000);
        const r = await join(f, room); if (!r.ok) throw new Error(`Live host tab lost its room: ${r.code}`);
        await leave(f); await leave(otherTab); return { liveTabPreserved: true };
      }),
    ]);
  }
} finally {
  for (const c of clients) c.socket.disconnect();
  const report = { phase, target: new URL(base).origin, generatedAt: new Date().toISOString(), observations,
    pass: observations.length > 0 && observations.every(r => r.pass),
    limitations: ['Real browser-to-messaging-app switching is not performed; socket disconnection exercises its server-side failure mode.', 'Guest tokens, user IDs and invite codes are not retained.'] };
  if (process.env.RESERVATION_REPORT_PATH) {
    await mkdir(dirname(process.env.RESERVATION_REPORT_PATH), { recursive: true });
    await writeFile(process.env.RESERVATION_REPORT_PATH, JSON.stringify(report, null, 2));
  }
  if (!report.pass) process.exitCode = 1;
}
