/**
 * AUCTION SOCKET FLEET — real socket.io clients playing full live auction
 * matches concurrently: queue → match found → ui-ready handshakes → clue
 * reveals → turn-based bids/folds → reveals → solo picks → finish.
 *
 * Each client follows the same wire protocol as the web app (waiting_for_ready
 * mirroring, turn_started-driven actions with human-ish delays, solo-pick
 * selection) with a simple bidding policy: bid when affordable with a
 * probability that shrinks as the price grows, else fold.
 *
 * Usage (staging — NEVER prod; guarded):
 *   npx tsx scripts/chaos/auction-fleet.ts --target staging --sockets 100 --matches-per-client 1
 *   npx tsx scripts/chaos/auction-fleet.ts --target local --api http://localhost:8000 --sockets 20
 *
 * Mixed-load scenarios: run this alongside the ranked fleet (scripts/chaos/run.ts
 * --sockets N) from two terminals — the fleets use disjoint user shards via
 * --offset.
 */
import { io, type Socket } from 'socket.io-client';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { provisionUsers, type ChaosUser } from './auth.js';

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, '../..');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flagValue = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || !args[index + 1] ? fallback : args[index + 1];
};
const numFlag = (name: string, fallback: number): number => Number(flagValue(name, String(fallback)));
const TARGET = flagValue('target', 'staging');
const SOCKETS = numFlag('sockets', 50);
const MATCHES_PER_CLIENT = numFlag('matches-per-client', 1);
const RAMP_SEC = numFlag('ramp', Math.min(120, SOCKETS));
const OFFSET = numFlag('offset', 0);
const API_OVERRIDE = flagValue('api', '');
const REPORT = flagValue('report', '');
const MATCH_START_TIMEOUT_MS = 180_000;
const MATCH_FINISH_TIMEOUT_MS = 25 * 60_000; // 21 rounds x ~45s + slack
const STALL_TIMEOUT_MS = 150_000; // no auction event at all for this long = stranded

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const env = readEnvFile(resolve(REPO_ROOT, '.env'));
const apiBase = API_OVERRIDE || (TARGET === 'staging' ? 'https://api-staging.quizball.io' : 'http://localhost:8000');
const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const bypassToken = process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN;

// PROD GUARD — this fleet must never point anywhere near production.
if (supabaseUrl.includes('lfbwhxvwubzeqkztghok') || apiBase.includes('api.quizball.io')) {
  throw new Error('PROD GUARD: refusing to run the auction fleet against production.');
}
if (!supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
  throw new Error(`PROD GUARD: expected the staging Supabase project in SUPABASE_URL, got "${supabaseUrl}".`);
}

// ── Metrics ──────────────────────────────────────────────────────────────────
interface Metrics {
  searchesStarted: number;
  matchesFound: number;
  matchesStarted: number;
  matchesFinished: number;
  stranded: number;
  startTimeouts: number;
  bids: number;
  folds: number;
  soloPicks: number;
  forfeitedCleanups: number;
  playerForfeitSignals: number;
  errors: Map<string, number>;
  disconnects: Map<string, number>;
  searchToFoundMs: number[];
  bidAckMs: number[];
  foldAckMs: number[];
  matchDurationSec: number[];
  roundsPerMatch: number[];
}
const metrics: Metrics = {
  searchesStarted: 0, matchesFound: 0, matchesStarted: 0, matchesFinished: 0,
  stranded: 0, startTimeouts: 0, bids: 0, folds: 0, soloPicks: 0,
  forfeitedCleanups: 0, playerForfeitSignals: 0,
  errors: new Map(), disconnects: new Map(),
  searchToFoundMs: [], bidAckMs: [], foldAckMs: [], matchDurationSec: [], roundsPerMatch: [],
};
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

// ── One fleet client ─────────────────────────────────────────────────────────
async function runClient(user: ChaosUser, clientIndex: number): Promise<void> {
  for (let matchIndex = 0; matchIndex < MATCHES_PER_CLIENT; matchIndex += 1) {
    const socket: Socket = io(apiBase, {
      transports: ['websocket'],
      auth: { token: user.token },
      forceNew: true,
      reconnection: true,
      extraHeaders: bypassToken ? { 'x-chaos-bypass': bypassToken } : undefined,
    });

    let matchId: string | null = null;
    let mySeatId: string | null = null;
    let phase: 'connecting' | 'searching' | 'playing' | 'finished' | 'failed' = 'connecting';
    let searchStartedAt = 0;
    let matchStartedAt = 0;
    let roundsSeen = 0;
    let lastEventAt = Date.now();
    let pendingAction: { kind: 'bid' | 'fold'; at: number } | null = null;
    const ackedReadyKeys = new Set<string>();

    const done = new Promise<void>((resolveDone) => {
      const finish = (outcome: 'finished' | 'failed', reason?: string) => {
        if (phase === 'finished' || phase === 'failed') return;
        phase = outcome;
        if (outcome === 'failed' && reason) bump(metrics.errors, `client:${reason}`);
        socket.disconnect();
        resolveDone();
      };

      const touch = () => { lastEventAt = Date.now(); };

      const startSearch = () => {
        phase = 'searching';
        searchStartedAt = Date.now();
        metrics.searchesStarted += 1;
        socket.emit('auction:search_start', { locale: 'en', formation: '2-2-2' });
      };

      socket.on('connect', () => {
        touch();
        if (phase === 'connecting') {
          // Give the server a beat to replay any stale match, then queue.
          setTimeout(() => { if (phase === 'connecting') startSearch(); }, 1_500);
        }
      });
      socket.on('connect_error', (error: Error) => {
        bump(metrics.errors, `connect_error:${error.message.slice(0, 40)}`);
        finish('failed', 'connect_error');
      });
      socket.on('disconnect', (reason: string) => { bump(metrics.disconnects, reason); });

      // Chaos identities are shared across harness runs: a stale RANKED match
      // or lobby from an old capacity test makes the session guard block the
      // auction queue. Self-heal: clean up whatever the guard reports, retry.
      let blockedRetries = 0;
      socket.on('session:blocked', (payload: {
        reason?: string;
        stateSnapshot?: { activeMatchId?: string | null; waitingLobbyId?: string | null };
      }) => {
        touch();
        const snapshot = payload.stateSnapshot ?? {};
        if (snapshot.activeMatchId) {
          socket.emit('match:forfeit', { matchId: snapshot.activeMatchId });
          socket.emit('auction:forfeit', { matchId: snapshot.activeMatchId });
          metrics.forfeitedCleanups += 1;
        }
        if (snapshot.waitingLobbyId) {
          socket.emit('lobby:leave', { lobbyId: snapshot.waitingLobbyId });
          metrics.forfeitedCleanups += 1;
        }
        blockedRetries += 1;
        if (blockedRetries > 4) { finish('failed', 'session_blocked_unrecoverable'); return; }
        setTimeout(() => {
          if (phase === 'searching' || phase === 'connecting') startSearch();
        }, 2_500);
      });

      // Stale session from a previous crashed run: forfeit it, then search.
      socket.on('auction:rejoin_available', (payload: { matchId: string }) => {
        touch();
        if (phase === 'connecting' || phase === 'searching') {
          socket.emit('auction:forfeit', { matchId: payload.matchId });
          metrics.forfeitedCleanups += 1;
          setTimeout(() => { if (phase === 'connecting') startSearch(); }, 1_000);
        }
      });
      socket.on('auction:state', (payload: { matchId: string; state?: { phase?: string } }) => {
        touch();
        // Replayed live match from a stale identity while we want a fresh one.
        if (phase === 'connecting' && payload.matchId) {
          socket.emit('auction:forfeit', { matchId: payload.matchId });
          metrics.forfeitedCleanups += 1;
          setTimeout(() => { if (phase === 'connecting') startSearch(); }, 1_000);
        }
      });

      socket.on('auction:match_found', (payload: { matchId: string }) => {
        touch();
        matchId = payload.matchId;
        metrics.matchesFound += 1;
        metrics.searchToFoundMs.push(Date.now() - searchStartedAt);
      });

      socket.on('auction:match_started', (payload: {
        matchId: string;
        state: { seats: Array<{ seatId: string; userId?: string | null }> };
      }) => {
        touch();
        matchId = payload.matchId;
        mySeatId = payload.state.seats.find((seat) => seat.userId === user.userId)?.seatId ?? null;
        matchStartedAt = Date.now();
        metrics.matchesStarted += 1;
        phase = 'playing';
      });

      // Mirror every readiness gate exactly like the web client.
      socket.on('auction:waiting_for_ready', (payload: {
        matchId: string; phase: 'round' | 'bidding' | 'reveal'; roundId: string; stateVersion: number;
        waitingUserIds?: string[];
      }) => {
        touch();
        const key = `${payload.phase}:${payload.roundId}:${payload.stateVersion}`;
        if (ackedReadyKeys.has(key)) return;
        if (payload.waitingUserIds && !payload.waitingUserIds.includes(user.userId)) return;
        ackedReadyKeys.add(key);
        setTimeout(() => {
          socket.emit('auction:ui_ready', {
            matchId: payload.matchId,
            phase: payload.phase,
            roundId: payload.roundId,
            stateVersion: payload.stateVersion,
          });
        }, jitter(200, 900));
      });

      socket.on('auction:round_started', () => { touch(); roundsSeen += 1; });
      socket.on('auction:clue_revealed', touch);
      socket.on('auction:bidding_started', touch);
      socket.on('auction:round_revealed', touch);
      socket.on('auction:squad_updated', touch);
      socket.on('auction:turn_started', (payload: {
        matchId: string; currentTurnSeatId: string; minBid: number; maxBid: number;
        round?: { highestBidderSeatId?: string | null };
      }) => {
        touch();
        if (!mySeatId || payload.currentTurnSeatId !== mySeatId) return;
        // Human-ish thinking delay, then bid/fold. The forced OPENER may not
        // fold (server rejects it) — an affordable opener always bids; an
        // unaffordable one stays silent and lets the turn timer advance.
        // Otherwise bid appetite shrinks as the price grows vs the 350M budget.
        const affordable = payload.minBid <= payload.maxBid;
        const mustOpen = !payload.round?.highestBidderSeatId;
        const appetite = payload.minBid <= 40_000_000 ? 0.75 : payload.minBid <= 90_000_000 ? 0.45 : 0.2;
        const willBid = affordable && (mustOpen || Math.random() < appetite);
        if (!willBid && mustOpen) return;
        setTimeout(() => {
          if (phase !== 'playing') return;
          pendingAction = { kind: willBid ? 'bid' : 'fold', at: Date.now() };
          if (willBid) {
            socket.emit('auction:bid', { matchId: payload.matchId, amount: payload.minBid });
          } else {
            socket.emit('auction:fold', { matchId: payload.matchId });
          }
        }, jitter(600, 2_500));
      });
      socket.on('auction:bid_accepted', () => {
        touch();
        if (pendingAction?.kind === 'bid') {
          metrics.bids += 1;
          metrics.bidAckMs.push(Date.now() - pendingAction.at);
          pendingAction = null;
        }
      });
      socket.on('auction:fold_accepted', () => {
        touch();
        if (pendingAction?.kind === 'fold') {
          metrics.folds += 1;
          metrics.foldAckMs.push(Date.now() - pendingAction.at);
          pendingAction = null;
        }
      });

      socket.on('auction:solo_pick_started', (payload: {
        matchId: string; soloPick?: { playerSeatId: string }; playerSeatId?: string;
      }) => {
        touch();
        const pickerSeatId = payload.soloPick?.playerSeatId ?? payload.playerSeatId;
        if (pickerSeatId !== mySeatId) return;
        setTimeout(() => {
          if (phase !== 'playing') return;
          metrics.soloPicks += 1;
          socket.emit('auction:solo_pick_select', {
            matchId: payload.matchId,
            option: Math.random() < 0.5 ? 'A' : 'B',
          });
        }, jitter(800, 3_000));
      });

      socket.on('auction:player_forfeited', () => { touch(); metrics.playerForfeitSignals += 1; });
      socket.on('auction:error', (payload: { code?: string }) => {
        touch();
        bump(metrics.errors, `auction:${payload?.code ?? 'unknown'}`);
      });

      socket.on('auction:match_finished', () => {
        touch();
        metrics.matchesFinished += 1;
        if (matchStartedAt > 0) {
          metrics.matchDurationSec.push(Math.round((Date.now() - matchStartedAt) / 1000));
          metrics.roundsPerMatch.push(roundsSeen);
        }
        finish('finished');
      });

      // Watchdogs.
      const watchdog = setInterval(() => {
        const idleMs = Date.now() - lastEventAt;
        if (phase === 'searching' && Date.now() - searchStartedAt > MATCH_START_TIMEOUT_MS) {
          metrics.startTimeouts += 1;
          clearInterval(watchdog);
          finish('failed', 'match_start_timeout');
        } else if (phase === 'playing' && idleMs > STALL_TIMEOUT_MS) {
          metrics.stranded += 1;
          if (matchId) socket.emit('auction:forfeit', { matchId });
          clearInterval(watchdog);
          finish('failed', 'stranded_stall');
        } else if (phase === 'playing' && Date.now() - matchStartedAt > MATCH_FINISH_TIMEOUT_MS) {
          metrics.stranded += 1;
          clearInterval(watchdog);
          finish('failed', 'match_finish_timeout');
        }
      }, 5_000);
    });

    await done;
    await sleep(jitter(500, 2_000));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('━'.repeat(72));
  console.log(`AUCTION FLEET  target=${TARGET} api=${apiBase} sockets=${SOCKETS} matches/client=${MATCHES_PER_CLIENT} ramp=${RAMP_SEC}s offset=${OFFSET}`);
  console.log('━'.repeat(72));
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing.');

  console.log(`Provisioning ${SOCKETS} confirmed test users…`);
  const users = await provisionUsers({
    apiBase,
    supabaseUrl,
    serviceRoleKey,
    count: SOCKETS,
    startIndex: OFFSET,
    password: 'ChaosTest12345!',
    emailPrefix: 'chaos',
    emailDomain: 'quizball.io',
    concurrency: 10,
    loginIntervalMs: 2_200,
    bypassToken,
  });
  console.log(`  → ${users.length} users authenticated.`);
  if (users.length < SOCKETS) console.log(`  ! only ${users.length}/${SOCKETS} usable — running with those.`);

  const startedAt = new Date();
  const progress = setInterval(() => {
    console.log(`[fleet] searches=${metrics.searchesStarted} found=${metrics.matchesFound} started=${metrics.matchesStarted} finished=${metrics.matchesFinished} bids=${metrics.bids} folds=${metrics.folds} solo=${metrics.soloPicks} stranded=${metrics.stranded} errors=${[...metrics.errors.values()].reduce((a, b) => a + b, 0)}`);
  }, 15_000);

  await Promise.all(users.map(async (user, index) => {
    await sleep((index / Math.max(1, users.length)) * RAMP_SEC * 1000);
    try {
      await runClient(user, index);
    } catch (error) {
      bump(metrics.errors, `client_crash:${String((error as Error).message).slice(0, 60)}`);
    }
  }));
  clearInterval(progress);

  const summary = {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    target: TARGET,
    sockets: users.length,
    matchesPerClient: MATCHES_PER_CLIENT,
    ...metrics,
    errors: Object.fromEntries(metrics.errors),
    disconnects: Object.fromEntries(metrics.disconnects),
    percentiles: {
      searchToFoundMs: { p50: percentile(metrics.searchToFoundMs, 50), p95: percentile(metrics.searchToFoundMs, 95), max: percentile(metrics.searchToFoundMs, 100) },
      bidAckMs: { p50: percentile(metrics.bidAckMs, 50), p95: percentile(metrics.bidAckMs, 95), max: percentile(metrics.bidAckMs, 100) },
      foldAckMs: { p50: percentile(metrics.foldAckMs, 50), p95: percentile(metrics.foldAckMs, 95), max: percentile(metrics.foldAckMs, 100) },
      matchDurationSec: { p50: percentile(metrics.matchDurationSec, 50), p95: percentile(metrics.matchDurationSec, 95), max: percentile(metrics.matchDurationSec, 100) },
    },
  };
  const completionRate = metrics.matchesStarted > 0 ? (metrics.matchesFinished / metrics.matchesStarted) * 100 : 0;

  console.log('━'.repeat(72));
  console.log(`RESULT sockets=${users.length}`);
  console.log(`  matches: found=${metrics.matchesFound} started=${metrics.matchesStarted} finished=${metrics.matchesFinished} (${completionRate.toFixed(1)}% completion) stranded=${metrics.stranded} startTimeouts=${metrics.startTimeouts}`);
  console.log(`  actions: bids=${metrics.bids} folds=${metrics.folds} soloPicks=${metrics.soloPicks}`);
  console.log(`  latency: search→found p50=${summary.percentiles.searchToFoundMs.p50}ms p95=${summary.percentiles.searchToFoundMs.p95}ms | bid→ack p50=${summary.percentiles.bidAckMs.p50}ms p95=${summary.percentiles.bidAckMs.p95}ms`);
  console.log(`  match duration: p50=${summary.percentiles.matchDurationSec.p50}s p95=${summary.percentiles.matchDurationSec.p95}s | rounds/match p50=${percentile(metrics.roundsPerMatch, 50)}`);
  console.log(`  errors: ${JSON.stringify(summary.errors)}`);
  console.log(`  disconnects: ${JSON.stringify(summary.disconnects)}`);

  if (REPORT) {
    mkdirSync(resolve(REPO_ROOT, 'scripts/chaos/reports'), { recursive: true });
    const path = resolve(REPO_ROOT, 'scripts/chaos/reports', REPORT);
    writeFileSync(path, JSON.stringify(summary, null, 2));
    console.log(`  report → ${path}`);
  }
  process.exit(metrics.stranded === 0 && metrics.startTimeouts === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
