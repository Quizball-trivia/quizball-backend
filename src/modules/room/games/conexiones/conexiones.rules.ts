import { z } from 'zod';

/**
 * Conexiones futboleras, pure and shared by the daily and the 1v1: a board is 16 footballers in 4 hidden groups of 4,
 * each group with a link ("played for Napoli") and a tier 1–4. Pick four: right locks the group in; "one away" means
 * three of the four share a group. A board has exactly one way to split it (the content validator proves it).
 */

export const CX_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type CxDifficulty = (typeof CX_DIFFICULTIES)[number];
export const CX_LOCALES = ['en', 'es', 'ka', 'tr', 'ru', 'pt', 'de'] as const;
export type CxLocale = (typeof CX_LOCALES)[number];
export type CxTier = 1 | 2 | 3 | 4;

export const CX_TILES = 16;
export const CX_GROUPS = 4;
export const CX_GROUP_SIZE = 4;
export const CX_DECOYS = 3;

/** Both seeders (days and room pool) take this lock, so the daily / room overlap check cannot be raced. */
export const CONEXIONES_CONTENT_LOCK = 'conexiones_content';

/** Limits validate.py mirrors (per locale). */
export const CX_LIMITS = { id: 64, name: 28, link: 64, note: 120 } as const;

const text = (max: number) => z.string().trim().min(1).max(max);
/** pt and de are optional until every board carries them; `textIn` falls back to English. */
const localized = (max: number) => z.object({ en: text(max), es: text(max), ka: text(max), tr: text(max), ru: text(max), pt: text(max).optional(), de: text(max).optional() }).strict();
export type CxLocalized = z.infer<ReturnType<typeof localized>>;
/** A footballer's name: Latin-script languages read the English spelling; Georgian and Russian have their own. */
const playerName = z.object({ en: text(CX_LIMITS.name), ka: text(CX_LIMITS.name), ru: text(CX_LIMITS.name) }).strict();
export type CxName = z.infer<typeof playerName>;

const assetUrl = z.string().max(400).regex(/^(https:\/\/|\/assets\/)/, 'Expected an https URL or a /assets/ path');
/** Opaque: the seed export shuffles the tiles and keys them by a hash, so neither a tile's place nor its id says its group. */
const tileId = z.string().regex(/^[a-z0-9]{8}$/);

export const cxTileSchema = z.object({ id: tileId, player: text(CX_LIMITS.id), name: playerName, portrait: assetUrl.nullable() }).strict();
export type CxTile = z.infer<typeof cxTileSchema>;

export const cxGroupSchema = z.object({
  id: text(CX_LIMITS.id).regex(/^[a-z0-9-]+$/),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** The predicate family and key (`club:napoli`, `curated:brothers`): the overlap ledger compares these. */
  key: text(CX_LIMITS.id).regex(/^[a-z]+:[a-z0-9:+._-]+$/),
  link: localized(CX_LIMITS.link),
  note: localized(CX_LIMITS.note).optional(),
  decoys: z.array(localized(CX_LIMITS.link)).length(CX_DECOYS),
  members: z.array(tileId).length(CX_GROUP_SIZE),
}).strict();
export type CxGroup = z.infer<typeof cxGroupSchema>;

const fold = (s: string, locale: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase(locale).replace(/\s+/g, ' ').trim();

export const cxBoardSchema = z.object({
  id: text(CX_LIMITS.id).regex(/^[a-z0-9-]+$/),
  difficulty: z.enum(CX_DIFFICULTIES),
  tiles: z.array(cxTileSchema).length(CX_TILES),
  groups: z.array(cxGroupSchema).length(CX_GROUPS),
}).strict().superRefine((b, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = b.tiles.map((t) => t.id);
  if (new Set(ids).size !== CX_TILES) issue('A tile id appears twice');
  if (new Set(b.tiles.map((t) => t.player)).size !== CX_TILES) issue('A footballer appears twice');
  for (const locale of ['en', 'ka', 'ru'] as const) {
    if (new Set(b.tiles.map((t) => fold(t.name[locale], locale))).size !== CX_TILES) issue(`Two tiles read the same in ${locale}`);
  }
  const members = b.groups.flatMap((g) => g.members);
  if (new Set(members).size !== CX_TILES || members.some((id) => !ids.includes(id))) issue('Every tile must be in exactly one group');
  if (new Set(b.groups.map((g) => g.tier)).size !== CX_GROUPS) issue('The four groups need the four tiers');
  if (new Set(b.groups.map((g) => g.id)).size !== CX_GROUPS) issue('A group id appears twice');
  for (const g of b.groups) {
    for (const locale of CX_LOCALES) {
      // An option still without its pt or de text is shown in English, so that is the text it must not repeat.
      const read = (o: CxLocalized) => fold(o[locale] ?? o.en, locale);
      const options = [g.link, ...g.decoys].map(read);
      if (new Set(options).size !== options.length) issue(`Two naming options of ${g.id} read the same in ${locale}`);
      // The other links are on screen when the last group is named: a decoy reading like one of them gives the answer away.
      const others = new Set(b.groups.filter((x) => x.id !== g.id).map((x) => read(x.link)));
      if (g.decoys.some((d) => others.has(read(d)))) issue(`A decoy of ${g.id} is another group's link in ${locale}`);
    }
  }
});
export type CxBoard = z.infer<typeof cxBoardSchema>;

export const textIn = (value: CxLocalized, locale: string): string => value[(CX_LOCALES as readonly string[]).includes(locale) ? (locale as CxLocale) : 'en'] ?? value.en;
export const nameIn = (name: CxName, locale: string): string => (locale === 'ka' ? name.ka : locale === 'ru' ? name.ru : name.en);

/** A four as a set: the same four in any order is the same try. */
export const tryKey = (ids: readonly string[]): string => [...ids].sort().join('|');

export type CxVerdict = 'right' | 'oneAway' | 'wrong';

/** Four distinct tiles of this board, all still in play; anything else is refused before it is judged. */
export function validFour(ids: readonly string[], inPlay: readonly string[]): boolean {
  return ids.length === CX_GROUP_SIZE && new Set(ids).size === CX_GROUP_SIZE && ids.every((id) => inPlay.includes(id));
}

export function judge(board: CxBoard, ids: readonly string[]): { verdict: CxVerdict; group: CxGroup | null } {
  let best = 0;
  for (const g of board.groups) {
    const hits = ids.filter((id) => g.members.includes(id)).length;
    if (hits === CX_GROUP_SIZE) return { verdict: 'right', group: g };
    best = Math.max(best, hits);
  }
  return { verdict: best === CX_GROUP_SIZE - 1 ? 'oneAway' : 'wrong', group: null };
}

export const tierOf = (board: CxBoard, tile: string): CxTier => board.groups.find((g) => g.members.includes(tile))!.tier;
/** The tiles still on the board, in the order given. */
export const remaining = (order: readonly string[], board: CxBoard, solved: readonly string[]): string[] => {
  const gone = new Set(board.groups.filter((g) => solved.includes(g.id)).flatMap((g) => g.members));
  return order.filter((id) => !gone.has(id));
};

export interface CxPublicTile { id: string; name: string; portrait: string | null }
/** A group once it is out (solved, named or revealed): what it was and who it went to. */
export interface CxPublicGroup { id: string; tier: CxTier; link: string; note: string | null; members: string[] }

export const publicTile = (t: CxTile, locale: string): CxPublicTile => ({ id: t.id, name: nameIn(t.name, locale), portrait: t.portrait });
export const publicGroup = (g: CxGroup, locale: string): CxPublicGroup => ({ id: g.id, tier: g.tier, link: textIn(g.link, locale), note: g.note ? textIn(g.note, locale) : null, members: [...g.members] });

/**
 * Whether the tiles split into the groups in one way only, given which tile may belong to which group (`fits[tile]`
 * = the group ids it could be in: true or unknown in the content checker's matrix). Returns how many splits exist,
 * stopping at 2. The validator mirrors this; the seeders refuse a board for which it is not 1.
 */
export function countPartitions(tiles: readonly string[], groups: readonly string[], fits: Readonly<Record<string, readonly string[]>>, size = CX_GROUP_SIZE): number {
  const left = new Map(groups.map((g) => [g, size]));
  let found = 0;
  const walk = (i: number): void => {
    if (found >= 2) return;
    if (i === tiles.length) { found += 1; return; }
    for (const g of fits[tiles[i]] ?? []) {
      const room = left.get(g);
      if (!room) continue;
      left.set(g, room - 1);
      walk(i + 1);
      left.set(g, room);
    }
  };
  walk(0);
  return found;
}
