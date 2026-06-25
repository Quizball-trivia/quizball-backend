import {
  FORMATION_BY_NAME,
  MIN_BID_INCREMENT,
  MIN_PLAYER_COST,
  POSITION_GROUPS,
} from './auction.constants.js';
import type {
  AuctionBidValidationInput,
  AuctionFormation,
  AuctionPlayer,
  AuctionPlayerRanking,
  AuctionTeam,
  AuctionTeamSlots,
  FormationName,
  PositionGroup,
  PositionNeeds,
} from './auction.types.js';

export function getFormationNeeds(formation: FormationName | AuctionFormation): PositionNeeds {
  const resolved = resolveFormation(formation);
  return { ...resolved.required };
}

export function createEmptyTeam(formation: FormationName | AuctionFormation): AuctionTeam {
  return {
    formation: resolveFormation(formation),
    slots: createEmptySlots(),
  };
}

export function needsPosition(playerOrTeam: AuctionPlayer | AuctionTeam, position: PositionGroup): boolean {
  const team = 'team' in playerOrTeam ? playerOrTeam.team : playerOrTeam;
  return team.slots[position].length < team.formation.required[position];
}

export function getFilledCount(team: AuctionTeam): number {
  return POSITION_GROUPS.reduce((sum, position) => sum + team.slots[position].length, 0);
}

export function getEmptySlots(team: AuctionTeam): number {
  return POSITION_GROUPS.reduce(
    (sum, position) => sum + Math.max(0, team.formation.required[position] - team.slots[position].length),
    0
  );
}

export function isTeamComplete(team: AuctionTeam): boolean {
  return getEmptySlots(team) === 0;
}

export function getTotalTeamValue(team: AuctionTeam): number {
  return POSITION_GROUPS.reduce(
    (sum, position) => sum + team.slots[position].reduce((positionSum, footballer) => (
      positionSum + footballer.trueValue
    ), 0),
    0
  );
}

export function getMaxBid(budget: number, emptySlots: number): number {
  if (emptySlots <= 1) return Math.max(0, budget);
  return Math.max(0, budget - (emptySlots - 1) * MIN_PLAYER_COST);
}

export function getMinBid(startingPrice: number, highestBid?: number | null): number {
  return highestBid && highestBid > 0
    ? highestBid + MIN_BID_INCREMENT
    : startingPrice;
}

export function canAffordMinBid(budget: number, emptySlots: number, minBid: number): boolean {
  return getMaxBid(budget, emptySlots) >= minBid;
}

export function isBidValid(input: AuctionBidValidationInput): boolean {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return false;
  const minBid = getMinBid(input.startingPrice, input.highestBid);
  return input.amount >= minBid
    && input.amount <= getMaxBid(input.budget, input.emptySlots);
}

export function shouldEliminateAfterPurchase(budget: number, emptySlots: number): boolean {
  return emptySlots > 0 && budget < emptySlots * MIN_PLAYER_COST;
}

export function canPlayerContinue(player: AuctionPlayer): boolean {
  if (player.isEliminated) return false;
  if (isTeamComplete(player.team)) return false;
  return !shouldEliminateAfterPurchase(player.budget, getEmptySlots(player.team));
}

export function rankAuctionPlayers(players: readonly AuctionPlayer[]): AuctionPlayerRanking[] {
  return players
    .map((player, index) => ({
      index,
      player,
      isComplete: isTeamComplete(player.team),
      totalTrueValue: getTotalTeamValue(player.team),
    }))
    .sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
      if (a.totalTrueValue !== b.totalTrueValue) return b.totalTrueValue - a.totalTrueValue;
      return a.index - b.index;
    })
    .map(({ player, isComplete, totalTrueValue }, index) => ({
      seatId: player.seatId,
      userId: player.userId,
      isBot: player.isBot,
      displayName: player.displayName,
      rank: index + 1,
      isComplete,
      totalTrueValue,
      budgetRemaining: player.budget,
      player,
    }));
}

function resolveFormation(formation: FormationName | AuctionFormation): AuctionFormation {
  return typeof formation === 'string' ? FORMATION_BY_NAME[formation] : formation;
}

function createEmptySlots(): AuctionTeamSlots {
  return { GK: [], DEF: [], MID: [], FWD: [] };
}
