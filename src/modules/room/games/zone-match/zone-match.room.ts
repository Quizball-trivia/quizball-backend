import { randomInt } from 'node:crypto';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, seatsChanged, standings, startMatch, tick, viewOf, zoneMatchCommandSchema, zoneMatchPackSchema, zoneMcqPoolItemSchema, zoneNumericItemSchema,
  type ZoneMatchCommand, type ZoneMatchContent, type ZoneMatchState, type ZoneMcq,
} from './zone-match.engine.js';

/** Categories dealt into a match (each side gets five; the rest stand in when a category runs dry). */
const CATEGORIES = 12;
/** Usable questions a dealt category must bring: a round uses up to ~4 (duels, a Substitution), the shootout any. */
const PER_CATEGORY = 10;
/**
 * Number questions per difficulty. A match can go to the number question on every duel (both right): enough for a
 * long regulation match without repeats (the engine draws lots once they run out, so a reveal never comes back).
 */
export const ZONE_NUMERICS_WANTED = { easy: 10, medium: 12, hard: 8 };
/** MCQs asked of the private pool per difficulty: generous room to fill CATEGORIES × PER_CATEGORY after grouping. */
export const ZONE_MCQS_WANTED = { easy: 150, medium: 150, hard: 150 };

const shuffled = <T>(xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const zoneMatchRoomEngine: RoomEngine<ZoneMatchContent, ZoneMatchState, ZoneMatchCommand, null> = {
  game: 'zone_match',
  version: 1,
  commandSchema: zoneMatchCommandSchema,

  parseContent(raw) {
    const parsed = zoneMatchPackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  parseOptions(raw) {
    return raw === null || raw === undefined ? null : undefined;
  },

  /**
   * Twelve random categories with ten questions each and the number questions, all from the private pool
   * (room_pool, game zone_match: tag mcq / tag numeric). Ranked content never touches the public questions tables —
   * those can be enumerated through the questions API, answers included. Null when the pool can't fill a match.
   */
  async deal(pick) {
    // Each item checked on its own: a bad one is left out, not the whole deal.
    const byCategory = new Map<string, { category: ZoneMatchContent['categories'][number]; mcqs: ZoneMcq[] }>();
    for (const item of await pick(ZONE_MCQS_WANTED, 'mcq')) {
      const raw = item.payload as Record<string, unknown> | null;
      const parsed = zoneMcqPoolItemSchema.safeParse({ ...(raw ?? {}), id: item.item_id });
      if (!parsed.success) continue;
      const { category, ...q } = parsed.data;
      const bucket = byCategory.get(category.id) ?? { category, mcqs: [] };
      bucket.mcqs.push({ id: q.id, categoryId: category.id, prompt: q.prompt, options: q.options, correctIndex: q.correctIndex });
      byCategory.set(category.id, bucket);
    }
    const full = shuffled([...byCategory.values()].filter((b) => b.mcqs.length >= PER_CATEGORY)).slice(0, CATEGORIES);
    if (full.length < CATEGORIES) return null;
    const categories = full.map((b) => b.category);
    const mcqs = full.flatMap((b) => shuffled(b.mcqs).slice(0, PER_CATEGORY));
    const numerics = (await pick(ZONE_NUMERICS_WANTED, 'numeric')).flatMap((item) => {
      const raw = item.payload as Record<string, unknown> | null;
      const parsed = zoneNumericItemSchema.safeParse({ ...(raw ?? {}), id: item.item_id });
      if (!parsed.success) return [];
      return [{ ...parsed.data, step: parsed.data.step ?? 10 ** -parsed.data.precision }];
    });
    if (numerics.length < 10) return null;
    const content = {
      seed: randomInt(0, 0x100000000),
      categories,
      mcqs,
      fallback: shuffled(mcqs.map((q) => q.id)).slice(0, 24),
      numerics,
      rules: { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' as const },
    };
    const parsed = zoneMatchPackSchema.safeParse(content);
    if (!parsed.success) return null;
    return { itemIds: [...mcqs.map((q) => q.id), ...numerics.map((n) => n.id)], content: parsed.data };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes) => seatsChanged(state, changes),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
};
