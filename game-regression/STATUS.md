# Game Regression Harness — STATUS (overnight build)

## TL;DR
The hard architecture is PROVEN: a real ranked-AI match boots AND plays to completion
in-process (queue → AI → draft → ban → all 12 questions → halftime → COMPLETED →
final_results) against a NATIVE local Postgres + Redis, in an automated vitest test,
with a full event trace. Invariants module ("the referee") is written. Next: wire
invariants into scenario tests, build named scenarios, then the fuzzing runner.

## Multi-match runner design (DECIDED)
Loop, per the user's plan:
```
START: clear everything + seed question POOL once
for each match:
  flush Redis; clean match/lobby/player/answer/rp rows (NOT questions); reset user ticket
  play match with a per-match RANDOM SEED (different scenario each time)
  check invariants
  if failure: ALWAYS persist BEFORE next cleanup wipes it →
    {event trace JSON, invariant findings, matchId, seed, run index, key DB rows}
    if STOP_ON_FIRST_FAILURE=1 → stop
debug modes: clean-before-each (Option 1) + stop-and-keep (Option 3) as flags.
```
Reuse the question pool across matches (don't re-seed 1000×). Persisting failure
artifacts before cleanup is MANDATORY — else the next match wipes the evidence.

## Fuzzing — what varies per match (the whole point of 1000 games)
Each match is a different RANDOM scenario (seeded, reproducible): which categories
banned, correct/wrong/random answers, fast/slow/timeout timing, answer-or-skip
specials, and lifecycle chaos — disconnect (mid-match, at varying qIndex/phase),
reconnect-within-grace (resume), disconnect→abandon (grace expires), forfeit/quit,
halftime ban actively / time out / withhold ui_ready. This covers the bug CLASSES
real players hit (e.g. the orphaned-match disconnect bug).

## Build order (DECIDED: invariants/scenarios FIRST, then fuzzer)
1. Wire invariants into a CLEAN full-match test (baseline: a clean match passes all 6). ← NEXT
2. Named scenarios (disconnect/reconnect/abandon/forfeit/halftime/timeout) + prove
   each invariant catches its bug by reverting the corresponding fix.
   ✅ DISCONNECT FAMILY DONE (disconnect-scenarios.test.ts, 3/3): disconnect→grace→
   terminal (orphaned-match guard); explicit forfeit→terminal; disconnect→reconnect→
   resume→completes. Bot actions: botDisconnect/expireGrace/botReconnect/botForfeit.
   Fixed 2 real harness bugs en route (5fc0962): stale category cache across matches
   (every match after the 1st failed — critical for the runner) + resume countdown not
   collapsed (reconnect never resumed). TODO: halftime-uiready-withheld + timeout-expire
   scenarios, and prove each invariant catches its bug by reverting the fix.
3. Fuzzing runner (random seed per match composes the named behaviors) + artifact
   persistence + STOP_ON_FIRST_FAILURE + reuse-pool.
4. Run 1000 → report. (LLM trace reviewer later.)
Rationale: a fuzzer is only useful if the invariants are solid first.

## EXPANDED SCOPE (user, 2026-06-03) — cover ALL modes & entry flows, not just ranked-vs-AI
The harness must EVENTUALLY test every game mode and entry path, the same way it tests
ranked-vs-AI now. Concretely:
- **Game variants (all 3):**
  - `ranked_sim` — possession vs AI (DONE — current harness)
  - `friendly_possession` — possession in a friend lobby
  - `friendly_party_quiz` — party-quiz mode
- **Entry/lobby flows:**
  - create a lobby
  - join by INVITE CODE / share LINK
  - lobby ready → host starts the match
  - human-vs-human (two real bot "humans" in one lobby, not just vs AI)
- This reuses MOST of the existing foundation (adapter, clock, fixtures, trace,
  invariants are mode-agnostic). What's new per mode: the BOOT path (lobby create/join
  vs ranked queue), the bot's lobby actions (ready/start/ban), and mode-specific
  invariants (party-quiz dropout rules, friendly-lobby category selection, 2-human
  seating). Build these AFTER the ranked fuzzer is proven, mode by mode.
Order: finish ranked scenarios + fuzzer first (it's the deepest path), then add a
lobby-boot path + friendly_possession, then friendly_party_quiz, then human-vs-human.

## Local stack (NATIVE — no Docker)
Both Postgres and Redis run natively via Homebrew (Docker is no longer used).

**One-time setup:**
```
brew install postgresql@16 redis
brew services start postgresql@16          # Postgres on :5432
# create the regression DB + Supabase-compatible roles + pg_cron stub, then apply
# the 66 migrations (stripping the CREATE EXTENSION pg_cron line). See
# game-regression/setup-native-db.sh — run it once to (re)build quizball_regression.
```

**Start the stack (each session / after reboot):**
```
brew services start postgresql@16                                   # DB :5432
redis-server --port 6379 --requirepass changeme --daemonize yes     # Redis :6379
redis-cli -p 6379 -a changeme ping                                  # -> PONG
```
- DB URL: `postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression`
- Redis URL: `redis://:changeme@127.0.0.1:6379` (password matches backend .env)

## How to run
```
cd backend-node
REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
  npx vitest run tests/regression/match-boot.test.ts
```
Env flags (local-only, config-guarded): `REGRESSION_DETERMINISTIC=1` (pins question
SQL randomness), `REGRESSION_FAST_TIMERS=1` (collapses matchmaking/draft/round delays).

## What works (committed, all authored as the user)
- **RNG seam** (`core/rng.ts`) + full path coverage + SQL question determinism — a
  seeded run replays the same questions. Proven.
- **Local isolated DB/Redis**, **fixture seeder** (validated vs the engine's real
  ranked-eligibility query), full wallet/user reset, idempotent cleanup.
- **Fake-time clock** (`game-regression/src/clock.mts`) — proven (in a unit test) to
  drive the real durable scheduler for a SINGLE scheduled timer. NOTE: it is NOT used
  by the match runner and is NOT proven for full match playback (fake timers don't
  compose with the engine's real DB/Redis I/O). The runner instead uses REAL fast
  timers (`Date.now()` / `setTimeout`) with the REGRESSION_FAST_TIMERS delay seam.
  The fake-time clock is kept for possible future use but should be treated as
  unproven for end-to-end playback.
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
1. **Ack-signal correction (per Codex review):** the earlier "Q3 has no match:answer_ack"
   was the WRONG signal for countdown — countdown guesses emit `match:countdown_guess_ack`
   (`possession-answer-handlers.ts:440`), NOT `match:answer_ack`. Put-in-order/clues DO emit
   `match:answer_ack`. So before assuming the special answer is rejected, check the RIGHT
   ack per kind: countdown→`match:countdown_guess_ack`, putInOrder/clues→`match:answer_ack`.
   The countdown answer may already be registering. Re-profile with per-kind ack assertions.
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
