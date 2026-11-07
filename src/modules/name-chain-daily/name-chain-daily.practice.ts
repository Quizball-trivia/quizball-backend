import { z } from 'zod';
import { rejected } from '../daily/daily.errors.js';
import type { Universe } from '../footballers/footballers.universe.js';
import { examplesOn, judge, letterExhausted, pickStart, type Verdict } from '../room/games/name-chain/name-chain.core.js';
import { ANSWER_MAX_LENGTH } from '../wordgame-daily/wordgame-daily.shared.js';

/**
 * Relaxed practice: the name chain with no clock, no run row and no score. The browser holds the chain and sends the
 * footballers used so far with every step; the server only judges, with the same rules (and the same release) as the
 * daily. Nothing is stored and nothing reaches a leaderboard, so the client is trusted with its own chain: a forged
 * `used` list can only change the player's own practice.
 */

/** Practice never opens with a start name the daily keeps for itself (the rooms' half). */
const PRACTICE_START_BUCKET = 1;
/** A long practice chain stays one small request; past this the client starts a fresh chain. */
export const PRACTICE_USED_MAX = 300;
const EXAMPLES = 5;

const localeSchema = z.enum(['en', 'ka', 'es', 'tr', 'ru', 'pt', 'de', 'fr']).optional();
const pidSchema = z.string().min(1).max(64);
const usedSchema = z.array(pidSchema).max(PRACTICE_USED_MAX).default([]);
export const practiceSchema = z.discriminatedUnion('op', [
  /** A fresh chain from a well-known name nobody in `used` has had. */
  z.object({ op: z.literal('start'), locale: localeSchema, used: usedSchema }),
  /** One typed answer on the letter `tail` (the chain's last footballer) passes on. */
  z.object({
    op: z.literal('answer'), locale: localeSchema, used: usedSchema, tail: pidSchema,
    answer: z.string().max(ANSWER_MAX_LENGTH).regex(/[\p{L}\p{N}]/u, 'An answer needs a letter or a digit'),
  }),
  /** The player ends the chain: the names they could have used on its letter. */
  z.object({ op: z.literal('pass'), locale: localeSchema, used: usedSchema, tail: pidSchema }),
]);
export type PracticeRequest = z.infer<typeof practiceSchema>;

export interface PracticeLink { pid: string; name: string; game: string; given: boolean }
export interface PracticeResponse {
  alphabet: 'latin' | 'cyrillic';
  /** The answer's verdict; null for a start or a pass. */
  result: Verdict | null;
  /** Links to append to the chain: the start name, or the accepted answer (plus a fresh supplied name when its letter ran dry). */
  links: PracticeLink[];
  /** The letter the next answer must start with ('' once the chain is over). */
  letter: string;
  last: { kind: Verdict; text: string; name: string | null; starts: string[] } | null;
  /** On a pass: well-known unused footballers who would have answered the letter. */
  could: string[];
  /** The release has nobody left to start a chain from. */
  exhausted: boolean;
}

const linkOf = (universe: Universe, pid: string, given: boolean): PracticeLink => {
  const player = universe.player(pid);
  return { pid, name: player?.name ?? '', game: player?.game ?? '', given };
};

/** One practice step against `universe`. Pure: `random` is one draw in [0, 1) for a start name. */
export function practiceStep(universe: Universe, alphabet: PracticeResponse['alphabet'], input: PracticeRequest, random: number): PracticeResponse {
  // Ids the release does not know are dropped: they cannot block anyone.
  const used = new Set(input.used.filter((pid) => universe.player(pid) !== undefined));
  const base: PracticeResponse = { alphabet, result: null, links: [], letter: '', last: null, could: [], exhausted: false };

  if (input.op === 'start') {
    const start = pickStart(universe, used, PRACTICE_START_BUCKET, random);
    if (start === null) return { ...base, exhausted: true };
    return { ...base, links: [linkOf(universe, start, true)], letter: universe.last(start) };
  }

  if (universe.player(input.tail) === undefined) throw rejected('practice_unknown_tail');
  used.add(input.tail);
  const letter = universe.last(input.tail);

  if (input.op === 'pass') return { ...base, could: examplesOn(universe, used, letter, EXAMPLES) };

  const text = input.answer.trim().slice(0, ANSWER_MAX_LENGTH);
  const judged = judge(universe, used, letter, text);
  const name = judged.pid ? universe.player(judged.pid)?.name ?? null : null;
  const last = {
    kind: judged.verdict, text, name,
    starts: judged.pid && judged.verdict === 'letter' ? [...universe.starts(judged.pid)] : [],
  };
  if (judged.verdict !== 'ok' || judged.pid === null) return { ...base, result: judged.verdict, letter, last };

  used.add(judged.pid);
  const links = [linkOf(universe, judged.pid, false)];
  const next = universe.last(judged.pid);
  if (!letterExhausted(universe, used, next)) return { ...base, result: 'ok', links, letter: next, last };
  // Nobody left on the new letter: like the daily, the game supplies a fresh name and nobody is penalised.
  const fresh = pickStart(universe, used, PRACTICE_START_BUCKET, random);
  if (fresh === null) return { ...base, result: 'ok', links, last, exhausted: true };
  return { ...base, result: 'ok', links: [...links, linkOf(universe, fresh, true)], letter: universe.last(fresh), last };
}
