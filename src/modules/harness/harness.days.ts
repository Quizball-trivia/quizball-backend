import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { addDays, dayNumber } from '../pistas/pistas.days.js';
import { normalizeAnswer, samePlayer } from '../pistas/pistas.normalize.js';
import { parseDayFile, seedDays, toDayRow } from '../pistas/pistas.seed.js';
import type { Clue, LocalizedText, PistasDifficulty } from '../pistas/pistas.types.js';
import { dailyRunway } from './harness.runway.js';

// The Day Builder (table harness.day_rounds): agents write the next days of a
// daily game before its calendar runs out. First game: Football Clues, where a
// day is ten rounds and a round is one footballer told in ten clues.
//
// Agents name footballers, write the clues, check every clue against the web
// and translate them (the harness worker). This file is the part that is code:
// it orders rounds when a game is running short, and puts finished rounds
// together into the next day, stored through the game's own seed checks. A
// day those checks refuse is never stored.

type Db = typeof sql;

export type DayGame = 'pistas';
type RoundStatus = 'planned' | 'written' | 'checked' | 'ready' | 'used' | 'dropped';

const LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el'] as const;
type Locale = (typeof LOCALES)[number];
type AllText = Record<Locale, string>;

/** The difficulty of each of a day's ten rounds, in order: every stored day follows it. */
export const PISTAS_PATTERN: readonly PistasDifficulty[] = ['easy', 'medium', 'hard', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard'];
const PER_DAY: Record<PistasDifficulty, number> = { easy: 3, medium: 4, hard: 3 };
const DIFFICULTIES: readonly PistasDifficulty[] = ['easy', 'medium', 'hard'];
const FACTS_PER_ROUND = 7;
/** Rounds ordered beyond what the missing days need: some are dropped by the checker. */
const SPARE = 1.3;
/** One planning job names at most this many footballers. */
const PLAN_AT_ONCE = 30;
const WRITER = 'day-builder';

export const DAY_GAMES: Record<DayGame, { label: string; runwayKey: string }> = {
  pistas: { label: 'Football Clues', runwayKey: 'pistas' },
};

/** What stands of a round after the fact check (English). */
export interface CheckedRound {
  name: string;
  accepted: string[];
  confed: string;
  position: string;
  foot: string | null;
  born: number;
  /** Hardest first, easiest last. */
  facts: string[];
}

/** The same round in every language. */
export interface LocalizedRound {
  display: Partial<AllText>;
  accepted?: string[];
  facts: Array<Partial<AllText>>;
}

/** The profile chips ("I'm European.") as the stored days word them, by kind and icon. */
export type ChipTexts = ReadonlyMap<string, AllText>;
const chipKey = (kind: string, icon: string) => `${kind}:${icon}`;

const allText = (value: unknown): AllText | null => {
  const v = (value ?? {}) as Record<string, unknown>;
  const out = {} as AllText;
  for (const locale of LOCALES) {
    const text = typeof v[locale] === 'string' ? (v[locale] as string).trim() : '';
    if (!text) return null;
    out[locale] = text;
  }
  return out;
};

/** Pure: how many rounds of each difficulty to order, given the days missing and what is already on its way. */
export function roundsToOrder(daysMissing: number, open: Record<PistasDifficulty, number>, room: number): Record<PistasDifficulty, number> {
  const want = { easy: 0, medium: 0, hard: 0 };
  let left = Math.max(0, Math.min(room, PLAN_AT_ONCE));
  for (const d of DIFFICULTIES) {
    const need = Math.max(0, Math.ceil(daysMissing * PER_DAY[d] * SPARE) - open[d]);
    want[d] = need;
  }
  // When there is not room for everything, keep the day's mix rather than filling up on one difficulty.
  const total = want.easy + want.medium + want.hard;
  if (total > left) {
    const scale = left / total;
    for (const d of DIFFICULTIES) want[d] = Math.floor(want[d] * scale);
  }
  for (const d of DIFFICULTIES) {
    want[d] = Math.min(want[d], left);
    left -= want[d];
  }
  return want;
}

/**
 * Pure: a finished round as the game stores it (without its id), or the reason it cannot be one. The three profile
 * chips come first and the facts after them, hardest to easiest: the game itself puts them in serving order.
 */
export function storedRound(checked: CheckedRound, localized: LocalizedRound, chips: ChipTexts, difficulty: PistasDifficulty) {
  const fail = (why: string) => ({ ok: false as const, why });
  const display = allText(localized.display);
  if (!display) return fail('the name is missing in a language');
  if (!Array.isArray(localized.facts) || localized.facts.length !== FACTS_PER_ROUND || checked.facts.length !== FACTS_PER_ROUND) return fail(`a round needs ${FACTS_PER_ROUND} facts`);
  const facts: AllText[] = [];
  for (const [i, f] of localized.facts.entries()) {
    const text = allText(f);
    if (!text) return fail(`fact ${i + 1} is missing in a language`);
    facts.push(text);
  }
  const chip = (kind: Clue['kind'], icon: string): Clue | null => {
    const text = chips.get(chipKey(kind, icon));
    return text ? { kind, icon, text: { ...text } } : null;
  };
  const confed = chip('confed', checked.confed);
  const position = chip('position', checked.position);
  if (!confed) return fail('no wording for that confederation');
  if (!position) return fail('no wording for that position');
  const decade = Number.isInteger(checked.born) ? chip('decade', String(Math.floor(checked.born / 10) * 10)) : null;
  // The stored days tell a recent player by their foot and an older one by the decade they were born in.
  const foot = (checked.foot === 'left' || checked.foot === 'right') && checked.born >= 1990 ? chip('foot', checked.foot) : null;
  const third = foot ?? decade ?? ((checked.foot === 'left' || checked.foot === 'right') ? chip('foot', checked.foot) : null);
  if (!third) return fail('no wording for the foot or the decade');
  const profile = third.kind === 'foot' ? [third, confed, position] : [confed, position, third];
  const accepted = [...new Set([...checked.accepted, ...(localized.accepted ?? []), ...Object.values(display)].map((a) => (typeof a === 'string' ? a.trim() : '')).filter((a) => normalizeAnswer(a).length > 0))];
  return {
    ok: true as const,
    round: {
      difficulty,
      clues: [...profile, ...facts.map((text): Clue => ({ kind: 'fact', icon: null, text }))],
      answer: { display: display as LocalizedText, accepted },
    },
  };
}

interface RoundRow {
  id: string;
  number: number;
  game: DayGame;
  status: RoundStatus;
  difficulty: PistasDifficulty;
  subject: string;
  checked: CheckedRound | null;
  localized: LocalizedRound | null;
  note: string | null;
  used_on: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

async function policyNumber(key: string, fallback: number): Promise<number> {
  const [row] = await sql<Array<{ value: unknown }>>`SELECT value FROM harness.policies WHERE key = ${key}`;
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function storing(game: DayGame): Promise<boolean> {
  const [row] = await sql<Array<{ value: unknown }>>`SELECT value FROM harness.policies WHERE key = ${`days.${game}.store`}`;
  return row?.value === true;
}

/** The wording of every profile chip, taken from the stored days: the most used text per kind and icon. */
async function chipTexts(db: Db): Promise<ChipTexts> {
  const rows = await db<Array<{ kind: string; icon: string; text: unknown }>>`
    SELECT kind, icon, text FROM (
      SELECT c->>'kind' AS kind, c->>'icon' AS icon, c->'text' AS text,
             row_number() OVER (PARTITION BY c->>'kind', c->>'icon' ORDER BY count(*) DESC) AS rn
        FROM public.pistas_days d, jsonb_array_elements(d.rounds) AS r, jsonb_array_elements(r->'clues') AS c
       WHERE c->>'kind' <> 'fact' AND c->>'icon' IS NOT NULL
         AND c->'text' ?& ARRAY['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el']
       GROUP BY 1, 2, 3
    ) q WHERE rn = 1`;
  const out = new Map<string, AllText>();
  for (const r of rows) {
    const text = allText(r.text);
    if (text) out.set(chipKey(r.kind, r.icon), text);
  }
  return out;
}

type Answer = { display: string[]; accepted: string[] };

/** Every footballer a daily answer may not be: the ones in stored days, and the ones in the duel pool. */
async function takenPlayers(db: Db): Promise<Answer[]> {
  const stored = await db<Array<{ answer: { display?: Record<string, string>; accepted?: string[] } }>>`
    SELECT r->'answer' AS answer FROM public.pistas_days d, jsonb_array_elements(d.rounds) AS r`;
  const [pool] = await db<Array<{ present: boolean }>>`SELECT to_regclass('public.duel_pool') IS NOT NULL AS present`;
  const duel = pool?.present
    ? await db<Array<{ answer: { display?: Record<string, string>; accepted?: string[] } }>>`SELECT payload->'answer' AS answer FROM public.duel_pool WHERE game = 'pistas' AND enabled`
    : [];
  return [...stored, ...duel].map((r) => ({ display: Object.values(r.answer?.display ?? {}), accepted: r.answer?.accepted ?? [] }));
}

const lastStoredDay = async (db: Db) => (await db<Array<{ day: string | null }>>`SELECT max(day)::text AS day FROM public.pistas_days`)[0]?.day ?? null;

async function daysLeft(game: DayGame): Promise<number> {
  const row = (await dailyRunway()).find((r) => r.key === DAY_GAMES[game].runwayKey);
  return row?.daysLeft ?? 0;
}

async function event(db: Db, level: 'info' | 'warn', message: string): Promise<void> {
  await db`INSERT INTO harness.events (type, level, message) VALUES ('day_build', ${level}, ${message.slice(0, 1000)})`;
}

/**
 * Puts ready rounds together into the next day and stores it, as long as days are missing and there are rounds
 * for one. Returns the days stored. One instance at a time, across every server.
 */
async function assemble(game: DayGame): Promise<string[]> {
  // The switch: while it is off, rounds are made and wait; nothing is stored for players.
  if (!(await storing(game))) return [];
  const ahead = await policyNumber(`days.${game}.ahead`, 21);
  const built: string[] = [];
  // At most a few days per call: each one is a locked write on the game's days table.
  for (let i = 0; i < 5; i++) {
    if ((await daysLeft(game)) >= ahead) break;
    const day = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      await tx`SELECT pg_advisory_xact_lock(hashtext('harness_day_build'), hashtext(${game}))`;
      const last = await lastStoredDay(tx);
      if (!last) return null;
      const next = addDays(last, 1);
      const chips = await chipTexts(tx);
      const taken = await takenPlayers(tx);
      const ready = await tx<RoundRow[]>`
        SELECT id, number, game, status, difficulty, subject, checked, localized, note, used_on, created_at, updated_at
          FROM harness.day_rounds WHERE game = ${game} AND status = 'ready' ORDER BY updated_at, number FOR UPDATE`;
      const drop = async (row: RoundRow, why: string) => {
        await tx`UPDATE harness.day_rounds SET status = 'dropped', note = ${why.slice(0, 1000)}, updated_at = now() WHERE id = ${row.id}`;
      };
      // Each ready round as the game would store it; one that cannot be stored is dropped here, with the reason.
      const usable = new Map<PistasDifficulty, Array<{ row: RoundRow; round: Extract<ReturnType<typeof storedRound>, { ok: true }> }>>(DIFFICULTIES.map((d) => [d, []]));
      const chosen: Answer[] = [];
      for (const row of ready) {
        if (!row.checked || !row.localized) {
          await drop(row, 'ready without its clues');
          continue;
        }
        const made = storedRound(row.checked, row.localized, chips, row.difficulty);
        if (!made.ok) {
          await drop(row, `could not be stored: ${made.why}`);
          continue;
        }
        const answer = { display: Object.values(made.round.answer.display) as string[], accepted: made.round.answer.accepted };
        if ([...taken, ...chosen].some((other) => samePlayer(answer, other))) {
          await drop(row, 'this footballer already has a round');
          continue;
        }
        chosen.push(answer);
        usable.get(row.difficulty)!.push({ row, round: made });
      }
      // The game's own checks decide. A round they refuse is dropped and the next one of its difficulty takes its place.
      for (let attempt = 0; attempt < 12; attempt++) {
        if (DIFFICULTIES.some((d) => usable.get(d)!.length < PER_DAY[d])) return null;
        const taking = { easy: 0, medium: 0, hard: 0 };
        const picks = PISTAS_PATTERN.map((d) => usable.get(d)![taking[d]++]!);
        const file = { day: next, number: dayNumber(next), rounds: picks.map((p, i) => ({ id: `${next}-r${i + 1}`, ...p.round.round })) };
        let parsed;
        try {
          parsed = parseDayFile(next, file);
        } catch (err) {
          // The seed's messages name positions and languages only, never an answer or a clue.
          const message = err instanceof Error ? err.message : 'refused';
          const at = /round (\d+)/.exec(message);
          if (!at) throw err;
          const bad = picks[Number(at[1]) - 1]!;
          await drop(bad.row, `the game's checks refused it: ${message.replace(/^[^:]*: /, '').replace(/^round \d+:? ?/, '')}`);
          const list = usable.get(bad.row.difficulty)!;
          list.splice(list.indexOf(bad), 1);
          continue;
        }
        // Stored on its own connection while this transaction holds the lock: the seed opens its own transaction.
        try {
          await seedDays(sql as never, [toDayRow(parsed)], { dryRun: false, allowCorrection: false, append: true });
        } catch (err) {
          // The seed compares names more strictly than the check above ("N'Golo" is "Ngolo"): it names the rounds
          // that repeat a footballer, as "<day> r<n>". Those are dropped and the day is tried again without them.
          const message = err instanceof Error ? err.message : '';
          const repeats = [...message.matchAll(/ r(\d+)/g)].map((m) => picks[Number(m[1]) - 1]).filter((p): p is (typeof picks)[number] => Boolean(p));
          if (!message.includes('repeat a player already used') || repeats.length === 0) throw err;
          for (const bad of repeats) {
            await drop(bad.row, 'this footballer already has a round');
            const list = usable.get(bad.row.difficulty)!;
            list.splice(list.indexOf(bad), 1);
          }
          continue;
        }
        await tx`UPDATE harness.day_rounds SET status = 'used', used_on = ${next}, updated_at = now() WHERE id = ANY(${picks.map((p) => p.row.id)}::uuid[])`;
        await event(tx, 'info', `${DAY_GAMES[game].label}: day ${file.number} (${next}) built from rounds ${picks.map((p) => p.row.number).join(', ')}`);
        return next;
      }
      return null;
    });
    if (!day) break;
    built.push(day);
  }
  return built;
}

/** Orders more rounds when days are missing and too few rounds are on their way. Returns how many were asked for. */
async function order(game: DayGame, by: string): Promise<number> {
  const ahead = await policyNumber(`days.${game}.ahead`, 21);
  const maxOpen = await policyNumber(`days.${game}.max_open_rounds`, 60);
  const missing = Math.max(0, ahead - (await daysLeft(game)));
  if (missing === 0) return 0;
  return sql.begin(async (t) => {
    const tx = t as unknown as Db;
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_day_order'), hashtext(${game}))`;
    const [live] = await tx<Array<{ id: string }>>`SELECT id FROM harness.jobs WHERE kind = 'round_plan' AND input->>'game' = ${game} AND status IN ('queued', 'running') LIMIT 1`;
    if (live) return 0;
    const [agent] = await tx<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${WRITER}`;
    if (!agent || agent.status !== 'active') return 0;
    const counts = await tx<Array<{ difficulty: PistasDifficulty; n: number }>>`
      SELECT difficulty, count(*)::int AS n FROM harness.day_rounds WHERE game = ${game} AND status IN ('planned', 'written', 'checked', 'ready') GROUP BY 1`;
    const open = { easy: 0, medium: 0, hard: 0 };
    for (const c of counts) open[c.difficulty] = c.n;
    const want = roundsToOrder(missing, open, maxOpen - (open.easy + open.medium + open.hard));
    const total = want.easy + want.medium + want.hard;
    if (total <= 0) return 0;
    // Everyone a new round may not be about: stored answers, duel pool players, and every round planned before
    // (a round dropped only because a job gave up may be named again).
    const names = new Set<string>();
    for (const p of await takenPlayers(tx)) for (const n of p.display) if (/^[\p{Script=Latin}\p{N}\s.'’-]+$/u.test(n)) names.add(n);
    const planned = await tx<Array<{ subject: string }>>`
      SELECT subject FROM harness.day_rounds WHERE game = ${game} AND NOT (status = 'dropped' AND note LIKE '% gave up: %')`;
    for (const p of planned) names.add(p.subject);
    await tx`
      INSERT INTO harness.jobs (kind, agent_slug, priority, input)
      VALUES ('round_plan', ${WRITER}, 3, ${sql.json({ game, want, taken: [...names].sort(), today: new Date().toISOString().slice(0, 10) } as never)})`;
    await event(tx, 'info', `${DAY_GAMES[game].label}: ${missing} day${missing === 1 ? '' : 's'} short of ${ahead} ahead, asked for ${total} footballers (${want.easy} easy, ${want.medium} medium, ${want.hard} hard), by ${by}`);
    return total;
  });
}

export const dayBuilder = {
  /** Where each game the Day Builder builds stands: days ahead, rounds on their way, what was built and dropped lately. */
  async status() {
    const runway = await dailyRunway();
    const games = [];
    for (const game of Object.keys(DAY_GAMES) as DayGame[]) {
      const r = runway.find((x) => x.key === DAY_GAMES[game].runwayKey);
      const counts = await sql<Array<{ status: RoundStatus; difficulty: PistasDifficulty; n: number }>>`
        SELECT status, difficulty, count(*)::int AS n FROM harness.day_rounds
         WHERE game = ${game} AND (status NOT IN ('used', 'dropped') OR updated_at > now() - interval '7 days') GROUP BY 1, 2`;
      const by = (status: RoundStatus) => counts.filter((c) => c.status === status).reduce((n, c) => n + c.n, 0);
      const ready = { easy: 0, medium: 0, hard: 0 };
      for (const c of counts) if (c.status === 'ready') ready[c.difficulty] = c.n;
      const built = await sql<Array<{ day: string; at: Date }>>`
        SELECT used_on::text AS day, max(updated_at) AS at FROM harness.day_rounds WHERE game = ${game} AND status = 'used' GROUP BY 1 ORDER BY 1 DESC LIMIT 5`;
      const dropped = await sql<Array<{ number: number; note: string | null; at: Date }>>`
        SELECT number, note, updated_at AS at FROM harness.day_rounds WHERE game = ${game} AND status = 'dropped' ORDER BY updated_at DESC LIMIT 8`;
      const [planning] = await sql<Array<{ id: string }>>`SELECT id FROM harness.jobs WHERE kind = 'round_plan' AND input->>'game' = ${game} AND status IN ('queued', 'running') LIMIT 1`;
      const [agent] = await sql<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${WRITER}`;
      games.push({
        game,
        label: DAY_GAMES[game].label,
        ahead: await policyNumber(`days.${game}.ahead`, 21),
        // Off: rounds are made and wait, and no day is stored from them.
        storing: await storing(game),
        daysLeft: r?.daysLeft ?? 0,
        storedThrough: r?.storedThrough ?? null,
        // On their way, step by step.
        rounds: { planned: by('planned'), written: by('written'), checked: by('checked'), ready: by('ready') },
        readyByDifficulty: ready,
        perDay: PER_DAY,
        // The last seven days.
        builtLately: built.map((b) => ({ day: b.day, at: new Date(b.at).toISOString() })),
        droppedLately: { count: by('dropped'), examples: dropped.map((d) => ({ number: d.number, note: d.note ?? '', at: new Date(d.at).toISOString() })) },
        planning: Boolean(planning),
        agent: agent ? (agent.status as 'active' | 'paused') : 'missing',
      });
    }
    return { games };
  },

  /**
   * The rounds that are not in a day yet, newest first, as a person reads them before trusting the builder: who, the
   * clues in English, what the checker changed, why a round was dropped. Admin-only, like the rest of HQ: these hold answers.
   */
  async rounds(game: string) {
    if (!(game in DAY_GAMES)) throw new ValidationError('The Day Builder does not build that game yet.');
    const rows = await sql<Array<RoundRow & { draft: { facts?: Array<{ text?: string; source?: string }> } | null }>>`
      SELECT id, number, game, status, difficulty, subject, draft, checked, localized, note, used_on, created_at, updated_at
        FROM harness.day_rounds WHERE game = ${game} AND status <> 'used' ORDER BY (status = 'ready') DESC, updated_at DESC LIMIT 120`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        difficulty: r.difficulty,
        subject: r.subject,
        note: r.note,
        profile: r.checked ? { confed: r.checked.confed, position: r.checked.position, foot: r.checked.foot, born: r.checked.born } : null,
        // What stands after the check; before it, what the writer wrote.
        facts: r.checked?.facts ?? (r.draft?.facts ?? []).map((f) => f.text ?? '').filter(Boolean),
        // The pages the writer read, for a person who wants to check one.
        sources: [...new Set((r.draft?.facts ?? []).map((f) => f.source ?? '').filter((s) => /^https:\/\//.test(s)))].slice(0, 12),
        names: r.localized?.display ?? null,
        // One language as a sample of the translation.
        georgian: (r.localized?.facts ?? []).map((f) => f.ka ?? '').filter(Boolean),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  },

  /** A person asks for it now: store what can be stored, then order what is missing. */
  async build(game: string, by: string) {
    if (!(game in DAY_GAMES)) throw new ValidationError('The Day Builder does not build that game yet.');
    const [agent] = await sql<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${WRITER}`;
    if (!agent) throw new NotFoundError('The Day Builder is not set up.');
    if (agent.status !== 'active') throw new ConflictError('The Day Builder is paused.');
    const built = await assemble(game as DayGame);
    const ordered = await order(game as DayGame, by);
    return { built, ordered };
  },

  /** The loop's round: every game, store then order. One game failing does not stop the others. */
  async runDue(): Promise<void> {
    for (const game of Object.keys(DAY_GAMES) as DayGame[]) {
      try {
        const built = await assemble(game);
        const ordered = await order(game, 'schedule');
        if (built.length || ordered) logger.info({ game, built, ordered }, 'Day Builder round');
      } catch (err) {
        logger.warn({ err, game }, 'Day Builder round skipped');
      }
    }
  },
};
