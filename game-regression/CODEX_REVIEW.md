# Codex Review — Game Regression Harness (full overview)

Repo: `backend-node` (branch `staging`). All work committed, nothing pushed.
Last Codex review was at `cb8c7b9` (cleared, no blocking issues). This brief covers
the whole harness effort end-to-end, with a focus on **prod-safety of engine changes**
and **harness correctness**.

## What the harness is
A bot plays REAL ranked-AI matches in-process (the actual production engine, against a
local DB + Redis), records every event into a trace, and "invariants" check the trace
for gameplay bugs. Goal: catch gameplay regressions automatically before they reach
staging. Full design + 5 prior review rounds in `game-regression/DESIGN.md`. Current
status + build plan in `game-regression/STATUS.md`. Potential findings in `BUGS_FOUND.md`.

## What works now (proven)
- A real ranked match boots AND plays to completion in-process: `ranked:queue_join` →
  AI fallback → draft → category ban → match:start → all 12 normal questions →
  LAST_ATTACK/HALFTIME → COMPLETED → `match:final_results`. The bot answers all 4
  question kinds (MCQ/countdown/putInOrder/clues).
- Invariants module (`game-regression/src/invariants.mts`) — 6 rules checked against the
  trace with precise per-violation findings.
- A clean full match passes ALL invariants (4/5 runs; the 5th surfaced finding #1, below).
- Fully NATIVE local stack (no Docker): Homebrew Postgres :5432 (DB `quizball_regression`,
  built by `setup-native-db.sh`) + Homebrew Redis :6379. The app's REDIS_URL is unchanged.

## Tests (all local-gated — skip unless REGRESSION_DB_URL is a local host)
- `tests/regression/match-boot.test.ts` — boots a match + first question (~5s)
- `tests/regression/clean-match-invariants.test.ts` — full match + all invariants
- `tests/regression/clock.test.ts` — fake-time clock drives the real scheduler (unit)
- `tests/regression/adapter.test.ts` — the FakeIo recorder (unit)
- Plus `tests/core/config.guard.test.ts`, `tests/realtime/scoring.grace.test.ts`.
Full `npm test` = ~777 pass / 7 skipped, lint clean. The integration tests SKIP on a
plain `npm test` (no local DB), so CI is unaffected.

## ⚠️ HIGHEST-PRIORITY REVIEW AREA: engine files touched for the harness
The harness required changes to 15 shipped `src/` files. Every change is meant to be a
NO-OP in production, gated on local-only flags. Please verify prod behaviour is truly
unchanged. The flags (both refused at boot outside NODE_ENV=local — see config.ts):
- `REGRESSION_DETERMINISTIC=1` — pins question SQL randomness + seeds the RNG seam.
- `REGRESSION_FAST_TIMERS=1` — collapses matchmaking/draft/round delays.

Engine files + what to check:
1. `src/core/harness-timing.ts` (NEW) — `harnessDelayMs(prodMs, fastMs)` returns `prodMs`
   unless REGRESSION_FAST_TIMERS=1. ★ Verify: when the flag is unset, every caller gets the
   real value. Default fastMs is 200; some callers pass larger (queue 1000ms, countdown 300ms).
2. `src/core/rng.ts` (NEW, earlier) — `getRandom()` === Math.random() unless inside
   `withSeed()` (AsyncLocalStorage). ★ Verify no accidental seeding in prod paths.
3. `src/core/config.ts` — guard refusing REGRESSION_* outside local; reads the PASSED env
   (env[k]) not process.env. ★ Verify the guard can't be bypassed and is order-correct.
4. Delay seams via `harnessDelayMs` in: `ranked-matchmaking.service.ts` (queue deadline),
   `lobby-ranked-ai.service.ts` (AI search + found-modal), `draft-realtime.service.ts`
   (draft auto-ban), `match-lifecycle.service.ts` (pre-match countdown), `possession-ai.ts`
   (AI answer delay), `possession-state.ts` (pre-answer reveal + answer window/deadline).
   ★ Verify: prod delays are byte-identical when the flag is off; nothing else changed.
5. `src/modules/matches/match-questions.repo.ts` — `REGRESSION_DETERMINISTIC=1` swaps
   `ORDER BY RANDOM()` → `ORDER BY md5(q.id || salt)` in the MCQ picker. ★ Verify prod still
   uses RANDOM(); the md5 string is built at module load from env (no per-query injection
   risk); salt is sanitized.
6. RNG seam swaps (`Math.random()` → `getRandom()`) in `possession-ai.ts`,
   `matches.service.ts` (put_in_order shuffle), `lobbies.service.ts`, `ai-ranked.constants.ts`,
   `possession-halftime.ts`, `draft-realtime.service.ts`. ★ Verify identical prod behaviour.
7. `src/realtime/socket-server.ts` — extracted the inline timer-handler map to an exported
   `buildRealtimeTimerHandlers()` (shared by prod + harness). ★ Verify the map is identical
   to before (pure refactor).
8. `src/realtime/realtime-timer-scheduler.ts` — exported the `RealtimeTimerHandlers` type.
9. `src/realtime/scoring.ts` — GRACE_MS 300→500 (this is the USER's gameplay change, with
   boundary tests in scoring.grace.test.ts). NOT a harness change; flagging so it's not
   conflated.

## Harness correctness to review (game-regression/src/)
- `adapter.mts` — FakeIo/FakeSocket are OBSERVE-ONLY (record server→client emits; do not
  deliver to client handlers). Documented. Fine for current scenarios; flag if a future
  rejoin scenario needs true round-trips.
- `runner.mts` — boots via the real production path; flushes Redis at setup (a stale queued
  search previously blocked AI fallback); uses real (fast) timers, NOT the fake clock.
  `playMatch` answers all 4 question kinds. ★ Check: is the answer-window collapse
  (`possession-state.ts`) changing scoring? (Intent: it shortens the deadline, not the
  scored timeMs — confirm.)
- `fixtures.mts` — seeds questions across all 3 difficulties + specials (a thin pool ran
  matches dry mid-game). `clearFixtures` TRUNCATEs match/lobby tables (destructive, but the
  DB is an isolated local harness DB). Wallet reset clears `tickets_refill_started_at`.
- `invariants.mts` — 6 rules: terminalStateReached, scoreMatchesBars (accepts score OR
  2×score for the speed-streak), questionCounterInRange (normal-phase only), legalPhaseOrder,
  one{RoundResult,Question}PerQIndex. ★ Review the rule semantics — are they correct given
  the engine? (See finding #1 — it may indicate either a real bug OR a too-strict rule.)

## 🟡 Finding #1 (documented in BUGS_FOUND.md — NOT fixed, needs classification)
1 of 5 runs: a `phaseKind:'normal'` question at qIndex 12 (a 13th normal question for a
12-question match), in a run with an unusual `NORMAL_PLAY → LAST_ATTACK → HALFTIME` order.
Could be a real "question 13 of 12" engine bug OR a harness fast-timer artifact. We did NOT
touch the engine for it. ★ A second opinion on whether the LAST_ATTACK→HALFTIME ordering is
legal, and whether a 13th normal dispatch is possible in prod, would be valuable.

## How to run (native stack)
```
brew services start postgresql@16
redis-server --port 6379 --requirepass changeme --daemonize yes
REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
  npx vitest run tests/regression/clean-match-invariants.test.ts
# rebuild the DB anytime: bash game-regression/setup-native-db.sh
```

## Specific questions for Codex
1. Are ALL the engine delay/RNG/SQL changes genuinely no-ops in production (flag off)?
2. Is the config guard airtight (can REGRESSION_* leak into staging/prod)?
3. Is `buildRealtimeTimerHandlers()` a faithful extraction (no behaviour drift)?
4. Are the 6 invariants semantically correct for this engine? Any other false-positive risks
   like the two we already found (2× streak; last-attack qIndex)?
5. Finding #1: real bug or harness artifact — any read on the LAST_ATTACK→HALFTIME ordering?
