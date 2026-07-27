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

- **Latent skill**: Rasch-style logit `P(correct)=sigmoid(θ_player − β_question +
  γ_format)` fit by L2-regularized gradient ascent (mean-anchored θ and γ). Only
  players with `≥ --min-answers` are estimated. Validated on an 80/20 holdout
  (AUC + calibration curve).
- **f(RP)**: percentile-anchors S2 RP onto the **fixed** S1 latent-skill
  distribution using **placed** S1 profiles (never live S2 percentiles).
- **Ceiling**: top-10 players by latent skill → aggregate accuracy − margin =
  the frozen `S1_CEILING_ACCURACY`; their clean-window answer-time percentiles →
  the speed floor.
