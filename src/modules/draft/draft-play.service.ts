import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { NotFoundError } from '../../core/errors.js';
import { rejected, notYourRun, staleState, signInForToday } from '../daily/daily.errors.js';
import { releaseDay } from '../daily/daily.calendar.js';
import type { DailyPlayer } from '../daily/daily.repo.js';
import { storeRepo } from '../store/store.repo.js';
import { activeRelease, draftPacks } from './draft.content.js';
import { draftDaily, setupForDay, teamShape, type DraftRunResponse } from './draft-daily.service.js';
import { draftCalendar } from './draft-daily.days.js';
import { draftRepo, type ChallengeRow, type FreeRunRow, type TieRow } from './draft.repo.js';
import { academyMove, completionOf, finishMove, newRunState, pickMove, publicRun, respinMove, spinMove, undoMove, type PublicRun, type RunContext, type RunSetup, type RunState } from './draft.run.js';
import type { RespinKind } from './draft.engine.js';
import { FORMATIONS, FREE_RESPINS, lines, matchDay, type Era, type FormationId, type Pick, type Variant } from './draft.rules.js';

/** Free play pays a little, a few times a day: the daily is where seasons really pay. */
export const FREE_REWARDED_RUNS_PER_DAY = 3;
export const FREE_REWARD_CAP = 50;
const PLAY_RETENTION_DAYS = 30;
const DONE_RETENTION_DAYS = 180;

export interface FreeRunResponse { run: { id: string; version: number }; state: PublicRun & { done: boolean; kind: FreeRunRow['kind']; challengeCode: string | null } }

const owns = (row: { user_id: string | null; guest_id: string | null }, player: DailyPlayer): boolean => (player.kind === 'member' ? row.user_id === player.userId : row.guest_id === player.guestId);

async function ctxOf(row: Pick_FreeRow): Promise<RunContext> {
  return { u: await draftPacks.get(row.setup.release), mode: row.kind === 'free' ? 'free' : 'challenge', setup: row.setup };
}
type Pick_FreeRow = Pick2<FreeRunRow, 'setup' | 'kind'>;
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

function respond(ctx: RunContext, row: FreeRunRow): FreeRunResponse {
  return { run: { id: row.id, version: row.state_version }, state: { ...publicRun(ctx, row.state), done: row.done, kind: row.kind, challengeCode: row.challenge_code } };
}

async function move(player: DailyPlayer, runId: string, version: number, step: (ctx: RunContext, s: RunState) => { state: RunState; coinsSpent?: number }, opts: { paid?: boolean } = {}): Promise<FreeRunResponse> {
  // Squads load before the lock: nothing waits on a cold read while holding a run.
  const preview = await draftRepo.getFreeRun(runId);
  if (!preview) throw new NotFoundError('Run not found');
  const base = await ctxOf(preview);
  return draftRepo.withTx(async (tx) => {
    const row = await draftRepo.lockFreeRun(tx, runId);
    if (!row) throw new NotFoundError('Run not found');
    if (!owns(row, player)) throw notYourRun();
    if (row.state_version !== version) throw staleState();
    // Locked for the whole re-spin, so two tabs cannot spend the same coins.
    const wallet = opts.paid && player.kind === 'member' ? await storeRepo.getWalletForUpdateInTx(tx, player.userId) : null;
    const ctx: RunContext = { ...base, coins: Math.floor(Number(wallet?.coins ?? 0)) };
    const out = step(ctx, row.state);
    if (out.coinsSpent && out.coinsSpent > 0) {
      if (player.kind !== 'member') throw rejected('no_coins');
      // Conditional in the database too: a wallet that fell short meanwhile refuses the whole move.
      if (!(await storeRepo.addCoinsInTx(tx, player.userId, -out.coinsSpent))) throw rejected('no_coins');
    }
    const completion = completionOf(out.state);
    let earned = row.coins_earned;
    let state = out.state;
    // Good seasons pay in free play too, a few a day: a script playing all night earns nothing more.
    if (completion && !row.done && row.kind === 'free' && player.kind === 'member') {
      const day = releaseDay(new Date());
      const coinsDue = Math.min(FREE_REWARD_CAP, out.state.result?.coinsEarned ?? 0);
      if (coinsDue > 0 && (await draftRepo.rewardedToday(tx, player.userId, day)) < FREE_REWARDED_RUNS_PER_DAY && (await draftRepo.recordAward(tx, { runId, userId: player.userId, day, source: 'free', coins: coinsDue }))) {
        await storeRepo.addCoinsInTx(tx, player.userId, coinsDue);
        earned = coinsDue;
      }
      if (state.result) state = { ...state, result: { ...state.result, coinsEarned: earned } };
    } else if (completion && !row.done && state.result && (row.kind !== 'free' || player.kind !== 'member')) {
      state = { ...state, result: { ...state.result, coinsEarned: 0 } };
    }
    const saved = await draftRepo.saveFreeRun(tx, runId, { state, version: row.state_version + 1, done: !!completion, score: completion?.score ?? null, coinsEarned: earned });
    return respond(ctx, saved);
  });
}

export const draftFree = {
  async start(player: DailyPlayer, choice: { leagueId: string; era: Era; formation: FormationId; variant: Variant }): Promise<FreeRunResponse> {
    const release = await activeRelease();
    const u = await draftPacks.get(release);
    if (!u.leagues.some((l) => l.id === choice.leagueId) || !u.hasEra(choice.leagueId, choice.era)) throw rejected('unknown_league');
    const setup: RunSetup = { ...choice, release, seed: randomBytes(12).toString('hex') };
    return startRun(player, 'free', null, setup);
  },
  spin: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (ctx, s) => ({ state: spinMove(ctx, s) })),
  pick: (player: DailyPlayer, runId: string, version: number, playerId: string, slotId?: string) => move(player, runId, version, (ctx, s) => ({ state: pickMove(ctx, s, playerId, slotId) })),
  academy: (player: DailyPlayer, runId: string, version: number, slotId: string) => move(player, runId, version, (ctx, s) => ({ state: academyMove(ctx, s, slotId) })),
  respin: (player: DailyPlayer, runId: string, version: number, kind: RespinKind) => move(player, runId, version, (ctx, s) => respinMove(ctx, s, kind), { paid: true }),
  undo: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (_ctx, s) => ({ state: undoMove(s) })),
  finish: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (ctx, s) => ({ state: finishMove(ctx, s) })),
  async current(player: DailyPlayer, runId: string): Promise<FreeRunResponse> {
    const row = await draftRepo.getFreeRun(runId);
    if (!row) throw new NotFoundError('Run not found');
    if (!owns(row, player)) throw notYourRun();
    return respond(await ctxOf(row), row);
  },
  purgeAbandoned: () => draftRepo.purgeAbandoned(PLAY_RETENTION_DAYS, DONE_RETENTION_DAYS, 5_000),
};

async function startRun(player: DailyPlayer, kind: FreeRunRow['kind'], code: string | null, setup: RunSetup): Promise<FreeRunResponse> {
  const ctx: RunContext = { u: await draftPacks.get(setup.release), mode: kind === 'free' ? 'free' : 'challenge', setup };
  return draftRepo.withTx(async (tx) => respond(ctx, await draftRepo.insertFreeRun(tx, { id: randomUUID(), player, kind, challengeCode: code, setup, state: newRunState() })));
}

// ── Challenges ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type RunSource = { daily: Variant; day: string } | { freeRunId: string };

async function myFinishedRun(player: DailyPlayer, source: RunSource): Promise<{ id: string; state: RunState; setup: RunSetup; day: string | null }> {
  if ('daily' in source) {
    const game = draftDaily[source.daily];
    const run = await game.finishedRun(player, source.day);
    if (!run) throw rejected('play_first');
    const day = await game.dayOf(source.day);
    return { id: run.id, state: run.state, setup: setupForDay(day, source.daily), day: source.day };
  }
  const row = await draftRepo.getFreeRun(source.freeRunId);
  if (!row || !owns(row, player)) throw notYourRun();
  if (!row.done) throw rejected('play_first');
  return { id: row.id, state: row.state, setup: row.setup, day: null };
}

export interface PublicChallenge {
  code: string; from: string; variant: Variant; league: string; era: Era; formation: FormationId;
  record: ChallengeRow['record'];
  /** Only once the viewer has played it: the challenger's team shows the draw. */
  picks: ReturnType<typeof teamShape> | null;
}

const challengeCode = (): string => randomBytes(6).toString('base64url');

export const draftChallenges = {
  async create(player: DailyPlayer, source: RunSource, fromName: string): Promise<{ code: string }> {
    const run = await myFinishedRun(player, source);
    const season = run.state.result?.season;
    if (!season) throw rejected('play_first');
    const owner = player.kind === 'member' ? { user_id: player.userId, guest_id: null } : { user_id: null, guest_id: player.guestId };
    const row = await draftRepo.insertChallenge({
      code: challengeCode(), ...owner, from_name: fromName.slice(0, 40), setup: { ...run.setup, respins: Math.max(FREE_RESPINS, run.state.respinsUsed) }, day: run.day,
      picks: run.state.picks, record: { w: season.w, d: season.d, l: season.l, points: season.points, gf: season.gf, ga: season.ga }, respins_used: run.state.respinsUsed, source_run: run.id,
    });
    return { code: row.code };
  },

  async read(code: string, viewer: DailyPlayer | null): Promise<PublicChallenge> {
    const row = await draftRepo.getChallenge(code);
    if (!row) throw new NotFoundError('Challenge not found');
    const u = await draftPacks.get(row.setup.release);
    const league = u.leagues.find((l) => l.id === row.setup.leagueId)?.name ?? row.setup.leagueId;
    const mine = viewer ? await finishedChallengeRun(viewer, row) : null;
    return { code, from: row.from_name, variant: row.setup.variant, league, era: row.setup.era, formation: row.setup.formation, record: row.record, picks: mine ? teamShape(row.picks) : null };
  },

  /**
   * Plays the challenge. A challenge from today's daily is that deal: for a member who has not played today it is their
   * daily (nothing is learned before it counts), for a guest it needs a sign-in, and only a member who already played it
   * replays it as practice. Anything else is an ordinary run on the same deal.
   */
  async accept(player: DailyPlayer, code: string): Promise<{ daily: DraftRunResponse; variant: Variant; day: string } | { free: FreeRunResponse }> {
    const row = await draftRepo.getChallenge(code);
    if (!row) throw new NotFoundError('Challenge not found');
    if (owns(row, player)) throw rejected('own_challenge');
    if (row.day && !draftCalendar.isClosedDay(row.day, new Date())) {
      if (player.kind === 'guest') throw signInForToday();
      const game = draftDaily[row.setup.variant];
      if (!(await game.finishedRun(player, row.day))) {
        const daily = await game.start(row.day, player);
        return { daily, variant: row.setup.variant, day: row.day };
      }
    }
    // One go per player: accepting again brings back the same run.
    const existing = await draftRepo.anyChallengeRun(player, code);
    if (existing) return { free: respond(await ctxOf(existing), existing) };
    try {
      return { free: await startRun(player, 'challenge', code, row.setup) };
    } catch (error) {
      const raced = await draftRepo.anyChallengeRun(player, code);
      if (raced) return { free: respond(await ctxOf(raced), raced) };
      throw error;
    }
  },

  async tie(player: DailyPlayer, code: string, myName: string) {
    const row = await draftRepo.getChallenge(code);
    if (!row) throw new NotFoundError('Challenge not found');
    if (owns(row, player)) throw rejected('own_challenge');
    const mine = await finishedChallengeRun(player, row);
    if (!mine) throw rejected('play_first');
    const owner: DailyPlayer = row.user_id ? { kind: 'member', userId: row.user_id } : { kind: 'guest', guestId: row.guest_id! };
    const tie = await playTie({ run: mine.id, player, name: myName, picks: mine.picks }, { run: row.source_run, player: owner, name: row.from_name, picks: row.picks }, row.setup.formation);
    return tieFor(tie, mine.id);
  },
};

async function finishedChallengeRun(viewer: DailyPlayer, row: ChallengeRow): Promise<{ id: string; picks: (Pick | null)[] } | null> {
  if (row.day) {
    const daily = await draftDaily[row.setup.variant].finishedRun(viewer, row.day);
    if (daily) return { id: daily.id, picks: daily.state.picks };
  }
  const run = await draftRepo.findChallengeRun(viewer, row.code);
  return run ? { id: run.id, picks: run.state.picks } : null;
}

// ── Team against team ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TieSide { run: string; player: DailyPlayer; name: string; picks: (Pick | null)[] }

/** One result per pair of runs, whichever side asks first, and the same one for both. */
export async function playTie(first: TieSide, second: TieSide, formation: FormationId): Promise<TieRow> {
  if (first.run === second.run) throw rejected('own_team');
  const [a, b] = first.run < second.run ? [first, second] : [second, first];
  const slots = FORMATIONS[formation];
  const seed = createHash('sha256').update(`${a.run}|${b.run}`).digest('hex').slice(0, 24);
  const result = matchDay(lines(slots, a.picks), lines(slots, b.picks), seed);
  return draftRepo.saveTie({ a, b, seed, result, formation });
}

/** The tie as this run sees it: its own goals first, its legs home then away. */
export const tieFor = (t: TieRow, myRun: string) => {
  const mineIsA = t.a_run === myRun;
  const flip = <T,>(x: [T, T]): [T, T] => (mineIsA ? x : [x[1], x[0]]);
  const r = t.result;
  return {
    id: t.id, seed: t.seed, formation: t.formation, at: t.created_at, side: mineIsA ? 0 : 1,
    opponent: mineIsA ? t.b_name : t.a_name, opponentPicks: teamShape(mineIsA ? t.b_picks : t.a_picks),
    result: { ...r, goals: flip(r.goals), legs: (mineIsA ? r.legs : [[r.legs[0][1], r.legs[0][0]], [r.legs[1][1], r.legs[1][0]]]) as typeof r.legs, penalties: r.penalties ? flip(r.penalties) : null, winner: (mineIsA ? r.winner : 1 - r.winner) as 0 | 1,
      battles: mineIsA ? r.battles : r.battles.map((x) => ({ ...x, mine: x.theirs, theirs: x.mine, winner: x.winner === null ? null : ((1 - x.winner) as 0 | 1) })) },
  };
};

export const draftTies = {
  /** My finished daily against a ranked team of that same day and version, once per pairing. */
  async againstBoard(player: DailyPlayer, variant: Variant, day: string, userId: string, myName: string, opponentName: string) {
    const game = draftDaily[variant];
    const mine = await game.finishedRun(player, day);
    if (!mine) throw rejected('play_first');
    const theirs = await game.finishedRun({ kind: 'member', userId }, day);
    if (!theirs || !theirs.ranked) throw new NotFoundError('Team not found');
    const setup = await game.dayOf(day);
    const tie = await playTie({ run: mine.id, player, name: myName, picks: mine.state.picks }, { run: theirs.id, player: { kind: 'member', userId }, name: opponentName, picks: theirs.state.picks }, setup.setup.formation);
    return tieFor(tie, mine.id);
  },
  async mine(player: DailyPlayer) {
    const rows = await draftRepo.myTies(player, 20);
    const iAmA = (t: TieRow) => (player.kind === 'member' ? t.a_user === player.userId : t.a_guest === player.guestId);
    return rows.map((t) => tieFor(t, iAmA(t) ? t.a_run : t.b_run));
  },
};
