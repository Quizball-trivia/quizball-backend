import { z } from 'zod';
import type { DealOptions, DraftUniverse } from './draft.engine.js';
import { EUROPE_GREATS, EUROPE_LEAGUE, EUROPE_REST_FINISH, EUROPE_RIVAL_FINISH, ICONIC_GREATS, ICONIC_LEAGUE, ICONIC_REST_FINISH, ICONIC_MIN_SEASONS, ICONIC_SEASONS } from './draft.iconic.js';
import { FORMATIONS, lines, rateSeason, rng, type ClubSeason, type DraftPlayer, type Era, type Honour, type League, type Lines, type Opponent, type Pos, ROLES } from './draft.rules.js';

/** One release of real squads, as stored in draft_packs (seeded from the private store; nothing real is in this repository). */
const playerSchema = z.tuple([
  z.string().min(1).max(80), // name
  z.enum(['GK', 'DEF', 'MID', 'FWD']),
  z.array(z.enum(['GK', 'DEF', 'MID', 'FWD'])).nullable(), // other lines he covers
  z.number().int().min(0).max(80), // apps
  z.number().int().min(0).max(100), // goals
  z.number().int().min(0).max(100).nullable(), // assists: null when no figure exists
  z.number().int().min(0).max(80), // clean sheets
  z.number().min(0).max(1), // share of the minutes
  z.string().min(1).max(80), // the real person
  z.number().int().min(0).max(1), // legend
  z.enum(ROLES).nullable().optional(), // role
  z.number().int().min(0).max(1).optional(), // clean sheets estimated
]);
const clubSchema = z.object({
  league: z.string().min(1).max(20),
  clubId: z.string().min(1).max(60),
  club: z.string().min(1).max(80),
  year: z.number().int().min(1900).max(2100),
  finish: z.number().int().min(1).max(30),
  players: z.array(playerSchema).min(11).max(90),
});
export const draftPackSchema = z.object({
  source: z.string().max(80),
  leagues: z.array(z.object({ id: z.string().min(1).max(20), name: z.string().min(1).max(60), short: z.string().min(1).max(8), teams: z.number().int().min(4).max(30), games: z.number().int().min(6).max(60) })).min(1).max(20),
  clubs: z.array(clubSchema).min(1),
}).superRefine((pack, ctx) => {
  // A league that falls back, a finish below the table or a squad that shadows another would all rate players wrongly.
  const teams = new Map(pack.leagues.map((l) => [l.id, l.teams]));
  if (teams.size !== pack.leagues.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['leagues'], message: 'league ids repeat' });
  const seen = new Set<string>();
  pack.clubs.forEach((c, i) => {
    const size = teams.get(c.league);
    if (size === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clubs', i, 'league'], message: `unknown league ${c.league}` });
    else if (c.finish > size) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clubs', i, 'finish'], message: `finish ${c.finish} in a ${size}-team league` });
    const key = `${c.clubId}-${c.year}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clubs', i], message: `${key} appears twice` });
    seen.add(key);
  });
});
export type DraftPack = z.infer<typeof draftPackSchema>;
type RawClub = DraftPack['clubs'][number];

export const seasonLabel = (year: number): string => `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
const inEra = (year: number, era: Era): boolean => era === 'all' || (era === 'modern' ? year >= 2004 : year < 2004);

export interface ServerUniverse extends DraftUniverse {
  clubSeason(id: string): ClubSeason | null;
  hasEra(leagueId: string, era: Era): boolean;
  /** Two people who shared a dressing room: the latest club-season they played together, or null. */
  together(a: string, b: string): { club: string; season: string } | null;
  /** Strong sides from other leagues (finished in the top four), named with their season: a European knockout's field. */
  europeField(leagueId: string, seed: string): Opponent[];
  /** The season the rivals of this draw come from (null for Iconic Clubs, whose rivals mix seasons). */
  rivalYear(leagueId: string, seed: string, deal?: DealOptions): number | null;
  /** That league season's real top scorer in the pack. */
  topScorer(leagueId: string, year: number): { name: string; club: string; goals: number } | null;
}

/** The best 4-3-3 a squad can field (top keeper, four defenders, three midfielders, three forwards). */
function bestXi(c: ClubSeason): Lines {
  const slots = FORMATIONS['4-3-3'];
  const left = c.players.slice().sort((a, b) => b.rating - a.rating);
  const picks = slots.map((slot) => {
    const i = left.findIndex((p) => p.pos === slot.pos);
    if (i < 0) return null;
    const [p] = left.splice(i, 1);
    return { slotId: slot.id, player: p, club: c.club, season: c.season, offPosition: false };
  });
  return lines(slots, picks);
}

interface Entry { raw: RawClub; id: string; league: string; honour?: Honour }

/** His best seasons other than this one, averaged: the name he had. A single season in the pack is all there is to go on. */
const REPUTATION = { others: 3, weight: 0.6 };
function reputationOf(rating: number, all: readonly number[]): number {
  const others = all.slice();
  others.splice(others.indexOf(rating), 1);
  if (!others.length) return rating;
  const best = others.sort((a, b) => b - a).slice(0, REPUTATION.others);
  return Math.round((REPUTATION.weight * (best.reduce((a, b) => a + b, 0) / best.length) + (1 - REPUTATION.weight) * rating) * 10) / 10;
}

/**
 * The engine's view of a pack. Squads are rated once and kept, so a move rebuilding its deal costs next to nothing.
 * `iconicSeasons`: which club-seasons make up Iconic Clubs (tests pass their own).
 */
export function universeOf(pack: DraftPack, iconicSeasons: ReadonlyArray<readonly [string, Honour]> = ICONIC_SEASONS): ServerUniverse {
  const leagueOf = (id: string): League => (id === ICONIC_LEAGUE.id ? ICONIC_LEAGUE : id === EUROPE_LEAGUE.id ? EUROPE_LEAGUE : pack.leagues.find((l) => l.id === id) ?? pack.leagues[0]);
  const rate = (c: RawClub, p: RawClub['players'][number]) => {
    const [, pos, , apps, goals, assists, cleanSheets, minutesShare, , legend] = p;
    return rateSeason({ pos: pos as Pos, minutesShare, apps, goals, assists, cleanSheets, finish: c.finish, teams: leagueOf(c.league).teams, legend: !!legend }).total;
  };
  // Every season of every person in the pack, so a price can know the name as well as the season.
  const careers = new Map<string, number[]>();
  for (const c of pack.clubs) for (const p of c.players) careers.set(p[8], [...(careers.get(p[8]) ?? []), rate(c, p)]);
  const built = new Map<string, ClubSeason>();
  const toClubSeason = (e: Entry): ClubSeason => {
    const known = built.get(e.id);
    if (known) return known;
    const c = e.raw;
    const players: DraftPlayer[] = c.players.map((p, i) => {
      const [name, pos, alt, apps, goals, assists, cleanSheets, minutesShare, personId, legend, role, estimated] = p;
      const rating = rate(c, p);
      return {
        id: `${e.id}-${i}`, personId, legend: !!legend, name, pos: pos as Pos, alt: (alt as Pos[] | null) ?? undefined, role: role ?? undefined, cleanSheetsEstimated: !!estimated, apps, goals, assists, cleanSheets, minutesShare,
        rating, reputation: reputationOf(rating, careers.get(personId) ?? [rating]),
      };
    });
    const club: ClubSeason = { id: e.id, clubId: c.clubId, club: c.club, season: seasonLabel(c.year), leagueId: e.league, legend: c.year < 2004, finish: c.finish, players, ...(e.honour ? { honour: e.honour } : {}) };
    built.set(e.id, club);
    return club;
  };
  const byLeague = new Map<string, Entry[]>();
  const byId = new Map<string, Entry>();
  const add = (e: Entry) => { byLeague.set(e.league, [...(byLeague.get(e.league) ?? []), e]); byId.set(e.id, e); };
  for (const c of pack.clubs) add({ raw: c, id: `${c.clubId}-${c.year}`, league: c.league });
  // Iconic Clubs: the same squads, rated in their own league, gathered in one more.
  const iconic = iconicSeasons.flatMap(([id, honour]) => { const e = byId.get(id); return e ? [{ raw: e.raw, id: `${ICONIC_LEAGUE.id}~${id}`, league: ICONIC_LEAGUE.id, honour }] : []; });
  const leagues: League[] = iconic.length >= Math.min(ICONIC_MIN_SEASONS, iconicSeasons.length) && iconic.length >= ICONIC_LEAGUE.teams ? [...pack.leagues, ICONIC_LEAGUE] : pack.leagues;
  if (leagues.includes(ICONIC_LEAGUE)) for (const e of iconic) add(e);
  // Europe: with more than one league in the pack, all of their club-seasons in one more league.
  const europe = pack.leagues.length > 1 ? pack.clubs.map((c) => ({ raw: c, id: `${EUROPE_LEAGUE.id}~${c.clubId}-${c.year}`, league: EUROPE_LEAGUE.id })) : [];
  if (europe.length) { leagues.push(EUROPE_LEAGUE); for (const e of europe) add(e); }
  const mixed = (leagueId: string) => leagueId === ICONIC_LEAGUE.id || leagueId === EUROPE_LEAGUE.id;
  const entriesOf = (leagueId: string): Entry[] => byLeague.get(leagueId) ?? [];
  const rivalOf = (e: Entry, id: string, name: string): Opponent => { const l = bestXi(toClubSeason(e)); return { id, name, strength: l.overall, gk: l.gk, def: l.def, mid: l.mid, att: l.att }; };
  const rivals = new Map<string, Opponent[]>();
  // Who played where: each person's club-seasons and each club-season's people (the real leagues only, not Iconic copies).
  const personSeasons = new Map<string, string[]>();
  const seasonPeople = new Map<string, Set<string>>();
  for (const c of pack.clubs) {
    const id = `${c.clubId}-${c.year}`;
    const people = new Set(c.players.map((p) => p[8]));
    seasonPeople.set(id, people);
    for (const person of people) personSeasons.set(person, [...(personSeasons.get(person) ?? []), id]);
  }
  const finishedSeasons = (leagueId: string): number[] => {
    const league = leagueOf(leagueId);
    const all = entriesOf(leagueId).map((e) => e.raw);
    // A finished season: a full table, and its busiest players played most of the games.
    const finished = (y: number) => { const cs = all.filter((c) => c.year === y); return cs.length >= league.teams && cs.every((c) => Math.max(...c.players.map((p) => p[3])) >= league.games * 0.8); };
    return [...new Set(all.map((c) => c.year))].filter(finished).sort((a, b) => a - b);
  };
  /** Rotating: a whole table from a season the seed draws. Otherwise the latest, as before. */
  const rivalYear = (leagueId: string, seed: string, deal?: DealOptions): number | null => {
    if (mixed(leagueId)) return null;
    const seasons = finishedSeasons(leagueId);
    if (!seasons.length) return null;
    return deal?.rotate ? seasons[Math.floor(rng(`${seed}|rival-season`)() * seasons.length)] : Math.max(...seasons);
  };
  /** The real leagues' club-seasons (never the copies in Iconic Clubs or other mixed leagues). */
  const realEntries = pack.clubs.map((c) => byId.get(`${c.clubId}-${c.year}`)!);
  /**
   * A mixed league's rivals for one draw: `greats` of the top pool, then other club-seasons up to a full table, one
   * season per club. Named with the season, and with club-season ids (two seasons of a club are two rivals).
   */
  const mixedRivals = (seed: string, top: Entry[], greats: number, rest: Entry[], count: number): Opponent[] => {
    const r = rng(`${seed}|rivals`);
    const shuffled = (list: Entry[]) => { const out = list.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
    const clubs = new Set<string>();
    // The same club-season under its Iconic name and its own is one team.
    const seasons = new Set<string>();
    const key = (e: Entry) => `${e.raw.clubId}|${e.raw.year}`;
    const picked: Entry[] = [];
    const take = (list: Entry[], upTo: number, newClubOnly: boolean) => {
      for (const e of list) {
        if (picked.length >= upTo) return;
        if (seasons.has(key(e)) || (newClubOnly && clubs.has(e.raw.clubId))) continue;
        picked.push(e); clubs.add(e.raw.clubId); seasons.add(key(e));
      }
    };
    const greatsPool = shuffled(top);
    take(greatsPool, greats, true);
    const others = shuffled(rest);
    take(others, count, true);
    // A small pack runs out: other seasons of clubs already in, then more of the greats, fill the table.
    take(others, count, false);
    take(greatsPool, count, false);
    return picked.map((e) => rivalOf(e, e.id, `${e.raw.club} ${seasonLabel(e.raw.year)}`)).sort((a, b) => b.strength - a.strength);
  };
  return {
    together: (a, b) => {
      if (a === b) return null;
      const shared = (personSeasons.get(a) ?? []).filter((id) => seasonPeople.get(id)?.has(b));
      if (!shared.length) return null;
      const latest = shared.map((id) => byId.get(id)!.raw).sort((x, y) => y.year - x.year)[0];
      return { club: latest.club, season: seasonLabel(latest.year) };
    },
    europeField: (leagueId, seed) => {
      // The real leagues' sides only (not the Iconic or Europe copies), from other leagues than the player's own.
      const pool = [...byId.values()].filter((e) => !mixed(e.league) && e.league !== leagueId && e.raw.finish <= 4);
      const r = rng(`${seed}|europe-field`);
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const seen = new Set<string>();
      return pool.filter((e) => (seen.has(e.raw.clubId) ? false : (seen.add(e.raw.clubId), true))).slice(0, 16).map((e) => rivalOf(e, e.id, `${e.raw.club} ${seasonLabel(e.raw.year)}`));
    },
    rivalYear,
    topScorer: (leagueId, year) => {
      let best: { name: string; club: string; goals: number } | null = null;
      for (const e of entriesOf(leagueId)) {
        if (e.raw.year !== year) continue;
        for (const p of e.raw.players) if (!best || p[4] > best.goals) best = { name: p[0], club: e.raw.club, goals: p[4] };
      }
      return best;
    },
    leagues,
    hasEra: (leagueId, era) => entriesOf(leagueId).some((e) => inEra(e.raw.year, era)),
    clubSeason: (id) => { const e = byId.get(id); return e ? toClubSeason(e) : null; },
    spin: (leagueId, era, seed, used, deal?: DealOptions) => {
      const r = rng(seed);
      const all = byLeague.get(leagueId) ?? [...byId.values()];
      const pool = all.filter((e) => inEra(e.raw.year, era));
      const fresh = pool.filter((e) => !used.includes(e.raw.clubId));
      if (!deal) {
        const from = fresh.length ? fresh : pool;
        return toClubSeason(from[Math.floor(r() * from.length)]);
      }
      // Clubs the player just met wait their turn while others remain.
      const avoid = deal.avoid ?? [];
      const unseen = fresh.filter((e) => !avoid.includes(e.raw.clubId));
      const from = unseen.length ? unseen : fresh.length ? fresh : pool;
      if (!deal.spread) return toClubSeason(from[Math.floor(r() * from.length)]);
      // A club first, weighted by the square root of its seasons: the giants still come up more, just not every time.
      const clubs = new Map<string, Entry[]>();
      for (const e of from) clubs.set(e.raw.clubId, [...(clubs.get(e.raw.clubId) ?? []), e]);
      const weighted = [...clubs.values()].map((seasons) => ({ seasons, weight: Math.sqrt(seasons.length) }));
      let at = r() * weighted.reduce((a, w) => a + w.weight, 0);
      const club = weighted.find((w) => (at -= w.weight) <= 0) ?? weighted[weighted.length - 1];
      return toClubSeason(club.seasons[Math.floor(r() * club.seasons.length)]);
    },
    otherClub: (club, era, seed, used) => {
      const pool = entriesOf(club.leagueId).filter((e) => e.raw.clubId !== club.clubId && inEra(e.raw.year, era));
      const fresh = pool.filter((e) => !used.includes(e.raw.clubId));
      const sameSeason = fresh.filter((e) => seasonLabel(e.raw.year) === club.season);
      const from = sameSeason.length ? sameSeason : fresh.length ? fresh : pool;
      return from.length ? toClubSeason(from[Math.floor(rng(seed)() * from.length)]) : null;
    },
    otherSeason: (club, era, seed) => {
      const others = entriesOf(club.leagueId).filter((e) => e.raw.clubId === club.clubId && seasonLabel(e.raw.year) !== club.season && inEra(e.raw.year, era));
      return others.length ? toClubSeason(others[Math.floor(rng(seed)() * others.length)]) : null;
    },
    opponents: (leagueId, seed, deal?: DealOptions) => {
      const league = leagueOf(leagueId);
      if (mixed(leagueId) && !deal?.mixed) {
        // Setups from before the mixed table: nineteen great sides (or Europe's top finishers), dealt exactly as they were.
        const r = rng(`${seed}|rivals`);
        const pool = entriesOf(leagueId).filter((e) => leagueId !== EUROPE_LEAGUE.id || e.raw.finish <= EUROPE_RIVAL_FINISH);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const seen = new Set<string>();
        const first = pool.filter((e) => (seen.has(e.raw.clubId) ? false : (seen.add(e.raw.clubId), true)));
        const picked = [...first, ...pool.filter((e) => !first.includes(e))].slice(0, league.teams - 1);
        return picked.map((e) => rivalOf(e, e.id, `${e.raw.club} ${seasonLabel(e.raw.year)}`)).sort((a, b) => b.strength - a.strength);
      }
      if (leagueId === ICONIC_LEAGUE.id) {
        // A league with a real spread: a few great sides to chase, and club-seasons from every league below them.
        // The great seasons only ever come in as the few greats, never again among the rest.
        const curated = new Set(entriesOf(leagueId).map((e) => `${e.raw.clubId}-${e.raw.year}`));
        return mixedRivals(seed, entriesOf(leagueId), ICONIC_GREATS, realEntries.filter((e) => e.raw.finish <= ICONIC_REST_FINISH && !curated.has(e.id)), league.teams - 1);
      }
      if (leagueId === EUROPE_LEAGUE.id) {
        // Europe: a few title sides from across the leagues, then sides from their league's top places.
        const titleSides = realEntries.filter((e) => e.raw.finish <= 2);
        return mixedRivals(seed, titleSides, EUROPE_GREATS, realEntries.filter((e) => e.raw.finish > 2 && e.raw.finish <= EUROPE_REST_FINISH), league.teams - 1);
      }
      const seasons = finishedSeasons(leagueId);
      // Rotating: a whole table from a season the seed draws, named with its season. Otherwise the latest, as before.
      const pickedYear = deal?.rotate && seasons.length ? rivalYear(leagueId, seed, deal) : null;
      const key = pickedYear === null ? leagueId : `${leagueId}|${pickedYear}`;
      const known = rivals.get(key);
      if (known) return known;
      const latest = pickedYear ?? Math.max(...seasons);
      // A rival's lines are its own best XI that season, rated the same way as the player's XI.
      // The club id, as before: rivals' own games are seeded by it, so runs already played keep their tables.
      const table = entriesOf(leagueId).filter((e) => e.raw.year === latest)
        .map((e) => rivalOf(e, e.raw.clubId, pickedYear === null ? e.raw.club : `${e.raw.club} ${seasonLabel(latest)}`))
        .sort((a, b) => b.strength - a.strength).slice(0, league.teams - 1);
      rivals.set(key, table);
      return table;
    },
  };
}

/**
 * Prices follow reputation only for setups made for it (the hidden Budget drafts): a run, challenge or room set up before
 * keeps the rating's price, so the same deal still costs what it did. Squads are copied once per universe.
 */
const ratingPriced = new WeakMap<ServerUniverse, ServerUniverse>();
export function pricedFor(u: ServerUniverse, setup: { hidden?: boolean }): ServerUniverse {
  if (setup.hidden) return u;
  const known = ratingPriced.get(u);
  if (known) return known;
  const copies = new Map<string, ClubSeason>();
  const plain = (c: ClubSeason): ClubSeason => {
    const seen = copies.get(c.id);
    if (seen) return seen;
    const copy = { ...c, players: c.players.map(({ reputation: _reputation, ...p }) => p) };
    copies.set(c.id, copy);
    return copy;
  };
  const view: ServerUniverse = {
    ...u,
    clubSeason: (id) => { const c = u.clubSeason(id); return c ? plain(c) : null; },
    spin: (...args) => plain(u.spin(...args)),
    otherClub: (...args) => { const c = u.otherClub(...args); return c ? plain(c) : null; },
    otherSeason: (...args) => { const c = u.otherSeason(...args); return c ? plain(c) : null; },
  };
  ratingPriced.set(u, view);
  return view;
}
