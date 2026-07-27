# Bot calibration pipeline (Season-1 → model params)

Offline, **prod-read-only** calibration that turns Season-1 human ranked history
into the persistent-bot gameplay model params (PR8 consumes them) and the frozen
Layer-1 ceiling constants. It writes NOTHING to any database — outputs are local
files for human review.

## What it produces

Into `--out` (default `scripts/bot-calibration/out/`):

- **`params.json`** — matches `bot_model_params.params`: the f(RP) curve knots,
  the ceiling block (top-cohort accuracy, margin, ceiling accuracy, speed floor,
  top-cohort timing), and the per-format easiness offsets.
- **`bot_model_params.insert.sql`** — an `INSERT … active=false` for review. It
  is **never applied automatically**; a human reviews and runs it deliberately.
- **`REPORT.md`** — cohort sizes, exclusion counts, the timeout-backfill
  signature, the f(RP) knot table, format offsets, holdout validation
  (AUC + calibration curve), timing distributions, and the **frozen Layer-1
  ceiling constants** printed as a copy-pasteable TS block for PR8.

## Read-only by construction

1. Connection string comes **only** from `CALIBRATION_DATABASE_URL` (never
   `DATABASE_URL`). Missing → the script refuses to run.
2. The session sets `default_transaction_read_only=on` and every query runs
   inside a `BEGIN TRANSACTION READ ONLY` block — Postgres rejects any write.
3. Every statement is screened as SELECT/WITH-only before it is sent
   (`assertSelectOnly`), as a secondary guard.

## Running it

Develop and test against the **local test DB**; only point it at prod when you
intend a real calibration.

```bash
# Local test DB (safe):
CALIBRATION_DATABASE_URL=postgresql://test:test@localhost:5432/test \
  npm run bot:calibrate -- --season 1 --min-answers 100 --margin-pp 4

# Prod pooler (read-only), modest smoke first via --limit:
CALIBRATION_DATABASE_URL='postgres://…@aws-1-eu-central-1.pooler.supabase.com:6543/postgres' \
  npm run bot:calibrate -- --season 1 --limit 200000
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--season N` | – | S1 season number to resolve the reset batch |
| `--batch-id UUID` | – | resolve the batch explicitly (overrides `--season`) |
| `--min-answers N` | 100 | min Bernoulli answers a player needs for a skill estimate |
| `--margin-pp N` | 4 | ceiling margin in percentage points below top-cohort accuracy |
| `--limit N` | – | cap Bernoulli answers scanned (smoke runs only — marked in the report) |
| `--out DIR` | `scripts/bot-calibration/out` | output directory |

## Exclusions (shared with the refresh job)

AI/seed/deleted users, dev matches, timeout backfills, and — for timing only —
the pre-`2026-07-06` corrupt window. Countdown answers are excluded from the
latent-skill logit (opponent-relative `is_correct`). The exclusion rules live in
`src/modules/bots/calibration/{constants,aggregate}.ts` so this script and the
`question_stats` refresh job can never drift.

## Method (short)

- **S1 scoping**: the fit set is Bernoulli answers from matches that ended
  BEFORE the reset batch (Season-1 only), by players who hold a **placed** S1
  archived profile. The placed intersection happens BEFORE fitting, anchoring,
  and top-cohort selection (not just at percentile-mapping time).
- **Bernoulli only**: only mcq_single / true_false / input_text (engine kind
  `multipleChoice`) feed the logit and smoothed accuracy. A backfill is exactly
  `selected_index IS NULL`. countdown / put-in-order / clues are modelled via
  payload-aware `format_stats` distributions, never the accuracy prior/logit.
- **Latent skill**: Rasch logit `P(correct)=sigmoid(θ_player − β_question)` (NO
  format term — β absorbs per-format difficulty; each question has one format).
  Optimizer is coordinate-normalized gradient ascent (per-parameter observation
  counts), so θ does not compress at production scale. **Convergence is
  enforced**: the script REFUSES to emit params if the refit did not converge.
- **Ceiling (no leakage)**: the top-10 cohort is selected on TRAIN θ; its ceiling
  accuracy is measured on HOLDOUT answers only; the final f(RP) then refits on
  ALL scoped rows. Both holdout and in-sample numbers are reported.
- **f(RP)**: percentile-anchors S2 RP onto the **fixed** S1 latent-skill
  distribution using **placed** S1 profiles (never live S2 percentiles).
- **Difficulty link**: a holdout-validated regression `β ≈ intercept + slope ·
  logit(question_stats.smoothed_accuracy)` so PR8 can recover β from
  question_stats and reproduce `sigmoid(θ − β)`.
- **Schema**: params.json is validated against the zod schema in
  `src/modules/bots/calibration/params-schema.ts` (PR8 imports it) BEFORE any
  file is written. It carries the θ-anchoring convention and the explicit clamps
  (final probability cap, skill cap, min answer time).

## Refresh job (`bot:refresh-question-stats`)

A full run does a complete latest-snapshot REPLACE: upsert every current row AND
delete obsolete question_stats / backoff rows atomically (delete-not-present).
`--limit` is a DRY RUN (computes a summary, writes nothing) — a limited scan
would otherwise persist arbitrary partial aggregates.
