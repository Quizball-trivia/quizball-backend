import { addDays, LAUNCH_DAY, PUBLISHED_DAYS } from './buscaminas.days.js';
import { disabled } from './buscaminas.errors.js';
import { openContent, type SealedContent } from './buscaminas.sealed.js';
import type { BuscaminasDayContent, PublicBoard } from './buscaminas.types.js';

export interface IndexedRound {
  id: string;
  cardIds: ReadonlySet<string>;
  okIds: ReadonlySet<string>;
  ok: string[];
  mines: string[];
}

export interface IndexedDay {
  day: string;
  contentVersion: number;
  rounds: IndexedRound[];
  /** Built field by field, so an `ok` flag can never reach a response through it. */
  board: PublicBoard;
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

export function publicBoard(d: BuscaminasDayContent): PublicBoard {
  return {
    day: d.day,
    number: d.number,
    contentVersion: d.contentVersion,
    rounds: d.rounds.map((r) => ({
      id: r.id,
      difficulty: r.difficulty,
      prompt: { es: r.prompt.es, en: r.prompt.en, ka: r.prompt.ka, tr: r.prompt.tr },
      cards: r.cards.map((c) => ({ id: c.id, name: c.name, img: c.img })),
    })),
  };
}

export function indexContent(days: readonly BuscaminasDayContent[]): ContentIndex {
  const index = new Map<string, IndexedDay>();
  for (const d of days) {
    index.set(d.day, {
      day: d.day,
      contentVersion: d.contentVersion,
      rounds: d.rounds.map((r) => {
        const ok = r.cards.filter((c) => c.ok).map((c) => c.id);
        return { id: r.id, cardIds: new Set(r.cards.map((c) => c.id)), okIds: new Set(ok), ok, mines: r.cards.filter((c) => !c.ok).map((c) => c.id) };
      }),
      board: publicBoard(d),
    });
  }
  return index;
}

/** The whole published calendar or nothing: a short artifact would silently empty every later day. */
export function assertCalendar(days: readonly BuscaminasDayContent[]): void {
  if (days.length !== PUBLISHED_DAYS) throw new Error(`expected ${PUBLISHED_DAYS} days from ${LAUNCH_DAY}, found ${days.length}`);
  days.forEach((d, i) => {
    const expected = addDays(LAUNCH_DAY, i);
    if (d.day !== expected) throw new Error(`days must be contiguous from ${LAUNCH_DAY}: position ${i + 1} is ${d.day}, expected ${expected}`);
    if (d.number !== i + 1) throw new Error(`${d.day}: number must be ${i + 1}, found ${d.number}`);
  });
}

export interface ContentLoaderDeps {
  sealed: () => Promise<SealedContent>;
  key: () => string | undefined;
}

export type ContentCheck = { ok: true; days: number } | { ok: false; reason: string };

export interface ContentLoader {
  /** The indexed answers; 503 while they cannot be decrypted or validated. */
  load(): Promise<ContentIndex>;
  /** Same single attempt as `load`, reporting why it failed (never key material). */
  check(): Promise<ContentCheck>;
}

/** Decrypts once (eagerly via the boot readiness check, else on first use); without a working key the module answers 503 instead of failing boot. */
export function createContentLoader(deps: ContentLoaderDeps): ContentLoader {
  let attempt: Promise<{ index: ContentIndex } | { reason: string }> | null = null;
  const settle = () => {
    attempt ??= (async () => {
      const key = deps.key();
      if (!key) throw new Error('BUSCAMINAS_CONTENT_KEY is not set');
      const days = openContent(await deps.sealed(), key);
      assertCalendar(days);
      return { index: indexContent(days) };
    })().catch((error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }));
    return attempt;
  };
  return {
    async load() {
      const result = await settle();
      if ('reason' in result) throw disabled();
      return result.index;
    },
    async check() {
      const result = await settle();
      return 'reason' in result ? { ok: false, reason: result.reason } : { ok: true, days: result.index.size };
    },
  };
}
