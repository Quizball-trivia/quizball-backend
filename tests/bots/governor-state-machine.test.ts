/**
 * Unit tests for the rubber-band governor state machine (PR9, plan §1.5).
 *
 * Covered:
 *  - EMA folds outcomes with the right memory; first sample seeds, no 0.5 prior
 *  - hysteresis dead band: no movement inside the target band
 *  - cooldown (matches AND wall-clock) prevents thrash / ratcheting
 *  - climbing win-rate drives the offset NEGATIVE, sinking win-rate POSITIVE
 *  - top-proximity DOMINATES a positive win-rate signal (never a boost)
 *  - offsets stay bounded to +/- MAX_GOVERNOR_ADJUSTMENT under any sequence
 *  - kill switch zeroes the offset while the EMA keeps observing
 *  - minimum-sample gate; unknown top-10 RP disables top-protection
 */

import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_MATCHES,
  COOLDOWN_MS,
  GOVERNOR_STEP,
  HYSTERESIS_BAND,
  MAX_GOVERNOR_ADJUSTMENT,
  MID_LADDER_TARGET_WINRATE,
  MIN_SAMPLES_FOR_WINRATE,
  TOP_BAND_TARGET_WINRATE,
  TOP_PROTECTION_CRITICAL_RP,
  TOP_PROTECTION_MARGIN_RP,
  TOP_PROTECTION_STEP,
  cooldownElapsed,
  stepGovernor,
  targetWinrate,
  topProtectionZone,
  updateWinrateEma,
  type GovernorInput,
  type GovernorState,
} from '../../src/modules/bots/governor/governor-state-machine.js';

const T0 = new Date('2026-07-28T10:00:00.000Z');

function freshState(overrides: Partial<GovernorState> = {}): GovernorState {
  return {
    adjustment: 0,
    winrateEma: null,
    winrateSamples: 0,
    updatedAt: null,
    samplesAtAdjustment: 0,
    ...overrides,
  };
}

/** A mid-ladder bot far below the top 10 — top-protection is 'clear'. */
function midLadderInput(overrides: Partial<GovernorInput> = {}): GovernorInput {
  return {
    botRp: 1000,
    humanTop10Rp: 4000,
    won: true,
    now: T0,
    enabled: true,
    ...overrides,
  };
}

/** Drive a sequence of results through the machine, returning the final state. */
function runSequence(
  state: GovernorState,
  results: boolean[],
  inputFor: (index: number, state: GovernorState) => GovernorInput,
): GovernorState {
  let current = state;
  results.forEach((won, index) => {
    current = stepGovernor(current, { ...inputFor(index, current), won }).next;
  });
  return current;
}

describe('updateWinrateEma', () => {
  it('seeds from the first outcome instead of an invented 0.5 prior', () => {
    expect(updateWinrateEma(null, true)).toBe(1);
    expect(updateWinrateEma(null, false)).toBe(0);
  });

  it('moves toward the outcome by the smoothing factor', () => {
    // 0.5 + 0.1 * (1 - 0.5)
    expect(updateWinrateEma(0.5, true)).toBeCloseTo(0.55, 10);
    expect(updateWinrateEma(0.5, false)).toBeCloseTo(0.45, 10);
  });

  it('stays within [0,1] over long one-sided runs', () => {
    let ema: number | null = null;
    for (let i = 0; i < 500; i += 1) ema = updateWinrateEma(ema, true);
    expect(ema).toBeLessThanOrEqual(1);
    expect(ema).toBeGreaterThan(0.99);
  });
});

describe('targetWinrate (per-band targets, §1.5)', () => {
  it('uses the lower top-band target inside the protection ring', () => {
    expect(targetWinrate(3900, 4000)).toBe(TOP_BAND_TARGET_WINRATE);
  });

  it('uses the mid-ladder target well below the ring', () => {
    expect(targetWinrate(1000, 4000)).toBe(MID_LADDER_TARGET_WINRATE);
  });

  it('falls back to mid-ladder when the top-10 RP is unknown', () => {
    expect(targetWinrate(9999, null)).toBe(MID_LADDER_TARGET_WINRATE);
  });
});

describe('topProtectionZone', () => {
  it('is clear well below the #10 human', () => {
    expect(topProtectionZone(4000 - TOP_PROTECTION_MARGIN_RP - 1, 4000)).toBe('clear');
  });

  it('warns once inside the margin', () => {
    expect(topProtectionZone(4000 - TOP_PROTECTION_MARGIN_RP, 4000)).toBe('warn');
  });

  it('is critical once inside the tight ring', () => {
    expect(topProtectionZone(4000 - TOP_PROTECTION_CRITICAL_RP, 4000)).toBe('critical');
    expect(topProtectionZone(4500, 4000)).toBe('critical');
  });

  it('is clear when the top-10 RP is unknown — never fires on a guess', () => {
    expect(topProtectionZone(99999, null)).toBe('clear');
    expect(topProtectionZone(99999, Number.NaN)).toBe('clear');
  });
});

describe('hysteresis dead band', () => {
  it('does not move the offset while the EMA sits inside the band', () => {
    // At target, plenty of samples, cooldown long elapsed. Note the machine
    // folds THIS match's result in BEFORE the band check, so a win lands the
    // EMA at 0.55 — still inside the +/-0.05 band, hence no movement.
    const state = freshState({
      winrateEma: MID_LADDER_TARGET_WINRATE,
      winrateSamples: 100,
      updatedAt: new Date(T0.getTime() - 10 * COOLDOWN_MS),
    });
    const decision = stepGovernor(state, midLadderInput({ won: true }));
    expect(decision.next.winrateEma).toBeCloseTo(0.55, 10);
    expect(decision.next.adjustment).toBe(0);
    expect(decision.trigger).toBe('none');
  });

  it('does not move at the band edge, but does just outside it', () => {
    const base = {
      winrateSamples: 100,
      updatedAt: new Date(T0.getTime() - 10 * COOLDOWN_MS),
    };
    // Pick a pre-EMA such that AFTER this match is folded in, the EMA lands
    // EXACTLY on the band edge (error == +HYSTERESIS_BAND). The check is
    // inclusive (<=), so the edge itself must NOT move the offset.
    // A loss folds as ema' = 0.9 * ema, so invert: ema = edge / 0.9.
    const edgeTarget = MID_LADDER_TARGET_WINRATE + HYSTERESIS_BAND;
    const atEdge = stepGovernor(
      freshState({ ...base, winrateEma: edgeTarget / 0.9 }),
      midLadderInput({ won: false }),
    );
    expect(atEdge.next.winrateEma).toBeCloseTo(edgeTarget, 10);
    expect(atEdge.trigger).toBe('none');

    // A clearly higher EMA is outside the band -> steps down.
    const outside = stepGovernor(
      freshState({ ...base, winrateEma: 0.95 }),
      midLadderInput({ won: true }),
    );
    expect(outside.trigger).toBe('winrate_down');
    expect(outside.next.adjustment).toBeCloseTo(-GOVERNOR_STEP, 10);
  });
});

describe('win-rate arm direction', () => {
  const settled = {
    winrateSamples: 100,
    updatedAt: new Date(T0.getTime() - 10 * COOLDOWN_MS),
    samplesAtAdjustment: 0,
  };

  it('a climbing win rate drives the offset NEGATIVE', () => {
    const decision = stepGovernor(
      freshState({ ...settled, winrateEma: 0.9 }),
      midLadderInput({ won: true }),
    );
    expect(decision.trigger).toBe('winrate_down');
    expect(decision.next.adjustment).toBeLessThan(0);
  });

  it('a sinking win rate drives the offset POSITIVE (away from the top)', () => {
    const decision = stepGovernor(
      freshState({ ...settled, winrateEma: 0.1 }),
      midLadderInput({ won: false }),
    );
    expect(decision.trigger).toBe('winrate_up');
    expect(decision.next.adjustment).toBeGreaterThan(0);
  });

  it('an always-winning mid-ladder bot converges to the negative bound', () => {
    // Every step is allowed to move (cooldown re-satisfied by advancing time).
    let state = freshState();
    for (let i = 0; i < 400; i += 1) {
      const now = new Date(T0.getTime() + i * (COOLDOWN_MS + 1000));
      state = stepGovernor(state, midLadderInput({ won: true, now })).next;
    }
    expect(state.adjustment).toBe(-MAX_GOVERNOR_ADJUSTMENT);
    expect(state.winrateEma).toBeGreaterThan(0.9);
  });
});

describe('minimum sample gate', () => {
  it('does not adjust before MIN_SAMPLES_FOR_WINRATE samples', () => {
    let state = freshState();
    for (let i = 0; i < MIN_SAMPLES_FOR_WINRATE - 1; i += 1) {
      const now = new Date(T0.getTime() + i * (COOLDOWN_MS + 1000));
      const decision = stepGovernor(state, midLadderInput({ won: true, now }));
      expect(decision.next.adjustment).toBe(0);
      expect(decision.trigger).toBe('none');
      state = decision.next;
    }
    // The sample that reaches the threshold may finally act.
    const final = stepGovernor(
      state,
      midLadderInput({ won: true, now: new Date(T0.getTime() + 1000 * COOLDOWN_MS) }),
    );
    expect(final.next.winrateSamples).toBe(MIN_SAMPLES_FOR_WINRATE);
    expect(final.trigger).toBe('winrate_down');
  });
});

describe('cooldown prevents thrash', () => {
  it('cooldownElapsed requires BOTH the match count and the wall clock', () => {
    const anchored = freshState({
      updatedAt: T0,
      winrateSamples: 100,
      samplesAtAdjustment: 100,
    });
    // Neither elapsed.
    expect(cooldownElapsed(anchored, new Date(T0.getTime() + 1000))).toBe(false);
    // Time elapsed, matches not.
    expect(cooldownElapsed(anchored, new Date(T0.getTime() + COOLDOWN_MS + 1))).toBe(false);
    // Matches elapsed, time not.
    expect(
      cooldownElapsed(
        { ...anchored, winrateSamples: 100 + COOLDOWN_MATCHES },
        new Date(T0.getTime() + 1000),
      ),
    ).toBe(false);
    // Both elapsed.
    expect(
      cooldownElapsed(
        { ...anchored, winrateSamples: 100 + COOLDOWN_MATCHES },
        new Date(T0.getTime() + COOLDOWN_MS + 1),
      ),
    ).toBe(true);
  });

  it('a burst of wins inside one cooldown window moves the offset ONCE', () => {
    // Warm state, way above target, cooldown initially satisfied.
    let state = freshState({
      winrateEma: 0.95,
      winrateSamples: 100,
      updatedAt: new Date(T0.getTime() - 10 * COOLDOWN_MS),
      samplesAtAdjustment: 0,
    });
    const triggers: string[] = [];
    // 30 matches in the SAME minute — a burst, no wall-clock progress.
    for (let i = 0; i < 30; i += 1) {
      const decision = stepGovernor(
        state,
        midLadderInput({ won: true, now: new Date(T0.getTime() + i * 1000) }),
      );
      triggers.push(decision.trigger);
      state = decision.next;
    }
    expect(triggers.filter((t) => t === 'winrate_down')).toHaveLength(1);
    expect(state.adjustment).toBeCloseTo(-GOVERNOR_STEP, 10);
    // The EMA kept observing every one of the 30 matches.
    expect(state.winrateSamples).toBe(130);
  });

  it('a no-op decision does not re-arm the cooldown', () => {
    const lastMove = new Date(T0.getTime() - COOLDOWN_MS - 1000);
    const state = freshState({
      winrateEma: MID_LADDER_TARGET_WINRATE,
      winrateSamples: 100,
      updatedAt: lastMove,
      samplesAtAdjustment: 0,
    });
    // A loss folds 0.5 -> 0.45, which is inside the dead band -> no move.
    const decision = stepGovernor(state, midLadderInput({ won: false }));
    expect(decision.trigger).toBe('none');
    expect(decision.next.updatedAt).toBe(lastMove);
    expect(decision.next.samplesAtAdjustment).toBe(0);
  });
});

describe('TOP PROTECTION DOMINATES (§1.5 precedence)', () => {
  it('a bot near the top with a LOW win rate is still nerfed, never boosted', () => {
    // Everything about the win-rate arm screams "boost this bot": EMA far below
    // target, samples plentiful, cooldown long elapsed. Top-protection wins.
    const state = freshState({
      winrateEma: 0.05,
      winrateSamples: 500,
      updatedAt: new Date(T0.getTime() - 100 * COOLDOWN_MS),
      samplesAtAdjustment: 0,
    });
    const decision = stepGovernor(state, {
      botRp: 4000 - TOP_PROTECTION_MARGIN_RP + 10, // inside the warn ring
      humanTop10Rp: 4000,
      won: false,
      now: T0,
      enabled: true,
    });
    expect(decision.trigger).toBe('top_protection');
    expect(decision.next.adjustment).toBeLessThan(0);
    expect(decision.next.adjustment).toBeCloseTo(-TOP_PROTECTION_STEP, 10);
  });

  it('the critical ring pins the offset to the floor immediately', () => {
    const decision = stepGovernor(freshState({ winrateEma: 0.0, winrateSamples: 500 }), {
      botRp: 4000,
      humanTop10Rp: 4000,
      won: false,
      now: T0,
      enabled: true,
    });
    expect(decision.trigger).toBe('top_protection_critical');
    expect(decision.next.adjustment).toBe(-MAX_GOVERNOR_ADJUSTMENT);
  });

  it('top protection ignores the cooldown — safety is not rate limited', () => {
    // Offset was moved one second ago; the win-rate arm would be blocked.
    const state = freshState({
      winrateEma: 0.5,
      winrateSamples: 100,
      updatedAt: new Date(T0.getTime() - 1000),
      samplesAtAdjustment: 100,
    });
    const decision = stepGovernor(state, {
      botRp: 3900,
      humanTop10Rp: 4000,
      won: true,
      now: T0,
      enabled: true,
    });
    expect(decision.trigger).toBe('top_protection');
    expect(decision.next.adjustment).toBeCloseTo(-TOP_PROTECTION_STEP, 10);
  });

  it('a bot that climbs into the ring has its earlier boost undone', () => {
    // Phase 1: mid-ladder loser earns a positive offset.
    let state = freshState();
    for (let i = 0; i < 200; i += 1) {
      state = stepGovernor(
        state,
        midLadderInput({ won: false, now: new Date(T0.getTime() + i * (COOLDOWN_MS + 1000)) }),
      ).next;
    }
    expect(state.adjustment).toBeGreaterThan(0);

    // Phase 2: it climbs into the protection ring. Offset must go negative.
    for (let i = 0; i < 10; i += 1) {
      state = stepGovernor(state, {
        botRp: 3900,
        humanTop10Rp: 4000,
        won: false,
        now: new Date(T0.getTime() + (200 + i) * (COOLDOWN_MS + 1000)),
        enabled: true,
      }).next;
    }
    expect(state.adjustment).toBe(-MAX_GOVERNOR_ADJUSTMENT);
  });

  it('protection never fires when the top-10 RP is unknown', () => {
    const decision = stepGovernor(freshState({ winrateEma: 0.5, winrateSamples: 100 }), {
      botRp: 99999,
      humanTop10Rp: null,
      won: true,
      now: T0,
      enabled: true,
    });
    expect(decision.trigger).not.toBe('top_protection');
    expect(decision.trigger).not.toBe('top_protection_critical');
  });
});

describe('bounds hold under any sequence', () => {
  it('random win/loss sequences never leave +/- MAX_GOVERNOR_ADJUSTMENT', () => {
    // Deterministic pseudo-random sequence (no RNG dependency).
    let seed = 12345;
    const nextBool = (): boolean => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 2 === 0;
    };
    let state = freshState();
    for (let i = 0; i < 3000; i += 1) {
      const won = nextBool();
      // Sweep the bot across the whole ladder, including deep into the ring.
      const botRp = 500 + ((i * 37) % 4200);
      state = stepGovernor(state, {
        botRp,
        humanTop10Rp: 4000,
        won,
        now: new Date(T0.getTime() + i * (COOLDOWN_MS + 1000)),
        enabled: true,
      }).next;
      expect(state.adjustment).toBeGreaterThanOrEqual(-MAX_GOVERNOR_ADJUSTMENT);
      expect(state.adjustment).toBeLessThanOrEqual(MAX_GOVERNOR_ADJUSTMENT);
      expect(state.winrateEma).toBeGreaterThanOrEqual(0);
      expect(state.winrateEma).toBeLessThanOrEqual(1);
    }
  });

  it('an out-of-range stored offset is pulled back inside the bounds', () => {
    const decision = stepGovernor(
      freshState({ adjustment: 99, winrateEma: 0.5, winrateSamples: 100 }),
      { botRp: 3900, humanTop10Rp: 4000, won: true, now: T0, enabled: true },
    );
    expect(decision.next.adjustment).toBeLessThanOrEqual(MAX_GOVERNOR_ADJUSTMENT);
  });
});

describe('kill switch', () => {
  it('zeroes a non-zero offset while the EMA keeps observing', () => {
    const state = freshState({
      adjustment: -0.4,
      winrateEma: 0.8,
      winrateSamples: 50,
      samplesAtAdjustment: 20,
    });
    const decision = stepGovernor(state, midLadderInput({ won: true, enabled: false }));
    expect(decision.next.adjustment).toBe(0);
    expect(decision.trigger).toBe('disabled');
    expect(decision.next.winrateSamples).toBe(51);
    expect(decision.next.winrateEma).toBeCloseTo(0.82, 10);
  });

  it('holds at zero and never re-adjusts while disabled, even near the top', () => {
    let state = freshState({ adjustment: 0.5 });
    for (let i = 0; i < 50; i += 1) {
      state = stepGovernor(state, {
        botRp: 4000,
        humanTop10Rp: 4000,
        won: true,
        now: new Date(T0.getTime() + i * COOLDOWN_MS),
        enabled: false,
      }).next;
      expect(state.adjustment).toBe(0);
    }
  });

  it('resumes from the warm EMA when re-enabled', () => {
    // Observe 40 wins with the governor OFF.
    let state = runSequence(freshState(), Array(40).fill(true), (i) => ({
      ...midLadderInput({ now: new Date(T0.getTime() + i * (COOLDOWN_MS + 1000)) }),
      enabled: false,
    }));
    expect(state.adjustment).toBe(0);
    expect(state.winrateEma).toBeGreaterThan(0.9);

    // Re-enable: the very next match acts on the warm EMA (no cold start).
    const decision = stepGovernor(
      state,
      midLadderInput({ won: true, now: new Date(T0.getTime() + 999 * COOLDOWN_MS) }),
    );
    expect(decision.trigger).toBe('winrate_down');
  });
});

describe('state bookkeeping', () => {
  it('always advances the EMA and sample count, so the row is always written', () => {
    const decision = stepGovernor(freshState(), midLadderInput({ won: true }));
    expect(decision.changed).toBe(true);
    expect(decision.next.winrateSamples).toBe(1);
    expect(decision.next.winrateEma).toBe(1);
  });

  it('stamps both cooldown anchors when (and only when) the offset moves', () => {
    const state = freshState({
      winrateEma: 0.95,
      winrateSamples: 100,
      updatedAt: new Date(T0.getTime() - 10 * COOLDOWN_MS),
      samplesAtAdjustment: 5,
    });
    const moved = stepGovernor(state, midLadderInput({ won: true }));
    expect(moved.trigger).toBe('winrate_down');
    expect(moved.next.updatedAt).toEqual(T0);
    expect(moved.next.samplesAtAdjustment).toBe(101);
  });

  it('does not re-stamp when a step is a no-op at the bound', () => {
    // Already pinned at the floor and still winning: the step cannot move it.
    const lastMove = new Date(T0.getTime() - 10 * COOLDOWN_MS);
    const state = freshState({
      adjustment: -MAX_GOVERNOR_ADJUSTMENT,
      winrateEma: 0.95,
      winrateSamples: 100,
      updatedAt: lastMove,
      samplesAtAdjustment: 5,
    });
    const decision = stepGovernor(state, midLadderInput({ won: true }));
    expect(decision.next.adjustment).toBe(-MAX_GOVERNOR_ADJUSTMENT);
    expect(decision.trigger).toBe('none');
    expect(decision.next.updatedAt).toBe(lastMove);
    expect(decision.next.samplesAtAdjustment).toBe(5);
  });
});
