import {
  FORMATION_BY_NAME,
  MIN_BID_INCREMENT,
  MIN_PLAYER_COST,
  POSITION_GROUPS,
  STARTING_BUDGET,
} from './auction.constants.js';
import { chemistryMultiplier, computeSquadChemistry } from './auction-chemistry.js';
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

/** Profit = the squad's "sell" value minus what was paid (starting budget less
 *  what's left). Negative if the player overpaid. `trueValue` is the sell value
 *  server-side (there are no season snapshots here, so it's the current value —
 *  the web client's getFutureValue falls back to the same). */
export function getSquadProfit(player: AuctionPlayer): number {
  // Spend is reconstructed from the seat's RECORDED starting budget (falling
  // back to the current constant for legacy states) and clamped at 0 — a state
  // created under an older, larger economy must never yield negative spend
  // (which would fabricate profit) after a deploy shrinks STARTING_BUDGET.
  const startingBudget = player.startingBudget ?? STARTING_BUDGET;
  const spent = Math.max(0, startingBudget - player.budget);
  return getTotalTeamValue(player.team) - spent;
}

/** Profit scaled by chemistry — the score the winner is decided on. Matches the
 *  web client's getAdjustedProfit exactly. Chemistry is a BONUS: it amplifies
 *  gains but never deepens a loss (multiplying a negative profit would rank a
 *  better-linked squad below a worse one whenever both overpaid). */
export function getAdjustedProfit(player: AuctionPlayer): number {
  const profit = getSquadProfit(player);
  if (profit <= 0) return Math.round(profit);
  return Math.round(profit * chemistryMultiplier(computeSquadChemistry(player.team).total));
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

export function hasLastPlayerStanding(players: readonly AuctionPlayer[]): boolean {
  return players.length > 1
    && players.filter((player) => !player.forfeited).length === 1
    && players.filter((player) => player.forfeited).length === players.length - 1;
}

export function rankAuctionPlayers(players: readonly AuctionPlayer[]): AuctionPlayerRanking[] {
  return players
    .map((player, index) => ({
      index,
      player,
      isComplete: isTeamComplete(player.team),
      totalTrueValue: getTotalTeamValue(player.team),
      chemistry: computeSquadChemistry(player.team).total,
      profit: getSquadProfit(player),
      adjustedProfit: getAdjustedProfit(player),
    }))
    .sort((a, b) => {
      // Forfeiters (quit / disconnect-timeout) always rank below every
      // non-forfeiter, no matter how good their squad was — you can't win by
      // quitting while ahead. Honest budget elimination is NOT penalized here.
      const aForfeited = Boolean(a.player.forfeited);
      const bForfeited = Boolean(b.player.forfeited);
      if (aForfeited !== bForfeited) return aForfeited ? 1 : -1;
      if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
      // Winner = most chemistry-adjusted profit (value growth × chemistry). This
      // mirrors the web client's results ordering exactly.
      if (a.adjustedProfit !== b.adjustedProfit) return b.adjustedProfit - a.adjustedProfit;
      return a.index - b.index;
    })
    .map(({ player, isComplete, totalTrueValue, chemistry, profit, adjustedProfit }, index) => {
      // Rankings are emitted to clients verbatim (auction:match_finished), so the
      // embedded seat must not carry the server-only bidding profile.
      const { botProfile: _botProfile, ...publicPlayer } = player;
      return {
        seatId: player.seatId,
        userId: player.userId,
        isBot: player.isBot,
        displayName: player.displayName,
        rank: index + 1,
        isComplete,
        totalTrueValue,
        chemistry,
        profit,
        adjustedProfit,
        budgetRemaining: player.budget,
        player: publicPlayer,
      };
    });
}

function resolveFormation(formation: FormationName | AuctionFormation): AuctionFormation {
  return typeof formation === 'string' ? FORMATION_BY_NAME[formation] : formation;
}

function createEmptySlots(): AuctionTeamSlots {
  return { GK: [], DEF: [], MID: [], FWD: [] };
}
