import { z } from 'zod';

/**
 * Football Horserace, the rules shared by the room game and the daily: every player owns a racer (a nation), picks a
 * stat, and the racer that really leads that stat moves one space, whoever picked it. Pure: no I/O, no clock, random
 * draws only from a seed.
 *
 * Data comes from a frozen release of one tournament: its nations, its eras (scopes), the stat wording, and every
 * stored value. A release never changes once published; a correction is a new release, so a running match or a day
 * already played keeps the numbers it started with.
 */
const label = z.string().min(1).max(120);
/** Every label a player reads: four languages, always. */
const labelsSchema = z.object({ en: label, es: label, ka: label, tr: label }).strict();
/** A detail line ("7–3 vs Paraguay · 1958"): Georgian and Turkish fall back to English when absent. */
export const l10nSchema = z.object({ en: label, es: label, ka: label.optional(), tr: label.optional() }).strict();
/** The source and attribution line (a CC BY-SA credit needs the author, the copyright notice and the licence). */
const credit = z.string().min(1).max(400);
const creditSchema = z.object({ en: credit, es: credit, ka: credit, tr: credit }).strict();
export type L10n = z.infer<typeof l10nSchema>;
export type RaceLocale = 'en' | 'es' | 'ka' | 'tr';
export const l10n = (text: L10n, locale: RaceLocale): string => text[locale] ?? text.en;

export const raceNationSchema = z.object({
  id: z.string().min(1).max(60),
  code: z.string().min(2).max(8),
  flag: z.string().min(2).max(10),
  name: labelsSchema,
  /** 0 = most matches in this tournament. */
  tier: z.number().int().min(0).max(400),
}).strict();
export type RaceNation = z.infer<typeof raceNationSchema>;

export const raceMetricSchema = z.object({
  id: z.string().min(1).max(60),
  family: z.string().min(1).max(30),
  dir: z.enum(['high', 'low']),
  unwanted: z.boolean(),
  decimals: z.number().int().min(0).max(3),
  kind: z.enum(['count', 'rate', 'percent', 'year']),
  label: labelsSchema,
  keywords: z.string().max(400),
}).strict();
export type RaceMetric = z.infer<typeof raceMetricSchema>;

export const raceStatSchema = z.object({
  id: z.string().min(1).max(100),
  scope: z.string().min(1).max(40),
  metric: z.string().min(1).max(60),
  values: z.record(z.number().finite()).refine((v) => Object.keys(v).length <= 400, 'too many values'),
  /** The match, years or player behind a racer's number ("7–3 vs Paraguay · 1958"). */
  details: z.record(l10nSchema).refine((v) => Object.keys(v).length <= 400, 'too many details').optional(),
  source: z.string().max(20).optional(),
}).strict();
export type RaceStat = z.infer<typeof raceStatSchema>;

/** One tournament of one release: everything a race in it needs. */
const unique = <T,>(items: readonly T[], key: (x: T) => string) => new Set(items.map(key)).size === items.length;

export const raceTournamentDataSchema = z.object({
  release: z.string().regex(/^[0-9a-z][0-9a-z.-]{2,59}$/),
  cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: creditSchema,
  tournament: z.object({ id: z.string().regex(/^[A-Z0-9]{2,20}$/), label: labelsSchema }).strict(),
  nations: z.array(raceNationSchema).min(2).max(400),
  scopes: z.array(z.object({ id: z.string().min(1).max(40), label: labelsSchema }).strict()).min(1).max(12),
  families: z.array(z.object({ id: z.string().min(1).max(30), label: labelsSchema }).strict()).min(1).max(12),
  metrics: z.array(raceMetricSchema).min(1).max(150),
  stats: z.array(raceStatSchema).min(1).max(600),
}).strict().superRefine((d, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  // Duplicates would let the command check and the reveal read different entries.
  if (!unique(d.nations, (n) => n.id)) issue('duplicate nation id');
  if (!unique(d.nations, (n) => n.code)) issue('duplicate nation code');
  if (!unique(d.scopes, (x) => x.id)) issue('duplicate era id');
  if (!unique(d.families, (f) => f.id)) issue('duplicate family id');
  if (!unique(d.metrics, (m) => m.id)) issue('duplicate metric id');
  if (!unique(d.stats, (x) => x.id)) issue('duplicate stat id');
  const scopes = new Set(d.scopes.map((x) => x.id));
  const families = new Set(d.families.map((f) => f.id));
  const metrics = new Set(d.metrics.map((m) => m.id));
  const nations = new Set(d.nations.map((n) => n.id));
  for (const m of d.metrics) if (!families.has(m.family)) issue(`metric ${m.id}: unknown family ${m.family}`);
  for (const x of d.stats) {
    if (!scopes.has(x.scope)) issue(`stat ${x.id}: unknown era ${x.scope}`);
    if (!metrics.has(x.metric)) issue(`stat ${x.id}: unknown metric ${x.metric}`);
    for (const n of Object.keys(x.values)) if (!nations.has(n)) issue(`stat ${x.id}: value for unknown nation ${n}`);
    for (const n of Object.keys(x.details ?? {})) if (!(n in x.values)) issue(`stat ${x.id}: detail without a value for ${n}`);
  }
});
export type RaceTournamentData = z.infer<typeof raceTournamentDataSchema>;

export interface Comparison { values: number[]; leaders: number[]; details: Array<L10n | null> }

/** The number as a screen shows it: one rounding for the comparison guard and for the display. */
export const displayed = (value: number, decimals: number): number => Math.round((value + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;

/**
 * The racers' values on one stat and who leads it among the racers still racing (`active`, all by default). Null when
 * the stat is not playable: a value is missing (unknown is never zero), the racers still racing are all level, or the
 * leader and a chaser would show the same number on screen.
 */
export function compare(stat: RaceStat, metric: RaceMetric, racers: readonly string[], active?: readonly boolean[]): Comparison | null {
  const values: number[] = [];
  for (const r of racers) {
    const v = stat.values[r];
    if (typeof v !== 'number') return null;
    values.push(v);
  }
  const live = racers.map((_, i) => active?.[i] ?? true);
  const score = (v: number) => (metric.dir === 'low' ? -v : v);
  const liveScores = values.flatMap((v, i) => (live[i] ? [score(v)] : []));
  if (liveScores.length < 2) return null;
  const best = Math.max(...liveScores);
  const leaders = values.flatMap((v, i) => (live[i] && score(v) === best ? [i] : []));
  if (leaders.length === liveScores.length) return null;
  const top = displayed(values[leaders[0]], metric.decimals);
  if (values.some((v, i) => live[i] && !leaders.includes(i) && displayed(v, metric.decimals) === top)) return null;
  return { values, leaders, details: racers.map((r) => stat.details?.[r] ?? null) };
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A room holds 1v1 up to this many players: beyond it the weakest nation leads too few stats for a fair race. */
export const MAX_SEATS = 4;
/** Spaces to the goal: about four to five rounds whatever the table. */
export const targetFor = (seats: number): number => (seats <= 3 ? 5 : seats + 2);
/** How often each tournament is drawn when it is left to chance (the big ones most). */
export const TOURNAMENT_WEIGHT: Readonly<Record<string, number>> = { WC: 6, EURO: 3, COPA: 3, AFCON: 2, ALL: 2, WCQ: 1, EUROQ: 1, ASIA: 1, GOLD: 1, NL: 1 };

/** Balance bar a deal must meet: each racer leads at least `minLeads` stats, of `minTypes` kinds, `minWanted` of them
 * not "unwanted" records, and the fewest leads are at least `balance` of the most. */
export const FAIR = { minLeads: 7, minTypes: 4, minWanted: 3, balance: 0.6 } as const;

export interface Deal {
  tournament: string;
  /** Nation ids, one per seat (the draft decides who takes which). */
  racers: string[];
  statIds: string[];
  leads: number[];
  fair: boolean;
}

function sample<T>(items: readonly T[], n: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

function leadsOf(data: RaceTournamentData, racers: string[], statIds: string[]) {
  const metricOf = new Map(data.metrics.map((m) => [m.id, m]));
  const statOf = new Map(data.stats.map((s) => [s.id, s]));
  const per = racers.map(() => ({ count: 0, types: new Set<string>(), wanted: 0 }));
  for (const id of statIds) {
    const stat = statOf.get(id)!;
    const metric = metricOf.get(stat.metric)!;
    const c = compare(stat, metric, racers);
    if (!c || c.leaders.length !== 1) continue;
    const p = per[c.leaders[0]];
    p.count += 1; p.types.add(metric.id); if (!metric.unwanted) p.wanted += 1;
  }
  return per;
}

const evenness = (leads: number[]) => Math.min(...leads) / Math.max(1, ...leads);

/**
 * A balanced group of `seats` nations in one tournament: drawn from a window of similar nations (by matches played),
 * kept only if every racer leads enough stats, of enough kinds, and none leads far more than another. The bar relaxes
 * a little at a time when nothing passes, never as far as a racer that leads nothing. Null when no playable group
 * exists.
 */
export function dealRace(data: RaceTournamentData, seats: number, seed: number): Deal | null {
  const random = rng(seed);
  const metricOf = new Map(data.metrics.map((m) => [m.id, m]));
  const byTier = [...data.nations].sort((a, b) => a.tier - b.tier).map((n) => n.id);
  if (byTier.length < seats) return null;
  const window = Math.min(byTier.length, Math.max(12, seats * 2));
  let best: Deal | null = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const step = Math.floor(attempt / 150);
    const minLeads = Math.max(2, FAIR.minLeads - step * 2);
    const balance = Math.max(0, FAIR.balance - step * 0.15);
    const start = Math.floor(random() * (byTier.length - window + 1));
    const racers = sample(byTier.slice(start, start + window), seats, random);
    const statIds = data.stats.filter((s) => compare(s, metricOf.get(s.metric)!, racers)).map((s) => s.id);
    const per = leadsOf(data, racers, statIds);
    const leads = per.map((p) => p.count);
    const enough = per.every((p) => p.count >= minLeads && p.types.size >= Math.min(FAIR.minTypes, minLeads) && p.wanted >= Math.min(FAIR.minWanted, minLeads));
    const fair = enough && evenness(leads) >= balance;
    const deal: Deal = { tournament: data.tournament.id, racers, statIds, leads, fair: fair && step === 0 };
    if (fair) return deal;
    if (!best || evenness(leads) > evenness(best.leads)) best = deal;
  }
  return best && Math.min(...best.leads) >= 1 ? best : null;
}

/** Tournament ids in a seeded order that favours the big ones (the order a "random tournament" room tries them in). */
export function tournamentOrder(ids: readonly string[], seed: number): string[] {
  const random = rng(seed + 17);
  return ids.map((id) => ({ id, k: random() ** (1 / (TOURNAMENT_WEIGHT[id] ?? 1)) })).sort((a, b) => b.k - a.k).map((x) => x.id);
}
