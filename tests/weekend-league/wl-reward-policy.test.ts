import { describe, expect, it } from 'vitest';
import { wlHighestReward, type WlRewardFacts } from '../../src/modules/weekend-league/wl-reward-policy.js';

const base: WlRewardFacts = {
  saturdayCheckedIn: false,
  saturdayPlayed: false,
  qualifiedForFinal: false,
  sundayCheckedIn: false,
  finalPlayed: false,
  humanRank: null,
};
const saturday: WlRewardFacts = { ...base, saturdayCheckedIn: true, saturdayPlayed: true };
const finalist: WlRewardFacts = { ...saturday, qualifiedForFinal: true, sundayCheckedIn: true };
const played = (humanRank: number): WlRewardFacts => ({ ...finalist, finalPlayed: true, humanRank });

describe('Weekend League highest-only reward policy', () => {
  it('gives nothing for registration, or for a check-in without play', () => {
    expect(wlHighestReward(base)).toBeNull();
    expect(wlHighestReward({ ...base, saturdayCheckedIn: true })).toBeNull();
    expect(wlHighestReward({ ...base, saturdayPlayed: true })).toBeNull();
  });

  it('pays Saturday participation 1,500, including after elimination', () => {
    expect(wlHighestReward(saturday)).toEqual({ band: 'participant', coins: 1500, packPlace: null });
  });

  it('keeps a Sunday no-show finalist on the participation band', () => {
    expect(wlHighestReward({ ...saturday, qualifiedForFinal: true })?.band).toBe('participant');
  });

  it('pays a checked-in finalist 4,000 and not 4,000 + 1,500', () => {
    expect(wlHighestReward(finalist)).toEqual({ band: 'finalist', coins: 4000, packPlace: null });
  });

  it('does not upgrade a finalist who never played the final, whatever the rank says', () => {
    expect(wlHighestReward({ ...finalist, humanRank: 1 })?.band).toBe('finalist');
  });

  it('maps final human ranks to the podium, top 10 and finalist bands', () => {
    expect(wlHighestReward(played(1))).toEqual({ band: 'winner', coins: 40000, packPlace: 1 });
    expect(wlHighestReward(played(2))).toEqual({ band: 'second', coins: 25000, packPlace: 2 });
    expect(wlHighestReward(played(3))).toEqual({ band: 'third', coins: 15000, packPlace: 3 });
    expect(wlHighestReward(played(4))).toEqual({ band: 'top10', coins: 8000, packPlace: null });
    expect(wlHighestReward(played(10))?.band).toBe('top10');
    expect(wlHighestReward(played(11))).toEqual({ band: 'finalist', coins: 4000, packPlace: null });
  });

  it('pays Sunday entitlements to a finalist who never answered on Saturday', () => {
    // A small field can advance an idle qualifier; they can still play and win the final.
    const idleSaturday: WlRewardFacts = { ...base, saturdayCheckedIn: true, qualifiedForFinal: true, sundayCheckedIn: true };
    expect(wlHighestReward(idleSaturday)).toEqual({ band: 'finalist', coins: 4000, packPlace: null });
    expect(wlHighestReward({ ...idleSaturday, finalPlayed: true, humanRank: 1 }))
      .toEqual({ band: 'winner', coins: 40000, packPlace: 1 });
    // ...but qualifying while idle and then skipping Sunday earns nothing.
    expect(wlHighestReward({ ...base, saturdayCheckedIn: true, qualifiedForFinal: true })).toBeNull();
  });

  it('ignores a rank that is not a positive integer', () => {
    expect(wlHighestReward(played(0))?.band).toBe('finalist');
    expect(wlHighestReward(played(1.5))?.band).toBe('finalist');
  });
});
