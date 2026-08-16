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

/**
 * How the match was created. Only 'queue' matches award Auction Points —
 * 'lobby' (friendly) matches are for fun and pay nothing, so a private lobby
 * can't be farmed for leaderboard position. Absent on states persisted before
 * this field existed, which is why readers must treat undefined as 'queue'
 * (see `auctionMatchOrigin`).
 */
export type AuctionMatchOrigin = 'queue' | 'lobby';

export interface AuctionMatchState {
  matchId: string;
  version: number;
  locale?: 'en' | 'ka';
  origin?: AuctionMatchOrigin;
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
  | 'id' | 'clueCardId' | 'name' | 'trueValue' | 'clues' | 'imageUrl'
  | 'currentClub' | 'nationality' | 'league' | 'snapshots'
>>;

export type PublicAuctionTeam = Omit<AuctionTeam, 'slots'> & {
  slots: Record<PositionGroup, PublicAuctionFootballer[]>;
};

export type PublicAuctionPlayer = Omit<AuctionPlayer, 'team' | 'botProfile' | 'isBot'> & {
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

/** Ranking entry as clients see it: no isBot flag, and the embedded seat is
 *  the PUBLIC one (the raw ranking carries the internal seat incl. botProfile). */
export type PublicAuctionPlayerRanking = Omit<AuctionPlayerRanking, 'isBot' | 'player'> & {
  /** Absent on rankings computed by pre-player-embedding code (legacy states). */
  player?: PublicAuctionPlayer;
};

export type PublicAuctionMatchState = Omit<
  AuctionMatchState,
  'seats' | 'currentRound' | 'completedRounds' | 'soloPick' | 'rankings'
> & {
  seats: PublicAuctionPlayer[];
  currentRound: PublicAuctionRoundState | null;
  completedRounds: PublicAuctionRoundState[];
  soloPick: PublicAuctionSoloPickState | null;
  rankings: PublicAuctionPlayerRanking[] | null;
};

export function toPublicAuctionRankings(
  rankings: AuctionPlayerRanking[] | null
): PublicAuctionPlayerRanking[] | null {
  if (!rankings) return null;
  return rankings.map(({ isBot: _isBot, player, ...rest }) => ({
    ...rest,
    player: player ? toPublicAuctionPlayer(player) : undefined,
  }));
}

/**
 * Origin of a match, defaulting to 'queue'. In-flight matches created before
 * the field shipped have no `origin` in their Redis blob; those all came from
 * the queue (the lobby path sets it explicitly from day one), so 'queue' is the
 * correct — and reward-preserving — reading for them.
 */
export function auctionMatchOrigin(state: AuctionMatchState): AuctionMatchOrigin {
  return state.origin ?? 'queue';
}

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
    rankings: toPublicAuctionRankings(state.rankings),
    currentRound: state.currentRound ? toPublicAuctionRound(state.currentRound) : null,
    completedRounds: state.completedRounds.map((round) => toPublicAuctionRound({
      ...round,
      revealed: true,
      clueRevealIndex: round.footballer.clues?.length ?? round.clueRevealIndex,
    })),
    soloPick: state.soloPick ? toPublicSoloPick(state.soloPick) : null,
  };
}

/** Pre-reveal snapshot set: [scout season, value-season stub]. The stub keeps
 *  only the season label (the "value in 2025/26" hook) — its stats, league and
 *  value are zeroed so nothing about the player's later career leaks early. */
function minimizeHiddenSnapshots(
  snapshots: AuctionFootballer['snapshots']
): AuctionFootballer['snapshots'] {
  if (!snapshots || snapshots.length === 0) return snapshots;
  const scout = snapshots[0];
  if (snapshots.length === 1) return [scout];
  const last = snapshots[snapshots.length - 1];
  return [
    scout,
    { season: last.season, league: '', age: null, apps: 0, goals: 0, valueEur: 0 },
  ];
}

export function toHiddenFootballer(
  footballer: AuctionFootballer,
  revealedClues: readonly string[] = []
): PublicAuctionFootballer {
  return {
    positionGroup: footballer.positionGroup,
    startingPrice: footballer.startingPrice,
    clues: [...revealedClues],
    // Only what the pre-reveal UI actually renders travels: the SCOUT season
    // (earliest) plus a stub carrying the value season's label. Middle seasons,
    // the final season's stats/league, and every historical value beyond the
    // scout year stay server-side — a devtools reader can no longer fingerprint
    // the career and look up the hidden current value.
    snapshots: minimizeHiddenSnapshots(footballer.snapshots),
    // Current league is withheld pre-reveal: the snapshot's league facet is
    // the clue-season league, and leaking today's league narrows the guess.
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
    league: footballer.league,
    snapshots: footballer.snapshots ? [...footballer.snapshots] : undefined,
  };
}

function toPublicAuctionPlayer(player: AuctionPlayer): PublicAuctionPlayer {
  // botProfile AND isBot are server-only: leaking either would let a client
  // tell bots from humans, which the product rule forbids.
  const { botProfile: _botProfile, isBot: _isBot, ...publicFields } = player;
  return {
    ...publicFields,
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
