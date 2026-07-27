# Persistent-bot burn-in engine (PR6)

One-time, per-environment engine that gives every persistent roster bot a
plausible season-to-date: 3 placement matches + backdated ranked bot-vs-bot
fixtures, settled through the REAL Season-2026 RP formula, with every bot's
final RP hard-capped below the live human top-10. Run staging first.

## Prerequisites

- Persistent roster rows must already exist: `users` (`is_ai=true`,
  `ai_kind='persistent'`), `synthetic_player_profiles` (base_skill, daily_cap,
  schedule, status), and optionally `ranked_profiles` (missing rows are
  treated as season-fresh).
- A zod-validated calibration params file (`--params`), parsed by
  `parseBotModelParams` from `src/modules/bots/calibration/params-schema.ts`.
- `DATABASE_URL` available via `.env.local` or `.env` (both are loaded, with
  `.env.local` taking precedence).
- At least 2 roster bots and at least one active category
  (`categories.is_active = true`); the engine throws otherwise.

## Commands

### Dry-run (default — no writes)

```bash
npm run bot:burnin -- --params <path> [--limit N] [--seed N] [--target N] [--margin-rp N] [--run-date ISO]
```

Simulates the full fixture plan in memory and prints the distribution report
(bots, planned fixtures, matches/bot, hard-ceiling check, band targets vs.
actual, sample bot timelines). Zero writes.

### Execute (writes — requires `--snapshot-out`)

```bash
npm run bot:burnin -- --params <path> --execute --snapshot-out snap.json [--receipt-out receipt.json]
```

Runs the same simulation, then (if the ceiling holds and the burn-in hasn't
already run) snapshots pre-run state, writes the backdated fixtures, and marks
the environment as burned in.

### Rollback

```bash
npm run bot:burnin:rollback -- --receipt receipt.json --snapshot snap.json
```

Reverts a burn-in run using its receipt (created match ids) and its pre-run
snapshot.

### Flags (`index.ts`)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--params <file>` | — (required) | zod-validated calibration params JSON |
| `--seed N` | `20260721` | RNG seed; also derives per-bot RNG streams and fixture keys |
| `--target N` | `22` | per-bot fixture-count target (population median inside the 15-40 band) |
| `--margin-rp N` | `200` | RP margin subtracted from human top-10 to get the hard ceiling |
| `--limit N` | none (all) | cap on roster size loaded (highest base_skill first) |
| `--run-date ISO` | `new Date()` (now) | simulated "as of" date the backfill runs up to |
| `--execute` | off (dry-run) | perform real writes instead of simulating |
| `--snapshot-out <file>` | none | required with `--execute`; pre-run state for rollback |
| `--receipt-out <file>` | `<snapshot-out base>.receipt.json` | where the creation receipt is written |

Season start is a fixed constant, `SEASON_START = 2026-07-21T00:00:00Z`, used
to compute each bot's day budget (`daysSinceReset × dailyCap`).

The ceiling itself: `humanTop10Rp - marginRp` when at least one placed human
profile exists (falls back to the lowest available placed human RP if fewer
than 10), else a conservative `1500 - marginRp`.

## Safety model

- **Dry-run is the default.** No DB writes happen unless `--execute` is
  passed.
- **`--execute` requires `--snapshot-out`.** The script throws immediately
  otherwise — there is no way to write without a way to revert.
- **Hard-ceiling abort.** If the simulated distribution's max bot RP exceeds
  the ceiling (`report.ceilingRespected === false`), `--execute` aborts before
  any write.
- **One-time marker.** `bot_model_params` gets a row with
  `note = 'persistent-bot-burnin:complete'` after a successful execute. A
  second `--execute` on the same environment checks for this marker first and
  refuses to run. Rollback deletes this row so the environment can be
  re-burned afterward.
- **Per-fixture idempotency.** Each planned fixture's match id is a
  deterministic UUID derived by hashing its fixture key
  (`fixtureMatchId` in `writer.ts`). The match insert and the downstream
  settlement/XP calls are each idempotent on that id, so a crashed or
  interrupted run can simply be re-invoked and resumes without duplicating
  fixtures. The receipt is flushed to disk every 50 fixtures during the run
  for the same reason.
- **Rollback verification.** For every match id in the receipt, rollback
  reads its `match_players` rows and refuses to touch any match whose
  participants aren't ALL in the receipt's roster set — it will never delete
  a match that involves a human or non-roster bot. Verified matches have
  their `ranked_rp_changes` and `user_xp_events` (source_type='match_result')
  rows deleted, then the match rows themselves (cascades to
  `match_players`/`match_answers`). Every roster bot's `ranked_profiles` +
  `users.total_xp` are then restored from the snapshot; if a bot had no
  profile before the run, rollback deletes the profile and its
  `user_mode_match_stats` ranked row instead of restoring blank values. The
  one-time marker is cleared in the same transaction.

## What it writes (execute mode)

Per fixture, via the real production settlement path
(`matchesService.completeMatch` → `rankedService.settleCompletedRankedMatch`
→ `progressionService.awardCompletedMatchXp`, all called with the fixture's
backdated timestamp):

- `matches` (one row, `mode='ranked'`, `is_dev=false`, backdated `started_at`)
- `match_players` (both bot seats, with points/goals from the simulation)
- `ranked_profiles` (RP, tier, placement, streak — via real settlement)
- `ranked_rp_changes` (ledger rows)
- `user_mode_match_stats` (ranked aggregation, since `is_dev=false`)
- `users.total_xp` (via `awardCompletedMatchXp`)

It does **not** write coins, tickets, notifications, or analytics events —
persistent bots are treated as AI for economy/analytics purposes by the
settlement and XP code paths themselves (not special-cased in this script),
so those side effects never fire for burn-in matches.

## Also produced

- **Dry-run report** (`report.ts`, printed to stdout): roster bot count,
  planned fixture count, matches/bot (min/median/mean/max), hard-ceiling
  check (human #10 RP, ceiling RP, max bot RP, respected Y/N), ladder band
  target vs. actual counts, and sample timelines for the 3 strongest, 3
  weakest, and 2 median bots (nickname, skill, final RP, tier, W-L record).
- **Snapshot file** (`--snapshot-out`): pre-run `ranked_profiles` + `total_xp`
  for every roster bot, plus run metadata (seed, env, ceiling, margin).
- **Receipt file** (`--receipt-out`): created match ids, fixture keys, roster
  user ids, seed, and env — the only input rollback needs besides the
  snapshot.
