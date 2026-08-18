import { AUCTION_SQUAD_SIZE, POSITION_GROUPS } from './auction.constants.js';
import type { AuctionFootballer, AuctionTeam, PositionGroup } from './auction.types.js';

// ── Squad chemistry (authoritative; the web client mirrors this exactly) ─────
// FC-style chemistry on three dimensions — club, league and nation. Each player
// earns up to MAX_PLAYER_CHEMISTRY points from how many squadmates share their
// club, league and nation (each dimension has its own tier thresholds). A
// player's points are the sum across the three dimensions, capped per player;
// the squad total then scales profit by chemistryMultiplier.
//
// Kept byte-for-byte in step with web `src/features/auction/data.ts` — same
// dimensions, thresholds, caps and multiplier — so the score the server ranks
// on equals the score the client shows. The client sees no `league` in a live
// match (the server contract omits it), so league links only ever form here if
// content later populates `AuctionFootballer.league`; today both sides agree on
// club + nation alone.

export const MAX_PLAYER_CHEMISTRY = 3;
export const MAX_SQUAD_CHEMISTRY = AUCTION_SQUAD_SIZE * MAX_PLAYER_CHEMISTRY; // 21

// Squadmate counts (including the player) needed for tier 1 / 2 / 3. Scaled for
// a 7-player squad (you can't reach 7–8 of the same league here).
export const CLUB_CHEM_THRESHOLDS = [2, 3, 4];
export const LEAGUE_CHEM_THRESHOLDS = [2, 4, 6];
export const NATION_CHEM_THRESHOLDS = [2, 4, 6];

export type ChemDimension = 'club' | 'league' | 'nation';

export const CHEM_THRESHOLDS: Record<ChemDimension, number[]> = {
  club: CLUB_CHEM_THRESHOLDS,
  league: LEAGUE_CHEM_THRESHOLDS,
  nation: NATION_CHEM_THRESHOLDS,
};

const CHEM_DIMENSIONS: ChemDimension[] = ['club', 'league', 'nation'];

export interface SquadChemistry {
  total: number; // 0…MAX_SQUAD_CHEMISTRY
  perPlayer: Record<string, number>; // footballer id → 0…MAX_PLAYER_CHEMISTRY
}

function chemTierPoints(count: number, thresholds: number[]): number {
  return thresholds.reduce((points, threshold) => points + (count >= threshold ? 1 : 0), 0);
}

function dimensionValue(footballer: AuctionFootballer, dim: ChemDimension): string | null {
  switch (dim) {
    case 'club':
      return footballer.currentClub ?? null;
    case 'league':
      return footballer.league ?? null;
    case 'nation':
      return footballer.nationality ?? null;
  }
}

function squadOf(team: AuctionTeam): AuctionFootballer[] {
  return POSITION_GROUPS.flatMap((position) => team.slots[position]);
}

export function computeSquadChemistry(team: AuctionTeam): SquadChemistry {
  const squad = squadOf(team);
  const counts: Record<ChemDimension, Map<string, number>> = {
    club: new Map(),
    league: new Map(),
    nation: new Map(),
  };
  for (const footballer of squad) {
    for (const dim of CHEM_DIMENSIONS) {
      const key = dimensionValue(footballer, dim);
      if (key) counts[dim].set(key, (counts[dim].get(key) ?? 0) + 1);
    }
  }

  const perPlayer: Record<string, number> = {};
  let total = 0;
  for (const footballer of squad) {
    let points = 0;
    for (const dim of CHEM_DIMENSIONS) {
      const key = dimensionValue(footballer, dim);
      if (key) points += chemTierPoints(counts[dim].get(key) ?? 0, CHEM_THRESHOLDS[dim]);
    }
    const chem = Math.min(MAX_PLAYER_CHEMISTRY, points);
    perPlayer[footballer.id] = chem;
    total += chem;
  }

  return { total: Math.min(MAX_SQUAD_CHEMISTRY, total), perPlayer };
}

/**
 * How much the squad's TOTAL chemistry would rise if `footballer` were signed
 * into `positionGroup`. Counts both the newcomer's own links and the points
 * existing squadmates gain from the new shared club/league/nation.
 */
export function chemistryGainIfAdded(
  team: AuctionTeam,
  footballer: AuctionFootballer,
  positionGroup: PositionGroup
): number {
  const hypothetical: AuctionTeam = {
    ...team,
    slots: {
      ...team.slots,
      [positionGroup]: [...team.slots[positionGroup], footballer],
    },
  };
  return computeSquadChemistry(hypothetical).total - computeSquadChemistry(team).total;
}

/** Chemistry → multiplier, a BONUS not a gate: 1 + chem/10, so no chemistry is
 *  ×1.0 (profit kept in full) and max chemistry is ×3.1. Applied to profit, so
 *  chemistry rewards a good squad rather than wiping a chemistry-less one. */
export function chemistryMultiplier(totalChemistry: number): number {
  return 1 + totalChemistry / 10;
}
