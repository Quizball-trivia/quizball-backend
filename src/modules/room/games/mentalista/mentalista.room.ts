import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, mentalistaCommandSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type MentalistaCommand, type MentalistaState,
} from './mentalista.engine.js';
import {
  mentalistaCategorySchema, mentalistaContentSchema, resolveTiming,
  type MentalistaCategory, type MentalistaContent, type MentalistaTiming,
} from './mentalista.rules.js';

/** What a match deals per difficulty; a spread wide enough to fill any admitted roster (3–6 rounds). */
export const MENTALISTA_PACK_WANTED = { easy: 2, medium: 2, hard: 2 } as const;
/** The difficulty curve the categories are drawn along; only the first `seats` of them are used. */
const DEAL_ORDER = ['easy', 'medium', 'hard', 'easy', 'medium', 'hard'] as const;

export const mentalistaRoomEngine: RoomEngine<MentalistaContent, MentalistaState, MentalistaCommand, MentalistaTiming> = {
  game: 'mentalista',
  version: 1,
  commandSchema: mentalistaCommandSchema,

  parseContent(raw) {
    const parsed = mentalistaContentSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  // The room host may tune the phase clocks (strictly validated, bounded); anything else is not this game's options.
  parseOptions(raw) {
    return resolveTiming(raw);
  },

  /**
   * One public category per potential round (up to MAX_ROUNDS), on the difficulty curve, each a distinct pool item.
   * Dealt before the gate admits anyone, so any admitted roster of `seats` has its own category for every round. The
   * host's resolved timing is baked in and re-validated by parseContent.
   */
  async deal(pick, options, seats) {
    const items = await pick(MENTALISTA_PACK_WANTED);
    const byDifficulty = new Map<string, Array<{ itemId: string; category: MentalistaCategory }>>();
    for (const item of items) {
      const parsed = mentalistaCategorySchema.safeParse(item.payload);
      if (parsed.success && parsed.data.difficulty === item.difficulty) {
        byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), { itemId: item.item_id, category: parsed.data }]);
      }
    }
    const chosen: Array<{ itemId: string; category: MentalistaCategory }> = [];
    const used = new Set<string>();
    const take = (next: { itemId: string; category: MentalistaCategory } | undefined) => {
      if (next && !used.has(next.category.id)) { chosen.push(next); used.add(next.category.id); }
    };
    for (const d of DEAL_ORDER) {
      if (chosen.length >= seats) break;
      take((byDifficulty.get(d) ?? []).shift());
    }
    // Short on the curve: fill from whatever difficulty still has a distinct category rather than refuse to start.
    for (const list of byDifficulty.values()) {
      for (const candidate of list) {
        if (chosen.length >= seats) break;
        take(candidate);
      }
    }
    if (chosen.length < seats) return null;
    const content: MentalistaContent = { timing: options, categories: chosen.map((c) => c.category) };
    return { itemIds: chosen.map((c) => c.itemId), content };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, content, nowMs) => afterOutage(state, content, nowMs),
  seatsChanged: (state, changes) => seatsChanged(state, changes),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
};
