/**
 * Weekend League reward policy v2 (owner-approved 2026-10-01; podium frames
 * added 2026-10-04). Pure
 * calculation only; nothing here touches a wallet. One reward per player per
 * weekend: the highest band reached, amounts never stack.
 */
/** v1: podium packs carry the jersey. v2: the jersey and the place frame. */
export function wlRewardPolicyVersion(framesEnabled: boolean): 1 | 2 {
  return framesEnabled ? 2 : 1;
}

export const WL_COIN_REWARDS = Object.freeze({
  participant: 1500,
  finalist: 4000,
  top10: 8000,
  third: 15000,
  second: 25000,
  winner: 40000,
});

export type WlRewardBand = keyof typeof WL_COIN_REWARDS;
export type WlPackPlace = 1 | 2 | 3;

/** The "Retro Playmaker" jersey each podium pack carries. */
const WL_PACK_JERSEYS: Readonly<Record<WlPackPlace, string>> = Object.freeze({
  1: 'avatar_jersey_wl_retro_home',
  2: 'avatar_jersey_wl_retro_away',
  3: 'avatar_jersey_wl_retro_training',
});

/** The matching place frame (policy v2). */
const WL_PACK_FRAMES: Readonly<Record<WlPackPlace, string>> = Object.freeze({
  1: 'avatar_frame_wl_champion',
  2: 'avatar_frame_wl_runnerup',
  3: 'avatar_frame_wl_podium',
});

/** What each podium pack carries. Receipts keep what was frozen, so turning
 *  frames on never changes a receipt that already exists. */
export function wlPackItemSlugs(framesEnabled: boolean): Readonly<Record<WlPackPlace, readonly string[]>> {
  return {
    1: framesEnabled ? [WL_PACK_JERSEYS[1], WL_PACK_FRAMES[1]] : [WL_PACK_JERSEYS[1]],
    2: framesEnabled ? [WL_PACK_JERSEYS[2], WL_PACK_FRAMES[2]] : [WL_PACK_JERSEYS[2]],
    3: framesEnabled ? [WL_PACK_JERSEYS[3], WL_PACK_FRAMES[3]] : [WL_PACK_JERSEYS[3]],
  };
}

/** Server-owned facts only; none of these may come from a client. */
export interface WlRewardFacts {
  saturdayCheckedIn: boolean;
  /** Had an accepted answer in a qualifier game (wrong answers count). */
  saturdayPlayed: boolean;
  qualifiedForFinal: boolean;
  sundayCheckedIn: boolean;
  /** The final was played AND this player had an accepted answer in it. */
  finalPlayed: boolean;
  /** Rank among eligible humans who played the final. */
  humanRank: number | null;
}

export interface WlReward {
  band: WlRewardBand;
  coins: number;
  packPlace: WlPackPlace | null;
}

export function wlHighestReward(facts: WlRewardFacts): WlReward | null {
  const saturday = facts.saturdayCheckedIn && facts.saturdayPlayed;
  // Reaching the final is its own entitlement: a small field can advance a
  // player who never answered on Saturday, and they can still win on Sunday.
  const finalist = facts.qualifiedForFinal && facts.sundayCheckedIn;
  if (!saturday && !finalist) return null;

  let band: WlRewardBand = finalist ? 'finalist' : 'participant';
  let packPlace: WlPackPlace | null = null;

  const rank = facts.humanRank;
  if (finalist && facts.finalPlayed && rank !== null && Number.isSafeInteger(rank) && rank > 0) {
    if (rank <= 3) {
      packPlace = rank as WlPackPlace;
      band = rank === 1 ? 'winner' : rank === 2 ? 'second' : 'third';
    } else if (rank <= 10) {
      band = 'top10';
    }
  }
  return { band, coins: WL_COIN_REWARDS[band], packPlace };
}
