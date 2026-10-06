# Six-player Party Quiz + Aproximado load tests

These scripts use real Socket.IO connections, lobby commands, matches, timers and storage. They do not import the application environment or replace game logic. `room-fleet-oracle.ts` independently calculates scores; the runner compares every completed match against persisted answers and all active clients' final results.

## Targets and credentials

- Default API: `http://127.0.0.1:8050`. Default observer DB: `postgresql://postgres@127.0.0.1:5436/quizball_load_local`.
- Local runs require a loopback API and a dedicated loopback `quizball_load_*` database. Production is blocked.
- Staging additionally requires `--target staging --confirm-staging`, exact API `https://api-staging.quizball.io`, a verified staging database identity and real staging test-user credentials. **Local JWT fixture credentials are refused on staging.** This capability is implemented but has not been staging-tested by the local run.
- Credential file: `{ "apiBase": "http://127.0.0.1:8050", "partyCategoryId": "uuid", "users": [{ "userId": "uuid", "token": "..." }] }`. Never commit it. Six distinct users per room; `--user-offset` allows disjoint cohorts. Do not run two fleets concurrently with overlapping users.
- Party/mixed runs require a known playable MCQ category, supplied in the manifest or `--category`. Default random categories can contain insufficient content and are a separate content-readiness test, not a reliable load fixture.
- Party Quiz requires accounts. Aproximado room games allow all six seats to be guests. For a guest profile, mint sessions and principals through the isolated local backend's normal guest HTTP endpoints, then use their opaque tokens/user IDs in the same manifest; do not pretend a registered fixture is a guest.
- Optional `--peer-api http://127.0.0.1:8051` splits each room across two **local** backend processes (alternating seats). Both must share the isolated DB, Redis, JWT fixture and game settings. Health is checked on both. Explicit peer routing is refused on staging; test its real load balancer instead.

## Isolated local setup

Use a dedicated Postgres instance/database and Redis instance. A normal local DB crowded by other developers' servers is not a capacity measurement. Clone the **local** room QA DB schema/content into the isolated DB; never restore a dump over the original. Remove old match/lobby state only in the clone before starting its backend. Install all room migrations in that clone.

`room-local-fixtures.ts` creates synthetic registered users with `example.invalid` addresses and a loopback JWKS fixture. The backend still performs normal JWT verification, identity lookup, authorization and gameplay operations. No external Supabase account, email or Google login is created. This isolates gameplay capacity from identity-provider and guest-session minting capacity; those need separate tests.

```sh
npx tsx scripts/chaos/room-local-fixtures.ts --database postgresql://postgres@127.0.0.1:5436/quizball_load_local --api http://127.0.0.1:8050 --users 1200 --auth-port 8062 --out /absolute/private/artifacts
```

Keep the fixture running. Launch a **separate** backend with a clean environment from a private working directory (so dotenv does not read the repository's staging environment). Set `NODE_ENV=local`, `PORT=8050`, the dedicated `DATABASE_URL` and `REDIS_URL`, `SUPABASE_URL=http://127.0.0.1:8062`, a dummy local anon key, `SUPABASE_JWKS_URL=http://127.0.0.1:8062/jwks`, `SUPABASE_JWT_ISSUER=http://127.0.0.1:8062/auth/v1`, `SUPABASE_JWT_AUDIENCE=authenticated`, and `ROOM_GAMES_ENABLED=aproximado`. Leave external analytics/mail credentials absent. Record pool/queue limits; use the release's defaults first.

Keep the Mac awake with its lid open. A machine sleep invalidates latency/timer measurements. Do not classify a suspended generator/backend as a server capacity limit.

Aproximado enforces 120 starts/hour/IP and 30 starts/hour/user (rematches count). A series of fleets from localhost shares that IP allowance. Use a fresh isolated local Redis before a new certification series, or wait for the window; never reset shared/staging rate limits to make a load run pass. Check backend logs to distinguish admission-policy failures from capacity failures. Registered fixtures do not exercise guest provisioning/admission.

## Runs

```sh
# Full six-player match per engine before ramping
npx tsx scripts/chaos/room-fleet.ts --mode aproximado --rooms 1 --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/baseline
npx tsx scripts/chaos/room-fleet.ts --mode party --rooms 1 --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/party

# Many complete games, both engines
npx tsx scripts/chaos/room-fleet.ts --mode mixed --rooms 10 --ramp-seconds 10 --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/10
# Then repeat at 25 / 50 / 100 rooms, stopping escalation when a tier fails.

# All six answers submitted together; duplicate submission chaos
npx tsx scripts/chaos/room-fleet.ts --mode mixed --rooms 10 --burst --fault duplicate --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/burst

# Network disconnect/reconnect or intentional leave on seat six
npx tsx scripts/chaos/room-fleet.ts --mode mixed --rooms 10 --fault reconnect --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/reconnect
npx tsx scripts/chaos/room-fleet.ts --mode mixed --rooms 10 --fault leave --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/leave

# Same six users, real rematches (not continually provisioning new users)
# Roughly one hour including idle intervals; below per-user and per-IP start limits.
npx tsx scripts/chaos/room-fleet.ts --mode mixed --rooms 8 --cycles 20 --cycle-pause-seconds 100 --users /absolute/private/artifacts/users.json --out /absolute/private/artifacts/soak
```

Runtime depends on real reveal/countdown timing; inspect actual duration rather than claiming a fixed number of cycles always equals an hour. Track the measured peak concurrent matches, not just the requested room count or connected sockets. A ramp longer than match duration can underfill the requested simultaneous-room target.

Aproximado returns to its existing lobby. Party Quiz uses the real `match:play_again` flow into a new rematch lobby; the runner has all six join it and restores the selected fixture category before Ready/Start.

## Outputs and verdict

Each run saves `summary.json` and `health.json`. Capture stdout separately. The result includes per-match IDs, completed games, confirmations, p50/p95/p99/max acknowledgement latency, measured peak active matches, memory/CPU/event-loop peaks, queue/rejection metrics, timer transition lateness and detailed errors.

`verifiedMatches` (legacy field `completedMatches`) counts games that passed every verification, not all rows whose database status is completed. Rejection counts are per-run deltas; sampled queue/CPU/memory peaks can miss short bursts. Gameplay queue high-water and maximum-wait counters are process-lifetime values, not new per-profile peaks. A green health endpoint and low average latency do not override failed answer confirmations. Timer lateness currently covers Aproximado phase transitions only. If profiles run concurrently with disjoint users, explicitly record the overlap: process-wide CPU/memory/rejection counters include all profiles, while active-match counts and client totals are scoped to each fleet.

Zero incorrect scores, missing acknowledgements, lost accepted answers, result disagreement, unintended revival or duplicate answer rows are required. Proposed latency targets: p95 <=500ms and p99 <=1000ms. Health probes must pass. A run exits nonzero if correctness, latency, health or capacity fails. Capacity requires zero DB, gameplay or Party completion admission rejections on every observed replica. The runner waits up to 120 seconds for the Party reward queue to drain before taking its final samples. Report saturation as a failed tier, not a pass simply because some games completed.

Observer queries use one **separate** connection with no shared-pool session setting changes or global statistics resets. Cleanup only calls leave/forfeit for the current fleet's synthetic users; completed rows are retained for evidence. Inspect any still-active rows after a failed run. Cleanup of the entire isolated environment must never run against an existing QA/staging/prod database.

Unit checks: `npx vitest run tests/chaos/room-fleet-oracle.test.ts`. Application typecheck excludes scripts, so also typecheck these three scripts explicitly with NodeNext/ES2022/strict options.

Local results do not certify production hardware, external authentication capacity, distributed guest mint limits, or the actual staging/production replica topology. Local guest/peer profiles and browser observers cover their measured setup only. Repeat the certified local profile on staging with its actual pool/resources and a few real browser players before production capacity claims.
