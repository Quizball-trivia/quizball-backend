import { z } from 'zod';
import type { DraftUniverse } from './draft.engine.js';
import { FORMATIONS, lines, rateSeason, rng, type ClubSeason, type DraftPlayer, type Era, type League, type Lines, type Opponent, type Pos, ROLES } from './draft.rules.js';

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
});
export type DraftPack = z.infer<typeof draftPackSchema>;
type RawClub = DraftPack['clubs'][number];

export const seasonLabel = (year: number): string => `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
const inEra = (year: number, era: Era): boolean => era === 'all' || (era === 'modern' ? year >= 2004 : year < 2004);

export interface ServerUniverse extends DraftUniverse {
  clubSeason(id: string): ClubSeason | null;
  hasEra(leagueId: string, era: Era): boolean;
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

/** The engine's view of a pack. Squads are rated once and kept, so a move rebuilding its deal costs next to nothing. */
export function universeOf(pack: DraftPack): ServerUniverse {
  const leagueOf = (id: string): League => pack.leagues.find((l) => l.id === id) ?? pack.leagues[0];
  const built = new Map<string, ClubSeason>();
  const toClubSeason = (c: RawClub): ClubSeason => {
    const id = `${c.clubId}-${c.year}`;
    const known = built.get(id);
    if (known) return known;
    const league = leagueOf(c.league);
    const players: DraftPlayer[] = c.players.map(([name, pos, alt, apps, goals, assists, cleanSheets, minutesShare, personId, legend, role, estimated], i) => ({
      id: `${id}-${i}`, personId, legend: !!legend, name, pos: pos as Pos, alt: (alt as Pos[] | null) ?? undefined, role: role ?? undefined, cleanSheetsEstimated: !!estimated, apps, goals, assists, cleanSheets, minutesShare,
      rating: rateSeason({ pos: pos as Pos, minutesShare, apps, goals, assists, cleanSheets, finish: c.finish, teams: league.teams, legend: !!legend }).total,
    }));
    const club: ClubSeason = { id, clubId: c.clubId, club: c.club, season: seasonLabel(c.year), leagueId: c.league, legend: c.year < 2004, finish: c.finish, players };
    built.set(id, club);
    return club;
  };
  const byLeague = new Map<string, RawClub[]>();
  const byId = new Map<string, RawClub>();
  for (const c of pack.clubs) {
    byLeague.set(c.league, [...(byLeague.get(c.league) ?? []), c]);
    byId.set(`${c.clubId}-${c.year}`, c);
  }
  const rivals = new Map<string, Opponent[]>();
  return {
    leagues: pack.leagues,
    hasEra: (leagueId, era) => (byLeague.get(leagueId) ?? []).some((c) => inEra(c.year, era)),
    clubSeason: (id) => { const raw = byId.get(id); return raw ? toClubSeason(raw) : null; },
    spin: (leagueId, era, seed, used) => {
      const r = rng(seed);
      const pool = (byLeague.get(leagueId) ?? pack.clubs).filter((c) => inEra(c.year, era));
      const fresh = pool.filter((c) => !used.includes(c.clubId));
      const from = fresh.length ? fresh : pool;
      return toClubSeason(from[Math.floor(r() * from.length)]);
    },
    otherClub: (club, era, seed, used) => {
      const pool = (byLeague.get(club.leagueId) ?? []).filter((c) => c.clubId !== club.clubId && inEra(c.year, era));
      const fresh = pool.filter((c) => !used.includes(c.clubId));
      const sameSeason = fresh.filter((c) => seasonLabel(c.year) === club.season);
      const from = sameSeason.length ? sameSeason : fresh.length ? fresh : pool;
      return from.length ? toClubSeason(from[Math.floor(rng(seed)() * from.length)]) : null;
    },
    otherSeason: (club, era, seed) => {
      const others = (byLeague.get(club.leagueId) ?? []).filter((c) => c.clubId === club.clubId && seasonLabel(c.year) !== club.season && inEra(c.year, era));
      return others.length ? toClubSeason(others[Math.floor(rng(seed)() * others.length)]) : null;
    },
    opponents: (leagueId) => {
      const known = rivals.get(leagueId);
      if (known) return known;
      const league = leagueOf(leagueId);
      const all = byLeague.get(leagueId) ?? [];
      // The latest finished season: a full table, and its busiest players played most of the games.
      const finished = (y: number) => { const cs = all.filter((c) => c.year === y); return cs.length >= league.teams && cs.every((c) => Math.max(...c.players.map((p) => p[3])) >= league.games * 0.8); };
      const latest = Math.max(...all.map((c) => c.year).filter(finished));
      // A rival's lines are its own best XI that season, rated the same way as the player's XI.
      const table = all.filter((c) => c.year === latest).map((c) => { const l = bestXi(toClubSeason(c)); return { id: c.clubId, name: c.club, strength: l.overall, gk: l.gk, def: l.def, mid: l.mid, att: l.att }; })
        .sort((a, b) => b.strength - a.strength).slice(0, league.teams - 1);
      rivals.set(leagueId, table);
      return table;
    },
  };
}
