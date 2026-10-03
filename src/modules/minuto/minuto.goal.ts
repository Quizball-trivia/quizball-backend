import { z } from 'zod';

/**
 * One goal of "¿En qué minuto?": the match card players see, and the minute they guess. Shared by the daily
 * days, the private duel pool and the duel engine, so every side validates and projects a goal the same way.
 * The minute (and the source trail) never leave the server before the guess that settles the goal is stored.
 */

export const MINUTO_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type MinutoLocale = (typeof MINUTO_LOCALES)[number];

export const MINUTO_COMPETITIONS = ['FIWC', 'EURO', 'COPA', 'CL', 'EL', 'CLI', 'KLUB', 'USC'] as const;
export const MINUTO_STAGES = ['final', 'third', 'semi', 'quarter', 'r16', 'r32', 'group', 'playoff', 'other'] as const;
export const MINUTO_TIERS = ['easy', 'medium', 'hard'] as const;
export type MinutoTier = (typeof MINUTO_TIERS)[number];

/** Guesses are whole minutes; added time is typed as base + added (45+2 → 47, 90+3 → 93). */
export const MIN_MINUTE = 1;
export const MAX_MINUTE = 130;

const text = z.string().trim().min(1).max(80);
const localized = z.object({ es: text, en: text, ka: text, tr: text });
export type LocalizedName = z.infer<typeof localized>;

/** Paths in our own public bucket, one rule per field: never a URL, never markup, never a descriptive photo name. */
const playerPhoto = z.string().max(120).regex(/^football-grid\/v1\/players\/[a-f0-9-]{36}\.webp$/);
const clubCrest = z.string().max(120).regex(/^club-logos\/[a-z0-9-]+\.(?:webp|png|svg)$/);
/** Goal photos are named by a hash: a path can never carry the minute. */
const goalPhoto = z.string().max(120).regex(/^minuto\/photos\/[a-f0-9]{16,40}\.webp$/);
/** Free licences only (plan §3: no agency photos). */
export const MINUTO_LICENSES = ['CC0', 'Public domain', 'CC BY 2.0', 'CC BY 3.0', 'CC BY 4.0', 'CC BY-SA 2.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'QuizBall'] as const;

const team = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nation'), flag: z.string().regex(/^[a-z]{2}(?:-[a-z]{3})?$/), name: localized }).strict(),
  z.object({ kind: z.literal('club'), crest: clubCrest.nullable(), name: localized }).strict(),
]);
export type MinutoTeam = z.infer<typeof team>;

const score = z.tuple([z.number().int().min(0).max(20), z.number().int().min(0).max(20)]);

export const goalSchema = z.object({
  /** Opaque (date + hash of public facts): ids reach clients before the guess, so they never encode the minute. */
  id: z.string().regex(/^g\d{8}-[a-f0-9]{10}$/),
  /** Canonical identity (match, scorer, minute): days and the duel pool never share one. */
  fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  tier: z.enum(MINUTO_TIERS),
  comp: z.enum(MINUTO_COMPETITIONS),
  /** Edition: the tournament year, or the year a club season ends. */
  year: z.number().int().min(1930).max(2100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stage: z.enum(MINUTO_STAGES),
  group: z.string().regex(/^[A-L]$/).nullable(),
  leg: z.union([z.literal(1), z.literal(2)]).nullable(),
  home: team,
  away: team,
  /** Final score after extra time; a shootout is separate. */
  score,
  aet: z.boolean(),
  pens: score.nullable(),
  side: z.enum(['home', 'away']),
  scorer: z.object({ name: localized, photo: playerPhoto.nullable() }).strict(),
  penalty: z.boolean(),
  /** The score right after this goal (home, away): tells which goal of the match it is. */
  scoreAfter: score,
  image: z.object({ src: goalPhoto, credit: z.string().trim().min(1).max(200), license: z.enum(MINUTO_LICENSES) }).strict().nullable(),
  minute: z.object({ base: z.number().int().min(1).max(120), added: z.number().int().min(0).max(30) }).strict(),
}).strict().refine((g) => g.minute.base + g.minute.added <= MAX_MINUTE, 'minute out of range')
  .refine((g) => g.minute.added === 0 || [45, 90, 105, 120].includes(g.minute.base), 'added time only after 45, 90, 105 or 120')
  .refine((g) => g.scoreAfter[0] <= g.score[0] && g.scoreAfter[1] <= g.score[1], 'scoreAfter beyond the final score')
  .refine((g) => (g.side === 'home' ? g.scoreAfter[0] : g.scoreAfter[1]) >= 1, 'scoreAfter must count the goal');

export type MinutoGoal = z.infer<typeof goalSchema>;

/**
 * Public text that contains the goal's minute as a number of its own ("73", "73'", "73:00", "minute: 73", "90+3") would
 * answer it before the guess: refused at seed time. A number inside a longer one (a year, "Schalke 04" for minute 4) is
 * not the minute. Returns the offending field paths.
 */
export function minuteLeaks(goal: MinutoGoal): string[] {
  const value = goal.minute.base + goal.minute.added;
  const standalone = new RegExp(`(^|[^0-9])${value}([^0-9]|$)`);
  const added = goal.minute.added > 0 ? new RegExp(`(^|[^0-9])${goal.minute.base}\\s*\\+\\s*${goal.minute.added}([^0-9]|$)`) : null;
  const texts: Array<[string, string]> = [
    ...(['es', 'en', 'ka', 'tr'] as const).flatMap((l): Array<[string, string]> => [[`home.name.${l}`, goal.home.name[l]], [`away.name.${l}`, goal.away.name[l]], [`scorer.name.${l}`, goal.scorer.name[l]]]),
    ...(goal.image ? [['image.credit', goal.image.credit] as [string, string]] : []),
    // Crest names come from club slugs; player and goal photo names are opaque (uuid / hash) and skip this check.
    ...(['home', 'away'] as const).flatMap((side): Array<[string, string]> => {
      const t = goal[side];
      return t.kind === 'club' && t.crest ? [[`${side}.crest`, t.crest]] : [];
    }),
  ];
  return texts.filter(([, text]) => standalone.test(text) || (added?.test(text) ?? false)).map(([path]) => path);
}

/** The minute as a number to type and compare: base + added. */
export const minuteValue = (minute: MinutoGoal['minute']): number => minute.base + minute.added;

/** What a player sees before guessing: everything but the minute, the identity and the source trail. */
export interface PublicGoal {
  id: string;
  tier: MinutoTier;
  comp: MinutoGoal['comp'];
  year: number;
  date: string;
  stage: MinutoGoal['stage'];
  group: string | null;
  leg: 1 | 2 | null;
  home: MinutoTeam;
  away: MinutoTeam;
  score: [number, number];
  aet: boolean;
  pens: [number, number] | null;
  side: 'home' | 'away';
  scorer: { name: LocalizedName; photo: string | null };
  penalty: boolean;
  scoreAfter: [number, number];
  image: { src: string; credit: string; license: string } | null;
}

const copyName = (n: LocalizedName): LocalizedName => ({ es: n.es, en: n.en, ka: n.ka, tr: n.tr });
const copyTeam = (t: MinutoTeam): MinutoTeam =>
  (t.kind === 'nation' ? { kind: 'nation', flag: t.flag, name: copyName(t.name) } : { kind: 'club', crest: t.crest, name: copyName(t.name) });

/** Built field by field, so a stray stored field (or the minute) can never reach a response. */
export function publicGoal(g: MinutoGoal): PublicGoal {
  return {
    id: g.id, tier: g.tier, comp: g.comp, year: g.year, date: g.date, stage: g.stage, group: g.group, leg: g.leg,
    home: copyTeam(g.home), away: copyTeam(g.away), score: [g.score[0], g.score[1]], aet: g.aet,
    pens: g.pens ? [g.pens[0], g.pens[1]] : null, side: g.side,
    scorer: { name: copyName(g.scorer.name), photo: g.scorer.photo }, penalty: g.penalty,
    scoreAfter: [g.scoreAfter[0], g.scoreAfter[1]],
    image: g.image ? { src: g.image.src, credit: g.image.credit, license: g.image.license } : null,
  };
}

/** Solo points: exact 3, within 2 minutes 2, within 5 minutes 1, else 0. */
export function soloPoints(diff: number): number {
  if (diff === 0) return 3;
  if (diff <= 2) return 2;
  if (diff <= 5) return 1;
  return 0;
}

/**
 * Duel points for one goal (the video's rules): an exact minute scores 3; otherwise the closer guess scores 1, and
 * equally close guesses score 1 each. An exact guess replaces the closest point: the other seat then scores 0.
 * A seat that did not answer scores 0 and cannot tie.
 */
export function duelPoints(guesses: readonly [number | null, number | null], answer: number): [number, number] {
  const diff = guesses.map((g) => (g === null ? null : Math.abs(g - answer))) as [number | null, number | null];
  if (diff[0] === 0 || diff[1] === 0) return [diff[0] === 0 ? 3 : 0, diff[1] === 0 ? 3 : 0];
  if (diff[0] !== null && diff[1] !== null) {
    if (diff[0] < diff[1]) return [1, 0];
    if (diff[1] < diff[0]) return [0, 1];
    return [1, 1];
  }
  if (diff[0] !== null) return [1, 0];
  if (diff[1] !== null) return [0, 1];
  return [0, 0];
}
