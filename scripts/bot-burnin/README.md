# Persistent-bot burn-in engine (PR6)

One-time, per-environment engine that gives every persistent roster bot a
plausible season-to-date: placement matches + backdated ranked bot-vs-bot
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
- `PERSISTENT_BOTS` flag must be OFF — burn-in is a pristine-state operation
  that must run before selection ever activates.

## Architecture: plan-all-then-execute-in-chronological-chunks

**PLAN** is a pure function of immutable inputs: seed, the explicit season
window (start + end), roster membership + each bot's fixed hidden ability
(base_skill/dailyCap/schedule/status), the target fixture count, the ceiling
margin, the calibration params, and the active category set. Every bot is
simulated from the pristine baseline (450 RP, unplaced, 0 games) and the
live-derived ceiling (human top-10 RP − margin) is enforced during pairing, so
the plan can never produce a fixture that would push a bot over it.

**EXECUTE** writes the plan in chronological CHUNKS (default 250 fixtures),
each chunk in its own committed transaction, in the scheduler's chronological
order. Each chunk-tx takes the xact advisory lock, re-checks the one-time
marker inside the transaction, and writes its fixtures; the `'complete'`
marker is inserted only in the FINAL chunk's transaction.

Burn-in **IS idempotently resumable.** A crash leaves a committed
chronological PREFIX — every bot's history up to that point is
self-consistent — and only the in-flight chunk rolls back. Re-running with
the SAME inputs re-plans identically and SKIPS already-written fixtures (by
deterministic match id), resuming from the first unwritten one, then writes
the one-time `'complete'` marker in the final chunk's transaction. There is
still no snapshot, no receipt, no ownership token.

## Commands

### Dry-run (default — no writes)

```bash
npm run bot:burnin -- --params <path> [--limit N] [--seed N] [--target N] [--margin-rp N] [--season-start ISO] [--season-end ISO]
```

Simulates the full fixture plan in memory and prints the distribution report
(bots, planned fixtures, matches/bot, hard-ceiling check, band targets vs.
actual, sample bot timelines). Zero writes. `--season-end` defaults to now();
`--limit` caps roster size loaded (highest base_skill first).

### Execute (writes — chronological chunk batches, resumable)

```bash
npm run bot:burnin -- --params <path> --execute --season-end <ISO> [--season-start ISO] [--seed N] [--target N] [--margin-rp N]
```

`--execute` REQUIRES an explicit `--season-end` (no wall-clock default, so the
plan is fully determined by its inputs). `--limit` is dry-run-only — passing
it with `--execute` is refused, since a partial burn plus a global one-time
marker would be incoherent. There is no `--snapshot-out` — nothing is
snapshotted.

### Rollback

```bash
npm run bot:burnin:rollback -- --params <path> --season-end <ISO> [--season-start ISO] [--seed N] [--target N] [--margin-rp N]
```

Recomputes the plan from the SAME inputs the run used, reads the ceiling from
the stored marker (verifying the recomputed manifest hash matches), then in
one transaction deletes exactly the plan's matches and resets every roster bot
to the pristine baseline. REFUSES (deletes nothing) if any roster bot has a
match not in the recomputed plan — that's real post-burn-in activity, not
burn-in's to touch.

### Flags and defaults

| Flag | Default | Meaning |
| --- | --- | --- |
| `--params <file>` | — (required) | zod-validated calibration params JSON |
| `--seed N` | `20260721` | RNG seed; also derives per-bot RNG streams and fixture keys |
| `--target N` | `22` | per-bot fixture-count target (population median inside the 15-40 band) |
| `--margin-rp N` | `200` | RP margin subtracted from human top-10 to get the hard ceiling |
| `--season-start ISO` | `2026-07-21T00:00:00Z` | start of the backfill window |
| `--season-end ISO` | now() (dry-run) / required (`--execute`) | end of the backfill window — the scheduler's timeline horizon |
| `--limit N` | none (all) | cap on roster size loaded (highest base_skill first); dry-run only |
| `--execute` | off (dry-run) | perform the real writes, in chronological chunk transactions (resumable) |
| `--allow-remote` | off | required (with matching `BURNIN_CONFIRM_ENV`) to target a non-localhost DB |

The ceiling itself: `humanTop10Rp - marginRp` when at least 10 placed human
profiles exist (falls back to the lowest available placed human RP if fewer
than 10 exist, or a conservative `1500 - marginRp` if none exist). The
concrete ceiling is derived live and is NOT part of the plan identity — it's
enforced per-fixture during pairing instead.

## Safety model

- **Dry-run is the default.** No DB writes happen unless `--execute` is
  passed.
- **One-time marker.** `bot_model_params` gets a row with
  `note = 'persistent-bot-burnin:complete'`, inserted inside the same
  transaction as the writes. A second `--execute` on the same environment
  refuses (checked both before and again inside the transaction, under the
  lock).
- **Pristine gate.** `--execute` refuses (inside the transaction, under the
  lock) unless every roster bot is exactly pristine: `ranked_profiles` at
  450 RP/unplaced/all-zero accumulators (or missing, treated as fresh), zero
  ranked ledger rows, zero ranked `user_mode_match_stats` games, zero
  finished/live matches, zero XP events, `users.total_xp = 0`, zero
  achievements, no reservations or live lobby membership. The gate runs under
  a row lock (`FOR UPDATE` on `ranked_profiles`) inside the first chunk's
  transaction, and only against bots not already touched by a prior partial
  run.
- **DB target guard.** Localhost is allowed by default; a remote target
  requires `--allow-remote` plus `BURNIN_CONFIRM_ENV` set to the matching
  Supabase project ref.
- **`PERSISTENT_BOTS` flag must be OFF.** `--execute` aborts otherwise — burn-in
  must run before selection ever activates.
- **Hard-ceiling abort.** If the simulated distribution's max bot RP would
  exceed the ceiling, `--execute` aborts before any write (defensive only —
  planning enforces the ceiling by construction).

## What it writes (execute mode)

Per fixture, using the SAME production settlement math
(`computeParticipantSettlement` from `season-rp-formula.ts`) and achievement
evaluation, called directly inside the transaction with the fixture's
backdated timestamp:

- `matches` (one row, `mode='ranked'`, `is_dev=false`, backdated `started_at`/`ended_at`)
- `match_players` (both bot seats, with points/goals from the simulation)
- `ranked_rp_changes` + `ranked_profiles` (RP, tier, placement, streak)
- `user_mode_match_stats` (ranked aggregation)
- `user_xp_events` + `users.total_xp`
- `user_achievements`

It does **not** write coins, tickets, notifications, or analytics events.

## Also produced

- **Dry-run report** (`report.ts`, printed to stdout): roster bot count,
  planned fixture count, matches/bot (min/median/mean/max), hard-ceiling
  check (human #10 RP, ceiling RP, max bot RP, respected Y/N), ladder band
  target vs. actual counts, and sample timelines for the 3 strongest, 3
  weakest, and 2 median bots (nickname, skill, final RP, tier, W-L record).
