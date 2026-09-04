/* eslint-disable no-console */
/**
 * Football Tic Tac Toe realtime scenario suite.
 *
 * Drives real authenticated Socket.IO clients through the lifecycle edges the
 * capacity gate (football-grid.ts) does not exercise: bot fallback through the
 * countdown fence, answer resolution, pass, disconnect + rejoin, grace forfeit
 * with result redelivery on reconnect, human pairing, explicit forfeit, theme
 * isolation, search cancel, and a full match to completion ACK.
 *
 * Usage:
 *   npm run chaos:grid:scenarios -- --target=local [--only=S1,S5] [--campaign=name]
 *   npm run chaos:grid:scenarios -- --target=staging --only=S1
 *
 * Reads API/Supabase/DB config from the backend .env in the current directory
 * (the same file the local backend runs with). Production is blocked by
 * Supabase project and API identity guards.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { io, type Socket } from 'socket.io-client';
import { listAdminUserIdsByEmail, provisionUsers, type ChaosUser } from './auth.js';

const STAGING_SUPABASE_PROJECT = 'nsdfiprfmhdqhbfxfwpv';
const PRODUCTION_SUPABASE_PROJECT = 'lfbwhxvwubzeqkztghok';
const STAGING_API = 'https://api-staging.quizball.io';

type Theme = 'european' | 'england' | 'italy' | 'spain' | 'france' | 'germany' | 'georgia'
  | 'netherlands' | 'brazil' | 'turkey' | 'argentina';

interface Args {
  target: 'staging' | 'local';
  only: Set<string> | null;
  campaign: string;
  report?: string;
  /** Keep the provisioned Supabase Auth users instead of deleting them at the end. */
  keepUsers: boolean;
}

interface TargetConfig {
  apiBase: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
  bypassToken?: string;
  emailDomain: string;
}

interface PlayerState {
  userId: string;
  seat: 1 | 2;
  isBot: boolean;
  handoffAcknowledged: boolean;
  ready: boolean;
}

interface GridState {
  matchId: string;
  phase: 'handoff' | 'loading' | 'countdown' | 'turn' | 'paused' | 'service_interruption' | 'terminal';
  stateVersion: number;
  turnNumber: number;
  board: { boardId: string };
  players: [PlayerState, PlayerState];
  openerUserId: string;
  currentPlayerUserId: string | null;
  winnerUserId: string | null;
  completionReason: string | null;
  reconnectDeadlineAt: string | null;
  claims: Array<{ cellIndex: number; footballPlayerId: string; claimantUserId: string }>;
  drawOffer: { byUserId: string; turnNumber: number } | null;
}

interface SeriesInfo {
  seriesId: string;
  format: 'single' | 'bo3';
  gameIndex: number;
  targetWins: number;
  wins: Record<string, number>;
  draws: number;
  winnerUserId: string | null;
  finished: boolean;
}

interface CompletedPayload {
  matchId: string;
  state: GridState;
  terminalStateVersion: number;
  ackToken: string;
  rewards?: { coins: number; tp: number; xp: number; coinEligibilityReason?: string };
  series?: SeriesInfo | null;
  rematch?: { eligible: boolean; seriesId: string } | null;
}

interface RecordedEvent {
  at: number;
  name: string;
  payload: unknown;
}

interface ScenarioResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  detail?: string;
  notes: string[];
}

function value(argv: string[], key: string): string | undefined {
  const prefix = `--${key}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseArgs(argv: string[]): Args {
  const target = value(argv, 'target');
  if (target !== 'staging' && target !== 'local') {
    throw new Error('--target=staging|local is required');
  }
  const only = value(argv, 'only');
  return {
    target,
    only: only ? new Set(only.split(',').map((item) => item.trim().toUpperCase())) : null,
    campaign: value(argv, 'campaign') ?? `scn${Date.now().toString(36)}`,
    report: value(argv, 'report'),
    keepUsers: argv.includes('--keep-users'),
  };
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

function resolveTarget(args: Args): TargetConfig {
  const env = readEnv(resolve(process.cwd(), '.env'));
  const port = process.env.PORT ?? env.PORT ?? '8000';
  const config: TargetConfig = {
    apiBase: args.target === 'staging' ? STAGING_API : `http://127.0.0.1:${port}`,
    supabaseUrl: process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL ?? '',
    bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
    emailDomain: args.target === 'staging' ? 'quizball.io' : 'example.com',
  };
  const identityBlob = `${config.apiBase} ${config.supabaseUrl} ${config.databaseUrl}`;
  if (identityBlob.includes(PRODUCTION_SUPABASE_PROJECT) || config.apiBase.includes('api.quizball.io')) {
    throw new Error('PRODUCTION GUARD: refusing Football Tic Tac Toe scenarios against production.');
  }
  // Auth users are provisioned through Supabase Auth, so the Supabase project
  // is guarded independently of the database: a staging DB with a production
  // Supabase URL would create confirmed users in production before anything
  // else failed.
  if (!config.supabaseUrl.includes(STAGING_SUPABASE_PROJECT)) {
    throw new Error('IDENTITY GUARD: SUPABASE_URL must identify the staging project (local backends also authenticate against staging Supabase).');
  }
  if (args.target === 'staging' && !config.databaseUrl.includes(STAGING_SUPABASE_PROJECT)) {
    throw new Error('STAGING IDENTITY GUARD: DATABASE_URL must identify the staging project.');
  }
  if (args.target === 'local') {
    const dbHost = (() => { try { return new URL(config.databaseUrl).hostname; } catch { return ''; } })();
    if (!['localhost', '127.0.0.1', '::1'].includes(dbHost)) {
      throw new Error(`LOCAL GUARD: local target requires a loopback DATABASE_URL host (got "${dbHost}"); a shared database's sweepers adjudicate presence for your matches.`);
    }
  }
  if (!config.supabaseUrl || !config.serviceRoleKey || !config.databaseUrl) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL are required.');
  }
  return config;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

class ScenarioFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

const STATE_EVENTS = new Set([
  'grid:match_found', 'grid:loading_state', 'grid:countdown', 'grid:state',
  'grid:turn_resolved', 'grid:paused', 'grid:resumed', 'grid:completed',
]);
const RECORDED_EVENTS = [
  ...STATE_EVENTS, 'grid:search_state', 'grid:command_result', 'grid:error',
  'grid:rematch_state', 'session:blocked', 'connect', 'disconnect',
  'lobby:state', 'lobby:error', 'error',
];

interface Waiter {
  name: string;
  predicate: (payload: unknown) => boolean;
  resolve: (payload: unknown) => void;
  timer: NodeJS.Timeout;
}

interface StateWaiter {
  predicate: (state: GridState) => boolean;
  resolve: (state: GridState) => void;
  timer: NodeJS.Timeout;
}

/** A pending wait that can be dropped when a race is decided by another event. */
type Pending<T> = Promise<T> & { cancel: () => void };

class GridClient {
  readonly socket: Socket;
  readonly events: RecordedEvent[] = [];
  state: GridState | null = null;
  matchId: string | null = null;
  completed: CompletedPayload | null = null;
  /** Results of earlier games in the current series. */
  completedGames: CompletedPayload[] = [];
  auto = { handoff: true, ready: true, heartbeat: true, resync: true };
  private waiters: Waiter[] = [];
  private stateWaiters: StateWaiter[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  /** Highest accepted state version per match; survives dropConnection(). */
  private readonly versionFloor = new Map<string, number>();
  private handoffAcked = new Set<number>();
  private readyAcked = new Set<number>();
  private connectedBefore = false;

  constructor(readonly user: ChaosUser, readonly label: string, target: TargetConfig, campaign: string) {
    this.socket = io(target.apiBase, {
      transports: ['websocket'],
      auth: { token: user.token },
      forceNew: true,
      autoConnect: false,
      reconnection: true,
      extraHeaders: {
        'x-client-instance-id': `${campaign}-${label}`,
        ...(target.bypassToken ? { 'x-chaos-bypass': target.bypassToken } : {}),
      },
    });
    for (const name of RECORDED_EVENTS) {
      this.socket.on(name, (payload: unknown) => this.record(name, payload));
    }
  }

  get userId(): string {
    return this.user.userId;
  }

  private record(name: string, payload: unknown): void {
    this.events.push({ at: Date.now(), name, payload });
    if (name === 'connect') {
      if (this.connectedBefore) {
        // Mirror the production hook: versioned handoff/ready commands may
        // have been lost with the old transport; let the resync re-trigger.
        this.handoffAcked.clear();
        this.readyAcked.clear();
        if (this.matchId && this.auto.resync) this.socket.emit('grid:resync', { matchId: this.matchId });
        if (this.matchId) this.startHeartbeat();
      }
      this.connectedBefore = true;
    }
    if (name === 'grid:match_found') {
      const found = payload as { matchId: string; state: GridState };
      if (this.matchId && found.matchId !== this.matchId) {
        // Next game of a series: the finished game's result is kept in
        // `completedGames`, per-match tracking starts over.
        if (this.completed) this.completedGames.push(this.completed);
        this.completed = null;
        this.state = null;
        this.handoffAcked.clear();
        this.readyAcked.clear();
      }
      this.matchId = found.matchId;
      this.startHeartbeat();
    }
    if (name === 'grid:completed') {
      const done = payload as CompletedPayload;
      if (!this.matchId || done.matchId === this.matchId) {
        this.completed = done;
        this.stopHeartbeat();
      } else {
        // Result of an earlier series game arriving after the next handoff.
        this.completedGames.push(done);
      }
    }

    if (STATE_EVENTS.has(name)) {
      const state = (payload as { state?: GridState }).state;
      if (state) this.applyState(state);
    }
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.name === name && waiter.predicate(payload)) {
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
      } else this.waiters.push(waiter);
    }
  }

  private applyState(state: GridState): void {
    if (this.matchId && state.matchId !== this.matchId) return;
    if (state.stateVersion < (this.versionFloor.get(state.matchId) ?? -1)) return;
    this.versionFloor.set(state.matchId, state.stateVersion);
    this.state = state;
    const me = state.players.find((player) => player.userId === this.userId);
    if (state.phase === 'handoff' && me && !me.handoffAcknowledged && this.auto.handoff
      && !this.handoffAcked.has(state.stateVersion)) {
      this.handoffAcked.add(state.stateVersion);
      this.socket.emit('grid:match_found_ack', {
        matchId: state.matchId, commandId: randomUUID(), expectedStateVersion: state.stateVersion,
      });
    }
    if (state.phase === 'loading' && me && !me.ready && this.auto.ready && !this.readyAcked.has(state.stateVersion)) {
      this.readyAcked.add(state.stateVersion);
      this.socket.emit('grid:client_ready', {
        matchId: state.matchId, commandId: randomUUID(), expectedStateVersion: state.stateVersion,
      });
    }
    const pending = this.stateWaiters;
    this.stateWaiters = [];
    for (const waiter of pending) {
      if (waiter.predicate(state)) {
        clearTimeout(waiter.timer);
        waiter.resolve(state);
      } else this.stateWaiters.push(waiter);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat || !this.auto.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.matchId && this.socket.connected) this.socket.emit('grid:presence_heartbeat', { matchId: this.matchId });
    }, 5_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.socket.connected) return;
    const connected = this.waitFor('connect', () => true, timeoutMs, `${this.label} connect`);
    this.socket.connect();
    await connected;
  }

  /**
   * Hard transport drop; auto-reconnect is off until connect() is called.
   * The cached snapshot is discarded so every wait after reconnect needs a
   * fresh server state (a command built from the pre-drop snapshot is
   * correctly rejected as STALE_STATE); the per-match version floor stays, so
   * a replayed pre-drop snapshot is still rejected.
   */
  dropConnection(): void {
    this.stopHeartbeat();
    this.socket.disconnect();
    this.state = null;
  }

  isInActiveMatch(): boolean {
    return Boolean(this.socket.connected && this.state && this.state.phase !== 'terminal' && !this.completed);
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    for (const waiter of this.stateWaiters) clearTimeout(waiter.timer);
    this.waiters = [];
    this.stateWaiters = [];
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }

  waitFor<T = unknown>(name: string, predicate: (payload: T) => boolean, timeoutMs: number, what: string): Pending<T> {
    let waiter: Waiter | null = null;
    const promise = new Promise<T>((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        reject(new ScenarioFailure(`${this.label}: timed out after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      waiter = { name, predicate: (payload) => predicate(payload as T), resolve: (payload) => resolveWait(payload as T), timer };
      this.waiters.push(waiter);
    }) as Pending<T>;
    promise.cancel = () => {
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((entry) => entry !== waiter);
    };
    // A cancelled or lost race must never surface as an unhandled rejection.
    promise.catch(() => undefined);
    return promise;
  }

  waitForState(predicate: (state: GridState) => boolean, timeoutMs: number, what: string): Pending<GridState> {
    let waiter: StateWaiter | null = null;
    const promise = new Promise<GridState>((resolveWait, reject) => {
      if (this.state && predicate(this.state)) {
        resolveWait(this.state);
        return;
      }
      const timer = setTimeout(() => {
        this.stateWaiters = this.stateWaiters.filter((entry) => entry !== waiter);
        reject(new ScenarioFailure(`${this.label}: timed out after ${timeoutMs}ms waiting for ${what} (last phase ${this.state?.phase ?? 'none'} v${this.state?.stateVersion ?? '-'})`));
      }, timeoutMs);
      waiter = { predicate, resolve: resolveWait, timer };
      this.stateWaiters.push(waiter);
    }) as Pending<GridState>;
    promise.cancel = () => {
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.stateWaiters = this.stateWaiters.filter((entry) => entry !== waiter);
    };
    promise.catch(() => undefined);
    return promise;
  }

  waitMyTurn(timeoutMs: number): Pending<GridState> {
    return this.waitForState(
      (state) => state.phase === 'turn' && state.currentPlayerUserId === this.userId,
      timeoutMs,
      'my turn',
    );
  }

  async search(theme: Theme, locale: 'en' | 'ka' = 'en'): Promise<{ matchId: string; state: GridState }> {
    const found = this.waitFor<{ matchId: string; state: GridState }>('grid:match_found', () => true, 45_000, `match_found (${theme})`);
    this.socket.emit('grid:search_start', { locale, theme });
    return found;
  }

  private async command(event: 'grid:submit_answer' | 'grid:pass' | 'grid:forfeit' | 'grid:draw_offer' | 'grid:draw_respond', extra: Record<string, unknown> = {}) {
    assert(this.state, `${this.label}: no state to command from`);
    const commandId = randomUUID();
    const result = this.waitFor<{ commandId: string; outcome: string }>(
      'grid:command_result', (payload) => payload.commandId === commandId, 15_000, `command_result for ${event}`,
    );
    // Server errors carry no commandId; only command-level rejections (those
    // with a gridCode) are attributed to the command in flight.
    const error = this.waitFor<{ code?: string; meta?: { gridCode?: string } }>(
      'grid:error', (payload) => typeof payload.meta?.gridCode === 'string', 15_000, 'grid:error',
    );
    this.socket.emit(event, {
      matchId: this.state.matchId, commandId, expectedStateVersion: this.state.stateVersion, ...extra,
    });
    try {
      return await Promise.race([
        result,
        error.then((err) => ({ commandId, outcome: `error:${err.meta?.gridCode ?? err.code ?? 'unknown'}` })),
      ]);
    } finally {
      result.cancel();
      error.cancel();
    }
  }

  submit(cellIndex: number, text: string, locale: 'en' | 'ka' = 'en') {
    return this.command('grid:submit_answer', { cellIndex, text, locale });
  }

  pass() {
    return this.command('grid:pass');
  }

  /** Forfeit emits no command_result; the terminal broadcast is the acknowledgement. */
  offerDraw() {
    return this.command('grid:draw_offer');
  }

  respondDraw(accept: boolean) {
    return this.command('grid:draw_respond', { accept });
  }

  forfeit(): Promise<CompletedPayload> {
    assert(this.state, `${this.label}: no state to forfeit from`);
    const done = this.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === this.state?.matchId, 15_000, 'grid:completed after forfeit');
    this.socket.emit('grid:forfeit', {
      matchId: this.state.matchId, commandId: randomUUID(), expectedStateVersion: this.state.stateVersion,
    });
    return done;
  }

  /** The completion payload for a match, whether it is the current one or an earlier series game. */
  completionFor(matchId: string): CompletedPayload | null {
    if (this.completed?.matchId === matchId) return this.completed;
    return this.completedGames.find((game) => game.matchId === matchId) ?? null;
  }

  ackCompleted(matchId?: string): void {
    const done = matchId ? this.completionFor(matchId) : this.completed;
    assert(done, `${this.label}: nothing to ack${matchId ? ` for ${matchId}` : ''}`);
    this.socket.emit('grid:completed_ack', {
      matchId: done.matchId,
      terminalStateVersion: done.terminalStateVersion,
      ackToken: done.ackToken,
    });
  }

  gridErrors(): string[] {
    return this.events
      .filter((event) => event.name === 'grid:error')
      .map((event) => {
        const err = event.payload as { code?: string; meta?: { gridCode?: string } };
        return err.meta?.gridCode ?? err.code ?? 'unknown';
      });
  }
}

class Content {
  private readonly db: postgres.Sql;

  constructor(databaseUrl: string) {
    this.db = postgres(databaseUrl, { max: 2, connect_timeout: 10, prepare: false });
  }

  /**
   * An exact English alias for an unclaimed valid answer, read from the
   * match's own pinned content + alias releases (what the resolver uses), so
   * the outcome is deterministic regardless of newer published releases.
   */
  async correctAnswer(matchId: string, cellIndex: number): Promise<string> {
    const rows = await this.db<Array<{ alias: string }>>`
      SELECT al.alias
        FROM football_grid_matches m
        JOIN football_grid_board_answers a
          ON a.board_id = m.board_id AND a.release_id = m.content_release_id AND a.cell_index = ${cellIndex}
        JOIN football_grid_player_aliases al
          ON al.football_player_id = a.football_player_id AND al.release_id = m.alias_release_id
         AND al.locale = 'en' AND al.acceptance_policy = 'exact'
       WHERE m.match_id = ${matchId}
         AND NOT EXISTS (
           SELECT 1 FROM football_grid_claims c
            WHERE c.match_id = m.match_id AND c.football_player_id = a.football_player_id
         )
       ORDER BY a.recognizable_rank NULLS LAST, al.alias
       LIMIT 1
    `;
    assert(rows[0]?.alias, `no unclaimed exact-alias answer for match ${matchId} cell ${cellIndex}`);
    return rows[0].alias;
  }

  async matchRow(matchId: string) {
    const rows = await this.db<Array<{ phase: string; completion_reason: string | null; winner_user_id: string | null }>>`
      SELECT phase, completion_reason, winner_user_id FROM football_grid_matches WHERE match_id = ${matchId}
    `;
    return rows[0] ?? null;
  }

  /** The user's delivery row for a match; 'delivered' is the terminal status set by grid:completed_ack. */
  async deliveryStatus(userId: string, matchId: string): Promise<string | null> {
    const rows = await this.db<Array<{ status: string }>>`
      SELECT status FROM football_grid_result_deliveries WHERE user_id = ${userId} AND match_id = ${matchId}
    `;
    return rows[0]?.status ?? null;
  }

  async undeliveredResults(userId: string) {
    return this.db<Array<{ match_id: string; status: string }>>`
      SELECT match_id, status FROM football_grid_result_deliveries
       WHERE user_id = ${userId} AND status <> 'delivered'
    `;
  }

  async close(): Promise<void> {
    await this.db.end({ timeout: 5 });
  }
}

/** Prove the outbox row exists, is awaiting our ACK, and flips to 'delivered' after it. */
async function ackAndProve(client: GridClient, content: Content, matchId: string): Promise<void> {
  const before = await content.deliveryStatus(client.userId, matchId);
  assert(before === 'awaiting_ack', `${client.label}: delivery row before ACK is ${before ?? 'missing'}, expected awaiting_ack`);
  client.ackCompleted(matchId);
  let after: string | null = before;
  for (let i = 0; i < 20 && after !== 'delivered'; i += 1) {
    await wait(250);
    after = await content.deliveryStatus(client.userId, matchId);
  }
  assert(after === 'delivered', `${client.label}: delivery row after ACK is ${after ?? 'missing'}, expected delivered`);
}

function freeCell(state: GridState, avoid: number[] = []): number {
  const taken = new Set([...state.claims.map((claim) => claim.cellIndex), ...avoid]);
  for (let index = 0; index < 9; index += 1) if (!taken.has(index)) return index;
  throw new ScenarioFailure('board is full');
}

function opponentOf(state: GridState, userId: string): PlayerState {
  const opponent = state.players.find((player) => player.userId !== userId);
  assert(opponent, 'opponent missing from state');
  return opponent;
}

interface Scenario {
  id: string;
  title: string;
  users: number;
  run: (ctx: ScenarioContext) => Promise<void>;
}

interface ScenarioContext {
  clients: GridClient[];
  content: Content;
  note: (message: string) => void;
}

/** Reach a live bot match at the first turn; returns the state at phase 'turn'. */
async function startBotMatch(client: GridClient, theme: Theme, note: (m: string) => void): Promise<GridState> {
  const searchedAt = Date.now();
  const found = await client.search(theme);
  const opponent = opponentOf(found.state, client.userId);
  assert(opponent.isBot, `expected a bot opponent after fallback, got human ${opponent.userId}`);
  note(`bot match ${found.matchId} after ${Date.now() - searchedAt}ms`);
  const turn = await client.waitForState((state) => state.phase === 'turn', 40_000, 'first turn (handoff→loading→countdown fence)');
  note(`first turn reached at v${turn.stateVersion} ${Date.now() - searchedAt}ms after search`);
  return turn;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'S1',
    title: 'Bot fallback crosses the countdown fence into a live turn',
    users: 1,
    run: async ({ clients: [a], note }) => {
      const state = await startBotMatch(a, 'european', note);
      assert(state.currentPlayerUserId, 'turn phase has no current player');
      assert(a.gridErrors().length === 0, `grid:error during start: ${a.gridErrors().join(',')}`);
    },
  },
  {
    id: 'S2',
    title: 'Correct answer claims the cell; wrong answer does not',
    users: 1,
    run: async ({ clients: [a], content, note }) => {
      await startBotMatch(a, 'european', note);
      let state = await a.waitMyTurn(30_000);
      const cell = freeCell(state);
      const answer = await content.correctAnswer(state.matchId, cell);
      const correct = await a.submit(cell, answer);
      note(`submitted "${answer}" for cell ${cell} → ${correct.outcome}`);
      assert(correct.outcome === 'correct', `expected correct, got ${correct.outcome}`);
      state = await a.waitForState((s) => s.claims.some((c) => c.cellIndex === cell && c.claimantUserId === a.userId), 10_000, 'claim to appear');
      state = await a.waitMyTurn(30_000);
      const cell2 = freeCell(state);
      const wrong = await a.submit(cell2, `zz-not-a-player-${randomUUID().slice(0, 8)}`);
      note(`garbage for cell ${cell2} → ${wrong.outcome}`);
      assert(wrong.outcome === 'wrong', `expected wrong, got ${wrong.outcome}`);
      state = await a.waitForState((s) => s.currentPlayerUserId !== a.userId || s.phase !== 'turn', 10_000, 'turn to pass to bot');
      assert(!state.claims.some((c) => c.cellIndex === cell2 && c.claimantUserId === a.userId), 'wrong answer must not claim');
    },
  },
  {
    id: 'S3',
    title: 'Pass hands the turn to the opponent',
    users: 1,
    run: async ({ clients: [a], note }) => {
      await startBotMatch(a, 'european', note);
      const before = await a.waitMyTurn(30_000);
      const pass = await a.pass();
      note(`pass → ${pass.outcome}`);
      assert(!pass.outcome.startsWith('error:'), `pass rejected: ${pass.outcome}`);
      const after = await a.waitForState((s) => s.stateVersion > before.stateVersion && s.currentPlayerUserId !== a.userId, 10_000, 'turn to move to bot');
      assert(after.turnNumber > before.turnNumber, 'turn number did not advance on pass');
    },
  },
  {
    id: 'S4',
    title: 'Transport drop mid-match → reconnect inside the window → match resumes',
    users: 1,
    run: async ({ clients: [a], note }) => {
      await startBotMatch(a, 'european', note);
      const before = await a.waitMyTurn(30_000);
      a.dropConnection();
      note('dropped transport, waiting 8s');
      await wait(8_000);
      await a.connect();
      const resumed = await a.waitForState(
        (s) => s.matchId === before.matchId && s.stateVersion > before.stateVersion && (s.phase === 'turn' || s.phase === 'countdown'),
        20_000,
        'post-pause/resume state after reconnect',
      );
      note(`back in phase ${resumed.phase} v${resumed.stateVersion} (was v${before.stateVersion})`);
      assert(resumed.phase !== 'terminal', 'match terminalized during a short drop');
      const turn = await a.waitMyTurn(40_000);
      const pass = await a.pass();
      assert(!pass.outcome.startsWith('error:'), `command after resume rejected: ${pass.outcome} (turn v${turn.stateVersion})`);
    },
  },
  {
    id: 'S5',
    title: 'Stay away past the reconnect window → forfeit, result delivered on next connect',
    users: 1,
    run: async ({ clients: [a], content, note }) => {
      const state = await startBotMatch(a, 'european', note);
      const bot = opponentOf(state, a.userId);
      a.dropConnection();
      const droppedAt = Date.now();
      note('dropped transport; waiting for presence lease + reconnect window to expire');
      let row = await content.matchRow(state.matchId);
      for (let i = 0; i < 40 && row?.phase !== 'terminal'; i += 1) {
        await wait(3_000);
        row = await content.matchRow(state.matchId);
      }
      assert(row?.phase === 'terminal', `match still ${row?.phase} ${Date.now() - droppedAt}ms after drop`);
      note(`terminal (${row.completion_reason}) ${Date.now() - droppedAt}ms after drop`);
      assert(row.completion_reason === 'disconnect_timeout', `expected disconnect_timeout, got ${row.completion_reason}`);
      assert(row.winner_user_id === bot.userId, `winner must be the bot ${bot.userId}, got ${row.winner_user_id}`);
      const pending = await content.deliveryStatus(a.userId, state.matchId);
      assert(pending !== null && pending !== 'delivered', `absent player's delivery row is ${pending ?? 'missing'}`);
      a.auto.resync = false; // the real client has no matchId after a reload; delivery must come from connect alone
      a.matchId = null;
      a.state = null;
      const delivered = a.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === state.matchId, 15_000, 'grid:completed on reconnect');
      await a.connect();
      const payload = await delivered;
      note(`result redelivered ${Date.now() - droppedAt}ms after drop, reason ${payload.state.completionReason}`);
      a.completed = payload;
      await ackAndProve(a, content, state.matchId);
    },
  },
  {
    id: 'S6',
    title: 'Two humans on the same theme are paired and both reach the first turn',
    users: 2,
    run: async ({ clients: [a, b], note }) => {
      const [fa, fb] = await Promise.all([a.search('england'), b.search('england')]);
      assert(fa.matchId === fb.matchId, `paired into different matches: ${fa.matchId} vs ${fb.matchId}`);
      assert(fa.state.players.every((p) => !p.isBot), 'human pair must not include a bot');
      note(`paired in ${fa.matchId}`);
      const [ta, tb] = await Promise.all([
        a.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
        b.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
      ]);
      assert(ta.currentPlayerUserId === tb.currentPlayerUserId, 'clients disagree on who moves first');
    },
  },
  {
    id: 'S7',
    title: 'Explicit forfeit ends a human match; both receive the result and ACK it',
    users: 2,
    run: async ({ clients: [a, b], content, note }) => {
      const [fa, fb] = await Promise.all([a.search('spain'), b.search('spain')]);
      assert(fa.matchId === fb.matchId, 'humans were not paired');
      await Promise.all([
        a.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
        b.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
      ]);
      const winnerSide = b.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fa.matchId, 15_000, 'completed (winner)');
      const ca = await a.forfeit();
      const cb = await winnerSide;
      note(`forfeit → ${ca.state.completionReason}`);
      assert(ca.state.completionReason === 'forfeit', `reason ${ca.state.completionReason}`);
      assert(ca.state.winnerUserId === b.userId && cb.state.winnerUserId === b.userId, 'winner must be the non-forfeiting player');
      await ackAndProve(a, content, fa.matchId);
      await ackAndProve(b, content, fa.matchId);
      assert(a.gridErrors().length === 0 && b.gridErrors().length === 0, `grid:error seen: ${[...a.gridErrors(), ...b.gridErrors()].join(',')}`);
    },
  },
  {
    id: 'S8',
    title: 'Different themes never pair and neither starves the other\'s bot fallback',
    users: 2,
    run: async ({ clients: [a, b], note }) => {
      const startedAt = Date.now();
      const [fa, fb] = await Promise.all([a.search('italy'), b.search('germany')]);
      assert(fa.matchId !== fb.matchId, 'players on different packs were paired together');
      assert(opponentOf(fa.state, a.userId).isBot && opponentOf(fb.state, b.userId).isBot, 'each should fall back to a bot');
      note(`both bot-matched ${Date.now() - startedAt}ms after search`);
      assert(Date.now() - startedAt < 30_000, 'bot fallback was deferred beyond its window (theme-blind starvation)');
    },
  },
  {
    id: 'S9',
    title: 'Search cancel leaves the queue idle with no match',
    users: 1,
    run: async ({ clients: [a], note }) => {
      const searching = a.waitFor<{ state: string; searchId: string }>('grid:search_state', (p) => p.state !== 'idle', 10_000, 'searching state');
      a.socket.emit('grid:search_start', { locale: 'en', theme: 'brazil' });
      const search = await searching;
      note(`search ${search.searchId} state ${search.state}`);
      // A cancel sent right after search_state can find the start path still
      // holding the user session lock (GRID_SEARCH_BUSY). This mirrors the web
      // client's policy exactly: up to 3 retries, 800ms apart.
      let cancelled = false;
      for (let attempt = 0; attempt <= 3 && !cancelled; attempt += 1) {
        const idle = a.waitFor<{ state: string }>('grid:search_state', (p) => p.state === 'idle', 4_000, 'idle state after cancel');
        const busy = a.waitFor<{ code?: string }>('grid:error', (p) => p.code === 'GRID_SEARCH_BUSY', 4_000, 'busy');
        a.socket.emit('grid:search_cancel', { searchId: search.searchId });
        const outcome = await Promise.race([idle.then(() => 'idle'), busy.then(() => 'busy')]).catch(() => 'timeout');
        idle.cancel();
        busy.cancel();
        if (outcome === 'idle') cancelled = true;
        else {
          note(`cancel attempt ${attempt + 1} → ${outcome}`);
          await wait(800);
        }
      }
      assert(cancelled, 'search never went idle after cancel (within the client retry budget)');
      await wait(15_000);
      assert(!a.matchId, 'a match was created after cancel');
    },
  },
  {
    id: 'S10',
    title: 'Full bot match to completion with a durable ACK and rewards payload',
    users: 1,
    run: async ({ clients: [a], content, note }) => {
      await startBotMatch(a, 'european', note);
      const deadline = Date.now() + 240_000;
      let moves = 0;
      while (!a.completed && Date.now() < deadline) {
        const myTurn = a.waitMyTurn(60_000);
        const done = a.waitFor<CompletedPayload>('grid:completed', () => true, 60_000, 'completed');
        const state = await Promise.race([myTurn, done.then(() => null)]).catch(() => null);
        myTurn.cancel();
        done.cancel();
        if (!state || a.completed) break;
        const cell = freeCell(state);
        const expectCorrect = moves % 2 === 0;
        const answer = expectCorrect ? await content.correctAnswer(state.matchId, cell) : `zz-wrong-${moves}`;
        const result = await a.submit(cell, answer);
        moves += 1;
        assert(result.outcome === (expectCorrect ? 'correct' : 'wrong'), `move ${moves} ("${answer}") → ${result.outcome}, expected ${expectCorrect ? 'correct' : 'wrong'}`);
        await wait(200);
      }
      assert(a.completed, `match did not complete within budget after ${moves} moves`);
      const final = a.completed.state;
      note(`completed after ${moves} of my moves: ${final.completionReason}, winner ${final.winnerUserId === a.userId ? 'me' : 'bot'}`);
      assert(final.claims.some((c) => c.claimantUserId === a.userId), 'no cell was ever claimed by the human');
      assert(['line', 'board_full', 'turn_limit'].includes(final.completionReason ?? ''), `unexpected completion reason ${final.completionReason}`);
      assert(a.completed.rewards, 'completed payload has no rewards');
      await ackAndProve(a, content, final.matchId);
      assert(a.gridErrors().length === 0, `grid:error seen: ${a.gridErrors().join(',')}`);
    },
  },
  {
    id: 'S14',
    title: 'Friend lobby: create, join by code, pick Tic Tac Toe, start → same best-of-3 for both; rematch offered after the series',
    users: 2,
    run: async ({ clients: [host, guest], content, note }) => {
      interface LobbyState { inviteCode?: string | null; members?: Array<{ isReady?: boolean }>; settings?: { gameMode?: string } }
      const created = host.waitFor<LobbyState>('lobby:state', (p) => Boolean(p.inviteCode), 15_000, 'lobby created');
      host.socket.emit('lobby:create', { mode: 'friendly' });
      const lobby = await created;
      note(`lobby ${lobby.inviteCode}`);
      const joined = host.waitFor<LobbyState>('lobby:state', (p) => (p.members?.length ?? 0) === 2, 15_000, 'guest joined');
      guest.socket.emit('lobby:join_by_code', { inviteCode: lobby.inviteCode });
      await joined;
      const modeSet = host.waitFor<LobbyState>('lobby:state', (p) => p.settings?.gameMode === 'football_grid', 15_000, 'mode selected');
      host.socket.emit('lobby:update_settings', { gameMode: 'football_grid' });
      await modeSet;
      const allReady = host.waitFor<LobbyState>('lobby:state', (p) => (p.members?.length ?? 0) === 2 && Boolean(p.members?.every((m) => m.isReady)), 15_000, 'both ready');
      host.socket.emit('lobby:ready', { ready: true });
      guest.socket.emit('lobby:ready', { ready: true });
      await allReady;
      const foundHost = host.waitFor<{ matchId: string; series?: SeriesInfo | null }>('grid:match_found', () => true, 30_000, 'match (host)');
      const foundGuest = guest.waitFor<{ matchId: string }>('grid:match_found', () => true, 30_000, 'match (guest)');
      host.socket.emit('lobby:start', {});
      const [fh, fg] = await Promise.all([foundHost, foundGuest]);
      assert(fh.matchId === fg.matchId, 'lobby members received different matches');
      assert(fh.series?.format === 'bo3' && fh.series.gameIndex === 1, `friend series info: ${JSON.stringify(fh.series)}`);
      note(`friend match ${fh.matchId} (bo3 game 1)`);
      const [th] = await Promise.all([
        host.waitForState((s) => s.phase === 'turn', 40_000, 'first turn (host)'),
        guest.waitForState((s) => s.phase === 'turn', 40_000, 'first turn (guest)'),
      ]);
      // Game 1: the mover claims a line with three correct answers while the other passes.
      const [mover, passer] = th.currentPlayerUserId === host.userId ? [host, guest] : [guest, host];
      const doneMover = mover.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fh.matchId, 120_000, 'game 1 result');
      for (const cell of [0, 1, 2]) {
        const state = await mover.waitMyTurn(60_000);
        const answer = await content.correctAnswer(state.matchId, cell);
        const result = await mover.submit(cell, answer);
        assert(result.outcome === 'correct', `cell ${cell} → ${result.outcome}`);
        if (cell < 2) {
          await passer.waitMyTurn(60_000);
          await passer.pass();
        }
      }
      const game1 = await doneMover;
      assert(game1.state.completionReason === 'line' && game1.state.winnerUserId === mover.userId, `game 1 ended ${game1.state.completionReason}`);
      assert(game1.rewards?.coinEligibilityReason === 'series_in_progress', `game 1 reason ${game1.rewards?.coinEligibilityReason}`);
      await ackAndProve(mover, content, fh.matchId);
      // The passer's copy usually lands while the mover is acknowledging.
      if (!passer.completionFor(fh.matchId)) {
        await passer.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fh.matchId, 15_000, 'game 1 result (passer)');
      }
      await ackAndProve(passer, content, fh.matchId);
      const [g2h, g2g] = await Promise.all([
        host.waitFor<{ matchId: string; state: GridState }>('grid:match_found', (p) => p.matchId !== fh.matchId, 20_000, 'game 2 (host)'),
        guest.waitFor<{ matchId: string; state: GridState }>('grid:match_found', (p) => p.matchId !== fh.matchId, 20_000, 'game 2 (guest)'),
      ]);
      assert(g2h.matchId === g2g.matchId, 'game 2 differs between friends');
      assert(g2h.state.openerUserId !== th.openerUserId, 'game 2 opener must alternate');
      note(`game 2 ${g2h.matchId} dealt`);
      await Promise.all([
        host.waitForState((s) => s.matchId === g2h.matchId && s.phase === 'turn', 40_000, 'game 2 turn (host)'),
        guest.waitForState((s) => s.matchId === g2h.matchId && s.phase === 'turn', 40_000, 'game 2 turn (guest)'),
      ]);
      // The loser of game 1 forfeits game 2: series decided 2-0, rematch offered to friends.
      const doneWinner = mover.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === g2h.matchId, 15_000, 'series result');
      const done = await passer.forfeit();
      const winnerView = mover.completionFor(g2h.matchId) ?? await doneWinner;
      doneWinner.cancel();
      assert(done.series?.finished && done.series.winnerUserId === mover.userId, `series not decided: ${JSON.stringify(done.series)}`);
      assert(winnerView.rewards?.coinEligibilityReason === 'friend_match_no_coins' || winnerView.rewards?.coinEligibilityReason === 'forfeit_no_coins', `deciding game reason ${winnerView.rewards?.coinEligibilityReason}`);
      note(`series over: ${JSON.stringify(done.series?.wins)}; rematch eligible=${winnerView.rematch?.eligible}`);
      assert(winnerView.rematch?.eligible === true, 'friends should be offered a rematch after the series');
      await ackAndProve(mover, content, g2h.matchId);
      await ackAndProve(passer, content, g2h.matchId);
    },
  },
  {
    id: 'S11',
    title: 'Best of 3 vs bot: game 1 pays nothing, game 2 is dealt automatically with the other opener',
    users: 1,
    run: async ({ clients: [a], content, note }) => {
      const first = await startBotMatch(a, 'european', note);
      const bot = opponentOf(first, a.userId);
      const game1 = first.matchId;
      const opener1 = first.currentPlayerUserId;
      // Lose game 1 fast: pass every turn until the bot completes a line.
      const done1 = a.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === game1, 240_000, 'game 1 result');
      const passLoop = (async () => {
        while (!a.completed) {
          const turn = a.waitMyTurn(60_000);
          const end = a.waitFor<CompletedPayload>('grid:completed', () => true, 60_000, 'completed');
          const state = await Promise.race([turn, end.then(() => null)]).catch(() => null);
          turn.cancel(); end.cancel();
          if (!state || a.completed) break;
          await a.pass();
          await wait(150);
        }
      })();
      const result1 = await done1;
      await passLoop;
      assert(result1.series && result1.series.format === 'bo3', 'game 1 result carries no bo3 series info');
      assert(result1.series.gameIndex === 1 && !result1.series.finished, `series after game 1: ${JSON.stringify(result1.series)}`);
      assert(result1.rewards && result1.rewards.coins === 0 && result1.rewards.tp === 0, `game 1 must not pay: ${JSON.stringify(result1.rewards)}`);
      assert(result1.rewards.coinEligibilityReason === 'series_in_progress', `reason ${result1.rewards.coinEligibilityReason}`);
      await ackAndProve(a, content, game1);
      const second = await a.waitFor<{ matchId: string; state: GridState; series?: SeriesInfo | null }>(
        'grid:match_found', (p) => p.matchId !== game1, 20_000, 'game 2 handoff');
      note(`game 2 ${second.matchId} dealt ${JSON.stringify(second.series?.wins)}`);
      assert(second.series?.gameIndex === 2, `game 2 series info: ${JSON.stringify(second.series)}`);
      assert(opponentOf(second.state, a.userId).userId === bot.userId, 'game 2 must keep the same bot');
      assert(second.state.openerUserId !== opener1, 'the opener must alternate between games');
      assert(second.state.board.boardId !== first.board.boardId, 'game 2 must use a different board');
      const turn2 = await a.waitForState((s) => s.matchId === second.matchId && s.phase === 'turn', 40_000, 'game 2 first turn');
      note(`game 2 live at v${turn2.stateVersion}`);
      // Forfeit game 2: the series ends 0-2 and this deciding game pays the series loss.
      const done2 = await a.forfeit();
      assert(done2.series?.finished && done2.series.winnerUserId === bot.userId, `series not decided for bot: ${JSON.stringify(done2.series)}`);
      assert(done2.rewards, 'deciding game carries no rewards');
      await ackAndProve(a, content, second.matchId);
    },
  },
  {
    id: 'S12',
    title: 'Draw offer: decline locks the offerer, accept ends the game as draw_agreed and deals game 2',
    users: 2,
    run: async ({ clients: [a, b], content, note }) => {
      const [fa, fb] = await Promise.all([a.search('italy'), b.search('italy')]);
      assert(fa.matchId === fb.matchId, 'humans were not paired');
      await Promise.all([
        a.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
        b.waitForState((s) => s.phase === 'turn', 40_000, 'first turn'),
      ]);
      const offered = await a.offerDraw();
      assert(offered.outcome === 'draw_offered', `offer → ${offered.outcome}`);
      const seen = await b.waitForState((s) => s.drawOffer?.byUserId === a.userId, 10_000, 'offer visible to opponent');
      note(`offer visible at v${seen.stateVersion}`);
      const declined = await b.respondDraw(false);
      assert(declined.outcome === 'draw_declined', `decline → ${declined.outcome}`);
      await a.waitForState((s) => s.drawOffer === null && s.stateVersion > seen.stateVersion, 10_000, 'offer cleared');
      const again = await a.offerDraw();
      assert(again.outcome === 'error:DRAW_OFFER_LOCKED', `locked offerer should be rejected, got ${again.outcome}`);
      const counter = await b.offerDraw();
      assert(counter.outcome === 'draw_offered', `counter offer → ${counter.outcome}`);
      await a.waitForState((s) => s.drawOffer?.byUserId === b.userId, 10_000, 'counter offer visible');
      const doneA = a.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fa.matchId, 15_000, 'completed (a)');
      const doneB = b.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fa.matchId, 15_000, 'completed (b)');
      const accepted = await a.respondDraw(true);
      assert(accepted.outcome === 'draw_accepted', `accept → ${accepted.outcome}`);
      const [ca, cb] = await Promise.all([doneA, doneB]);
      assert(ca.state.completionReason === 'draw_agreed' && cb.state.completionReason === 'draw_agreed', `reason ${ca.state.completionReason}`);
      assert(ca.series?.draws === 1 && !ca.series.finished, `series after draw: ${JSON.stringify(ca.series)}`);
      await ackAndProve(a, content, fa.matchId);
      await ackAndProve(b, content, fa.matchId);
      const [na, nb] = await Promise.all([
        a.waitFor<{ matchId: string }>('grid:match_found', (p) => p.matchId !== fa.matchId, 20_000, 'game 2 (a)'),
        b.waitFor<{ matchId: string }>('grid:match_found', (p) => p.matchId !== fa.matchId, 20_000, 'game 2 (b)'),
      ]);
      assert(na.matchId === nb.matchId, 'both players must be dealt the same game 2');
      note(`game 2 ${na.matchId} dealt after the agreed draw`);
    },
  },
  {
    id: 'S13',
    title: 'Dead board ends the game as an automatic draw',
    users: 2,
    run: async ({ clients: [a, b], content, note }) => {
      const [fa, fb] = await Promise.all([a.search('spain'), b.search('spain')]);
      assert(fa.matchId === fb.matchId, 'humans were not paired');
      const start = await a.waitForState((s) => s.phase === 'turn', 40_000, 'first turn');
      await b.waitForState((s) => s.phase === 'turn', 40_000, 'first turn');
      // Mover-1 takes 0,4,6,5 and mover-2 takes 8,2,3,1: after the 8th claim
      // every line holds both colours, so no line is winnable for anyone.
      const order: Array<[GridClient, number]> = [];
      const [m1, m2] = start.currentPlayerUserId === a.userId ? [a, b] : [b, a];
      for (const [who, cell] of [[m1, 0], [m2, 8], [m1, 4], [m2, 2], [m1, 6], [m2, 3], [m1, 5], [m2, 1]] as Array<[GridClient, number]>) order.push([who, cell]);
      const doneA = a.waitFor<CompletedPayload>('grid:completed', (p) => p.matchId === fa.matchId, 300_000, 'completed (a)');
      for (const [who, cell] of order) {
        const state = await who.waitMyTurn(60_000);
        const answer = await content.correctAnswer(state.matchId, cell);
        const result = await who.submit(cell, answer);
        assert(result.outcome === 'correct', `claim of cell ${cell} → ${result.outcome} ("${answer}")`);
        if (who.completed) break;
      }
      const done = await doneA;
      note(`ended: ${done.state.completionReason} after ${done.state.claims.length} claims`);
      assert(done.state.completionReason === 'board_dead', `expected board_dead, got ${done.state.completionReason}`);
      assert(done.state.winnerUserId === null, 'a dead board has no winner');
      await ackAndProve(a, content, fa.matchId);
      await ackAndProve(b, content, fa.matchId);
    },
  },
];

/**
 * Best-effort removal of this run's Supabase Auth identities (the DB rows
 * stay, like every other harness). Keyed by email so it also covers users
 * created by a provisioning run that failed before login, and runs at most
 * once even when both the normal exit path and a signal handler reach it.
 */
let authCleanupDone = false;
async function deleteAuthUsersByEmail(target: TargetConfig, emails: string[], deadlineMs = 60_000): Promise<void> {
  if (authCleanupDone) return;
  authCleanupDone = true;
  // One deadline for the whole cleanup (lookup + deletes, which run in
  // parallel) so a signal-path exit is bounded regardless of user count.
  const deadline = AbortSignal.timeout(deadlineMs);
  let deleted = 0;
  // The backend row id is not the Auth uid; resolve by email.
  const authIds = await Promise.race([
    listAdminUserIdsByEmail(target, new Set(emails.map((email) => email.toLowerCase()))),
    new Promise<Map<string, string>>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('cleanup deadline')), { once: true })),
  ]).catch(() => new Map<string, string>());
  await Promise.all(emails.map(async (email) => {
    const authId = authIds.get(email.toLowerCase());
    if (!authId) return; // never created, or already removed
    try {
      const res = await fetch(`${target.supabaseUrl}/auth/v1/admin/users/${authId}`, {
        method: 'DELETE',
        headers: { apikey: target.serviceRoleKey, Authorization: `Bearer ${target.serviceRoleKey}` },
        signal: deadline,
      });
      if (res.ok) deleted += 1;
      else console.warn(`auth cleanup: ${email} → ${res.status}`);
    } catch (error) {
      console.warn(`auth cleanup: ${email} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  console.log(`auth cleanup: deleted ${deleted}/${authIds.size} run users (pass --keep-users to skip)`);
}

async function runScenario(scenario: Scenario, users: ChaosUser[], target: TargetConfig, content: Content, campaign: string): Promise<ScenarioResult> {
  const notes: string[] = [];
  const note = (message: string) => {
    notes.push(message);
    console.log(`  · ${message}`);
  };
  const clients = users.map((user, index) => new GridClient(user, `${scenario.id}-${String.fromCharCode(97 + index)}`, target, campaign));
  const startedAt = Date.now();
  console.log(`\n▶ ${scenario.id} ${scenario.title}`);
  try {
    await Promise.all(clients.map((client) => client.connect()));
    await scenario.run({ clients, content, note });
    console.log(`✔ ${scenario.id} passed in ${Date.now() - startedAt}ms`);
    return { id: scenario.id, title: scenario.title, status: 'pass', durationMs: Date.now() - startedAt, notes };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`✘ ${scenario.id} FAILED: ${detail}`);
    for (const client of clients) {
      const tail = client.events.slice(-6).map((event) => {
        const state = (event.payload as { state?: GridState } | null)?.state;
        return typeof state === 'object' && state ? `${event.name}(${state.phase} v${state.stateVersion})` : event.name;
      });
      console.log(`    ${client.label} last events: ${tail.join(' → ')}`);
      for (const event of client.events.filter((e) => ['grid:error', 'session:blocked', 'error', 'lobby:error'].includes(e.name))) {
        console.log(`    ${client.label} ${event.name}: ${JSON.stringify(event.payload).slice(0, 300)}`);
      }
    }
    return { id: scenario.id, title: scenario.title, status: 'fail', durationMs: Date.now() - startedAt, detail, notes };
  } finally {
    // Leave no live match behind: an abandoned one holds a bot through its
    // grace window and leaves an unacknowledged delivery for the next run.
    for (const client of clients) {
      if (client.isInActiveMatch()) {
        await client.forfeit().then((done) => { client.completed = done; }).catch(() => undefined);
      }
      if (client.socket.connected) {
        for (const done of [client.completed, ...client.completedGames]) {
          if (done) { try { client.ackCompleted(done.matchId); } catch { /* already acknowledged */ } }
        }
      }
    }
    await wait(300);
    await Promise.all(clients.map((client) => client.close()));
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run chaos:grid:scenarios -- --target=local|staging [--only=S1,S5] [--campaign=name] [--report=path] [--keep-users]');
    console.log(SCENARIOS.map((scenario) => `  ${scenario.id}  ${scenario.title}`).join('\n'));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  const selected = SCENARIOS.filter((scenario) => !args.only || args.only.has(scenario.id));
  if (selected.length === 0) throw new Error(`no scenarios match --only=${[...(args.only ?? [])].join(',')}`);
  const totalUsers = selected.reduce((sum, scenario) => sum + scenario.users, 0);

  console.log(`Football Tic Tac Toe scenarios → ${args.target} (${target.apiBase}); campaign ${args.campaign}; ${selected.length} scenarios, ${totalUsers} users`);
  // Fresh users per campaign: the session guard blocks a search while an
  // earlier (possibly failed) scenario's match is still active, and the
  // opponent-diversity scorer would otherwise keep re-pairing the same two.
  // Per-run throwaway credentials: the users only live for this campaign and
  // are deleted from Supabase Auth at the end unless --keep-users is passed.
  // Emails are derived up front (same scheme as provisionUsers) so cleanup can
  // run even if provisioning fails half-way or the process is interrupted.
  const password = process.env.CHAOS_USER_PASSWORD ?? `Scn-${randomUUID()}`;
  const emailPrefix = `gridscn-${args.campaign}`;
  const runEmails = Array.from({ length: totalUsers }, (_, index) => `${emailPrefix}+u${index}@${target.emailDomain}`);
  const cleanup = async (deadlineMs?: number) => {
    if (!args.keepUsers) await deleteAuthUsersByEmail(target, runEmails, deadlineMs);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`\n${signal}: cleaning up run users before exit (20s budget)`);
      void cleanup(20_000).finally(() => process.exit(130));
    });
  }
  let users: ChaosUser[];
  try {
    users = await provisionUsers({
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      serviceRoleKey: target.serviceRoleKey,
      count: totalUsers,
      password,
      emailPrefix,
      emailDomain: target.emailDomain,
      concurrency: 4,
      loginIntervalMs: args.target === 'staging' ? 250 : 0,
      bypassToken: target.bypassToken,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  const content = new Content(target.databaseUrl);
  const results: ScenarioResult[] = [];
  let cursor = 0;
  try {
    for (const scenario of selected) {
      const slice = users.slice(cursor, cursor + scenario.users);
      cursor += scenario.users;
      results.push(await runScenario(scenario, slice, target, content, args.campaign));
    }
  } finally {
    await content.close();
    await cleanup();
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
  for (const result of results.filter((r) => r.status === 'fail')) console.log(`  ✘ ${result.id}: ${result.detail}`);

  const reportPath = args.report
    ?? resolve(process.cwd(), 'scripts/chaos/reports', `football-grid-scenarios-${args.target}-${args.campaign}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    target: args.target, apiBase: target.apiBase, campaign: args.campaign, ranAt: new Date().toISOString(), results,
  }, null, 2));
  console.log(`report: ${reportPath}`);
  if (passed !== results.length) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
