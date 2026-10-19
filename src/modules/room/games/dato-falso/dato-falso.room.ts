import { randomBytes } from 'node:crypto';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, datoFalsoCommandSchema, datoFalsoPackSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type DatoFalsoCommand, type DatoFalsoContent, type DatoFalsoState,
} from './dato-falso.engine.js';
import { DF_ORDER, DF_PACK_WANTED, dfCardSchema, type DfCard } from './dato-falso.rules.js';

export const datoFalsoRoomEngine: RoomEngine<DatoFalsoContent, DatoFalsoState, DatoFalsoCommand, null> = {
  game: 'dato_falso',
  version: 1,
  commandSchema: datoFalsoCommandSchema,

  parseContent(raw) {
    const parsed = datoFalsoPackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  parseOptions(raw) {
    return raw === null || raw === undefined ? null : undefined;
  },

  /**
   * Ten pool cards on the difficulty curve, preferring cards none of the players met lately, and a fresh salt. Twice
   * the cards are drawn so one footballer appears once per match; a small pool may repeat one rather than not start.
   */
  async deal(pick) {
    const wanted = Object.fromEntries(Object.entries(DF_PACK_WANTED).map(([d, n]) => [d, n * 2]));
    const byDifficulty = new Map<string, DfCard[]>();
    for (const item of await pick(wanted)) {
      const card = dfCardSchema.safeParse(item.payload);
      if (card.success && card.data.difficulty === item.difficulty) byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), card.data]);
    }
    const players = new Set<string>();
    const take = (difficulty: string, fresh: boolean) => {
      const list = byDifficulty.get(difficulty) ?? [];
      const at = list.findIndex((c) => !fresh || !players.has(c.player.id));
      if (at < 0) return undefined;
      const [card] = list.splice(at, 1);
      players.add(card.player.id);
      return card;
    };
    const cards = DF_ORDER.map((d) => take(d, true) ?? take(d, false));
    if (cards.some((c) => !c)) return null;
    const content: DatoFalsoContent = { salt: randomBytes(16).toString('hex'), cards: cards as DfCard[] };
    return { itemIds: content.cards.map((c) => c.id), content };
  },

  start: (seats, _content, nowMs) => startMatch(seats, nowMs),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes) => seatsChanged(state, changes),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
};
