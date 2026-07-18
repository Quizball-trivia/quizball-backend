# Chaos engineering harness

Drives every game/API route at a configurable RPS to find where the backend +
Postgres degrade under pressure, and surfaces missing-index hot spots via
`pg_stat_statements` + `EXPLAIN`.

There are two load shapes:

- `--rps=N` is the original worst-case mode: **N per route**.
- `--total-rps=N` is the production-shaped mode: one total open-loop budget is
  distributed using each route's weight while sockets play complete matches.

## Safety

- **Prod is hard-blocked.** `run.ts` aborts if the resolved API/DB points at the
  prod Supabase project (`lfbwhxvwubzeqkztghok`) or `api.quizball.io`. Staging
  must resolve to project `nsdfiprfmhdqhbfxfwpv`.
- Socket fleet mode applies the same guard to the socket URL and only allows
  `api-staging.quizball.io` or localhost targets.
- Spend routes (ticket/coin drains like `daily/complete`) are **off by default**;
  enable with `--include-spend`.
- Test users are provisioned as `chaos+uN@quizball.io`, pre-confirmed via the
  Supabase admin API (service-role key from `.env`). Re-runs reuse them. Staging
  session bootstrap is paced because one load generator has one source IP;
  password-login capacity is measured separately from distributed IPs.
- Socket fleet users are topped back up to 5 ranked tickets via the configured
  non-prod database before DB stats are reset.
- Every run enforces SLOs before the database's hard ceiling: HTTP errors ≤1%,
  route p95 ≤1.5s, route p99 ≤3s, Postgres connections ≤75%, DB admission
  max wait ≤1s with no shedding, event-loop p99 ≤100ms, allocated CPU capacity
  ≤90%, no gameplay boot violations/wrongful forfeits, and matchmaking p95
  ≤120s.

## Run

```bash
# Standard pressure run: 100 rps per route, 30s, 25-user fleet, against staging
npx tsx scripts/chaos/run.ts --target=staging --rps=100 --duration=30 --users=25

# Dedicated human matchmaking queue storm. Every user must pair reciprocally
# with another test user; AI fallback, duplicate/self-pairs, and ghost cleanup fail.
npm run chaos:matchmaking -- --target=local --clients=100
npm run chaos:matchmaking -- --target=staging --clients=500 --offset=0

# Distributed workers use disjoint shards (example: five 1k workers for 5k).
# Connections are prepared first, then each worker compresses joins into 1s.
# worker 1: --clients=1000 --offset=0; worker 2: --clients=1000 --offset=1000; etc.
# Only one distributed worker should collect direct DB stats; pass
# `--no-db-stats` to the others so monitoring does not become test traffic.
# Queue-storm cleanup sends one cancellation per matched lobby, ramps those
# cancellations within the match-found modal, and ramps ordinary disconnects.
# A simultaneous disconnect storm is measured as a separate chaos scenario.

# Include ticket/coin-draining writes
npx tsx scripts/chaos/run.ts --target=staging --rps=50 --duration=20 --include-spend

# Only specific routes
npx tsx scripts/chaos/run.ts --target=staging --only=categories.list,ranked.leaderboard.global --rps=150

# Local backend + local Supabase
npx tsx scripts/chaos/run.ts --target=local --rps=200 --duration=15

# HTTP pressure plus 5 ranked socket clients for 5 minutes, staggered over 10s
npx tsx scripts/chaos/run.ts --target=staging --rps=50 --duration=300 --sockets=5 --flap-rate=0.5

# Boot-stage chaos: independently flap ~50% of eligible stages per match
npx tsx scripts/chaos/run.ts --target=staging --sockets=3 --matches-per-client=1 \
  --flap-rate=0.5 --flap-stage=search,draft,gate

# Old mobile protocol profile: no draft/kickoff/resume UI-ready acks
npx tsx scripts/chaos/run.ts --target=staging --sockets=2 --matches-per-client=1 --legacy-protocol

# Production-shaped 100-player raid from distributed source IPs
npx tsx scripts/chaos/run.ts --target=staging --users=100 --sockets=100 \
  --offset=0 --total-rps=50 --duration=300 --ramp-s=60

# Preview and then inject a staging-only Supavisor connection-closure burst.
# The script hard-blocks every project except staging, requires max_connections=60,
# targets only the postgres/Supavisor pooler backends, and requires explicit --apply.
railway run -- npx tsx scripts/chaos/terminate-staging-connections.ts
railway run -- npx tsx scripts/chaos/terminate-staging-connections.ts --apply

# Distributed workers must use disjoint user shards. For ten 500-player workers,
# use offsets 0,500,1000,...,4500. Reusing an offset makes multiple sockets act
# as the same account and invalidates matchmaking/correctness results.

# Find the sustained ceiling. Stops at the first failed SLO level.
npm run chaos:capacity -- --target=staging \
  --levels=25,100,250,500,750,1000,2000,5000 --duration=300 --cooldown=30
```

Do not include `--login-storm` in a single-machine gameplay ceiling run above
30 users. Supabase Auth deliberately allows a burst of 30 `/token` requests per
source IP. Use the distributed k6 suite for login/refresh capacity, and use the
paced bootstrap plus this harness for backend/database/gameplay capacity.

### Flags

| flag | default | meaning |
|---|---|---|
| `--target` | `staging` | `staging` or `local` (prod blocked) |
| `--rps` | `100` | target requests/sec **per route** |
| `--total-rps` | unset | total weighted HTTP requests/sec across all selected routes; enables production-shaped mode |
| `--duration` | `30` (`300` with sockets) | run length in seconds |
| `--drain-s` | `360` | hard maximum for matches already in progress after offered load stops |
| `--users` | `25` | size of provisioned test-user fleet |
| `--offset` | `0` | first numeric user suffix; must be disjoint across distributed workers |
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
| `--start-at` | unset | future ISO/Unix timestamp used to synchronize distributed workers after preparation |
| `--login-storm` | off | re-login every provisioned user once during the run |
| `--login-ramp-s` | `60` | time over which login arrivals are spread |
| `--report` | generated path | full JSON report path for automation/capacity ladders |

## Output

1. Per-route table sorted by p95: sent / ok / rps / p50 / p95 / p99 / max /
   err% (5xx) / 4xx% / status histogram.
2. Live DB activity (peak + after): total/max connection utilization, active,
   idle-in-txn, lock waits, and longest query.
3. Top queries by total DB time during the run.
4. Seq-scan / missing-index candidates (EXPLAIN on the slowest reads).
5. With `--sockets > 0`: socket fleet totals, wrongful-forfeit count,
   boot-stage detector counts (`deadSearch`, `banRollback`, `gateAbandon`,
   `legacyDraftStall`), draft replay style metrics, reconnect inflation, latency
   percentiles, socket error histograms, and a JSON report under
   `scripts/chaos/reports/`.
6. Machine-readable SLO verdict plus a complete JSON report. The command exits
   non-zero when an SLO fails.

The engine is **open-loop**: it fires at the target rate regardless of response
time, so a slow backend shows up as growing latency, not a self-throttled lower
rate. A global in-flight cap (2000) sheds load if the target stalls completely.

## Capacity-test procedure

1. Deploy the candidate code to **two staging replicas** with the same Railway
   CPU/memory and Supabase compute size as production.
2. Configure `DB_POOL_MAX=12`, `DB_INFLIGHT_LIMIT=12`, `DB_QUEUE_LIMIT=48`, and
   a non-production `CHAOS_BYPASS_TOKEN` on staging.
3. Run a 25-player smoke level. Confirm the JSON report sees the expected
   Postgres `max_connections` value and both replicas in Railway logs.
4. Run the clean capacity ladder first. It increases players, real Socket.IO
   clients, login arrivals, weighted REST traffic, matchmaking, and full
   gameplay together. It does not inject disconnects or repeatedly spend
   limited economy resources.
5. Treat the last passing level as the sustained capacity **for this traffic
   model**, not a marketing maximum. Operate at no more than roughly 50–60% of
   that level until a second run confirms it.
6. After the normal ladder, restart one staging replica during a passing level.
   The other replica must continue serving, the restarted replica must recover,
   and no request may hang beyond the 15s harness timeout. This validates the
   incident recovery path without terminating production database connections.

For a true single-replica failure, target one Railway deployment instance (for
example with `railway ssh --deployment-instance <id>`) and terminate that
container. Do **not** use `railway scale` as the replica-loss injector: Railway
applies a topology change as a deployment rollout, which can replace every
WebSocket-owning instance and measures full-rollout recovery instead.

The migration runner must keep its deployment mutex as
`pg_advisory_xact_lock` inside a dedicated coordinator transaction. A
session-level `pg_advisory_lock` is unsafe through Supavisor transaction mode:
lock and unlock queries can land on different backend sessions, and an
interrupted deploy can strand the lock in the pool.

After finding a passing level, rerun that one level with `--flap-rate=0.5` and
`--flap-stage=search,draft,gate,match` as a separate chaos proof. Keep the
generated report directory with the release evidence.
