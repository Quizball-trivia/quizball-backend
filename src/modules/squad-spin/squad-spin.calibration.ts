import { sql, type TransactionSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import {
  CALIBRATION_MAX_ACCURACY_BP,
  CALIBRATION_MAX_DAILY_DROP_BP,
  CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP,
  CALIBRATION_MIN_ACCURACY_BP,
  CALIBRATION_PRIOR_STRENGTH,
  CALIBRATION_RULES_VERSION,
  LAUNCH_HAIRCUT_BP,
  LAUNCH_HAIRCUT_MIN_SAMPLES,
  MARGIN_BP,
  PRICING_MAX_ACCURACY_BP,
  PRICING_SKILL_GAP_BP,
  SQUAD_SPIN_TIERS,
  TIER_PRIOR_ACCURACY_BP,
  fairStepBp,
  type SquadSpinTier,
} from './squad-spin.constants.js';
import { squadSpinRepo } from './squad-spin.repo.js';
import type { SquadSpinCalibrationRow, StepsSnapshot } from './squad-spin.types.js';

export interface TierObservation { tier: SquadSpinTier; correct: number; total: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Blends the cold-start prior with the human answers of the window (prior worth
 * CALIBRATION_PRIOR_STRENGTH observations), clamps to a sane band, never lets
 * the accuracy drift more than CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP under the
 * prior, and lets it fall by at most CALIBRATION_MAX_DAILY_DROP_BP per snapshot.
 * Steps are then priced PRICING_SKILL_GAP_BP above the measured accuracy.
 * Deterministic and pure so the pricing invariants are unit-testable.
 */
export function computeCalibration(
  observations: readonly TierObservation[],
  previous: Pick<SquadSpinCalibrationRow, 'accuracy_bp'> | null,
): { accuracy: Record<SquadSpinTier, number>; steps: StepsSnapshot; samples: Record<SquadSpinTier, number> } {
  const byTier = new Map(observations.map((row) => [row.tier, row]));
  const accuracy = {} as Record<SquadSpinTier, number>;
  const samples = {} as Record<SquadSpinTier, number>;
  for (const tier of SQUAD_SPIN_TIERS) {
    const observed = byTier.get(tier) ?? { tier, correct: 0, total: 0 };
    const prior = TIER_PRIOR_ACCURACY_BP[tier];
    const blended = Math.round((CALIBRATION_PRIOR_STRENGTH * prior + observed.correct * 10_000) / (CALIBRATION_PRIOR_STRENGTH + observed.total));
    let value = clamp(blended, Math.max(CALIBRATION_MIN_ACCURACY_BP, prior - CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP), CALIBRATION_MAX_ACCURACY_BP);
    const previousValue = previous?.accuracy_bp?.[tier];
    if (previousValue != null) value = Math.max(value, previousValue - CALIBRATION_MAX_DAILY_DROP_BP);
    accuracy[tier] = value;
    samples[tier] = observed.total;
  }
  const seasoned = SQUAD_SPIN_TIERS.every((tier) => samples[tier] >= LAUNCH_HAIRCUT_MIN_SAMPLES);
  const margin = seasoned ? MARGIN_BP : Math.floor((MARGIN_BP * LAUNCH_HAIRCUT_BP) / 10_000);
  const priced = (tier: SquadSpinTier) => fairStepBp(Math.min(PRICING_MAX_ACCURACY_BP, accuracy[tier] + PRICING_SKILL_GAP_BP));
  const steps: StepsSnapshot = { t3e: priced('t3e'), t3m: priced('t3m'), t4: priced('t4'), t5: priced('t5'), margin };
  return { accuracy, steps, samples };
}

/**
 * One immutable snapshot per UTC day. Round starts take the indexed fast path; the
 * first start of a day publishes under a transaction-scoped advisory lock so
 * replicas cannot publish twice.
 */
export async function ensureDailyCalibration(tx: TransactionSql): Promise<SquadSpinCalibrationRow> {
  const day = await squadSpinRepo.getDatabaseDay(tx);
  const existing = await squadSpinRepo.getCalibration(tx, day);
  if (existing) return existing;
  await squadSpinRepo.lockCalibrationPublisher(tx);
  const raced = await squadSpinRepo.getCalibration(tx, day);
  if (raced) return raced;
  const previous = await squadSpinRepo.getLatestCalibrationBefore(tx, day);
  const observations = await squadSpinRepo.getHumanTierObservations(tx);
  const computed = computeCalibration(observations, previous);
  const row = await squadSpinRepo.insertCalibration(tx, { publicationDay: day, ...computed, rulesVersion: CALIBRATION_RULES_VERSION });
  logger.info({ day, accuracy: computed.accuracy, steps: computed.steps, samples: computed.samples }, 'squad-spin daily calibration published');
  return row;
}

export const publishDailyCalibration = (): Promise<SquadSpinCalibrationRow> => sql.begin((tx) => ensureDailyCalibration(tx));
