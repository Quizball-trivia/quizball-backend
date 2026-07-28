/**
 * The rubber-band governor state machine (PR9, plan §1.5 Layer 3).
 *
 * PURE and IO-free: given a bot's stored governor state, the settled result of
 * one ranked match against a human, and the live rank context, it returns the
 * next state. All persistence, querying and scheduling live in the service.
 *
 * WHAT IT DOES
 * The gameplay model (PR8) fixes a bot's per-question accuracy from its RP.
 * That is an OPEN loop: it says nothing about the realized WIN RATE, which also
 * depends on the opponent mix. The governor is the CLOSED loop — it nudges an
 * effective-skill offset (theta units) so a bot's win rate against humans drifts
 * back into its target band, and — far more importantly — so no bot parks itself
 * in the human top 10.
 *
 * THE FOUR MECHANISMS (all required by §1.5, all deterministic)
 *   1. EMA        — win rate is smoothed over settled human matches, so one
 *                   lucky night cannot move the offset.
 *   2. Hysteresis — the offset only moves when the EMA leaves a DEAD BAND around
 *                   the target; inside the band nothing happens. Prevents a bot
 *                   sitting exactly on the boundary from flipping every match.
 *   3. Cooldown   — a minimum number of settled matches AND wall-clock time
 *                   between adjustments, so a burst of matches cannot ratchet
 *                   the offset in one direction.
 *   4. Bounds     — the offset is hard-bounded to +/- MAX_GOVERNOR_ADJUSTMENT.
 *
 * PRECEDENCE (the rule that matters most)
 * Top-protection DOMINATES the win-rate signal, unconditionally. When a bot is
 * within the protection margin of the #10 human's RP, the governor may only
 * push the offset DOWN (toward losing). A low win rate inside the protected zone
 * NEVER earns a boost — that is exactly the be#175 failure mode (bots buffed
 * into the leaderboard). Top-protection also ignores the cooldown for downward
 * moves: keeping bots out of the top 10 is a safety property, and safety is not
 * rate-limited.
 *
 * RELATIONSHIP TO THE HARD CLAMPS (never weakened)
 * The offset produced here is one ADDEND inside baseSkillTheta() — it is applied
 * BEFORE effectiveSkillCap() clamps theta and BEFORE the per-question
 * effectiveProbCap(). So a maximally positive governor offset still cannot raise
 * a bot above HARD_PROB_CAP / HARD_SKILL_CAP; the clamps run strictly after.
 * governor-clamp-order.test.ts asserts this ordering.
 *
 * KNOWN LIMITS OF THE CONTROL AUTHORITY (deliberate, documented for the soak)
 *  - SPECIAL FORMATS. The offset moves theta, which drives the Bernoulli
 *    (multiple-choice) path. Countdown / put-in-order / clue outcomes are
 *    sampled from calibrated format_stats histograms and only consult skill in
 *    their no-distribution FALLBACK (persistent-bot-gameplay.ts). So the
 *    governor's authority over a match is partial, and a bot whose matches are
 *    format-heavy responds more slowly. This is a PR8 modelling property, not
 *    something PR9 changes; making the histograms skill-conditional is the
 *    proper fix and belongs with the model, not the controller. The top-10
 *    backstop does not depend on it (RP-proximity still nerfs the MCQ path).
 *  - RANK LATENCY. Top-protection reacts at SETTLEMENT, so it changes the
 *    NEXT match, never the one that crossed the line. Combined with the 60s
 *    top-10 snapshot, a bot can briefly appear inside the human top 10 before
 *    the ring bites. The margins (150 RP ring / 400 RP band) are sized to start
 *    pushing back well before that; a hard "never rank a bot top-10" guarantee
 *    would need a leaderboard-level exclusion or an RP cap, which is a product
 *    decision outside this controller.
 */

/** Bounded offset in theta (logit) units. Deliberately small: this trims, never re-skills. */
export const MAX_GOVERNOR_ADJUSTMENT = 0.5;

/** One adjustment step. Small enough that the loop settles instead of ringing. */
export const GOVERNOR_STEP = 0.1;

/**
 * A larger step when top-protection fires: the bot must fall away from the top
 * quickly, not over dozens of matches.
 */
export const TOP_PROTECTION_STEP = 0.25;

/** EMA smoothing factor per settled human match (~ a 20-match memory). */
export const WINRATE_EMA_ALPHA = 0.1;

/**
 * Minimum settled human matches before the WIN-RATE arm may act at all. Below
 * this the EMA is pure noise (one win = 100%). Top-protection is NOT gated on
 * this — it acts from the very first match.
 */
export const MIN_SAMPLES_FOR_WINRATE = 15;

/** Settled human matches that must pass between two win-rate adjustments. */
export const COOLDOWN_MATCHES = 10;

/** Wall-clock cooldown between two win-rate adjustments. */
export const COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Hysteresis dead band (half-width) around the target win rate. The offset moves
 * only when the EMA is further than this from target — so a bot hovering at the
 * band edge does not oscillate.
 */
export const HYSTERESIS_BAND = 0.05;

/**
 * Float tolerance for the dead-band comparison. The EMA is built from repeated
 * `x + 0.1*(y-x)` steps, so a value that is mathematically EXACTLY on the band
 * edge (e.g. 0.5 -> 0.55 against a 0.05 band) lands a few ULPs outside it
 * (0.55000000000000004). Without this tolerance a bot parked precisely at the
 * edge would adjust every single match — the exact oscillation the dead band
 * exists to prevent. Far smaller than any meaningful win-rate difference.
 */
const BAND_EPSILON = 1e-9;

/**
 * Per-band target win rates (§1.5: ~40-45% top band, ~45-55% mid-ladder). We
 * steer to the CENTRE of each band; the hysteresis band then reproduces the
 * width, so no adjustment happens anywhere inside the intended range.
 */
export const TOP_BAND_TARGET_WINRATE = 0.425;
export const MID_LADDER_TARGET_WINRATE = 0.5;

/**
 * How close (in RP) a bot may come to the #10 human before top-protection
 * engages. Wide on purpose: the governor is slow, so it must start pushing back
 * well before the bot is actually threatening a top-10 slot.
 */
export const TOP_PROTECTION_MARGIN_RP = 150;

/**
 * A second, tighter ring. Inside it the bot is close enough that the governor
 * pins the offset to the floor immediately rather than stepping down.
 */
export const TOP_PROTECTION_CRITICAL_RP = 50;

/**
 * The TOP BAND for win-rate purposes, deliberately WIDER than the protection
 * ring (Sol finding #2 + #4).
 *
 * Two things depend on this being wider:
 *
 * (a) REACHABILITY. Inside the protection ring stepGovernor returns from the
 *     top-protection branch before the win-rate arm ever runs, so if the
 *     top-band target were keyed on the ring itself it would be unreachable
 *     dead code and the documented 40-45% steering would not exist. Keying it
 *     on this wider zone means bots APPROACHING the top — the ones the target
 *     is actually about — steer to 42.5% under the ordinary win-rate arm.
 *
 * (b) NO RINGING AT THE BOUNDARY. A bot that just fell out of the ring sits in
 *     the band between the two radii. There the win-rate arm targets 42.5%, so
 *     its nerf-depressed EMA does not immediately read as "losing too much" and
 *     buy back a boost that would push it straight back into the ring. The gap
 *     between the ring and this zone IS the hysteresis on the rank axis.
 */
export const TOP_BAND_MARGIN_RP = 400;

export type GovernorTrigger =
  | 'none'
  | 'winrate_up'
  | 'winrate_down'
  | 'top_protection'
  | 'top_protection_critical'
  | 'disabled';

/** Persisted per-bot governor state (synthetic_player_profiles governor columns). */
export interface GovernorState {
  /** Current effective-skill offset in theta units, always within the bounds. */
  adjustment: number;
  /** EMA of "did this bot win vs a human", or null before the first sample. */
  winrateEma: number | null;
  /** Count of settled human matches folded into the EMA. */
  winrateSamples: number;
  /** When the ADJUSTMENT last changed (cooldown anchor); null if never. */
  updatedAt: Date | null;
  /**
   * winrateSamples as of the last adjustment — the match-count half of the
   * cooldown. Persisted so a burst of matches inside one wall-clock window
   * cannot ratchet the offset (governor_samples_at_adjustment).
   */
  samplesAtAdjustment: number;
}

/** Everything about the world the state machine needs for one decision. */
export interface GovernorInput {
  /** The bot's RP AFTER this match settled. */
  botRp: number;
  /**
   * RP of the #10 human on the live leaderboard, or null when unknown (fewer
   * than 10 placed humans, or the snapshot query failed). Null DISABLES the
   * top-protection arm — it must never fire on a guess.
   */
  humanTop10Rp: number | null;
  /** Did the bot WIN this settled match against a human? */
  won: boolean;
  /** Settlement time — the cooldown clock. */
  now: Date;
  /** Kill switch: when false, every offset collapses to 0. */
  enabled: boolean;
}

export interface GovernorDecision {
  next: GovernorState;
  /** Why the adjustment moved (or didn't) — surfaced in telemetry + logs. */
  trigger: GovernorTrigger;
  /** True when `next` differs from the input state and must be persisted. */
  changed: boolean;
}

function clampAdjustment(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_GOVERNOR_ADJUSTMENT, Math.max(-MAX_GOVERNOR_ADJUSTMENT, value));
}

/** Round to 4dp so a float-drift-only delta never counts as a change to persist. */
function quantize(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Fold one match result into the EMA. The FIRST sample seeds the EMA with the
 * raw outcome (0 or 1) rather than pulling a 0.5 prior toward itself — a prior
 * would take ~20 matches to shake off and would make early behaviour depend on
 * an invented value.
 */
export function updateWinrateEma(previous: number | null, won: boolean): number {
  const outcome = won ? 1 : 0;
  if (previous == null) return outcome;
  return previous + WINRATE_EMA_ALPHA * (outcome - previous);
}

/**
 * The bot's target win rate: the lower top-band figure once it is within
 * TOP_BAND_MARGIN_RP of the #10 human, else mid-ladder.
 *
 * Keyed on TOP_BAND_MARGIN_RP (400) rather than the protection ring (150) so
 * the target is actually REACHABLE — inside the ring the top-protection branch
 * returns before the win-rate arm runs, so a ring-keyed target would be dead
 * code. See TOP_BAND_MARGIN_RP.
 *
 * With an unknown top-10 RP we cannot place the bot on the ladder at all, so we
 * assume mid-ladder (the protection arm is disabled in that case regardless).
 */
export function targetWinrate(botRp: number, humanTop10Rp: number | null): number {
  if (humanTop10Rp == null || !Number.isFinite(humanTop10Rp)) return MID_LADDER_TARGET_WINRATE;
  return botRp >= humanTop10Rp - TOP_BAND_MARGIN_RP
    ? TOP_BAND_TARGET_WINRATE
    : MID_LADDER_TARGET_WINRATE;
}

/**
 * How deep into the protected zone the bot is.
 *   'critical' — at/above (#10 human RP − TOP_PROTECTION_CRITICAL_RP): about to
 *                take a top-10 slot. Offset is pinned to the floor at once.
 *   'warn'     — at/above (#10 human RP − TOP_PROTECTION_MARGIN_RP): approaching.
 *                Offset steps down, cooldown bypassed.
 *   'clear'    — outside the ring, or the top-10 RP is unknown.
 */
export function topProtectionZone(
  botRp: number,
  humanTop10Rp: number | null,
): 'clear' | 'warn' | 'critical' {
  if (humanTop10Rp == null || !Number.isFinite(humanTop10Rp)) return 'clear';
  if (botRp >= humanTop10Rp - TOP_PROTECTION_CRITICAL_RP) return 'critical';
  if (botRp >= humanTop10Rp - TOP_PROTECTION_MARGIN_RP) return 'warn';
  return 'clear';
}

/**
 * Have BOTH cooldown halves elapsed since the offset last moved? A bot that has
 * never been adjusted (updatedAt null) is free to move immediately.
 */
export function cooldownElapsed(state: GovernorState, now: Date): boolean {
  if (state.updatedAt == null) return true;
  if (state.winrateSamples - state.samplesAtAdjustment < COOLDOWN_MATCHES) return false;
  return now.getTime() - state.updatedAt.getTime() >= COOLDOWN_MS;
}

/**
 * Advance the governor by ONE settled ranked match against a human.
 *
 * Order of precedence, highest first:
 *   0. Kill switch off  -> offset forced to 0 (bots run on base calibrated skill).
 *   1. Top-protection   -> may only DECREASE the offset; ignores cooldown and
 *                          the minimum-sample gate; overrides any win-rate signal.
 *   2. Win-rate arm     -> symmetric step toward the per-band target, gated by
 *                          minimum samples, the hysteresis dead band, and the
 *                          cooldown.
 *
 * The EMA is ALWAYS updated (even when the offset does not move, and even while
 * the kill switch is off) so telemetry keeps observing reality and a re-enable
 * starts from a warm, honest estimate.
 *
 * The returned state is ALWAYS meant to be persisted: even when the offset does
 * not move, the EMA and sample count advanced.
 */
export function stepGovernor(state: GovernorState, input: GovernorInput): GovernorDecision {
  // The EMA always advances, whatever the arms decide below.
  const observed: GovernorState = {
    adjustment: state.adjustment,
    winrateEma: updateWinrateEma(state.winrateEma, input.won),
    winrateSamples: state.winrateSamples + 1,
    updatedAt: state.updatedAt,
    samplesAtAdjustment: state.samplesAtAdjustment,
  };

  /**
   * Commit an offset value: re-stamps the cooldown anchors only when the offset
   * ACTUALLY moved, so a no-op decision never extends the cooldown.
   */
  const settle = (rawAdjustment: number, trigger: GovernorTrigger): GovernorDecision => {
    const adjustment = quantize(clampAdjustment(rawAdjustment));
    const moved = adjustment !== quantize(state.adjustment);
    return {
      next: {
        ...observed,
        adjustment,
        updatedAt: moved ? input.now : state.updatedAt,
        samplesAtAdjustment: moved ? observed.winrateSamples : state.samplesAtAdjustment,
      },
      trigger: moved ? trigger : 'none',
      changed: true, // the EMA advanced, so the row is always written
    };
  };

  // 0. KILL SWITCH. The offset collapses to zero; the EMA keeps observing so a
  //    re-enable resumes from a warm estimate instead of a cold start.
  if (!input.enabled) return settle(0, 'disabled');

  // 1. TOP PROTECTION — dominates everything below. Downward only, no cooldown,
  //    no minimum-sample gate. Keeping bots out of the top 10 is a safety
  //    property, and safety is not rate-limited.
  const zone = topProtectionZone(input.botRp, input.humanTop10Rp);
  if (zone === 'critical') return settle(-MAX_GOVERNOR_ADJUSTMENT, 'top_protection_critical');
  if (zone === 'warn') {
    // Math.min pins this arm to nerf-only: it can never raise the offset.
    return settle(Math.min(state.adjustment - TOP_PROTECTION_STEP, state.adjustment), 'top_protection');
  }

  // 2. WIN-RATE ARM — only ever reached OUTSIDE the protected zone, so a low win
  //    rate near the top can never earn a boost (the be#175 failure mode).
  if (observed.winrateSamples < MIN_SAMPLES_FOR_WINRATE) {
    return { next: observed, trigger: 'none', changed: true };
  }
  const error = (observed.winrateEma ?? 0) - targetWinrate(input.botRp, input.humanTop10Rp);
  if (Math.abs(error) <= HYSTERESIS_BAND + BAND_EPSILON) {
    // Inside the dead band: this IS the intended win-rate range, do nothing.
    return { next: observed, trigger: 'none', changed: true };
  }
  if (!cooldownElapsed(observed, input.now)) {
    return { next: observed, trigger: 'none', changed: true };
  }

  // Winning too much -> lower the offset; losing too much -> raise it.
  const direction = error > 0 ? -1 : 1;
  return settle(
    state.adjustment + direction * GOVERNOR_STEP,
    direction < 0 ? 'winrate_down' : 'winrate_up',
  );
}
