import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { RoomEngine } from '../../room.engine.js';
import { ROOM_LOCALES, type RoomLocale } from '../../room.types.js';
import {
  ABSENCE, afterOutage, applyCommand, codenamesCommandSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type CodenamesCommand, type CodenamesContent, type CodenamesState,
} from './codenames.engine.js';
import {
  BOARD_FACES, BOARD_SIZE, codenamesCardSchema, codenamesPackSchema, codenamesWordItemSchema, dealBoard, dealWordBoard, fold, turnTimerSchema, WORDS_BOARD, wordTag,
  type CodenamesCard, type CodenamesWordItem,
} from './codenames.rules.js';

/** Pool tags: a card is a caricature (`face`) or anything else (`object`). */
export const FACE_TAG = 'face';
export const OBJECT_TAG = 'object';

/**
 * What the host picked: no options = a picture board without a clock; `words` = a word board in `lang` (the host's
 * language); `timer` = seconds per clue and per team's guessing.
 */
export const codenamesOptionsSchema = z.object({ board: z.literal('words').optional(), lang: z.enum(ROOM_LOCALES).optional(), timer: turnTimerSchema.optional() }).strict()
  .refine((o) => (o.board === 'words') === (o.lang !== undefined), 'a word board names its language');
export type CodenamesOptions = z.infer<typeof codenamesOptionsSchema> | null;

const random = () => randomInt(0, 0x100000000) / 0x100000000;

/**
 * Word-board matches are stored under version 2 (see the registry), picture matches stay version 1, and a match with a
 * turn timer (either board) is version 3: a build from before timers neither runs it (its pack has a field that build's
 * schema refuses) nor shows it to a tab that cannot draw its clock.
 */
export const CODENAMES_WORDS_VERSION = 2;
export const CODENAMES_TIMER_VERSION = 3;

export const codenamesRoomEngine: RoomEngine<CodenamesContent, CodenamesState, CodenamesCommand, CodenamesOptions> = {
  game: 'codenames',
  version: 1,
  commandSchema: codenamesCommandSchema,

  parseContent(raw) {
    const parsed = codenamesPackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  parseOptions(raw) {
    if (raw === null || raw === undefined) return null;
    const parsed = codenamesOptionsSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    // Stored the way it was sent minus empty keys; nothing chosen is no options at all.
    const o = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as z.infer<typeof codenamesOptionsSchema>;
    return Object.keys(o).length > 0 ? o : null;
  },

  versionFor: (options) => (options?.timer ? CODENAMES_TIMER_VERSION : options?.board === 'words' ? CODENAMES_WORDS_VERSION : 1),

  /** The board (see `dealBoardFor`) with the host's turn timer: the match's write-once content. */
  async deal(pick, options) {
    const dealt = await dealBoardFor(pick, options);
    return dealt && options?.timer ? { ...dealt, content: { ...dealt.content, timer: options.timer } } : dealt;
  },

  start: (seats, content, nowMs, context) => startMatch(seats, content, nowMs, context?.hostSeat ?? null),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, content, nowMs) => afterOutage(state, content, nowMs),
  seatsChanged: (state, changes, nowMs) => seatsChanged(state, changes, nowMs),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
  absence: ABSENCE,
};

/**
 * A random board from the whole deck, preferring cards none of the players met in their last matches: a word board in
 * the host's language, or six caricatures and fourteen other pictures, keyed by a fresh seed.
 */
async function dealBoardFor(pick: Parameters<typeof codenamesRoomEngine.deal>[0], options: CodenamesOptions) {
  // A language without its own deck yet (pt) deals the English words rather than leaving the room without a board.
  if (options?.board === 'words' && options.lang) return (await dealWords(pick, options.lang)) ?? (options.lang === 'en' ? null : dealWords(pick, 'en'));
  const valid = (items: Awaited<ReturnType<typeof pick>>) => items.flatMap((item) => {
    const card = codenamesCardSchema.safeParse(item.payload);
    return card.success ? [card.data] : [];
  });
  const faces = valid(await pick({ easy: BOARD_FACES }, FACE_TAG));
  const objects = valid(await pick({ easy: BOARD_SIZE - BOARD_FACES }, OBJECT_TAG));
  const cards: CodenamesCard[] = [...faces, ...objects];
  if (faces.length !== BOARD_FACES || cards.length !== BOARD_SIZE || new Set(cards.map((c) => c.id)).size !== BOARD_SIZE) return null;
  const pack = dealBoard(cards, random, randomInt(0, 0x100000000));
  return { itemIds: cards.map((c) => c.id), content: pack };
}

/** Words drawn beyond the board, so a row that does not parse or repeats a spelling (a hand edit) is skipped, not fatal. */
const SPARE_WORDS = 5;

/** 25 words of the room's language, preferring words none of the players met lately; null when that deck is short. */
async function dealWords(pick: Parameters<typeof codenamesRoomEngine.deal>[0], lang: RoomLocale) {
  const spellings = new Set<string>();
  const items: CodenamesWordItem[] = (await pick({ easy: WORDS_BOARD.size + SPARE_WORDS }, wordTag(lang))).flatMap((item) => {
    const word = codenamesWordItemSchema.safeParse(item.payload);
    if (!word.success || word.data.lang !== lang || spellings.has(fold(word.data.word))) return [];
    spellings.add(fold(word.data.word));
    return [word.data];
  }).slice(0, WORDS_BOARD.size);
  if (items.length !== WORDS_BOARD.size || new Set(items.map((w) => w.id)).size !== WORDS_BOARD.size) return null;
  const pack = dealWordBoard(items, lang, random, randomInt(0, 0x100000000));
  return { itemIds: items.map((w) => w.id), content: pack };
}
