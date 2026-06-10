# Chaos engineering harness

Drives every game/API route at a configurable RPS to find where the backend +
Postgres degrade under pressure, and surfaces missing-index hot spots via
`pg_stat_statements` + `EXPLAIN`.

## Safety

- **Prod is hard-blocked.** `run.ts` aborts if the resolved API/DB points at the
  prod Supabase project (`lfbwhxvwubzeqkztghok`) or `api.quizball.io`. Staging
  must resolve to project `nsdfiprfmhdqhbfxfwpv`.
- Spend routes (ticket/coin drains like `daily/complete`) are **off by default**;
  enable with `--include-spend`.
- Test users are provisioned as `chaos+uN@quizball.io`, pre-confirmed via the
  Supabase admin API (service-role key from `.env`). Re-runs reuse them.

## Run

```bash
# Standard pressure run: 100 rps per route, 30s, 25-user fleet, against staging
npx tsx scripts/chaos/run.ts --target=staging --rps=100 --duration=30 --users=25

# Include ticket/coin-draining writes
npx tsx scripts/chaos/run.ts --target=staging --rps=50 --duration=20 --include-spend

# Only specific routes
npx tsx scripts/chaos/run.ts --target=staging --only=categories.list,ranked.leaderboard.global --rps=150

# Local backend + local Supabase
npx tsx scripts/chaos/run.ts --target=local --rps=200 --duration=15
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--target` | `staging` | `staging` or `local` (prod blocked) |
| `--rps` | `100` | target requests/sec **per route** |
| `--duration` | `30` | run length in seconds |
| `--users` | `25` | size of provisioned test-user fleet |
| `--include-spend` | off | also hit ticket/coin-draining routes |
| `--only` | all | comma list of route names |
| `--no-db-stats` | off | skip the pg_stat_statements capture |
| `--api` / `--db` | from env | override API base / Postgres URL |

## Output

1. Per-route table sorted by p95: sent / ok / rps / p50 / p95 / p99 / max /
   err% (5xx) / 4xx% / status histogram.
2. Live DB activity (peak + after): active, idle-in-txn, lock waits, longest query.
3. Top queries by total DB time during the run.
4. Seq-scan / missing-index candidates (EXPLAIN on the slowest reads).

The engine is **open-loop**: it fires at the target rate regardless of response
time, so a slow backend shows up as growing latency, not a self-throttled lower
rate. A global in-flight cap (2000) sheds load if the target stalls completely.
