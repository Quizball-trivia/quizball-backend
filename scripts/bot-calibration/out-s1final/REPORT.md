# Season-1 Bot Calibration Report

Generated: 2026-07-27T20:14:44.653Z
S1 batch: `faa0bedc-8b48-4b8b-81d8-b86bae6ccc62` (season 1), boundary Tue Jul 21 2026 01:27:36 GMT+0400 (Georgia Standard Time)

## Frozen Layer-1 ceiling constants (for PR8)

Immutable, non-CMS-tunable backstops PR8 bakes into code. Copy verbatim.

```ts
// Season-1 calibration — Layer-1 hard backstop (immutable at runtime).
export const S1_TOP_COHORT_ACCURACY_HOLDOUT = 0.9031;
export const S1_CEILING_MARGIN_PP = 4;
export const S1_CEILING_ACCURACY = 0.8631; // holdout accuracy − margin
export const S1_TOP_MEDIAN_TIME_MS = 1184;
export const S1_TOP_LOG_TIME_SIGMA = 0.7190;
export const S1_SPEED_FLOOR_MS = {
  p10: 469,
  p25: 813,
  p50: 1184,
};
export const FINAL_PROB_CAP = 0.93;
export const SKILL_CAP = 4;
export const MIN_ANSWER_TIME_MS = 600;
```

Top cohort: 10 players. Ceiling accuracy measured on HOLDOUT: 90.3% (in-sample 91.1%, for reference). Ceiling = holdout − 4pp = 86.3%.

## Cohort sizes & MEASURED exclusions

| Metric | Value |
| --- | --- |
| Placed S1 profiles (non-AI/seed/deleted) | 1816 |
| S1 Bernoulli answers (placed, pre-boundary, non-backfill) | 645393 |
| Eligible players (≥ 100 answers) | 1078 |
| Fit train / holdout rows | 484645 / 121648 |
| Players joined for f(RP) (placed ∩ skill) | 1078 |

### question_stats aggregation exclusion counts (MEASURED, whole-DB scan)

| Metric | Value |
| --- | --- |
| Total eligible answer rows scanned | 1109541 |
| Bernoulli rows | 791528 |
| Bernoulli backfills excluded (selected_index NULL) | 15461 |
| Special-format rows (countdown/put-in-order/clues) | 318013 |
| Bernoulli rows outside timing clean-window | 551261 |
| question_stats rows built | 13898 |
| backoff rows built | 79 |
| global Bernoulli mean accuracy | 62.6% |

### Format distribution (all scanned answers by question type)

| type | answers |
| --- | --- |
| mcq_single | 791528 |
| put_in_order | 156757 |
| clue_chain | 154444 |
| countdown_list | 6812 |

### Exclusion rules

- AI / seed / deleted users; dev matches; only `mode=ranked, status=completed`.
- **Bernoulli set** = mcq_single / true_false / input_text (engine kind `multipleChoice`). Only these feed accuracy + the latent-skill logit.
- **Backfill** (Bernoulli) = `selected_index IS NULL` — a genuine multiple-choice answer always persists a non-null index. The old time_ms-conjunction was dropped: clue chains vary in length and a real countdown player can persist the backfill signature (resolver fires a zero-valued insert before reading the real result, ON CONFLICT DO NOTHING).
- **countdown / put-in-order / clues** never enter accuracy/timing (countdown is opponent-relative; specials are partial-credit and their backfills are indistinguishable). They are modelled via payload-aware `format_stats` distributions.
- **Timing clean-window**: only `answered_at >= 2026-07-05T00:00:00Z` feeds median/sigma; accuracy ignores the window. Accuracy and timing back off INDEPENDENTLY (each with its own sample count).

## Accuracy by question difficulty (Bernoulli, whole population)

| difficulty | answers | mean accuracy |
| --- | --- | --- |
| easy | 440165 | 71.4% |
| hard | 136004 | 43.7% |
| medium | 199898 | 56.1% |

## Latent-skill fit & validation

- Model: `sigmoid(theta_player − beta_question)` (no format term — beta absorbs format difficulty; each question has one format).
- Fit converged: **true** (iters 128, final mean-abs update 9.81e-5).
- Holdout AUC: 0.808.

### Holdout calibration curve

| bin | n | mean predicted | observed |
| --- | --- | --- | --- |
| 0.0–0.1 | 1830 | 7.2% | 14.5% |
| 0.1–0.2 | 6580 | 15.4% | 20.5% |
| 0.2–0.3 | 8835 | 25.2% | 27.8% |
| 0.3–0.4 | 10545 | 35.1% | 35.1% |
| 0.4–0.5 | 11219 | 45.1% | 42.9% |
| 0.5–0.6 | 12742 | 55.1% | 53.4% |
| 0.6–0.7 | 13703 | 65.1% | 63.7% |
| 0.7–0.8 | 15258 | 75.1% | 75.2% |
| 0.8–0.9 | 17742 | 85.2% | 85.6% |
| 0.9–1.0 | 21210 | 95.0% | 95.2% |

## Difficulty link (PR8 recovers beta from question_stats)

`beta_question ≈ intercept + slope · logit(question_stats.smoothed_accuracy)`.
Slope is negative (higher accuracy → lower difficulty).

| param | value |
| --- | --- |
| intercept | 0.4322 |
| slope | -1.4784 |
| holdout R² | 0.874 |
| holdout RMSE (beta units) | 0.473 |
| questions in link | 6249 |

## f(RP) → skill curve (fixed S1 scale, placed profiles)

| RP | skill (logit θ) |
| --- | --- |
| 315 | -0.9106 |
| 425 | -0.7148 |
| 671 | -0.4293 |
| 889 | -0.2028 |
| 1008 | -0.0771 |
| 1196 | 0.0854 |
| 1739 | 0.3193 |
| 4015 | 0.8160 |
| 8983 | 1.2060 |

## Speed (top-cohort answer times)

Top-cohort median 1184 ms, ln-time σ 0.719.

| percentile | time (ms) |
| --- | --- |
| p10 | 469 |
| p25 | 813 |
| p50 | 1184 |
