import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { NotFoundError } from '../../core/errors.js';
import { rejected, notYourRun, staleState, signInForToday } from '../daily/daily.errors.js';
import { addDays, releaseDay } from '../daily/daily.calendar.js';
import { createLeaderboardCache } from '../daily/leaderboard-cache.js';
import { LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import type { DailyPlayer } from '../daily/daily.repo.js';
import { storeRepo } from '../store/store.repo.js';
import { activeRelease, draftPacks } from './draft.content.js';
import { pricedFor, type ServerUniverse } from './draft.universe.js';
import { draftDaily, setupForDay, teamShape, type DraftRunResponse } from './draft-daily.service.js';
import { draftRepo, type ChallengeRow, type FreeRunRow, type LeagueBoardRow, type TieRow } from './draft.repo.js';
import { academyMove, captainMove, completionOf, finishMove, fromScore, januarySignMove, januarySpinMove, newRunState, pickMove, publicRun, respinMove, spinMove, tacticMove, undoMove, veiled, type PublicRun, type RunContext, type RunSetup, type RunState } from './draft.run.js';
import { newDraft, roundsOf, type RespinKind } from './draft.engine.js';
import { FORMATIONS, FREE_RESPINS, RULES_V2, lines, matchDay, type Era, type FormationId, type MatchDay, type Pick, type TacticId, type Variant } from './draft.rules.js';

/** With no daily any more, a member's first few finished runs of the day pay the full table; the rest pay nothing. */
export const FREE_REWARDED_RUNS_PER_DAY = 3;
export const FREE_REWARD_CAP = 1_500;

/** The board week a day belongs to: its Monday (Buenos Aires days, like every daily). */
export function weekOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}
export const thisWeek = (now = new Date()): string => weekOf(releaseDay(now));
/** The first board week: there are no league boards before it. */
export const BOARDS_START = '2026-11-16';

/** The board's rules: Budget with the squads hidden until signing, every era, any formation. Members only. */
export const rankedSetup = (setup: Pick2<RunSetup, 'variant' | 'era' | 'hidden'>): boolean => setup.variant === 'budget' && setup.era === 'all' && !!setup.hidden;
const PLAY_RETENTION_DAYS = 30;
const DONE_RETENTION_DAYS = 180;

/** `ranked`: the run counts on its league's weekly board once finished. */
export interface FreeRunResponse { run: { id: string; version: number }; state: PublicRun & { done: boolean; kind: FreeRunRow['kind']; challengeCode: string | null; ranked: boolean } }

const owns = (row: { user_id: string | null; guest_id: string | null }, player: DailyPlayer): boolean => (player.kind === 'member' ? row.user_id === player.userId : row.guest_id === player.guestId);

async function ctxOf(row: Pick_FreeRow): Promise<RunContext> {
  return { u: pricedFor(await draftPacks.get(row.setup.release), row.setup), mode: row.kind === 'free' ? 'free' : 'challenge', setup: row.setup };
}
type Pick_FreeRow = Pick2<FreeRunRow, 'setup' | 'kind'>;
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

function respond(ctx: RunContext, row: FreeRunRow): FreeRunResponse {
  return { run: { id: row.id, version: row.state_version }, state: { ...publicRun(ctx, row.state), done: row.done, kind: row.kind, challengeCode: row.challenge_code, ranked: row.ranked } };
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
    // Judged on what the player can see, so a finish the hidden squads forced takes no lock it could be timed by.
    const finishing = veiled(row.state).phase === 'ready' || row.state.phase === 'half';
    // Also for a finish: the wallet lock is what makes the daily reward count and the award one step across this member's runs.
    const wallet = (opts.paid || finishing) && player.kind === 'member' ? await storeRepo.getWalletForUpdateInTx(tx, player.userId) : null;
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
    // A ranked run lands on its league's board for the week it was finished in.
    const board = completion && !row.done && row.ranked ? { leagueId: row.setup.leagueId, week: thisWeek() } : null;
    const saved = await draftRepo.saveFreeRun(tx, runId, { state, version: row.state_version + 1, done: !!completion, score: completion?.score ?? null, coinsEarned: earned, record: completion?.stat ?? null, board });
    if (board) leagueBoards.delete(boardKey(board.leagueId, board.week));
    return respond(ctx, saved);
  });
}

export const draftFree = {
  async start(player: DailyPlayer, choice: { leagueId: string; era: Era; formation: FormationId; variant: Variant }): Promise<FreeRunResponse> {
    const release = await activeRelease();
    const u = await draftPacks.get(release);
    if (!u.leagues.some((l) => l.id === choice.leagueId) || !u.hasEra(choice.leagueId, choice.era)) throw rejected('unknown_league');
    // Variety: clubs spread out, the clubs of the player's last two drafts in this league wait their turn, and the rivals'
    // season rotates. Every Budget draft shows names and prices only until a player is signed.
    const avoid = await recentClubs(player, choice.leagueId, release, u);
    const setup: RunSetup = { ...choice, release, seed: randomBytes(12).toString('hex'), draw: { spread: true, rotate: true, avoid }, ...(choice.variant === 'budget' ? { hidden: true, rules: RULES_V2 } : {}) };
    return startRun(player, 'free', null, setup, player.kind === 'member' && rankedSetup(setup));
  },
  spin: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (ctx, s) => ({ state: spinMove(ctx, s) })),
  pick: (player: DailyPlayer, runId: string, version: number, playerId: string, slotId?: string) => move(player, runId, version, (ctx, s) => ({ state: pickMove(ctx, s, playerId, slotId) })),
  academy: (player: DailyPlayer, runId: string, version: number, slotId: string) => move(player, runId, version, (ctx, s) => ({ state: academyMove(ctx, s, slotId) })),
  respin: (player: DailyPlayer, runId: string, version: number, kind: RespinKind) => move(player, runId, version, (ctx, s) => respinMove(ctx, s, kind), { paid: true }),
  undo: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (_ctx, s) => ({ state: undoMove(s) })),
  finish: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (ctx, s) => ({ state: finishMove(ctx, s) })),
  captain: (player: DailyPlayer, runId: string, version: number, slotId: string) => move(player, runId, version, (ctx, s) => ({ state: captainMove(ctx, s, slotId) })),
  tactic: (player: DailyPlayer, runId: string, version: number, tactic: TacticId) => move(player, runId, version, (ctx, s) => ({ state: tacticMove(ctx, s, tactic) })),
  januarySpin: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (ctx, s) => ({ state: januarySpinMove(ctx, s) })),
  januarySign: (player: DailyPlayer, runId: string, version: number, playerId: string, slotId: string) => move(player, runId, version, (ctx, s) => ({ state: januarySignMove(ctx, s, playerId, slotId) })),
  async current(player: DailyPlayer, runId: string): Promise<FreeRunResponse> {
    const row = await draftRepo.getFreeRun(runId);
    if (!row) throw new NotFoundError('Run not found');
    if (!owns(row, player)) throw notYourRun();
    return respond(await ctxOf(row), row);
  },
  purgeAbandoned: async () => (await draftRepo.purgeAbandoned(PLAY_RETENTION_DAYS, DONE_RETENTION_DAYS, 5_000)) + (await draftRepo.purgeShared(DONE_RETENTION_DAYS, 5_000)),
};

const RECENT_DRAFTS = 2;
/** The clubs dealt in the player's last drafts of this league (rebuilt from their setups; a lost read only means less variety). */
async function recentClubs(player: DailyPlayer, leagueId: string, release: string, u: ServerUniverse): Promise<string[]> {
  const setups = await draftRepo.recentSetups(player, leagueId, RECENT_DRAFTS).catch(() => []);
  const clubs = new Set<string>();
  for (const setup of setups) {
    try {
      // Each deal against the release it was dealt from: another pack would rebuild another deal.
      const own = setup.release === release ? u : await draftPacks.get(setup.release).catch(() => null);
      if (!own) continue;
      const d = newDraft(pricedFor(own, setup), { mode: 'free', variant: setup.variant, leagueId: setup.leagueId, era: setup.era, formation: setup.formation, seed: setup.seed, draw: setup.draw, rules: setup.rules, seats: [{ name: 'p', avatar: null, bot: false }] });
      for (const c of d.deal) clubs.add(c.clubId);
    } catch { /* a setup from another release may not rebuild: skip it */ }
  }
  return [...clubs];
}

async function startRun(player: DailyPlayer, kind: FreeRunRow['kind'], code: string | null, setup: RunSetup, ranked = false): Promise<FreeRunResponse> {
  const ctx: RunContext = { u: pricedFor(await draftPacks.get(setup.release), setup), mode: kind === 'free' ? 'free' : 'challenge', setup };
  return draftRepo.withTx(async (tx) => respond(ctx, await draftRepo.insertFreeRun(tx, { id: randomUUID(), player, kind, challengeCode: code, setup, state: newRunState(roundsOf(setup)), ranked })));
}

// ── League boards ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface LeagueBoardEntry extends Omit<LeagueBoardRow, 'record'> { w: number; d: number; l: number; points: number; gd: number; gf: number }
const decode = ({ record, ...row }: LeagueBoardRow): LeagueBoardEntry => { const f = fromScore(row.score, record); return { ...row, w: f.w, d: f.d, l: f.l, points: f.points, gd: f.gd, gf: f.gf }; };
const boardKey = (leagueId: string, week: string) => `${leagueId}|${week}`;
const leagueBoards = createLeaderboardCache<LeagueBoardEntry>(
  async (key) => { const [leagueId, week] = key.split('|'); const b = await draftRepo.leagueBoard(leagueId, week, LEADERBOARD_TOP); return { players: b.players, top: b.top.map(decode) }; },
  LEADERBOARD_CACHE_MS, () => Date.now(),
);

/** A board run that is also a live challenge stays hidden until the viewer has played that challenge. */
async function mayRevealBoardRun(row: FreeRunRow, viewer: DailyPlayer | null): Promise<void> {
  if (viewer && owns(row, viewer)) return;
  const challenge = await draftRepo.challengeOfRun(row.id);
  if (!challenge) return;
  if (!viewer || !(await finishedChallengeRun(viewer, challenge))) throw rejected('challenge_unplayed');
}

export const draftBoards = {
  /** What the first screen needs: the leagues on offer, this week, and the member's best of the week in each. */
  async leagues(player: DailyPlayer | null) {
    const u = await draftPacks.get(await activeRelease());
    const week = thisWeek();
    const bests = player?.kind === 'member' ? await draftRepo.weekBests(player.userId, week) : [];
    return {
      week,
      leagues: u.leagues.map((l) => ({ id: l.id, name: l.name, short: l.short, teams: l.teams, games: l.games })),
      mine: bests.map((b) => { const f = fromScore(b.score, b.record); return { leagueId: b.leagueId, w: f.w, d: f.d, l: f.l, points: f.points }; }),
      guest: player?.kind !== 'member',
    };
  },

  async board(leagueId: string, week: string | undefined, userId: string | null) {
    const at = week ?? thisWeek();
    // Only real leagues and board weeks reach the cache: it keeps one entry per key.
    if (weekOf(at) !== at || at > thisWeek() || at < BOARDS_START) throw rejected('unknown_week');
    const u = await draftPacks.get(await activeRelease());
    if (!u.leagues.some((l) => l.id === leagueId)) throw rejected('unknown_league');
    const board = await leagueBoards.get(boardKey(leagueId, at));
    const mine = userId ? await draftRepo.leagueBoardRank(userId, leagueId, at) : null;
    return { leagueId, week: at, players: board.players, top: board.top, me: mine ? decode(mine) : null };
  },

  /**
   * A team on a board: a random deal of its own, so seeing it gives nothing away, unless it was also sent as a
   * challenge. Then its deal is still open to play, and only its owner and those who have played it may see the team.
   */
  async team(runId: string, viewer: DailyPlayer | null) {
    const row = await draftRepo.getFreeRun(runId);
    if (!row || !row.ranked || !row.done) throw new NotFoundError('Team not found');
    await mayRevealBoardRun(row, viewer);
    return { formation: row.setup.formation, picks: teamShape(row.state.picks) };
  },

  /** My best run of that league and week against a team on its board, once per pairing. */
  async tie(player: DailyPlayer, runId: string, myName: string, theirName: (userId: string) => Promise<string>) {
    const theirs = await draftRepo.getFreeRun(runId);
    if (!theirs || !theirs.ranked || !theirs.done || !theirs.user_id || !theirs.league_id || !theirs.week) throw new NotFoundError('Team not found');
    if (player.kind !== 'member') throw rejected('play_first');
    // A tie shows the other XI: the same gate as looking at it.
    await mayRevealBoardRun(theirs, player);
    const best = await draftRepo.leagueBoardRank(player.userId, theirs.league_id, theirs.week);
    const mine = best ? await draftRepo.getFreeRun(best.runId) : null;
    if (!mine) throw rejected('play_first');
    const tie = await playTie(
      { run: mine.id, player, name: myName, picks: mine.state.picks, formation: mine.setup.formation },
      { run: theirs.id, player: { kind: 'member', userId: theirs.user_id }, name: await theirName(theirs.user_id), picks: theirs.state.picks, formation: theirs.setup.formation },
      mine.setup.formation,
    );
    return tieFor(tie, mine.id);
  },
};

// ── Challenges ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type RunSource = { daily: Variant; day: string } | { freeRunId: string };

async function myFinishedRun(player: DailyPlayer, source: RunSource): Promise<{ id: string; state: RunState; setup: RunSetup; day: string | null; rootCode?: string | null }> {
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
  return { id: row.id, state: row.state, setup: row.setup, day: null, rootCode: row.challenge_code };
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
    // A replay of a challenge passes the original on: a new one would be a way around the original's limits and its stored ties.
    if (run.rootCode) return { code: run.rootCode };
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
    if (row.day && !(await draftDaily[row.setup.variant].closedForSure(row.day))) {
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

/** `formation`: this side's own, when the two teams were drafted in different shapes. */
export interface TieSide { run: string; player: DailyPlayer; name: string; picks: (Pick | null)[]; formation?: FormationId }

/** Stored as one formation, or `a|b` when the two sides differ: each XI is read in its own shape. */
const formationsOf = (stored: string): [FormationId, FormationId] => { const [a, b] = stored.split('|') as FormationId[]; return [a, b ?? a]; };

/** One result per pair of runs, whichever side asks first, and the same one for both. */
export async function playTie(first: TieSide, second: TieSide, formation: FormationId): Promise<TieRow> {
  if (first.run === second.run) throw rejected('own_team');
  const [a, b] = first.run < second.run ? [first, second] : [second, first];
  const [fa, fb] = [a.formation ?? formation, b.formation ?? formation];
  const seed = createHash('sha256').update(`${a.run}|${b.run}`).digest('hex').slice(0, 24);
  const result = matchDay(lines(FORMATIONS[fa], a.picks), lines(FORMATIONS[fb], b.picks), seed);
  return draftRepo.saveTie({ a, b, seed, result, formation: fa === fb ? fa : `${fa}|${fb}` });
}

/** The tie as this run sees it: its own goals first, its home leg first, its attack against the other side's defence. */
export const tieFor = (t: TieRow, myRun: string) => {
  const mineIsA = t.a_run === myRun;
  const r = t.result;
  const by = (key: MatchDay['battles'][number]['key']) => r.battles.find((x) => x.key === key)!;
  const turn = (x: MatchDay['battles'][number], key: MatchDay['battles'][number]['key']) => ({ key, mine: x.theirs, theirs: x.mine, winner: x.winner === null ? null : ((1 - x.winner) as 0 | 1) });
  const result: MatchDay = mineIsA ? r : {
    ...r, goals: [r.goals[1], r.goals[0]], legs: [[r.legs[1][1], r.legs[1][0]], [r.legs[0][1], r.legs[0][0]]], penalties: r.penalties ? [r.penalties[1], r.penalties[0]] : null, winner: (1 - r.winner) as 0 | 1,
    battles: [turn(by('defence'), 'attack'), turn(by('midfield'), 'midfield'), turn(by('attack'), 'defence')],
  };
  const [fa, fb] = formationsOf(t.formation);
  // `picks`: the XI that played for this side (a board tie plays the member's best of the week, not their latest).
  return { id: t.id, seed: t.seed, formation: mineIsA ? fa : fb, opponentFormation: mineIsA ? fb : fa, picks: teamShape(mineIsA ? t.a_picks : t.b_picks), at: t.created_at, side: mineIsA ? 0 : 1, opponent: mineIsA ? t.b_name : t.a_name, opponentPicks: teamShape(mineIsA ? t.b_picks : t.a_picks), result };
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
