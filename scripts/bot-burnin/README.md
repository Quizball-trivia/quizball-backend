# Persistent-bot burn-in engine (PR6)

One-time, per-environment engine that seeds every persistent roster bot from
the Season-2 placed-human ladder shape, then adds a short backdated ranked
bot-vs-bot history settled through the real Season-2026 RP formula.

## Prerequisites

- Persistent roster rows must already exist: `users` (`is_ai=true`,
  `ai_kind='persistent'`), `synthetic_player_profiles` (base_skill, daily_cap,
  schedule, status), plus pristine `ranked_profiles` rows at 450/unplaced.
- A zod-validated calibration params file (`--params`), parsed by
  `parseBotModelParams` from `src/modules/bots/calibration/params-schema.ts`.
- `DATABASE_URL` available via `.env.local` or `.env` (both are loaded, with
  `.env.local` taking precedence).

  > **Trap — setting `DATABASE_URL` in code does not work, and fails silently.**
  > ESM hoists every `import` above module-body statements, so `src/core/config.ts`
  > (which runs `dotenv` against `.env`) is evaluated *before* any
  > `process.env.DATABASE_URL = ...` written at the top of a script. The pool is
  > built from `.env` — which is **staging** — while the script's own banner
  > happily prints `localhost`. A scratch harness did exactly this on 2026-07-28
  > and created bot rows on staging. Always pass the DSN on the command line
  > (`DATABASE_URL='postgresql://…' npx tsx …`), and guard on
  > `config.DATABASE_URL` (what the pool actually used), never on `process.env`.
- At least 2 roster bots and at least one active category
  (`categories.is_active = true`); the engine throws otherwise.
- `PERSISTENT_BOTS` flag must be OFF — burn-in is a pristine-state operation
  that must run before selection ever activates.

## Architecture: plan-all-then-execute-in-chronological-chunks

**PLAN** is a pure function of immutable inputs: seed, the explicit season
window (start + end), roster membership + each bot's fixed hidden ability
(base_skill/dailyCap/schedule/status), the recent fixture count, the ceiling
margin, the calibration params, and the active category set. Every bot is
simulated as placed from its deterministic S2 seed, and the ceiling (human
top-10 RP − margin) is enforced during pairing.

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
npm run bot:burnin -- --params <path> [--limit N] [--seed N] [--recent-matches N] [--margin-rp N] [--human-top10-rp N] [--season-start ISO] [--season-end ISO]
```

Simulates the full fixture plan in memory and prints the distribution report
(bots, planned fixtures, matches/bot, hard-ceiling check, capped and uncapped
seeded ladders, tier histograms, and sample timelines). Zero writes.
`--season-end` defaults to now();
`--limit` caps roster size loaded (highest base_skill first).

### Execute (writes — chronological chunk batches, resumable)

```bash
npm run bot:burnin -- --params <path> --execute --season-end <ISO> [--season-start ISO] [--seed N] [--recent-matches N] [--margin-rp N] [--human-top10-rp N]
```

`--execute` REQUIRES an explicit `--season-end` (no wall-clock default, so the
plan is fully determined by its inputs). `--limit` is dry-run-only — passing
it with `--execute` is refused, since a partial burn plus a global one-time
marker would be incoherent. There is no `--snapshot-out` — nothing is
snapshotted.

**Arguments are validated strictly, before any planning or DB work.** An
unknown flag, a flag missing its value, a `--flag=value` form, a repeated flag,
or a non-numeric value for a numeric flag all exit non-zero and list the valid
flags. Burn-in is one-time and marker-guarded, so a typo that silently reverted
to a default (`--margin` for `--margin-rp`) would change the planned ladder
while the operator believed they had overridden it.

#### Writes are batched per chunk

Each 250-fixture chunk commits in ~7 statements — one locked read of the
chunk's ranked profiles, then one multi-row write per table — instead of ~7
statements *per fixture*. Measured at full scale (1,000 bots / 5,927 fixtures /
24 chunks): **41,489 → 168 statements, a 247x round-trip reduction**, 24.2s →
4.2s on loopback. Over a WAN link to the Supabase pooler that is ~21 minutes of
pure network time reduced to ~5 seconds, and it keeps each chunk transaction
far below the pooler's 15s `idle_in_transaction_session_timeout` (slowest chunk
measured locally: 281ms).

Because `ranked_profiles` is read-modify-write per fixture (streak chaining and
RP accumulation across a bot's many fixtures in one chunk), the batched writer
folds each bot's sequence **in memory** — seeded from a live locked read at
chunk start, so a resumed run picks up the RP/streak the committed prefix left
— and writes one final row-state per bot. `tests/bot-burnin/writer-equivalence.integration.test.ts`
is the merge gate: it replays one plan through both writers and asserts the
final state is identical across every table, including a resume seam where a
per-fixture prefix is finished by the batched writer.

### Rollback

```bash
npm run bot:burnin:rollback -- --params <path> --season-end <ISO> [--season-start ISO] [--seed N] [--recent-matches N] [--margin-rp N]
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
| `--recent-matches N` | `12` | per-bot recent-history fixture target |
| `--human-top10-rp N` | `2615` | human-frontier reference used to derive the bot ceiling |
| `--margin-rp N` | `50` | RP margin subtracted from human top-10 to get the hard ceiling |
| `--season-start ISO` | `2026-07-21T00:00:00Z` | start of the backfill window |
| `--season-end ISO` | now() (dry-run) / required (`--execute`) | end of the backfill window — the scheduler's timeline horizon |
| `--limit N` | none (all) | cap on roster size loaded (highest base_skill first); dry-run only |
| `--execute` | off (dry-run) | perform the real writes, in chronological chunk transactions (resumable) |
| `--allow-remote` | off | required (with matching `BURNIN_CONFIRM_ENV`) to target a non-localhost DB |

The ceiling is `humanTop10Rp - marginRp`; the human-frontier flag defaults to
the production #10 value. The concrete ceiling is not part of the plan identity
and is stored in the durable marker for exact rollback recomputation.

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
(`computeParticipantSettlement` from `season-rp-formula.ts`), written as plain
SQL directly inside the transaction with the fixture's backdated timestamp:

- `matches` (one row, `mode='ranked'`, `is_dev=false`, backdated `started_at`/`ended_at`)
- `match_players` (both bot seats, with points/goals from the simulation)
- `ranked_rp_changes` + `ranked_profiles` (RP, tier, placement, streak)
- `user_mode_match_stats` (ranked aggregation)
- `user_xp_events` + `users.total_xp`

That list is exhaustive, and deliberately so. Burn-in invokes **no side-effect
services**: no achievements, notifications, quests, streak rewards, coins,
tickets or analytics. These fixtures are backdated synthetic history rather than
gameplay that happened, so a service that treats match completion as a live
event would manufacture unlocks for matches nobody played — and would also make
the executed ladder drift from the plan the seed solver computed. If you wire a
new post-match service into the live flow, do **not** add it here; the
`writes ONLY the ledger tables` test in `tests/bot-burnin/writer.integration.test.ts`
is there to fail if someone does.

## Also produced

- **Dry-run report** (`report.ts`, printed to stdout): roster bot count,
  planned fixture count, matches/bot (min/median/mean/max), hard-ceiling
  check, capped and uncapped seeded-ladder quantiles, tier histograms with S2
  human counts, per-band seed ranges, and sample seed-to-final timelines.
