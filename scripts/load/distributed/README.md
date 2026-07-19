# Distributed staging load fleet

This directory provisions short-lived Hetzner workers for QuizBall's staging
capacity campaign. Production is not an accepted target anywhere in the app,
Socket.IO, matchmaking, or k6 harnesses.

## Required one-time account setup

1. Create an isolated Hetzner Cloud project named `quizball-staging-load`.
2. Enable billing and request a server quota of at least 11. A quota of 21 lets
   the separate Auth test add ten temporary source IPs.
3. Create a read/write API token. Store it locally, never in the repository:

   ```bash
   hcloud context create quizball-load
   ```

4. Verify the context and cost guard:

   ```bash
   scripts/load/distributed/fleet.sh preflight
   scripts/load/distributed/fleet.sh estimate 10 cx33
   ```

The default server-spend guard is $15 for a maximum modeled lifetime of 24
hours. It queries the active Hetzner project's live hourly server price and
includes the separately billed Primary IPv4 for every worker. Platform compute
and egress remain separately monitored in Railway and Supabase. Provisioning is
also locked unless `HCLOUD_SPEND_APPROVAL` exactly identifies the approved
campaign, fleet role, count, and server type.

## Production-shaped non-production data

The seeder uses production **row-count metadata only**. It never reads or copies
production rows, and it refuses production project URLs. Generated rows are
tagged so they can be removed with `--reset --apply`.

```bash
# Docker Supabase on localhost:54322 (synthetic questions + core history)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx tsx scripts/load/seed-production-shape.ts --target=local --apply

# Staging only; the Railway environment supplies the explicit staging URL
railway run \
  --project f69e88c4-9afa-4640-8748-f592350dd58e \
  --environment 8eb31d59-ff31-4fee-9468-a747b8d29de4 \
  --service f686a274-653b-48e1-ac91-74e0882113bd \
  -- npx tsx scripts/load/seed-production-shape.ts --target=staging --apply
```

The certified core scope is auth, users, wallet/store, questions, daily
challenges, friends, leaderboards/stats, matchmaking, draft, and gameplay.
Auction remains a staging-only experimental feature and is not part of the core
release capacity verdict.

## Mixed gameplay/API fleet

```bash
HCLOUD_SPEND_APPROVAL=quizball-staging-5k:mixed:10:cx33 \
  scripts/load/distributed/fleet.sh provision mixed 10 cx33
scripts/load/distributed/fleet.sh wait-ready mixed
scripts/load/distributed/fleet.sh upload mixed
scripts/load/distributed/fleet.sh health mixed
```

Install the four staging-only runtime values on the workers without printing
them. The project, environment, and service IDs are explicit so the Railway
CLI cannot fall back to production:

```bash
railway run \
  --project f69e88c4-9afa-4640-8748-f592350dd58e \
  --environment 8eb31d59-ff31-4fee-9468-a747b8d29de4 \
  --service f686a274-653b-48e1-ac91-74e0882113bd \
  -- npx tsx scripts/load/distributed/sync-env.ts --fleet=mixed
```

The synchronizer refuses any Supabase URL/connection that does not contain the
staging project reference, and refuses the production project reference.

## Distributed scenarios

The scenario runner splits load evenly, assigns disjoint account shards,
prepares workers in parallel, and starts measured traffic at a common UTC
timestamp:

```bash
scripts/load/distributed/run-scenario.sh gameplay 500 900 250
scripts/load/distributed/run-scenario.sh gameplay 1000 900 500
# Add real daily-completion and coin-purchase transactions (never Stripe).
scripts/load/distributed/run-scenario.sh gameplay 1000 900 500 60 true
# Separate transport connection pressure from the synchronized queue storm.
# This connects 5k clients over 120s, then joins the queue at 100 clients/s.
scripts/load/distributed/run-scenario.sh matchmaking 5000 90 50 120
scripts/load/distributed/run-scenario.sh http 2500 15m 2m
# Exact distributed replay of the 40/48/32 RPS questions, /me, wallet mix.
scripts/load/distributed/run-scenario.sh http-hot 120 5m 1m
```

Only worker zero runs direct DB sampling. Other workers pass `--no-db-stats` so
monitoring does not become a distributed workload of its own.

The matchmaking scenario deliberately defers opponent validation until all
worker reports have been downloaded. Its aggregate report must prove every
account appears once, every opponent is another fleet account with the same
lobby ID, and 5,000 clients form exactly 2,500 reciprocal human pairs. Any
missing worker, duplicated user shard, AI fallback, self-match, duplicate
`match_found`, asymmetric pair, or p95 breach fails the scenario.

Every worker is labeled with `quizball-load=true`, the campaign ID, fleet role,
staging target, and intended maximum lifetime. Source upload refuses a dirty
worktree so reports always identify an exact commit.

## Auth source-IP fleet

The ten mixed workers provide ten source IPs. Add ten smaller workers only for
the login/signup distribution test:

```bash
HCLOUD_SPEND_APPROVAL=quizball-staging-5k:auth:10:cx23 \
  scripts/load/distributed/fleet.sh provision auth 10 cx23
scripts/load/distributed/fleet.sh wait-ready auth
scripts/load/distributed/fleet.sh upload auth

railway run \
  --project f69e88c4-9afa-4640-8748-f592350dd58e \
  --environment 8eb31d59-ff31-4fee-9468-a747b8d29de4 \
  --service f686a274-653b-48e1-ac91-74e0882113bd \
  -- npx tsx scripts/load/distributed/sync-env.ts --fleet=all

scripts/load/distributed/run-scenario.sh auth-login 10 10m 2m
scripts/load/distributed/run-scenario.sh auth-mix 100 10m 2m
```

Supabase signup mail must point at a staging sink before signup pressure is
enabled. Password login and refresh are tested separately from application and
gameplay capacity.

## Emergency and normal teardown

```bash
scripts/load/distributed/fleet.sh list all
scripts/load/distributed/fleet.sh destroy auth
scripts/load/distributed/fleet.sh destroy mixed
scripts/load/distributed/fleet.sh list all
```

Deleting every labeled server is mandatory after collecting reports. Turning a
server off does not stop Hetzner billing.
