import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { roomRussianView } from '../../../footballers/footballers.russian.js';
import { footballersService } from '../../../footballers/footballers.service.js';
import type { RoomEngine } from '../../room.engine.js';
import { refusedName } from '../../../wordgame-reports/wordgame-reports.rules.js';
import {
  afterOutage, applyCommand, judgingFor, nameChainCommandSchema, nameChainPackSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type NameChainCommand, type NameChainContent, type NameChainState,
} from './name-chain.engine.js';

/** The game's one pool item: which footballer release its matches are played on. */
export const nameChainItemSchema = z.object({ id: z.string().min(1).max(64), release: z.string().min(3).max(40) }).strict();

export const nameChainRoomEngine: RoomEngine<NameChainContent, NameChainState, NameChainCommand, null> = {
  game: 'name_chain',
  version: 1,
  commandSchema: nameChainCommandSchema,

  parseContent(raw) {
    const parsed = nameChainPackSchema.safeParse(raw);
    return parsed.success ? { pack: parsed.data, universe: null } : null;
  },

  // Nothing to choose: every footballer is an answer.
  parseOptions: () => null,

  /** No questions to deal: a match is a release and a seed (every start name follows from them). */
  async deal(pick) {
    const items = (await pick({ easy: 1 })).flatMap((item) => { const p = nameChainItemSchema.safeParse(item.payload); return p.success ? [p.data] : []; });
    if (items.length === 0) return null;
    return { itemIds: [items[0].id], content: { release: items[0].release, seed: randomInt(0, 0x100000000) } };
  },

  async hydrate(content, state, tx) {
    const universe = content.universe ?? await footballersService.universe(content.pack.release);
    // A match that froze Russian names is judged with exactly them.
    const russian = state?.ov ? await roomRussianView(universe, content.russian, state.ov, tx !== undefined) : null;
    return { pack: content.pack, universe, russian };
  },

  start: (seats, _content, nowMs, context) => startMatch(seats, nowMs, context),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes, nowMs) => seatsChanged(state, changes, nowMs),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat) => viewOf(state, content, seat),

  // Judged as the match is: with the names and letters it froze.
  refusal: (state, content, _round, text) => (content.universe ? refusedName(judgingFor(state, content), text) : null),
};
