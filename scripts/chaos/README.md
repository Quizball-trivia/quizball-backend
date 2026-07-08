# Chaos engineering harness

Drives every game/API route at a configurable RPS to find where the backend +
Postgres degrade under pressure, and surfaces missing-index hot spots via
`pg_stat_statements` + `EXPLAIN`.

## Safety

- **Prod is hard-blocked.** `run.ts` aborts if the resolved API/DB points at the
  prod Supabase project (`lfbwhxvwubzeqkztghok`) or `api.quizball.io`. Staging
  must resolve to project `nsdfiprfmhdqhbfxfwpv`.
- Socket fleet mode applies the same guard to the socket URL and only allows
  `api-staging.quizball.io` or localhost targets.
- Spend routes (ticket/coin drains like `daily/complete`) are **off by default**;
  enable with `--include-spend`.
- Test users are provisioned as `chaos+uN@quizball.io`, pre-confirmed via the
  Supabase admin API (service-role key from `.env`). Re-runs reuse them.
- Socket fleet users are topped back up to 5 ranked tickets via the configured
  non-prod database before DB stats are reset.

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

# HTTP pressure plus 5 ranked socket clients for 5 minutes, staggered over 10s
npx tsx scripts/chaos/run.ts --target=staging --rps=50 --duration=300 --sockets=5 --flap-rate=0.5

# Boot-stage flap coverage: search, draft, and kickoff gate once per socket match
npx tsx scripts/chaos/run.ts --target=staging --sockets=3 --matches-per-client=1 --flap-stage=search,draft,gate

# Old mobile protocol profile: no draft/kickoff/resume UI-ready acks
npx tsx scripts/chaos/run.ts --target=staging --sockets=2 --matches-per-client=1 --legacy-protocol
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--target` | `staging` | `staging` or `local` (prod blocked) |
| `--rps` | `100` | target requests/sec **per route** |
| `--duration` | `30` (`300` with sockets) | run length in seconds |
| `--users` | `25` | size of provisioned test-user fleet |
| `--include-spend` | off | also hit ticket/coin-draining routes |
| `--only` | all | comma list of route names |
| `--no-db-stats` | off | skip the pg_stat_statements capture |
| `--api` / `--db` | from env | override API base / Postgres URL |
| `--sockets` | `0` | concurrent socket.io ranked clients; `0` keeps HTTP-only behavior |
| `--flap-rate` | `0` | average reconnect flaps per socket match |
| `--flap-stage` | `match` | socket flap stages: `search`, `draft`, `gate`, `match`; repeat or comma-separate |
| `--legacy-protocol` | off | emulate the old React Native protocol by skipping `draft:ui_ready`, kickoff/resume UI-ready, and reveal acks |
| `--ramp-s` | `10` | seconds to stagger initial socket queue joins |
| `--matches-per-client` | unset | stop each socket client after this many matches; if set without `--duration`, socket clients run until this count |

## Output

1. Per-route table sorted by p95: sent / ok / rps / p50 / p95 / p99 / max /
   err% (5xx) / 4xx% / status histogram.
2. Live DB activity (peak + after): active, idle-in-txn, lock waits, longest query.
3. Top queries by total DB time during the run.
4. Seq-scan / missing-index candidates (EXPLAIN on the slowest reads).
5. With `--sockets > 0`: socket fleet totals, wrongful-forfeit count,
   boot-stage detector counts (`deadSearch`, `banRollback`, `gateAbandon`,
   `legacyDraftStall`), draft replay style metrics, reconnect inflation, latency
   percentiles, socket error histograms, and a JSON report under
   `scripts/chaos/reports/`.

The engine is **open-loop**: it fires at the target rate regardless of response
time, so a slow backend shows up as growing latency, not a self-throttled lower
rate. A global in-flight cap (2000) sheds load if the target stalls completely.
