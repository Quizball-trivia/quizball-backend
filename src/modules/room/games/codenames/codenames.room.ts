import { randomInt } from 'node:crypto';
import type { RoomEngine } from '../../room.engine.js';
import {
  ABSENCE, afterOutage, applyCommand, codenamesCommandSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type CodenamesCommand, type CodenamesContent, type CodenamesState,
} from './codenames.engine.js';
import { BOARD_FACES, BOARD_SIZE, codenamesCardSchema, codenamesPackSchema, dealBoard, type CodenamesCard } from './codenames.rules.js';

/** Pool tags: a card is a caricature (`face`) or anything else (`object`). */
export const FACE_TAG = 'face';
export const OBJECT_TAG = 'object';

export const codenamesRoomEngine: RoomEngine<CodenamesContent, CodenamesState, CodenamesCommand, null> = {
  game: 'codenames',
  version: 1,
  commandSchema: codenamesCommandSchema,

  parseContent(raw) {
    const parsed = codenamesPackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  parseOptions(raw) {
    return raw === null || raw === undefined ? null : undefined;
  },

  /**
   * A random board from the whole deck, preferring cards none of the players met in their last matches: six
   * caricatures and fourteen other cards, keyed by a fresh seed. The board is the match's write-once content.
   */
  async deal(pick) {
    const valid = (items: Awaited<ReturnType<typeof pick>>) => items.flatMap((item) => {
      const card = codenamesCardSchema.safeParse(item.payload);
      return card.success ? [card.data] : [];
    });
    const faces = valid(await pick({ easy: BOARD_FACES }, FACE_TAG));
    const objects = valid(await pick({ easy: BOARD_SIZE - BOARD_FACES }, OBJECT_TAG));
    const cards: CodenamesCard[] = [...faces, ...objects];
    if (faces.length !== BOARD_FACES || cards.length !== BOARD_SIZE || new Set(cards.map((c) => c.id)).size !== BOARD_SIZE) return null;
    const pack = dealBoard(cards, () => randomInt(0, 0x100000000) / 0x100000000, randomInt(0, 0x100000000));
    return { itemIds: cards.map((c) => c.id), content: pack };
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
