# Game Regression Harness — STATUS (overnight build)

## TL;DR
The hard architecture is PROVEN: a real ranked-AI match boots end-to-end in-process
(queue → AI fallback → draft → category ban → match:start → first question) against
the local Supabase DB + Redis, in an automated vitest test, with a full event trace.
Two issues remain before the harness can run many matches reliably (see KNOWN ISSUES).

## How to run
```
cd backend-node
supabase start                 # local Postgres :54322
docker compose up -d redis     # local Redis :6379
REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx vitest run tests/regression/match-boot.test.ts
```
Env flags (local-only, config-guarded): `REGRESSION_DETERMINISTIC=1` (pins question
SQL randomness), `REGRESSION_FAST_TIMERS=1` (collapses matchmaking/draft/round delays).

## What works (committed, all authored as the user)
- **RNG seam** (`core/rng.ts`) + full path coverage + SQL question determinism — a
  seeded run replays the same questions. Proven.
- **Local isolated DB/Redis**, **fixture seeder** (validated vs the engine's real
  ranked-eligibility query), full wallet/user reset, idempotent cleanup.
- **Fake-time clock** (`game-regression/src/clock.mts`) — proven to drive the real
  durable scheduler. (Note: the runner currently uses REAL fast timers, not this —
  see below.)
- **Adapter + recorder** (`adapter.mts`) — FakeIo/FakeSocket capture every emit
  (match/user rooms + per-socket acks) into an EventTrace. Tested.
- **Runner** (`runner.mts`) — `bootMatch()` boots a real match through the production
  path; `playMatch()` answers MCQs to drive play; `runFullMatch()` does both.
- **match-boot.test.ts** — boots a real match + first question. Passes (see flakiness).
- Config guard for the REGRESSION_* flags (local-only) + GRACE_MS boundary tests.

## RESOLVED: boot is now fast + reliable
The boot flakiness/slowness was a single uncollapsed delay: the pre-match COUNTDOWN
(`beginMatchForLobby` countdownSec, ~5s) gating the first question, plus the found-modal
wait. Both now go through harnessDelayMs. The boot test is **4/4 reliable at ~5s**
(was ~10s and ~1/3 flaky). The earlier "stall at search" was the same countdown delay
pushing match:question past the test's 10s budget on slower iterations — not a real race.

## KNOWN ISSUE (next session) — PRECISELY DIAGNOSED
### Full match completes only the MCQ rounds fast; special rounds are the bottleneck
Per-round profiling (see below) shows the architecture works great for MCQ but stalls on
special questions (countdown / putInOrder / clues):
```
+3467ms  Q0 (MCQ)  -> round_result +4018ms   (~550ms ✓)
+4049ms  Q1 (MCQ)  -> round_result +4512ms   (~460ms ✓)
+4542ms  Q2 (MCQ)  -> round_result +5025ms   (~480ms ✓)
+5027ms ........... 9-SECOND GAP ...........
+14052ms Q3 (SPECIAL) -> NO answer_ack from bot -> round_result +17032ms (timeout)
```
Two concrete sub-issues for the special-question path:
1. **The bot's special answer isn't registering** — Q3 has no `match:answer_ack`, so the
   bot's countdown/putInOrder/clues submission (just wired in runner.answerQuestion) is
   being rejected. Likely the special handlers need the question to be in its "playable"
   window (post-reveal) or a different payload/timing than MCQ. Debug: log the handler
   result / why it's a no-op for the special kind.
2. **A ~9s gap BEFORE the special dispatches** — almost certainly the AI's special answer
   delay on the PREVIOUS round, or the special pre-answer reveal not fully collapsed. The
   AI countdown delay (getAiAnswerDelayMs countdown branch = 12-22s) IS wrapped in
   harnessDelayMs — verify it's taking effect for the countdown kind; profile the AI
   answer scheduling for specials.
Once specials answer + resolve fast, a full match should finish in a few seconds and reach
halftime + match:final_results. Then build invariants on the completed-match trace.

### Per-round timing is otherwise excellent
MCQ rounds resolve in ~500ms (bot answers, AI answers, round_result). Boot ~5s. The whole
approach is sound — only the special-question answer/timing path remains.

## Engine changes made for the harness (all prod-safe, flag-gated)
- `core/harness-timing.ts` (NEW): `harnessDelayMs(prodMs, fastMs)` — returns fast value
  only when REGRESSION_FAST_TIMERS=1. Applied at: ranked queue deadline, AI search
  duration, draft auto-ban, AI answer delay, question pre-answer reveal, answer window.
- `socket-server.ts`: extracted the timer-handler map to `buildRealtimeTimerHandlers()`
  (exported, shared by prod + harness so they can't drift).
- `match-questions.repo.ts`: `REGRESSION_DETERMINISTIC` swaps ORDER BY RANDOM() → md5.
- RNG seam across possession-ai / lobbies / draft / halftime / matches.service shuffle.

## NOT a regression gate yet
Per the design, this is advisory until it (a) runs full matches reliably and (b) the
invariants are built and proven to catch the 3 reverted fixes. Neither is done.

## Remaining Slice 1 work (in order)
1. Fix boot flakiness + remaining boot delay (issue #1).
2. Get a full match to complete reliably (issue #2; answer specials).
3. INVARIANTS module — terminal state, legal phase order, score==bars, one round_result
   per qIndex, penalty uses penaltyCategoryId, counter ≤ total — run against the trace.
4. The 4 scenarios (S-clean, S-halftime-uiready-withheld, S-timeout-expire,
   S-reload-rejoin) + prove each invariant catches its bug by reverting the fix.
5. Score planner (deterministic draw → penalties).
6. N-match runner + report (the "1000 matches" deliverable) + LLM trace reviewer.

## scoring.ts
GRACE_MS 300→500 is the USER's committed change (4e0b885); boundary tests added
(14683cc). An UNRELATED uncommitted scoring.ts edit may still be in the working tree —
left untouched.
