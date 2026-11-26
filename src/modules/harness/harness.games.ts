import { config } from '../../core/config.js';
import { sql } from '../../db/index.js';
import { adminStatsRepo } from '../admin-stats/admin-stats.repo.js';
import { ttlCache } from '../hq/hq.cache.js';

// The Games hub (HQ → Games): every game the product has, whether it is on,
// how much it was played in the last 7 days against the 7 before, and where a
// playable preview of it lives. Both weeks are whole Georgian days ending
// yesterday, and only real players count (no AI, seed, deleted or guest-account rows; anonymous guests do count). The Head of Games starts here: play a game,
// see how it is doing, then ask for a change.
//
// Previews are served by the staging site only (web: /demos and /dev/games,
// real game screens on bundled sample data: no login, no opponent needed).

export type GameGroup = 'match' | 'daily' | 'party' | 'solo' | 'live' | 'partner';
export type GameState = 'on' | 'off' | 'paused' | 'beta' | 'retired';

/** Where the game can be played alone on the staging site. */
export type GamePreview =
  /** The games playground: every screen of the game, with editable situations. `game` is its id there. */
  | { kind: 'playground'; game: string }
  /** The demo showcase: one scripted run of the game. */
  | { kind: 'demo'; slug: string };

interface GameDef {
  key: string;
  name: string;
  group: GameGroup;
  /** One line a newcomer understands. */
  what: string;
  /** The game's real page on the site (needs a login for most games). */
  route: string | null;
  preview: GamePreview | null;
  /** Its daily runs tables (<game>_runs: one row per player per day). */
  runs?: readonly string[];
  /** Its modes in the play counts (admin-stats gamesPerDay): matches, room games, solo rounds. */
  modes?: readonly string[];
  /** A count of its own: the older daily challenges (completions), or the players who took part in a live show. */
  own?: 'legacy-daily' | 'show-players';
  state: () => GameState;
}

const on = (): GameState => 'on';
const flag = (enabled: boolean): GameState => (enabled ? 'on' : 'off');
const roomOff = (game: string) => (config.ROOM_GAMES_DISABLED ?? []).includes(game);

/** A daily game that friends can also play together in a room: on unless its room version is switched off too. */
const daily = (key: string, name: string, what: string, route: string, opts: { preview?: GamePreview; runs?: string[]; room?: string } = {}): GameDef => ({
  key, name, group: 'daily', what, route,
  preview: opts.preview ?? null,
  runs: opts.runs ?? [`${key.replace(/-/g, '_')}_runs`],
  modes: opts.room ? [`room_${opts.room}`] : [],
  state: on,
});

export const GAMES: readonly GameDef[] = [
  // ── the match ──
  { key: 'ranked', name: 'Ranked match', group: 'match', what: 'The main 1v1 football quiz match: two halves of questions, goals for right answers, penalties on a draw.', route: '/game', preview: { kind: 'demo', slug: 'match' }, modes: ['ranked'], state: on },
  { key: 'friendly', name: 'Friendly match', group: 'match', what: 'The same match against a friend, with no ranking points.', route: '/play/friend', preview: { kind: 'demo', slug: 'match' }, modes: ['friendly'], state: on },
  { key: 'zone-match', name: 'Ranked 2.0 (zone match)', group: 'match', what: 'The next version of the match, played over zones of the pitch. In beta.', route: '/ranked2', preview: null, modes: ['room_zone_match'], state: () => (roomOff('zone_match') ? 'off' : 'beta') },
  { key: 'football-grid', name: 'Football Tic Tac Toe', group: 'match', what: 'A 3×3 grid: name a player who fits both the row and the column, three in a row wins.', route: '/tic-tac-toe', preview: { kind: 'demo', slug: 'mini-football-grid' }, modes: ['grid'],
    // Playable when its boards are on and there is a way in: the queue or a friend lobby.
    state: () => flag(config.FOOTBALL_GRID_CONTENT_ENABLED && (config.FOOTBALL_GRID_QUEUE_ENABLED || config.FOOTBALL_GRID_LOBBY_ENABLED)) },
  { key: 'auction', name: 'Auction', group: 'match', what: 'Three players bid a budget for footballers and the best squad wins.', route: '/auction', preview: { kind: 'demo', slug: 'auction' }, modes: ['auction'], state: () => flag(config.AUCTION_ENABLED) },

  // ── daily games (most can also be played with friends) ──
  daily('buscaminas', 'Minesweeper', '16 players, 12 fit the clue and 4 are mines. Five rounds a day.', '/buscaminas', { preview: { kind: 'playground', game: 'buscaminas' } }),
  daily('pistas', 'Football Clues', 'Guess the footballer from clues revealed one at a time.', '/pistas', { preview: { kind: 'playground', game: 'pistas' } }),
  daily('tenable', 'Football Tenable', 'Name the entries of a top list. Three wrong and you are out.', '/football-tenable', { preview: { kind: 'playground', game: 'tenable' }, room: 'tenable' }),
  daily('minuto', 'What Minute?', 'See a famous goal and guess the minute it was scored.', '/minuto'),
  daily('darts501', 'Football Darts 501', 'Count down from 501 using footballers’ real career numbers.', '/football-darts-501', { preview: { kind: 'playground', game: 'football501' }, room: 'darts501' }),
  { ...daily('draft', 'Football Draft', 'Draft a squad within a budget and play it against others.', '/football-draft', { preview: { kind: 'playground', game: 'draft' }, runs: ['draft_runs_budget', 'draft_runs_classic', 'draft_runs_knowledge'], room: 'draft' }) },
  daily('conexiones', 'Football Connections', '16 footballers hide four groups of four. Find them.', '/conexiones-futboleras', { preview: { kind: 'playground', game: 'conexiones' }, room: 'conexiones' }),
  daily('dato-falso', 'Odd One Out', 'Four facts about a footballer, one is false. Spot it.', '/dato-falso-futbolero', { preview: { kind: 'playground', game: 'datofalso' }, room: 'dato_falso' }),
  daily('codenames', 'Football Codenames', 'Give one-word clues that link several footballers on the board.', '/codenames', { preview: { kind: 'playground', game: 'codenames' }, room: 'codenames' }),
  daily('football-race', 'Football Horserace', 'Pick the clubs or players that will finish ahead in a race of real numbers.', '/horserace', { preview: { kind: 'playground', game: 'carrera' }, room: 'football_race' }),
  daily('shared-player', 'Played for Both', 'Name a footballer who played for both clubs.', '/ortak-futbolcu', { room: 'shared_player' }),
  daily('name-chain', 'Name Chain', 'Name a footballer whose name starts with the last letter of the one before.', '/son-harfle', { room: 'name_chain' }),
  daily('grid-daily', 'Daily Tic Tac Toe', 'The daily 3×3 grid, played alone against the clock.', '/daily-grid'),
  { ...daily('ultimo', 'Last Answer Standing', 'Keep naming answers that fit a category until you run out.', '/ultimo', { preview: { kind: 'playground', game: 'ultimo' } }), state: () => 'retired' },
  { key: 'daily-challenges', name: 'Daily challenges', group: 'daily', what: 'The older daily set: Money Drop, Countdown, Career Path, Card Detective, Missing XI, Pass Chain, Closest Wins, True or False.', route: '/play', preview: { kind: 'demo', slug: '' }, own: 'legacy-daily', state: on },

  // ── party games (rooms of 2 to 6) ──
  { key: 'aproximado', name: 'Closest Wins', group: 'party', what: 'Everyone guesses a number about a footballer; the closest guess wins the round.', route: null, preview: { kind: 'playground', game: 'aproximado' }, modes: ['room_aproximado'], state: () => flag(!roomOff('aproximado')) },
  { key: 'party-quiz', name: 'Party quiz', group: 'party', what: 'A quiz for a group of friends in one room.', route: '/play/friend', preview: null, modes: ['party_quiz'], state: on },
  { key: 'duels', name: 'Friend duels', group: 'party', what: 'A daily game played head to head against a friend (Minesweeper, What Minute?, Football Clues, Last Answer Standing).', route: null, preview: null, modes: ['duel'], state: () => flag((config.DUEL_GAMES_ENABLED ?? []).length > 0) },

  // ── solo coin games ──
  { key: 'free-kicks', name: 'Free Kicks', group: 'solo', what: 'Answer to earn shots, then score free kicks for coins.', route: '/free-kicks', preview: { kind: 'demo', slug: 'mini-final-third' }, modes: ['free_kicks'], state: () => flag(config.FREE_KICKS_ENABLED) },
  { key: 'squad-spin', name: 'Squad Spin', group: 'solo', what: 'Spin for footballers and build the best squad for coins.', route: '/squad-spin', preview: { kind: 'demo', slug: 'mini-squad-spin' }, modes: ['squad_spin'], state: () => flag(config.SQUAD_SPIN_ENABLED) },
  { key: 'guess-the-goal', name: 'Guess the Goal', group: 'solo', what: 'A famous goal replays on a tactics board. Name it, then watch the clip.', route: '/guess-the-goal', preview: { kind: 'demo', slug: 'mini-guess-the-goal' }, modes: ['guess_the_goal'], state: () => flag(config.GUESS_THE_GOAL_ENABLED) },
  { key: 'road-to-goal', name: 'Road to Goal', group: 'solo', what: 'Answer step by step up the pitch; cash out or risk it for more coins.', route: '/road-to-goal', preview: { kind: 'demo', slug: 'mini-road-to-goal' }, modes: ['road_to_goal'], state: () => flag(config.ROAD_TO_GOAL_ENABLED) },
  { key: 'trivia-mines', name: 'Trivia Mines', group: 'solo', what: 'Pick tiles for coins and avoid the mines; a right answer saves you.', route: '/trivia-mines', preview: { kind: 'demo', slug: 'mini-trivia-mines' }, modes: ['trivia_mines'], state: () => flag(config.TRIVIA_MINES_ENABLED) },

  // ── live ──
  { key: 'orshabatoba', name: 'Orshabatoba (Monday live show)', group: 'live', what: 'The live quiz the podcast hosts run on Monday nights, Georgia only.', route: '/orshabatoba', preview: { kind: 'demo', slug: 'weekend-league' }, own: 'show-players', state: on },
  { key: 'weekend-league', name: 'Weekend League', group: 'live', what: 'The weekend tournament with qualifiers and a final. Paused for now.', route: '/weekend-league', preview: { kind: 'demo', slug: 'weekend-league' }, modes: ['weekend_league'], state: () => (config.WL_PAUSED ? 'paused' : 'on') },

  // ── partners ──
  { key: 'partner-games', name: 'Partner games (Freecroco)', group: 'partner', what: 'Twelve games built for the partner’s own site: ranked, countdown, true or false, pick’em, career path, higher or lower and more.', route: null, preview: null, state: on },
];

/** A count over the last 7 whole days and over the 7 before. */
export interface Counted {
  now: number;
  before: number;
}
export interface GameStats {
  /** Daily game: players who started a day. Null when the game has no daily. */
  started: Counted | null;
  /** Daily game: of those, how many finished the day. */
  finished: Counted | null;
  /** Matches, room games or solo rounds played (for a live show: players who took part). Null when nothing counts them. */
  played: Counted | null;
}

interface RunsRow { tbl: string; started_now: string; started_before: string; done_now: string; done_before: string }

const runTables = () => [...new Set(GAMES.flatMap((g) => g.runs ?? []))];

const TZ = 'Asia/Tbilisi';
const REAL_USERS = `SELECT id FROM users WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest`;

/** The two weeks compared: `from` up to `mid` is the week before, `mid` up to `end` the last 7 whole days (Georgian days; `end` is today, excluded). */
export interface Weeks {
  from: string;
  mid: string;
  end: string;
}
/** Pure: the two weeks ending yesterday, from 15 days oldest first (the last one is today). */
export function weeksOf(days: readonly string[]): Weeks {
  return { from: days[0]!, mid: days[7]!, end: days[14]! };
}
const window = (column: string) => `${column} >= ($1::date::timestamp AT TIME ZONE '${TZ}') AND ${column} < ($3::date::timestamp AT TIME ZONE '${TZ}')`;
const isNow = (column: string) => `${column} >= ($2::date::timestamp AT TIME ZONE '${TZ}')`;

/** Starts and finishes per runs table, in one statement (table names come from the fixed list above, never from input). */
async function dailyRuns(w: Weeks): Promise<Map<string, RunsRow>> {
  const wanted = runTables();
  const present = new Set(
    (await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(${wanted})`).map((r) => r.table_name),
  );
  const tables = wanted.filter((t) => present.has(t) && /^[a-z0-9_]+$/.test(t));
  if (tables.length === 0) return new Map();
  // The same players the play counts use: registered real users, plus anonymous guests.
  const parts = tables.map(
    (t) => `SELECT '${t}' AS tbl,
      count(*) FILTER (WHERE ${isNow('r.created_at')}) AS started_now,
      count(*) FILTER (WHERE NOT ${isNow('r.created_at')}) AS started_before,
      count(*) FILTER (WHERE ${isNow('r.created_at')} AND r.done) AS done_now,
      count(*) FILTER (WHERE NOT ${isNow('r.created_at')} AND r.done) AS done_before
    FROM public.${t} r
    WHERE ${window('r.created_at')}
      AND (r.user_id IS NULL OR r.user_id IN (SELECT id FROM real_users))
      AND (r.user_id IS NOT NULL OR r.guest_id IS NOT NULL)`,
  );
  const rows = await sql.unsafe<RunsRow[]>(`WITH real_users AS (${REAL_USERS}) ${parts.join(' UNION ALL ')}`, [w.from, w.mid, w.end]);
  return new Map(rows.map((r) => [r.tbl, r]));
}

/** The counts that have no mode of their own in the shared play counts. */
async function ownCounts(w: Weeks): Promise<Map<NonNullable<GameDef['own']>, Counted>> {
  const rows = await sql.unsafe<Array<{ key: NonNullable<GameDef['own']>; now: string; before: string }>>(
    `WITH real_users AS (${REAL_USERS})
     -- The older daily challenges only (the shared 'daily' bucket also holds every newer daily game).
     SELECT 'legacy-daily' AS key, count(*) FILTER (WHERE ${isNow('at')}) AS now, count(*) FILTER (WHERE NOT ${isNow('at')}) AS before
       FROM (SELECT dc.completed_at AS at FROM daily_challenge_completions dc JOIN real_users ru ON ru.id = dc.user_id WHERE ${window('dc.completed_at')}
             UNION ALL SELECT gdc.created_at FROM guest_daily_completions gdc WHERE ${window('gdc.created_at')}) c
     UNION ALL
     -- The Monday show: real players who entered a show that was played to the end (a show cancelled after the
     -- hosts pressed Start keeps its start time, so only completed ones count). Its events are flagged as tests, so the
     -- shared Weekend League count leaves them out.
     SELECT 'show-players', count(*) FILTER (WHERE ${isNow('t.qualifier_starts_at')}), count(*) FILTER (WHERE NOT ${isNow('t.qualifier_starts_at')})
       FROM wl_entries e
       JOIN wl_tournaments t ON t.id = e.tournament_id
       JOIN real_users ru ON ru.id = e.user_id
      WHERE t.config->>'event_slug' = 'orshabatoba' AND t.status = 'completed' AND t.qualifier_starts_at IS NOT NULL AND ${window('t.qualifier_starts_at')}`,
    [w.from, w.mid, w.end],
  );
  return new Map(rows.map((r) => [r.key, { now: Number(r.now), before: Number(r.before) }]));
}

/** Pure: split per-mode play counts into the last 7 whole days and the 7 before (`days`: 15 days oldest first, the last one today, which is left out). */
export function splitWeeks(rows: ReadonlyArray<{ day: string; mode: string; games: number }>, days: readonly string[]): Map<string, Counted> {
  const recent = new Set(days.slice(7, 14));
  const earlier = new Set(days.slice(0, 7));
  const out = new Map<string, Counted>();
  for (const r of rows) {
    const c = out.get(r.mode) ?? { now: 0, before: 0 };
    if (recent.has(r.day)) c.now += Number(r.games);
    else if (earlier.has(r.day)) c.before += Number(r.games);
    out.set(r.mode, c);
  }
  return out;
}

/** Pure: one game's numbers from the per-table and per-mode counts. */
export function gameStats(def: Pick<GameDef, 'runs' | 'modes' | 'own'>, runs: ReadonlyMap<string, RunsRow>, modes: ReadonlyMap<string, Counted>, own: ReadonlyMap<string, Counted> = new Map()): GameStats {
  const tables = (def.runs ?? []).map((t) => runs.get(t)).filter((r): r is RunsRow => !!r);
  const sum = (pick: (r: RunsRow) => string) => tables.reduce((n, r) => n + Number(pick(r)), 0);
  const counted = (def.modes ?? []).map((m) => modes.get(m)).filter((c): c is Counted => !!c);
  return {
    started: tables.length ? { now: sum((r) => r.started_now), before: sum((r) => r.started_before) } : null,
    finished: tables.length ? { now: sum((r) => r.done_now), before: sum((r) => r.done_before) } : null,
    // A game whose mode never appears had no plays in the 14 days: zero, not unknown.
    played: def.own
      ? (own.get(def.own) ?? { now: 0, before: 0 })
      : (def.modes ?? []).length
        ? { now: counted.reduce((n, c) => n + c.now, 0), before: counted.reduce((n, c) => n + c.before, 0) }
        : null,
  };
}

const DAY_MS = 86_400_000;
/** The last 15 Tbilisi days, oldest first, ending today (the play counts are keyed by Tbilisi day). */
export function lastDays(now: Date, count = 15): string[] {
  const today = new Date(now.getTime() + 4 * 3_600_000);
  return Array.from({ length: count }, (_, i) => new Date(today.getTime() - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

async function compute(now: Date = new Date()) {
  // One after the other on purpose: both scan play tables (the same rule the analytics page follows).
  const days = lastDays(now);
  const weeks = weeksOf(days);
  const runs = await dailyRuns(weeks);
  const own = await ownCounts(weeks);
  // 15 days back from now always covers both whole weeks (the oldest of the 15 days starts less than 15 days ago).
  const modes = splitWeeks(await adminStatsRepo.gamesPerDay(15), days);
  return {
    generatedAt: now.toISOString(),
    /** The two weeks compared, as Georgian days: the last 7 whole days end yesterday. */
    weeks: { before: [weeks.from, days[6]!], now: [weeks.mid, days[13]!] },
    games: GAMES.map((g) => ({
      key: g.key,
      name: g.name,
      group: g.group,
      what: g.what,
      state: g.state(),
      route: g.route,
      preview: g.preview,
      stats: gameStats(g, runs, modes, own),
    })),
  };
}

// The counts scan two weeks of plays: reuse them for five minutes.
const cache = ttlCache<string, Awaited<ReturnType<typeof compute>>>(300_000);

export const gamesHub = {
  overview: () => cache.get('games', () => compute()),
};
