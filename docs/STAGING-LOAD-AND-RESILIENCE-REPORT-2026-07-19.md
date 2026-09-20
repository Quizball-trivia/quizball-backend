# QuizBall staging incident, resilience, and load-test report

**Report date:** 2026-07-19  
**Scope:** local environment and staging only  
**Production:** not load tested, not queried, and not modified  
**Overall status:** **PARTIAL PASS — not yet certified for 5,000 fully active players**

## Executive answer

The campaign established five important facts:

1. `EDBHANDLEREXITED: connection to database closed` was the symptom of a database connection disappearing underneath the Node process. The retained evidence does not prove whether the original initiating event was Supabase/Supavisor pressure, maintenance, a network interruption, or another upstream reset. The old aggregate pool allowance made self-inflicted pressure plausible, but it is not proven as the original root cause because the relevant upstream logs expired.
2. The application-side reasons that a connection-loss burst could become a prolonged outage were identified and fixed: excessive aggregate connection allowance, unbounded waiting, weak health checks, a replica allowed to remain alive while unhealthy, and an incorrect Railway restart policy.
3. The fixed staging service passed a normal 100-player real-gameplay run plus a 50 RPS, 32-route HTTP workload. It also survived direct staging database-connection termination with only two bounded 503 responses and no lost matches.
4. Distributed matchmaking connected and correctly paired exactly 5,000 users into 2,500 reciprocal human pairs at a 788 ms p95. No user was duplicated, self-matched, sent to AI, or left unmatched.
5. The same exact-5k run is still a strict failure. A synchronized disconnect caused delayed lobby cleanup callbacks to escape the socket cleanup limiter and generated 193 application DB-admission rejections. The pairing phase passed; the teardown phase did not.

The honest 5k conclusion is therefore:

> QuizBall has demonstrated the core matchmaking logic at 5,000 connected users, but it has **not** demonstrated 5,000 users simultaneously playing complete matches while also exercising login, refresh, `/users/me`, wallet, questions, daily challenges, stats, and the rest of the API. Do not advertise or plan production around a 5,000-active-player capacity yet.

## Certification matrix

| Capability | Highest durable evidence | Result | Meaning |
|---|---:|---|---|
| Normal full gameplay plus broad API mix | 100 Socket.IO players + 50 HTTP RPS across 32 routes for 5 minutes | **PASS** | Safe evidence for this exact staging workload |
| Direct DB connection termination under load | 20 gameplay clients + 30 HTTP RPS | **PASS** | Connection loss was bounded; all matches completed |
| Railway replica restart under load | 20 gameplay clients + 30 HTTP RPS | **Functional pass** | Replica returned quickly and gameplay/HTTP recovered; the preserved raw report has a now-corrected CPU-gate false failure |
| Local signup throughput | 5,012 registrations at 25 arrivals/s | **PASS** | Sustainable cumulative signup rate locally; not 5,012 simultaneous signups |
| Distributed matchmaking | 100, 500, 1,000, 2,000 users | **PASS** | Exact users connected and formed valid human pairs |
| Distributed matchmaking core at 5,000 | 5,000 users, controlled ramp | **PASS** | 5,000/5,000 paired into 2,500 valid pairs; p95 788 ms |
| Exact-5k end-to-end matchmaking lifecycle | Pairing plus synchronized teardown | **FAIL** | Delayed disconnect cleanup caused 193 DB admission sheds |
| Concentrated hot endpoints | 120 RPS from one Mac | **INCONCLUSIVE/FAIL** | About 27% network/client failures; DB was not the wall; distributed replay still required |
| Full 5k gameplay plus Auth and broad HTTP | Not run | **NOT PROVEN** | This is the remaining certification campaign |

## What happened in the original incident

### What is known

- Existing Postgres connections held by the application closed unexpectedly, producing `EDBHANDLEREXITED`.
- The errors burst during peak traffic.
- At the time, two application replicas could collectively claim a large share of the database/pooler connection budget before Supabase services, administration, and operational headroom were considered.
- Requests could accumulate behind unhealthy database work without an application acquisition deadline.
- The health endpoint did not demonstrate database readiness.
- An unhealthy process could remain alive and continue receiving traffic.
- Railway's earlier `ON_FAILURE` behavior did not replace a process that exited cleanly after a targeted termination.

These are the proven application-side failure amplifiers. Together, they explain how a short upstream connection event could become a long user-visible outage.

### What is probable but unproven

Pool over-subscription is a strong candidate for the initiating burst. Two replicas were previously allowed up to 30 app connections each, so the application could demand 60 before accounting for Supabase Auth, PostgREST, Realtime, Storage, observability, and administrative connections. Peak streamer traffic was exactly the kind of synchronized burst that could expose that budget error.

However, a Supabase maintenance/failover event or a network interruption could produce the same driver symptom. The original Supavisor/pooler event logs are no longer retained, so the initiating cause cannot honestly be named with certainty.

### What the error does not mean

It does not mean one database connection is needed per user. Thousands of users normally share a small pool because a connection is occupied only while a query executes. Capacity depends on query arrival rate, query duration, synchronized bursts, and how the application bounds waiting—not directly on the number of logged-in users.

## Fixes implemented on staging

### Database resilience

- `DB_POOL_MAX=12` per replica.
- `DB_INFLIGHT_LIMIT=12` per replica.
- `DB_QUEUE_LIMIT=48` on staging.
- `DB_ACQUIRE_TIMEOUT_MS=1500`; excess work gets a retryable 503 instead of waiting indefinitely or leaking a raw driver 500.
- With two replicas, application pools can claim at most 24 of staging Postgres's 60 configured connections, leaving headroom for the Supabase platform and operations.
- A real `/health/db` readiness probe now performs a bounded database query.
- A database watchdog exits after repeated failed probes so Railway can replace a poisoned process.
- Unhandled process/socket rejection boundaries prevent a detached failure from leaving a half-alive process.
- Railway's stateless API restart policy was changed to `ALWAYS` after chaos testing proved `ON_FAILURE` could leave staging at one replica.

### Auth resilience

- Hosted Supabase Auth has its own application bulkhead because its database usage sits outside the direct app pool.
- Each replica defaults to 4 active Auth operations, 16 queued, a 2-second admission deadline, and a 10-second upstream request timeout.
- Overload is intentionally shed as retryable 429 responses instead of allowing an Auth storm to consume the shared database budget and produce 5xx errors.
- Staging Auth IP forwarding was corrected so real users are not all represented by the two Railway replica IPs.

### Matchmaking and gameplay resilience

The campaign found and merged a series of hot-path improvements:

- Reduced repeated database round trips during pair creation.
- Distributed and batched ranked-pair startup.
- Streamed bounded pair starts instead of producing one giant burst.
- Bounded durable timer work and mass-disconnect workflows.
- Removed or skipped stale queue entries.
- Added exact queue-exit, reciprocal-pair, duplicate-user, self-match, AI-fallback, and unmatched-user assertions to the harness.
- Added controlled connection and queue-entry ramps, cleanup tails, per-replica health telemetry, and budget/spend guards.

These changes are on staging through PRs #227–#249. The currently deployed staging commit is `a64d9a6`, deployed successfully on 2026-07-19 at 16:32 UTC.

### Network and environment corrections

- Railway staging was moved from Virginia to EU West, near the Frankfurt Supabase database. A trivial database readiness round trip fell from roughly 359–375 ms to roughly 33–41 ms.
- Geo lookups were coalesced, cached, and bounded so an external geo provider cannot add a repeated multi-second delay to authenticated endpoints.
- Four independent Helsinki load generators were used so distributed tests did not collapse onto one source IP or one local machine.

## Test architecture and methodology

### Environments

- **Local:** local API and local Supabase, configured with a 60-connection Postgres ceiling to model staging and isolate deterministic failures.
- **Staging:** two Railway API replicas, EU West; staging Supabase Postgres with `max_connections=60`; staging Redis; synthetic users/data only.
- **Load generators:** four temporary Hetzner CX33 workers in Helsinki, each with a disjoint user shard and source IP.
- **Production:** explicitly out of scope.

### Workload types

- k6 fixed-arrival HTTP/Auth traffic for stable requests-per-second measurements.
- Real Socket.IO clients that queue, match, draft, receive questions, answer, score, and complete matches.
- Exact distributed matchmaking fleets with cross-worker reciprocal-pair validation.
- Database telemetry: total/active/idle connections, utilization, locks, long queries, and top query timings.
- Per-replica application telemetry: DB and Auth admission, socket cleanup queues, health failures, CPU, memory, and event-loop delay.
- Chaos actions: terminate staging DB backend connections and terminate/restart one Railway replica while traffic continues.

### What p95 and p99 mean

- **p95 = 788 ms** means 95% of measured operations completed in 788 ms or less; the slowest 5% took longer.
- **p99** describes the slowest 1% tail and is more sensitive to rare stalls.
- Averages alone are not sufficient because a system can have a good average while a meaningful group of users waits many seconds.
- **RPS is not concurrent users.** Five thousand connected players may create modest RPS while waiting or answering occasionally, whereas 120 large responses per second can be more expensive than many idle sockets.

## Detailed results

### 1. Local incident RED → GREEN

The old and fixed application behavior were tested against connection blackholes/resets and direct backend termination.

- Old behavior: raw connection-closed 500 responses and latency around 6.7–6.9 seconds p95 and 7.6–7.8 seconds p99.
- Fixed behavior under the same failure class: bounded retryable 503 responses near the 1.5-second acquisition deadline, followed by recovery.
- A direct local `pg_terminate_backend` run at 120 RPS completed 3,600/3,600 responses with no server errors.
- Three failed watchdog probes caused an exit; the local supervisor restarted the process and database health returned to 200.

This proves the application no longer needs a perfectly reliable upstream connection to remain bounded. It does not prove which upstream component initiated the original production incident.

### 2. Normal staging workload: 100 real players plus 50 RPS

Artifact: `scripts/chaos/reports/staging-prod-shape-gameplay-100-mixed-v1.json`

For five minutes the harness ran 100 real gameplay sockets and 50 HTTP requests/s over 32 normal routes.

- HTTP: 13,500 sent, 13,500 completed, zero server errors.
- Gameplay: 100 clients, 100 matches started, 100 completed.
- Gameplay correctness: zero failures, forfeits, abandons, wrongful forfeits, or dead searches.
- Queue-to-match-start p95: 3,997 ms.
- Answer acknowledgement p95: 145 ms.
- Worst HTTP p95: `/questions` list at 494 ms; p99 1,159 ms.
- `/users/me` p95: 278 ms; p99 408 ms.
- Wallet p95: 183 ms; p99 355 ms.
- Postgres peak: 30/60 connections, 50% configured utilization; 14 active; no lock wait at the peak.
- Formal artifact verdict: **PASS**.

This is the highest preserved proof of complete real gameplay combined with a broad HTTP workload. It is not a 5k-gameplay result.

### 3. Direct staging DB connection termination

Artifact: `scripts/chaos/reports/staging-db-termination-green-20-30rps-v1.json`

Twenty real gameplay clients and a weighted 30 RPS, 32-route HTTP mix continued while staging-only database backends were terminated.

- HTTP: 8,550/8,550 requests completed.
- Only two approximate server errors, both bounded; the worst per-route error percentage stayed below 1%.
- Gameplay: 20/20 matches completed with zero captured gameplay failures.
- Postgres peak: 30/60; no lock pressure.
- Formal artifact verdict: **PASS**.

This is the direct evidence that the tested connection-loss class no longer expands into an application outage at this workload.

### 4. Railway replica loss and restart

The first targeted replica termination exposed a separate infrastructure bug: `ON_FAILURE` left a cleanly terminated replica down indefinitely, reducing capacity to one replica and creating multi-second HTTP tails even though Postgres was healthy.

After changing the service to `ALWAYS` restart, the identical targeted termination returned to two healthy replicas before the first eight-second status poll completed.

Artifact: `scripts/chaos/reports/staging-single-replica-restart-certified-20-30rps-v1.json`

- HTTP: 6,899/6,900 completed; one transient network timeout remained within the 1% budget.
- Worst route p95: 1,124 ms; p99 in the preserved route data stayed below the 3-second route limit.
- Gameplay: 30/30 expected matches completed; zero forfeits, abandons, or captured gameplay failures.
- Postgres peak: 32/60; no lock waiters or long query.
- The preserved artifact's only formal violation is a `cpuCorePct > 90` gate. That formula treated one process using more than one CPU core on an eight-core allocation as overload. The corrected gate uses allocated CPU utilization plus event-loop delay; by those semantics this recovery run is functionally green.

An earlier broad “replica-loss” artifact remains red and should not be used as proof: it lost two match starts, generated 25 approximate server errors, and had multi-second p99 tails. Keeping that artifact is useful because it shows the test harness caught the failure before the restart policy was corrected.

### 5. Local signup and Auth admission

Artifacts: `scripts/load/k6/reports/quizball-staging-5k-local/`

#### RED run before Auth admission

- At 100 signup arrivals/s, about 65% of operations became upstream 5xx responses, including SQLSTATE `53300` (`too many clients`).
- This reproduced how a signup storm could consume hosted Auth/database capacity outside the app's direct Postgres pool.

#### GREEN overload behavior after Auth admission

- The same overload produced zero 5xx responses.
- Excess work was shed intentionally as 429 responses.
- This is safer but not a capacity pass: it proves overload containment, not that 100 signups/s is supportable.

#### Sustainable local ladder

| Arrival rate | Attempts | Successful | Rate limited/failed | HTTP p95 | Result |
|---:|---:|---:|---:|---:|---|
| 25/s short rung | 950 | 950 | 0 | 136 ms | PASS |
| 40/s short rung | 1,519 | 1,512 | 7 (0.46%) | 419 ms | PASS under 1% error budget |
| 50/s short rung | 1,552 | 1,143 | 409 (26.35%) | 695 ms | First clear wall |
| 25/s long run | 5,012 | 5,012 | 0 | 110 ms; p99 354 ms | PASS |

The long run created 5,012 users over about 207 seconds; it did not create 5,012 simultaneous signups. Local Postgres went from 32 baseline connections to a measured peak of 38/60. All 5,012 Auth and public-user rows were transactionally deleted afterward and zero remained.

Staging signup was intentionally not hammered because there is no dedicated email sink and the campaign prohibited Supabase overage/add-ons. Distributed login and refresh using pre-created staging accounts remain part of the final campaign.

### 6. Distributed matchmaking ladder

Four VPS workers split users into disjoint shards. Aggregate validation checked exact counts and reciprocal pair tuples across all workers.

| Run | Connected/searching | Human matched | Human pairs | AI/unmatched/invalid | Match-found p95 | Verdict |
|---:|---:|---:|---:|---:|---:|---|
| 100 | 100/100 | 100 | 50 | 0 | 2,948 ms | PASS |
| 500 | 500/500 | 500 | 250 | 0 | 1,524 ms | PASS |
| 1,000 | 1,000/1,000 | 1,000 | 500 | 0 | 6,919 ms | PASS under the then-8s SLO |
| 2,000 | 2,000/2,000 | 2,000 | 1,000 | 0 | 601 ms | PASS |
| 5,000 first attempt | 5,000/5,000 | 5,000 | 2,500 | 0 | 25,999 ms | FAIL latency |
| 5,000 second attempt | 4,991 connected; 4,975 searched | 4,974 | 2,487 | 1 AI; 25 unmatched | 630 ms | FAIL correctness/DB sheds |
| 5,000 latest | 5,000/5,000 | 5,000 | 2,500 | 0 | 788 ms | FAIL teardown only |

The rungs were run across successive fixes, so their latency numbers are not a monotonic capacity curve. The table records the actual campaign history and why each rerun happened.

Latest exact-5k artifact: `scripts/load/distributed/reports/quizball-staging-5k/20260719T163432Z-matchmaking-5000/aggregate.json`

The latest run used a 120-second socket connection ramp and a 50-second queue-entry ramp:

- 5,000 expected, 5,000 unique, 5,000 connected, zero connection retries.
- 5,000 queue acknowledgements.
- 5,000 human-matched users and 2,500 reciprocal human pairs.
- Zero AI fallbacks, unmatched users, duplicate match notifications, self-matches, invalid pairs, or duplicate user IDs.
- Match-found p95: 788 ms against an 8-second stored threshold. PR #250 tightens future matchmaking SLO enforcement and preserves p99/worst-worker evidence.
- Observed Postgres peak in the final run: 32/60 connections (53.3%); peak active 16; no connection exhaustion.
- During the 5,000-account Auth preparation, the two replicas performed 2,483 + 2,517 Auth acquisitions with zero Auth admission rejection or timeout.

#### Why the final run still failed

At deliberate mass disconnect, both replicas' socket cleanup limiters absorbed large queues without rejecting or timing out:

- Replica A: maximum 4,077 queued socket DB tasks; maximum wait 19.2 seconds.
- Replica B: maximum 4,264 queued socket DB tasks; maximum wait 21.0 seconds.
- Socket limiter rejections/timeouts: zero.

However, waiting-lobby disconnect processing schedules its database cleanup inside a 15-second `setTimeout` and returns immediately. The outer limiter slot is released before the timer fires. Thousands of timers then execute their database work almost together, outside the limiter:

- Replica A DB admission rejections: 159.
- Replica B DB admission rejections: 34.
- Total: 193 bounded DB admission sheds; zero DB acquisition timeouts.

This is a real application bug, not a database connection ceiling and not a load-generator artifact. The correct fix is to reacquire `socketDbTaskLimiter` inside the delayed cleanup callback. The limiter must not be held during the 15-second grace period; only the database work after the grace period should be limited. The identical 5k run must then be repeated with a long enough teardown tail to prove zero sheds and complete cleanup.

### 7. Concentrated `/questions`, `/users/me`, and wallet test

An ad-hoc single-Mac run sent 120 RPS concentrated on three endpoints:

- `/questions`: about 40 RPS.
- `/users/me`: about 48 RPS.
- `/store/wallet`: about 32 RPS.

It produced about 27% client/network errors both with and without connection termination. At the same time, SQL remained roughly 0.03–4 ms, database usage stayed below 49%, and no lock pressure appeared. Therefore, database execution and connection exhaustion were not the wall.

Unlike the formal chaos and distributed runs, this ad-hoc run does not currently have a durable JSON artifact in the repository; its figures come from the campaign notes. It must be reproduced by the checked-in distributed profile before it can support a release decision.

Likely contributors are the single generator, the Railway edge path, Node serialization, response bandwidth, and `/questions` returning up to 50 complete question objects. At 40 list requests/s, the server can serialize/transmit roughly 2,000 full question objects each second.

This result is not a server capacity number. PR #250 adds a reproducible distributed `hot-db` k6 profile with the exact 40/48/32 RPS mix, per-endpoint p95/p99/error aggregation, and worst-worker evidence. PR #250 is open, mergeable, and reviewed, but its distributed replay has not yet been run.

Recommended product/API improvements before or after the replay:

- A small gameplay-specific question-pack payload.
- CMS summary lists with full detail fetched only when opened.
- Smaller pagination defaults.
- Cache immutable/published question packs.
- Verify compression and ETag behavior.
- Keep answer validation authoritative on the server.

### 8. Post-test PostgreSQL warnings and errors

The 24-hour staging dashboard showed 5,457 Postgres log events, including 4,594 warnings and 98 errors. Classification found no connection-exhaustion incident hidden in those 98 errors:

| Count | Cause | Assessment |
|---:|---|---|
| 82 | Harness `EXPLAIN` helper substituted typed `$N` parameters with invalid strings such as `__p1__` | Test-tool noise; fix the helper |
| 10 | Deliberate staging connection terminations | Expected chaos evidence |
| 3 | Ad-hoc monitoring queried a nonexistent `matches.created_at` column | Operator/tooling error |
| 2 | Advisory-lock statement timeouts | Test-tool contention/noise |
| 1 | Weekly `cleanup_ai_users()` foreign-key violation | Real staging maintenance bug |

Most warnings were the repeated Postgres collation-version mismatch emitted on new connections: recorded collation version 153.120 versus operating-system version 153.121. It should be resolved by rebuilding affected collation-dependent indexes and then refreshing the database collation version; merely hiding the warning would not be sufficient.

Live staging inspection also found migration drift: migration history says the safe AI-cleanup replacements were applied, but `pg_get_functiondef(cleanup_ai_users)` still showed the old unsafe deletion function. A new idempotent repair migration is required, followed by verification of the live function definition and a dry-run/transactional test.

The chaos `EXPLAIN` helper at `scripts/chaos/db-stats.ts` should stop guessing parameter types. It should skip normalized queries containing `$N` unless typed bind values are available. That change will remove the majority of the red error bars from future dashboard views.

## Why earlier testing did not catch these problems

1. **The workload dimension was too small.** A 100-player test cannot expose 5,000 timers firing after the same 15-second grace period.
2. **Pairing and teardown are different phases.** Earlier tests stopped after match formation or used a short cleanup tail. The latest harness kept measuring long enough to catch delayed cleanup.
3. **One generator is not neutral.** A Mac or one VPS can hit CPU, sockets, ephemeral ports, bandwidth, source-IP Auth limits, or the edge before the application. Four generators separated those limits.
4. **Local and one-replica tests miss topology failures.** Only staging could reveal cross-replica pairing behavior and Railway's `ON_FAILURE` restart-policy problem.
5. **Connection closures are symptoms.** Without retained pooler/network event logs, the original initiator cannot be reconstructed from the application error string alone.
6. **Migration history was trusted instead of live state.** A migration row being present does not prove a function body or index matches the repository. Live schema fingerprints are necessary.
7. **The test tooling itself generated noise.** Invalid `EXPLAIN` substitution and bad ad-hoc monitoring queries inflated the database error chart and obscured the single real maintenance failure.
8. **“5,000 users” was not defined precisely.** Five thousand queued sockets, five thousand signups over several minutes, and five thousand players in 2,500 live matches are radically different workloads. Each needs its own scenario and acceptance criteria.

## Are we good for 5,000 users?

### Yes, for this narrow statement

At a controlled ramp, the current staging matchmaking implementation accepted 5,000 unique Socket.IO clients and placed all of them into 2,500 correct reciprocal human pairs with a 788 ms p95. Postgres did not exhaust connections during pairing.

### No, for the product-level claim

We cannot yet say the app supports 5,000 active players because:

- The exact-5k lifecycle failed during disconnect cleanup.
- The highest complete gameplay proof is 100 players, not 5,000.
- The full draft/question/answer/scoring/completion path has not been run at 500, 1k, 2k, and 5k on the distributed fleet.
- Distributed login/refresh plus gameplay plus broad HTTP traffic has not been combined at those rungs.
- The concentrated hot-endpoint test has not been repeated from multiple generators.
- A long soak and a highest-green chaos run are still outstanding.

A 5,000-player full-game test means up to 2,500 simultaneous matches, repeated questions and answers, draft timers, scoring writes, reconnects, match completion, objectives, wallet/profile reads, and background cleanup. Match formation alone is encouraging but materially cheaper than that full lifecycle.

## Required work before a 5k certification

### Priority 0: remove known correctness/operations failures

1. Reacquire the socket DB task limiter inside delayed lobby cleanup; add a regression test with thousands of scheduled callbacks.
2. Rerun the identical exact-5k matchmaking scenario. Require zero DB/Auth/socket admission rejection/timeouts, 5,000/5,000 reciprocal matching, and verified cleanup after the grace tail.
3. Repair `cleanup_ai_users()` with a new idempotent migration and verify the live function definition.
4. Fix the `EXPLAIN` helper and bad monitoring query; establish a clean log baseline.
5. Plan collation index rebuild/refresh on staging, then verify warnings stop.

### Priority 1: complete the capacity ladder

1. Merge PR #250 after final review.
2. Run its distributed 120 RPS hot-endpoint replay. If it passes, ladder upward until the first SLO wall; if it fails, compare workers to isolate generator versus server/edge behavior.
3. Run complete gameplay at 500 → 1,000 → 2,000 → 5,000, holding each rung 10–15 minutes and stopping at the first failure.
4. At each rung add production-shaped HTTP arrivals for `/users/me`, wallet, questions, daily challenges, inventory, leaderboards, stats, notifications, friends, and objectives.
5. Add distributed existing-account login and refresh traffic. Continue to keep destructive/high-volume staging signup disabled unless a dedicated Auth email sink exists.

### Priority 2: resilience and endurance at the highest green rung

1. Hold the highest passing workload for 30–60 minutes.
2. Run a synchronized reconnect/disconnect spike.
3. Terminate staging DB backends once while the combined workload continues.
4. Restart one Railway replica once and require healthy-sibling continuity and recovery in under 60 seconds.
5. Repeat the highest passing rung twice. Define operating capacity as no more than 50–60% of the twice-confirmed breaking point, not the absolute maximum.

### Certification acceptance criteria

- Exact scenario user count and zero harness drops.
- HTTP errors below 1%; no raw 5xx from connection loss.
- Per-endpoint p95 below 1.5 seconds and p99 below 3 seconds unless an endpoint has a documented tighter SLO.
- Match-found p95 below the final agreed SLO, with p99 and worst-worker retained.
- Zero invalid pairs, duplicates, self-matches, wrongful forfeits, dead searches, or unexpected AI fallback.
- Zero DB/Auth/socket admission rejection or timeout during a planned green capacity run.
- Postgres below 75% connection utilization, no lock waiters, no long idle transactions, and no unexplained log errors.
- Recovery from injected connection loss/replica restart in under 60 seconds.

## Infrastructure cost and safety

- Four CX33 Helsinki workers were created at approximately 2026-07-19 07:32 UTC.
- Approved maximum for 24 hours: **$1.63** for the workers.
- At report time (~10.3 worker-hours elapsed per server), estimated worker spend was about **$0.70 total** using the campaign's approved $0.068/hour combined rate.
- Railway incremental usage was authorized up to $5; no Supabase upgrade, add-on, or intentional overage was purchased.
- The total remains well below the later $80 overall cap.
- The four workers were still running when this report was written and must be destroyed no later than 2026-07-20 07:32 UTC unless explicitly reauthorized.

## Durable evidence index

### Incident and resilience

- `scripts/chaos/INCIDENT-2026-07-13.md`
- `scripts/chaos/reports/staging-prod-shape-gameplay-100-mixed-v1.json`
- `scripts/chaos/reports/staging-db-termination-green-20-30rps-v1.json`
- `scripts/chaos/reports/staging-single-replica-kill-20-30rps-v1.json`
- `scripts/chaos/reports/staging-single-replica-restart-certified-20-30rps-v1.json`

### Signup/Auth

- `scripts/load/k6/reports/quizball-staging-5k-local/quizball-local-signup-5k.json`
- `scripts/load/k6/reports/quizball-staging-5k-local/quizball-local-signup-5k-green.json`
- `scripts/load/k6/reports/quizball-staging-5k-local/quizball-local-signup-25rps.json`
- `scripts/load/k6/reports/quizball-staging-5k-local/quizball-local-signup-40rps.json`
- `scripts/load/k6/reports/quizball-staging-5k-local/quizball-local-signup-50rps.json`
- `scripts/load/k6/reports/quizball-staging-5k-local/signup-local5k-20260719T165640Z.json`

### Distributed matchmaking

- `scripts/load/distributed/reports/quizball-staging-5k/20260719T084131Z-matchmaking-100/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T111428Z-matchmaking-500/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T112829Z-matchmaking-1000/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T133327Z-matchmaking-2000/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T135918Z-matchmaking-5000/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T151842Z-matchmaking-5000/aggregate.json`
- `scripts/load/distributed/reports/quizball-staging-5k/20260719T163432Z-matchmaking-5000/aggregate.json`

### Current tooling PR

- PR #250: `test(load): add distributed hot-endpoint replay`
- Branch: `agent/load-http-profiles`, commit `c74260c`
- Status when reported: open, mergeable, CodeRabbit success; focused load tests 13/13, build and lint passed. Full suite retained the same 15 unrelated baseline failures (1,373 pass, 52 skipped).

## Final decision

The incident response is materially better: the tested connection-loss failure is bounded, unhealthy replicas restart, aggregate DB usage is budgeted, and Auth overload sheds safely. Matchmaking correctness at 5,000 is a strong result.

The release/capacity decision is still **not certified for 5,000 active players**. Fix the delayed cleanup escape, obtain a strict-green exact-5k lifecycle rerun, and then complete the combined distributed gameplay/Auth/HTTP ladder plus soak and chaos at the highest green rung. Until that evidence exists, the defensible statement is:

> Proven on staging: 100 complete concurrent gameplay clients plus 50 RPS over 32 API routes; proven separately: correct controlled-ramp matchmaking for 5,000 users, with one known teardown issue still open.
