/* eslint-disable no-console */
// Restart-between-rounds gate for ranked possession matches (staging QA 2026-10-07: six ranked matches froze for
// ~9 min when a deploy replaced the server between a round result and the next question).
//
// Real processes, real sockets: boots the backend as a child process, starts a ranked match against the bot
// (dev:quick_match), answers until a ready-gated round result, SIGKILLs the backend in the gap before the next
// question, starts it again on the same database + Redis, reconnects and rejoins, requires the next question within the
// deadline, then plays the match to its normal end and checks: no question sent twice, the match row completed, saved
// goals/points equal the final results, one RP change and one match XP award. Exit 0 = all pass.
//
// Local only. Usage (worktree cwd):
//   npx tsx scripts/chaos/possession-restart-between-rounds.ts [--port 8052] [--redis-db 12] [--deadline-ms 30000]
//     [--kill-after-ms 2500] [--first-cwd <checkout of the previous release>]
// Reads DATABASE_URL from .env and refuses anything that is not a loopback database. Redis uses its own DB index so
// another local backend's timers are not shared.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import postgres from 'postgres';
import { io as connect, type Socket } from 'socket.io-client';

const argv = process.argv.slice(2);
const opt = (key: string, fallback: string) => (argv.includes(`--${key}`) ? argv[argv.indexOf(`--${key}`) + 1] : fallback);
const PORT = Number(opt('port', '8052'));
const AUTH_PORT = PORT + 11;
const REDIS_DB = Number(opt('redis-db', '12'));
const DEADLINE_MS = Number(opt('deadline-ms', '30000'));
// Normal rounds send the next question at once (its reveal delay is inside the question); only a goal/penalty round
// waits for the players' ready acks (in-memory gate, ~9 s ceiling). A round result with no question within
// GATE_PROBE_MS is such a wait. The kill lands KILL_AFTER_MS after the result: the resolve has persisted and cleared
// its question timer by then (killing instantly re-runs the unsaved round from that timer, which hides the gap).
const GATE_PROBE_MS = 600;
const KILL_AFTER_MS = Number(opt('kill-after-ms', '2500'));
// Optional checkout for the FIRST backend only (e.g. the previous release): the deploy case, where an old process
// dies mid-transition and the new code must recover a wait that never had a durable timer.
const FIRST_CWD = argv.includes('--first-cwd') ? resolve(opt('first-cwd', '.')) : undefined;
// between-rounds (default): kill inside a goal/penalty ready-gated wait. final-round: kill after the final round
// committed COMPLETED but before completion ran (held open by the non-prod CHAOS_PAUSE_BEFORE_COMPLETION_MS hook).
const SCENARIO = opt('scenario', 'between-rounds') as 'between-rounds' | 'final-round';
if (!['between-rounds', 'final-round'].includes(SCENARIO)) throw new Error(`Unknown --scenario ${SCENARIO}`);
const API = `http://127.0.0.1:${PORT}`;
const OUT = resolve(opt('out', join(tmpdir(), 'possession-restart-gate')));
mkdirSync(OUT, { recursive: true });

const envFile = readFileSync(resolve('.env'), 'utf8');
const envValue = (key: string) => envFile.match(new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm'))?.[1];
const DATABASE_URL = envValue('DATABASE_URL') ?? '';
const db = new URL(DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(db.hostname)) throw new Error(`Refusing non-local database ${db.hostname}`);
const redisBase = new URL(envValue('REDIS_URL') ?? 'redis://localhost:6379');
if (!['127.0.0.1', 'localhost'].includes(redisBase.hostname)) throw new Error('Refusing non-local Redis');
redisBase.pathname = `/${REDIS_DB}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

// --- local auth: a loopback JWKS and one synthetic registered player -------------------------------------------
const issuer = `http://127.0.0.1:${AUTH_PORT}/auth/v1`;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'restart-gate', alg: 'RS256', use: 'sig' };
const jwks = createServer((req, res) => {
  if (req.url === '/jwks') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => jwks.listen(AUTH_PORT, '127.0.0.1', r));

const sql = postgres(DATABASE_URL, { max: 1 });
const userId = randomUUID();
const email = `restart-gate-${userId.slice(0, 8)}@example.invalid`;
await sql`INSERT INTO users (id, nickname, email, country, onboarding_complete, is_seed) VALUES (${userId}, ${`Restart ${userId.slice(0, 4)}`}, ${email}, 'GE', true, true)`;
await sql`INSERT INTO user_identities (user_id, subject, provider, email) VALUES (${userId}, ${userId}, 'supabase', ${email})`;
const token = await new SignJWT({ email, role: 'authenticated', app_metadata: { provider: 'email' } })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject(userId).setIssuer(issuer).setAudience('authenticated')
  .setIssuedAt().setExpirationTime('2h').sign(privateKey);

// --- backend child process ----------------------------------------------------------------------------------------
let generation = 0;
function startBackend(): ChildProcess {
  generation += 1;
  const out = createWriteStream(resolve(OUT, `backend-${generation}.log`));
  const child = spawn('npx', ['tsx', 'src/bootstrap.ts'], {
    cwd: generation === 1 && FIRST_CWD ? FIRST_CWD : process.cwd(),
    env: {
      ...process.env,
      // The validated loopback database and Redis, explicitly: an inherited env or another checkout's .env must
      // not decide which database the backends use.
      NODE_ENV: 'local', PORT: String(PORT), DATABASE_URL, REDIS_URL: redisBase.href,
      SUPABASE_JWKS_URL: `http://127.0.0.1:${AUTH_PORT}/jwks`, SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_AUDIENCE: 'authenticated',
      LOG_LEVEL: 'info', REGRESSION_FAST_TIMERS: '',
      CHAOS_PAUSE_BEFORE_COMPLETION_MS: SCENARIO === 'final-round' ? '8000' : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout!.pipe(out); child.stderr!.pipe(out);
  return child;
}
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* booting */ }
    await sleep(500);
  }
  throw new Error('Backend did not become healthy');
}
const kill = (child: ChildProcess) => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };

function client(): Socket {
  return connect(API, { auth: { token }, transports: ['websocket'], reconnection: false });
}

let backend = startBackend();
let exitCode = 1;
let socket: Socket | null = null;
try {
  await waitHealthy();
  log(`backend #${generation} up on ${API} (Redis db ${REDIS_DB}, DB ${db.pathname})`);

  // --- play until a round result after the first question ------------------------------------------------------
  socket = client();
  const resolved = await new Promise<{ matchId: string; qIndex: number }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(SCENARIO === 'final-round' ? 'Match did not reach COMPLETED within 8 min' : 'No ready-gated round within 240 s')), SCENARIO === 'final-round' ? 480_000 : 240_000);
    let lastQuestion = -1;
    socket!.on('connect', () => socket!.emit('dev:quick_match', {}));
    socket!.on('error', (e: unknown) => log('server error event', JSON.stringify(e)));
    socket!.on('match:question', (q: { matchId: string; qIndex: number; question: { kind?: string } }) => {
      lastQuestion = Math.max(lastQuestion, q.qIndex);
      log(`question ${q.qIndex} (${q.question?.kind ?? '?'})`);
      setTimeout(() => socket!.emit('match:answer', { matchId: q.matchId, qIndex: q.qIndex, selectedIndex: 0, timeMs: 1200 }), 1200);
    });
    socket!.on('match:state', (st: { matchId: string; phase: string }) => {
      if (SCENARIO !== 'final-round' || st.phase !== 'COMPLETED') return;
      log('final round committed COMPLETED -> killing before completion');
      clearTimeout(timer); done({ matchId: st.matchId, qIndex: Number.MAX_SAFE_INTEGER });
    });
    socket!.on('match:round_result', (r: { matchId: string; qIndex: number }) => {
      log(`round result ${r.qIndex}`);
      if (SCENARIO === 'final-round') return;
      setTimeout(() => {
        if (lastQuestion > r.qIndex) return; // next question already out: no gap here, keep playing
        log(`round ${r.qIndex}: no question within ${GATE_PROBE_MS} ms -> ready-gated transition`);
        clearTimeout(timer); done(r);
      }, GATE_PROBE_MS);
    });
  });

  // --- the gap: kill before the next question ------------------------------------------------------------------
  let earlyQuestion = false;
  socket.on('match:question', (q: { qIndex: number }) => { if (q.qIndex > resolved.qIndex) earlyQuestion = true; });
  if (SCENARIO === 'between-rounds') await sleep(Math.max(0, KILL_AFTER_MS - GATE_PROBE_MS));
  if (earlyQuestion) throw new Error('Next question arrived before the kill; lower --kill-after-ms');
  kill(backend);
  log(SCENARIO === 'final-round'
    ? `SIGKILL backend #${generation} between the COMPLETED commit and completion (match ${resolved.matchId.slice(0, 8)})`
    : `SIGKILL backend #${generation} ${KILL_AFTER_MS} ms after round ${resolved.qIndex} (match ${resolved.matchId.slice(0, 8)})`);
  socket.close();
  await sleep(1000);

  backend = startBackend();
  await waitHealthy();
  log(`backend #${generation} up again`);

  // --- reconnect, rejoin, require the next question, then play the match to its normal end ----------------------
  const nextIndex = resolved.qIndex + 1;
  socket = client();
  const seen: number[] = [];
  const startedAt = Date.now();
  let recoveredAt: number | null = null;
  type Final = { matchId: string; winnerId: string | null; players: Record<string, { goals?: number; totalPoints?: number }>; cancelledNoContest?: boolean };
  const final = await new Promise<Final | null>((done) => {
    const recoveryTimer = setTimeout(() => { if (recoveredAt === null) done(null); }, SCENARIO === 'final-round' ? 8 * 60_000 : DEADLINE_MS);
    const matchTimer = setTimeout(() => done(null), 8 * 60_000);
    socket!.on('connect', () => socket!.emit('match:rejoin', { matchId: resolved.matchId }));
    socket!.on('match:question', (q: { matchId: string; qIndex: number }) => {
      seen.push(q.qIndex);
      if (q.qIndex >= nextIndex && recoveredAt === null) {
        recoveredAt = Date.now() - startedAt;
        clearTimeout(recoveryTimer);
        log(`after restart: question ${q.qIndex} at +${recoveredAt} ms; playing on to the end`);
      }
      setTimeout(() => socket!.emit('match:answer', { matchId: q.matchId, qIndex: q.qIndex, selectedIndex: 0, timeMs: 1200 }), 1200);
    });
    socket!.on('match:final_results', (r: Final) => { clearTimeout(matchTimer); clearTimeout(recoveryTimer); done(r); });
  });

  // --- verdict: recovered once, completed normally, scores and rewards written once ------------------------------
  const checks: Array<[string, boolean, string?]> = [];
  if (SCENARIO === 'between-rounds') {
    checks.push([`question ${nextIndex} arrived after the restart`, recoveredAt !== null, recoveredAt === null ? `none within ${DEADLINE_MS} ms` : `+${recoveredAt} ms`]);
  } else {
    checks.push(['no question sent after the final round', seen.length === 0, seen.length ? `got ${seen.join(',')}` : 'none']);
  }
  const dupes = seen.filter((q, i) => seen.indexOf(q) !== i);
  checks.push(['no question sent twice after the restart', dupes.length === 0, dupes.length ? `repeated: ${dupes.join(',')}` : `${seen.length} questions`]);
  checks.push(['match reached its normal final result', Boolean(final && !final.cancelledNoContest), final ? `winner ${final.winnerId?.slice(0, 8) ?? 'draw'}` : 'no final results']);
  if (final) {
    const [match] = await sql<{ status: string; is_dev: boolean }[]>`SELECT status, is_dev FROM matches WHERE id = ${resolved.matchId}`;
    checks.push(['match row completed', match?.status === 'completed', match?.status]);
    const players = await sql<{ user_id: string; goals: number; total_points: number }[]>`SELECT user_id, goals, total_points FROM match_players WHERE match_id = ${resolved.matchId}`;
    const scoresMatch = players.length === 2 && players.every((p) => final.players[p.user_id]?.goals === p.goals && final.players[p.user_id]?.totalPoints === p.total_points);
    checks.push(['saved goals/points equal the final results', scoresMatch, players.map((p) => `${p.user_id.slice(0, 4)} ${p.goals}g/${p.total_points}p`).join(' · ')]);
    await sleep(3000); // settlement and XP are written just after the final results
    const [rp] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ranked_rp_changes WHERE match_id = ${resolved.matchId} AND user_id = ${userId}`;
    checks.push(['one RP change for the player', rp?.n === 1, `${rp?.n}`]);
    const [xp] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_xp_events WHERE user_id = ${userId} AND source_type = 'match_result' AND source_key LIKE ${`%${resolved.matchId}%`}`;
    // dev:quick_match rows are is_dev, which by design never award match XP; otherwise exactly one award.
    const expectedXp = match?.is_dev ? 0 : 1;
    checks.push([`match XP awarded exactly ${expectedXp} time(s)${match?.is_dev ? ' (dev match: none by design)' : ''}`, xp?.n === expectedXp, `${xp?.n}`]);
  }
  for (const [name, ok, detail] of checks) log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
  exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  log(exitCode === 0 ? 'GATE PASSED' : 'GATE FAILED');
  if (!final) socket.emit('match:forfeit', { matchId: resolved.matchId });
  await sleep(500);
} finally {
  socket?.close();
  kill(backend);
  jwks.close();
  await sql`UPDATE users SET is_deleted = true, deleted_at = now() WHERE id = ${userId}`.catch(() => undefined);
  await sql.end();
  log(`logs: ${OUT}`);
  process.exit(exitCode);
}
