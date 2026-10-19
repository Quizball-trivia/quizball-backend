import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { rejected } from '../daily/daily.errors.js';
import { ANSWER_GRACE_MS } from '../wordgame-daily/wordgame-daily.shared.js';
import { DF_CARDS, DF_OPTIONS, DF_ORDER, cutFor, dfPlayerKeys, dfCardSchema, pointsFor, type DfArt, type DfCard, type DfCategory, type DfJoker, type DfLocalized } from '../room/games/dato-falso/dato-falso.rules.js';

/**
 * Dato falso futbolero, solo: the same ten cards for everyone each day, thirty seconds a card. Pure: time comes in as
 * `now` (the database clock, read after the run's lock). A card's fake and explanation leave the server once that card
 * is settled; the whole day only once the day is closed.
 */
export const CARD_MS = 30_000;

export const dayCardsSchema = z.object({ cards: z.array(dfCardSchema).length(DF_CARDS) }).strict().superRefine((d, ctx) => {
  if (new Set(d.cards.map((c) => c.id)).size !== d.cards.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A card appears twice' });
  const keys = d.cards.map(dfPlayerKeys);
  if (new Set(keys.map((k) => k.id)).size !== keys.length || new Set(keys.map((k) => k.name)).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A footballer appears twice in one day' });
  if (d.cards.some((c, i) => c.difficulty !== DF_ORDER[i])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The cards must follow the difficulty curve' });
});
export type DayCards = z.infer<typeof dayCardsSchema>;

/** One settled card: the option picked (null = the clock ran out), the jokers on it, and its points. */
export interface CardResult { pick: number | null; cut: boolean; dbl: boolean; right: boolean; pts: number }

/**
 * dato_falso_runs.state: r = card index; open = its clock is running; dl = the deadline (epoch ms) while open;
 * cut / dbl = jokers on the open card; jk = jokers spent this run; salt = which true options Descartar 2 greys out;
 * end = why the current card settled; res = every settled card.
 */
export interface RunState {
  v: 1;
  r: number;
  open: boolean;
  dl: number | null;
  cut: boolean;
  dbl: boolean;
  jk: { cut: boolean; double: boolean };
  salt: string;
  end: 'pick' | 'time' | null;
  res: CardResult[];
  done: boolean;
}

export const newState = (): RunState => ({
  v: 1, r: 0, open: false, dl: null, cut: false, dbl: false, jk: { cut: false, double: false },
  salt: randomBytes(12).toString('hex'), end: null, res: [], done: false,
});

function settle(s: RunState, fake: number | null, pick: number | null): RunState {
  const right = pick !== null && pick === fake;
  const res = [...s.res, { pick, cut: s.cut, dbl: s.dbl, right, pts: pointsFor(right, s.dbl) }];
  return { ...s, open: false, dl: null, end: pick === null ? 'time' : 'pick', res, done: res.length >= DF_CARDS };
}

/** The run as of `now`: an open clock that ran out (past the network grace) is the card lost to time. */
export function project(s: RunState, now: number): RunState {
  return s.open && s.dl !== null && now > s.dl + ANSWER_GRACE_MS ? settle(s, null, null) : s;
}

/** When `project` settled the card by time: the instant its clock (with the grace) ran out. */
export const settledAt = (stored: RunState, projected: RunState): number | null =>
  (stored.open && !projected.open && stored.dl !== null ? stored.dl + ANSWER_GRACE_MS : null);

/** Opens the first card, or the one after a settled card. */
export function next(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.open) throw rejected('card_open');
  return { ...s, r: s.end !== null ? s.r + 1 : s.r, open: true, dl: now + CARD_MS, cut: false, dbl: false, end: null };
}

export function joker(s: RunState, kind: DfJoker): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.open) throw rejected('card_closed');
  if (s.jk[kind]) throw rejected('joker_used');
  const jk = { ...s.jk, [kind]: true };
  return kind === 'cut' ? { ...s, jk, cut: true } : { ...s, jk, dbl: true };
}

export function pick(s: RunState, card: DfCard, option: number): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.open) throw rejected('card_closed');
  if (option < 0 || option >= DF_OPTIONS) throw rejected('unknown_option');
  if (s.cut && cutFor(card, s.salt).includes(option)) throw rejected('option_removed');
  return settle(s, card.fake, option);
}

/** A correction moves an unfinished run onto new content from scratch (the kit also unranks it). */
export const rebase = (_s: RunState): RunState => newState();

export const score = (s: RunState): number => s.res.reduce((sum, r) => sum + r.pts, 0);
export const rights = (s: RunState): number => s.res.filter((r) => r.right).length;

export interface PublicCard { id: string; category: DfCategory; player: { name: DfLocalized; portrait: string | null }; options: Array<{ label: DfLocalized; art: DfArt }> }
/** A settled card as the player may see it: what they did, the fake and why. */
export interface PublicResult extends CardResult { card: PublicCard | null; fake: number | null; explain: DfLocalized | null }

export interface PublicRunState {
  day: string;
  card: number;
  totalCards: number;
  cardMs: number;
  /** The card on screen, once opened; never its fake. */
  current: PublicCard | null;
  open: boolean;
  /** ISO; the web counts down against `serverNow`. */
  deadline: string | null;
  serverNow: string;
  removed: number[];
  doubled: boolean;
  jokers: { cut: boolean; double: boolean };
  /** The card just settled (fake and explanation), until the next one opens. */
  settled: (PublicResult & { reason: 'pick' | 'time' }) | null;
  results: PublicResult[];
  done: boolean;
  score: number;
  rights: number;
  ranked: boolean;
  /** The run is over and its day closed: every card with its fake. */
  disclosed: boolean;
  rank?: number;
}

const publicCard = (c: DfCard): PublicCard => ({ id: c.id, category: c.category, player: { name: c.player.name, portrait: c.player.portrait }, options: c.options.map((o) => ({ label: o.label, art: o.art })) });

/** What the player sees; `s` must already be projected to `now`. `day` is null on other content (a corrected day). */
export function publicState(s: RunState, dayId: string, day: DayCards | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number }): PublicRunState {
  const resultOf = (r: CardResult, i: number): PublicResult => {
    const c = day?.cards[i];
    return { ...r, card: c ? publicCard(c) : null, fake: c ? c.fake : null, explain: c ? c.explain : null };
  };
  const current = day?.cards[s.r] ?? null;
  const started = s.open || s.end !== null;
  const disclosed = s.done && extra.disclose;
  return {
    day: dayId,
    card: s.r,
    totalCards: DF_CARDS,
    cardMs: CARD_MS,
    current: started && current ? publicCard(current) : null,
    open: s.open,
    deadline: s.open && s.dl !== null ? new Date(s.dl).toISOString() : null,
    serverNow: new Date(now).toISOString(),
    removed: s.open && s.cut && current ? cutFor(current, s.salt) : [],
    doubled: s.open && s.dbl,
    jokers: s.jk,
    settled: s.end ? { ...resultOf(s.res[s.res.length - 1], s.r), reason: s.end } : null,
    results: disclosed && day ? day.cards.map((_, i) => resultOf(s.res[i] ?? { pick: null, cut: false, dbl: false, right: false, pts: 0 }, i)) : s.res.map(resultOf),
    done: s.done,
    score: score(s),
    rights: rights(s),
    ranked: extra.ranked,
    disclosed,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
