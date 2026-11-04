import { randomInt } from 'node:crypto';
import type { RoomEngine } from '../../room.engine.js';
import { questionPayloadSchema } from '../../../questions/questions.schemas.js';
import {
  afterOutage, applyCommand, seatsChanged, standings, startMatch, tick, viewOf, zoneMatchCommandSchema, zoneMatchPackSchema, zoneNumericItemSchema,
  type ZoneMatchCommand, type ZoneMatchContent, type ZoneMatchState, type ZoneMcq,
} from './zone-match.engine.js';

/** Categories dealt into a match (each side gets five; the rest stand in when a category runs dry). */
const CATEGORIES = 12;
/** Usable questions a dealt category must bring: a round uses up to ~4 (duels, a Substitution), the shootout any. */
const PER_CATEGORY = 10;
/** Questions sampled per category before the unusable ones (image, malformed) are dropped. */
const SAMPLE_PER_CATEGORY = 24;
/**
 * Number questions per difficulty. A match can go to the number question on every duel (both right): enough for a
 * long regulation match without repeats (the engine reuses only once they run out).
 */
export const ZONE_NUMERICS_WANTED = { easy: 10, medium: 12, hard: 8 };
/** A category needs at least this many ranked questions to be considered. */
const MIN_QUESTIONS = 20;

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
   * Twelve random ranked categories with their questions (every language, answers included: the pack is private to
   * the server) and the number questions from the private pool. Null when there aren't enough to fill a match.
   */
  async deal(pick) {
    // Loaded here: these repos build SQL fragments at import, and the registry is imported before any database is.
    const [{ lobbiesRepo }, { matchQuestionsRepo }] = await Promise.all([
      import('../../../lobbies/lobbies.repo.js'),
      import('../../../matches/match-questions.repo.js'),
    ]);
    const candidates = shuffled(await lobbiesRepo.listAllValidCategories(MIN_QUESTIONS, 'mcq'));
    const mcqs: ZoneMcq[] = [];
    const dealt: typeof candidates = [];
    for (const category of candidates) {
      if (dealt.length === CATEGORIES) break;
      const usable: ZoneMcq[] = [];
      for (const row of await matchQuestionsRepo.getRandomQuestionsForCategory(category.id, SAMPLE_PER_CATEGORY)) {
        const parsed = questionPayloadSchema.safeParse(row.payload);
        if (!parsed.success || parsed.data.type !== 'mcq_single' || parsed.data.options.length !== 4 || parsed.data.image) continue;
        const correctIndex = parsed.data.options.findIndex((o) => o.is_correct);
        if (correctIndex < 0 || typeof row.prompt?.en !== 'string') continue;
        usable.push({ id: row.id, categoryId: category.id, prompt: row.prompt, options: parsed.data.options.map((o) => o.text as Record<string, string>), correctIndex });
        if (usable.length === PER_CATEGORY) break;
      }
      // A category short of plain questions isn't dealt (the next one stands in).
      if (usable.length < PER_CATEGORY) continue;
      dealt.push(category);
      mcqs.push(...usable);
    }
    if (dealt.length < CATEGORIES) return null;
    const categories = dealt;
    // Each number question checked on its own: a bad one is left out, not the whole deal.
    const numerics = (await pick(ZONE_NUMERICS_WANTED)).flatMap((item) => {
      const raw = item.payload as Record<string, unknown> | null;
      const parsed = zoneNumericItemSchema.safeParse({ ...(raw ?? {}), id: item.item_id });
      if (!parsed.success) return [];
      return [{ ...parsed.data, step: parsed.data.step ?? 10 ** -parsed.data.precision }];
    });
    if (numerics.length < 10) return null;
    const content = {
      seed: randomInt(0, 0x100000000),
      categories: categories.map((c) => ({ id: c.id, name: c.name, imageUrl: c.image_url, icon: c.icon })),
      mcqs,
      fallback: shuffled(mcqs.map((q) => q.id)).slice(0, 24),
      numerics,
      rules: { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' as const },
    };
    const parsed = zoneMatchPackSchema.safeParse(content);
    if (!parsed.success) return null;
    return { itemIds: numerics.map((n) => n.id), content: parsed.data };
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
