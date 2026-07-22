import type {
  AuctionFootballer,
  AuctionPlayer,
  AuctionPlayerRanking,
  AuctionTeam,
  FormationName,
  PositionGroup,
} from './auction.types.js';

export type AuctionMatchPhase =
  | 'created'
  | 'clue_reveal'
  | 'bidding'
  | 'reveal'
  | 'solo_pick'
  | 'finished';

export interface AuctionBidState {
  seatId: string;
  amount: number;
  placedAt: string;
}

export interface AuctionRoundState {
  roundId: string;
  roundIndex: number;
  positionGroup: PositionGroup;
  footballer: AuctionFootballer;
  clueRevealIndex: number;
  bids: AuctionBidState[];
  highestBidderSeatId: string | null;
  highestBid: number;
  startingPrice: number;
  winnerSeatId: string | null;
  winningBid: number;
  revealed: boolean;
  turnOrder: string[];
  currentTurnSeatId: string | null;
  foldedSeatIds: string[];
  turnEndsAt: string | null;
  /** Deadline of the post-clue study window; null outside it. */
  biddingStartsAt: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface AuctionSoloPickOptionState {
  type: 'revealed' | 'mystery';
  footballer: AuctionFootballer;
  clues?: readonly string[];
}

export interface AuctionSoloPickState {
  playerSeatId: string;
  positionGroup: PositionGroup;
  optionA: AuctionSoloPickOptionState;
  optionB: AuctionSoloPickOptionState;
  selectedOption: 'A' | 'B' | null;
  startedAt: string;
}

export interface AuctionMatchState {
  matchId: string;
  version: number;
  locale?: 'en' | 'ka';
  phase: AuctionMatchPhase;
  formation: FormationName;
  seats: AuctionPlayer[];
  currentRound: AuctionRoundState | null;
  completedRounds: AuctionRoundState[];
  soloPick: AuctionSoloPickState | null;
  usedClueCardIds: string[];
  rankings: AuctionPlayerRanking[] | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicAuctionFootballer = Pick<
  AuctionFootballer,
  'positionGroup' | 'startingPrice'
> & Partial<Pick<
  AuctionFootballer,
  'id' | 'clueCardId' | 'name' | 'trueValue' | 'clues' | 'imageUrl' | 'currentClub' | 'nationality'
>>;

export type PublicAuctionTeam = Omit<AuctionTeam, 'slots'> & {
  slots: Record<PositionGroup, PublicAuctionFootballer[]>;
};

export type PublicAuctionPlayer = Omit<AuctionPlayer, 'team'> & {
  team: PublicAuctionTeam;
};

export type PublicAuctionRoundState = Omit<AuctionRoundState, 'footballer'> & {
  footballer: PublicAuctionFootballer;
  revealedClues: readonly string[];
};

export type PublicAuctionSoloPickOptionState = Omit<AuctionSoloPickOptionState, 'footballer'> & {
  footballer: PublicAuctionFootballer;
};

export type PublicAuctionSoloPickState = Omit<
  AuctionSoloPickState,
  'optionA' | 'optionB'
> & {
  optionA: PublicAuctionSoloPickOptionState;
  optionB: PublicAuctionSoloPickOptionState;
};

export type PublicAuctionMatchState = Omit<
  AuctionMatchState,
  'seats' | 'currentRound' | 'completedRounds' | 'soloPick'
> & {
  seats: PublicAuctionPlayer[];
  currentRound: PublicAuctionRoundState | null;
  completedRounds: PublicAuctionRoundState[];
  soloPick: PublicAuctionSoloPickState | null;
};

export function findAuctionSeatBySeatId(
  state: AuctionMatchState,
  seatId: string
): AuctionPlayer | null {
  return state.seats.find((seat) => seat.seatId === seatId) ?? null;
}

export function findAuctionSeatByUserId(
  state: AuctionMatchState,
  userId: string
): AuctionPlayer | null {
  return state.seats.find((seat) => seat.userId === userId) ?? null;
}

export function toPublicAuctionMatchState(state: AuctionMatchState): PublicAuctionMatchState {
  return {
    ...state,
    seats: state.seats.map(toPublicAuctionPlayer),
    currentRound: state.currentRound ? toPublicAuctionRound(state.currentRound) : null,
    completedRounds: state.completedRounds.map((round) => toPublicAuctionRound({
      ...round,
      revealed: true,
      clueRevealIndex: round.footballer.clues?.length ?? round.clueRevealIndex,
    })),
    soloPick: state.soloPick ? toPublicSoloPick(state.soloPick) : null,
  };
}

export function toHiddenFootballer(
  footballer: AuctionFootballer,
  revealedClues: readonly string[] = []
): PublicAuctionFootballer {
  return {
    positionGroup: footballer.positionGroup,
    startingPrice: footballer.startingPrice,
    clues: [...revealedClues],
  };
}

export function toRevealedFootballer(footballer: AuctionFootballer): PublicAuctionFootballer {
  return {
    id: footballer.id,
    clueCardId: footballer.clueCardId,
    name: footballer.name,
    positionGroup: footballer.positionGroup,
    trueValue: footballer.trueValue,
    startingPrice: footballer.startingPrice,
    clues: footballer.clues ? [...footballer.clues] : undefined,
    imageUrl: footballer.imageUrl,
    currentClub: footballer.currentClub,
    nationality: footballer.nationality,
  };
}

function toPublicAuctionPlayer(player: AuctionPlayer): PublicAuctionPlayer {
  return {
    ...player,
    team: {
      ...player.team,
      slots: {
        GK: player.team.slots.GK.map(toRevealedFootballer),
        DEF: player.team.slots.DEF.map(toRevealedFootballer),
        MID: player.team.slots.MID.map(toRevealedFootballer),
        FWD: player.team.slots.FWD.map(toRevealedFootballer),
      },
    },
  };
}

function toPublicAuctionRound(round: AuctionRoundState): PublicAuctionRoundState {
  const allClues = round.footballer.clues ?? [];
  const revealedClues = allClues.slice(0, round.clueRevealIndex);
  const footballer = round.revealed
    ? toRevealedFootballer(round.footballer)
    : toHiddenFootballer(round.footballer, revealedClues);

  return {
    ...round,
    footballer,
    revealedClues,
  };
}

function toPublicSoloPick(option: AuctionSoloPickState): PublicAuctionSoloPickState {
  return {
    ...option,
    optionA: {
      ...option.optionA,
      footballer: toRevealedFootballer(option.optionA.footballer),
    },
    optionB: {
      ...option.optionB,
      footballer: option.optionB.type === 'mystery'
        ? toHiddenFootballer(option.optionB.footballer, option.optionB.clues ?? option.optionB.footballer.clues ?? [])
        : toRevealedFootballer(option.optionB.footballer),
    },
  };
}
