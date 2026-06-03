# Game Regression Harness — Design

## Goal
Catch gameplay-breaking regressions automatically after code changes, without a human
playing matches. A scripted bot plays full matches (the real engine), every event is
recorded into a trace, and judges check correctness:
- **Judge 1 — invariants (code):** deterministic rules the game must never violate. Fails CI.
- **Judge 2 — LLM (Gemini Flash, later):** reads traces, flags anomalies the invariants
  didn't encode. Real flags get promoted into invariants.

## One bot, two runners
The same bot logic + same invariants, behind a small `MatchClient` interface:

- **LOCAL runner** — drives the real engine **in-process** against a **local Docker
  Postgres + Redis** (`docker:start`) — DECIDED: an isolated, throwaway DB the bot can
  hammer and reset. NOT the staging DB (the local runner writes thousands of matches/AI
  users and would pollute staging + interfere with real testing + be slow). The realtime
  timer scheduler is ticked deterministically. Runs ~hundreds–thousands of matches; the
  regression gate.
- **STAGING runner** — same bot over a **Socket.IO connection** to deployed
  `api-staging.quizball.io`. `--count N` real matches at real speed; post-deploy smoke
  check. The ONLY runner that touches staging, at a controlled count over the socket (not
  direct DB writes). **Auth (REVISED per review P2c): use DEDICATED staging test users**, not
  a personal token — a personal token makes smoke runs flaky and pollutes your real
  stats/progression/ranked state. Provision a small pool of `is_test`-flagged staging users,
  tag their matches, and clean them up after a run (and/or a test-only matchmaking namespace
  so bot traffic never mixes with real players). The earlier "reuse my own token" choice is
  superseded by this for anything beyond a one-off manual poke.

```
        ┌────────── shared: Bot + Scenarios + Invariants ──────────┐
        │  pick category · ban · answer random · quit/reconnect/   │
        │  forfeit · early-submit   +   rule checks on the trace   │
        └───────────────┬───────────────────────┬─────────────────┘
                 LocalAdapter (in-proc)    StagingAdapter (socket.io)
                        │                         │
                        └───────► EventTrace ◄────┘
                                     │
                          Judge 1 (invariants)  →  pass/fail
                          Judge 2 (LLM, later)  →  anomaly flags
```

## Key facts (audited)
- **START MATCHES VIA THE REAL PATH, NOT `dev:quick_match` (corrected per review P1a).**
  `dev:quick_match` is a dev-tool shortcut (used only by `/dev/penalties`) that pre-picks
  BOTH categories up front specifically to **skip halftime banning** — so it would NEVER
  exercise the halftime code that regresses. The bot instead emits **`ranked:queue_join`**,
  which (no human pair) falls back to a real AI match via `startRankedAiForUser` →
  `startDraft` → match. This is the exact production lifecycle a player hits: category draft,
  AI opponent, open play, **halftime banning** (categoryB chosen via the ban, not pre-set),
  penalties. No dev shortcut, no skipped phases.
- **Emit surface is broader than `io.to(room).emit` (corrected per review P2b).** The engine
  also uses `socket.emit` (27 sites in answer/dispatch), `io.emit`, and `io.to(\`user:<id>\`)`
  / `io.to(\`match:<id>\`)`. The recorder MUST capture client-specific events too — answer
  acks, countdown-guess acks, `match:rejoin_available`, `error`, session-state — via the
  fake socket(s) AND user-room routing, not just match-room broadcasts.
- Client/human actions are plain socket events the bot emits/calls:
  `ranked:queue_join`, `match:answer`, `match:halftime_ban`, `match:halftime_ui_ready`,
  `match:countdown_guess`, `match:forfeit`, `match:leave`, `match:rejoin`,
  `match:ready_for_next_question`, …
- **The ranked queue → AI fallback is loop+ticket gated (corrected per review P1).**
  `ranked:queue_join` only QUEUES the user; AI does NOT start immediately. Requirements the
  harness MUST satisfy in Slice 1 setup:
  1. **Seed a ticket**: the queue has a ticket preflight (`ranked-matchmaking.service.ts:93`,
     `wallet.tickets >= 1`) — seed the test user's wallet with ≥1 ticket via `storeService`
     /store repo, else join is blocked with `insufficientTickets`.
  2. **Run the matchmaking loop — drive `rankedTick` / `processFallbacks`, NOT `processPairs`
     (corrected R5).** AI fallback is handled by **`processFallbacks`** (line 295);
     `processPairs` (326) is human-vs-human pairing only. Both are invoked by **`rankedTick`**
     (359) on the loop `setInterval` (395). The harness must **advance fake time past the queue
     deadline AND drive `rankedTick`** (start `rankedMatchmakingService.start(io)` and tick under
     fake time, OR expose a deterministic `rankedTick()`/`processFallbacks()` seam to call).
  3. **`RANKED_HUMAN_QUEUE_ENABLED`** must be set so the loop runs (line 393).
  4. **One ticket per scenario (corrected R5).** The ticket is checked twice and **consumed at
     draft start** (`ticket-refill.service.ts:136` `wallet.tickets - 1`, via
     `lobby-draft-start.service.ts`). So a single seeded ticket is spent by scenario 1 and
     scenario 2 would be blocked. **Seed/reset one ticket per scenario, OR use a fresh test
     user per scenario.** (No country/RP/placement gate blocks AI fallback — country is
     optional; RP/profile context is generated/loaded in the ranked-AI flow.)
  The fake-time loop (below) must therefore also drive this `setInterval`, not only the
  realtime-timer scheduler.
- **AI behaviour: correctness seam + RNG seam now IMPLEMENTED (updated — RNG commits landed).**
  `aiCorrectness` is read from `ranked_context.aiCorrectness` (`possession-ai.ts`) and can be
  SET at match creation. The engine's nondeterministic `Math.random()` sites across the
  ranked-AI/draft/halftime path AND the put_in_order shuffle now go through the seeded
  `getRandom()` seam (`core/rng.ts`, commits 7475f45 / 570651a / this round). SQL question
  randomness (`ORDER BY RANDOM()` in the MCQ picker) is pinned via `REGRESSION_DETERMINISTIC=1`
  (deterministic md5 order; prod still RANDOM()) — proven: same seed → same question. Setting
  `aiCorrectness` alone still doesn't dial an exact scoreline (timing/kind matter) — the score
  PLANNER handles that — but a seeded run is now fully REPLAYABLE.
- The match clock (question deadlines, AI answers, halftime) runs through the durable
  **realtime timer scheduler** (`realtime:timers` ZSET + `pollDueTimers`). Ticking that
  deterministically advances the whole match — one clock to drive.
- Engine is coupled to real Postgres + Redis. **LOCAL runner uses a real local DB/Redis**
  (Docker) for fidelity — a mocked engine could pass while the real one breaks (e.g. the
  orphaned-active-match bug was DB state). Fidelity > speed.

## In-process adapter (the crux) — REVISED per review (P1b, P2a)
- **Fake `io`**: implements the FULL surface the engine uses — `to(room).emit` for both
  `match:<id>` AND `user:<id>` rooms, plus `io.emit`, `in(...).fetchSockets()`, room
  membership. Every emit is appended to the `EventTrace`, tagged with the target room so
  user-specific events (acks, rejoin-available, errors) are attributable to a seat.
- **Fake `socket`(s)**: one per "human" seat. Carries `socket.data.user`, `connectedAt`,
  `join/leave`, `id`, and a `socket.emit` (server→that client) that ALSO records — many
  acks (`match:answer` result, countdown-guess result, session state) go via `socket.emit`,
  not room broadcast, so the per-socket recorder is mandatory, not optional.
- **Drive the SOCKET EVENT LAYER, not just possession handlers (P1b).** Answer logic can
  call `handlePossessionAnswer` directly, BUT lifecycle actions (`match:leave`,
  `match:rejoin`, disconnect, reconnect) MUST go through the same entry points the socket
  server wires: `matchRealtimeService.handleMatchLeave/handleMatchRejoin`,
  `handleMatchDisconnect`, and **connect hydration** `rejoinActiveMatchOnConnect`. These run
  `runWithUserTransitionLock` (session guard), presence keys, `resumePausedMatch`, the grace
  timer — exactly where the orphaned-match/freeze bugs live. A "reconnect" = drop the fake
  socket, make a NEW fake socket for the same user, and call the connect path. Bypassing this
  is how a harness goes green while staging breaks.
- **Fake time must cover ALL clock sources (P2a).** The engine uses 32 call sites of
  `setTimeout` / `Date.now()` / `new Date()` (dispatch:11, disconnect:13, halftime:5, ai:3)
  in ADDITION to the Redis `realtime:timers` scheduler. A single controllable clock must, in
  one advance loop:
  1. advance the **wall clock** (`Date.now()` / `new Date()` — via vitest fake timers or an
     injected `now()` the harness controls),
  2. fire due **JS `setTimeout`s** (resume countdown, AI nuance delays, grace fallback),
  3. advance **Redis timer scores** and run `pollDueTimers()` (question deadline, AI answer,
     halftime),
  4. **drive the matchmaking loop tick** (`rankedMatchmakingService` `setInterval` →
     `rankedTick`/`processFallbacks`, which pops the `ranked:mm:timeouts` ZSET) so
     queue→AI fallback fires (P1),
  5. **flush microtasks** so awaited promises settle,
  then re-check for newly-scheduled timers and repeat until quiescent or the match ends.
  Validate against a known-good match shape before trusting it.

## EventTrace (shared schema) — REVISED per review (P2b)
Emitted events alone are too weak — the freeze bug is mostly "nothing emitted." The trace
records, in order with timestamps:
- **Emitted events**: `{ t, dir, event, room?, payload }`.
- **Timer lifecycle**: `timer_scheduled` / `timer_fired` / `timer_cancelled`
  (kind, key, dueAt) — captured by instrumenting the scheduler + JS-timer shims in the
  harness. Critical for diagnosing "stuck because a timer never fired / fired twice."
- **State snapshots** at each transition: `phase`, `currentQIndex`,
  `currentQuestion.qIndex`, `halftime.deadlineAt/uiReadyAt/purpose`, `penaltyCategoryId`,
  pause/grace/presence Redis keys present.
- **Final DB state**: `matches` row (status, winner, current_q_index) + `match_players`
  totals.

**Local vs staging trace fidelity (corrected per review P2a).** The LOCAL in-process runner
sees everything above (it owns the scheduler + Redis + DB). A plain Socket.IO STAGING client
**cannot** observe timer scheduled/fired/cancelled or Redis/cache state — only emitted
events it receives + (optionally) DB state via a query. So:
- Staging traces are a **reduced shape** (received events + final DB state), and invariants
  that depend on internal timer/cache state (e.g. "deadline rebased," "timer fired once")
  are tagged **local-only** and skipped on staging.
- OR (future) add a **staging-only debug/trace endpoint** (auth-gated, non-prod) that streams
  the internal timer/state events so staging reaches full fidelity. Until then, staging is a
  reduced smoke check, not a full invariant gate. Each invariant declares
  `requires: 'full' | 'events-only'` so the runner runs the right subset per environment.

## Invariants (Judge 1) — REVISED: Slice 1 must include the bugs we just fixed (P1a)
Slice 1 invariants (the regression-relevant set, NOT the generic 3):
1. **Terminal state reached** — match never ends stuck `active` (orphaned-match bug).
2. **No halftime finalize before UI-ready / ban window** — finalize must be deferred until
   `uiReadyAt === deadlineAt` (the existing `uiReadyForDeadline` guard,
   `possession-halftime.ts:252`). Assert no `PENALTY_SHOOTOUT`/2nd-half transition fires
   while the ban window isn't ready.
3. **No expired-question replay on resume** — after `resumePausedMatch`, a stale
   `current_q_index` question is not re-dispatched/double-resolved.
4. **Exactly one question + one round_result per qIndex** — no duplicate dispatch or
   duplicate resolution for the same index.
5. **Legal phase order** — allowed transition graph; never halftime twice in a row; no
   question after COMPLETED.
6. **Score == bars** — bar points reconcile with `possessionPointsEarned` (+8/+0 bug).
Later: penalty uses `penaltyCategoryId` not `categoryBId`; counter ≤ total; one AI answer
per question; no duplicate goal events.

## Scenarios — REVISED: Slice 1 includes the three investigated bugs (P1)
All scenarios start the match via the REAL `ranked:queue_join` → AI path (so halftime
banning actually runs — see Key facts). Slice 1 ships minimal repros of the recent failures:
- **S-clean**: full match incl. penalties (draft → open play → halftime ban → 2nd half →
  forced draw → penalty ban → shootout → COMPLETED). Bot emits `match:halftime_ui_ready`
  promptly and bans normally — the happy path.
- **S-halftime-happy** (explicit happy-path control): enter halftime, emit
  `match:halftime_ui_ready`, ban a category → assert finalize proceeds, 2nd half dispatches
  the correct next question. Pairs with the unhappy case below.
- **S-halftime-uiready-withheld** (the actual bug, precise per review P1b): enter halftime
  but **DO NOT emit `match:halftime_ui_ready`**. Advance time **past the original
  `deadlineAt`**. Assert: match **stays in HALFTIME**, `deadlineAt`/`uiReadyAt` get
  **rebased** (not finalized), and **no 2nd-half question (e.g. q7) is dispatched** until
  UI-ready arrives. (Mirrors `possession-halftime.ts:252` `uiReadyForDeadline` guard.)
- **S-timeout-expire**: let a question timer expire (no answer) → assert single
  dispatch/resolve per qIndex, no freeze, exactly one `round_result`.
- **S-reload-rejoin**: mid-match drop the fake socket → reconnect by creating a NEW fake
  socket for the same user and running connect hydration (`rejoinActiveMatchOnConnect`) →
  `match:rejoin` → `resumePausedMatch` → assert no expired-question replay/double-resolve,
  reaches terminal state.
Slice 2 fuzzes these ×N with randomized combinations.

## Reaching penalties deterministically (decided per review P2)
"Force a draw" cannot be assumed with real AI + `Math.random` timing + random questions.
We do NOT bypass scoring. Decision, in preference order:

**A. Seedable RNG injection (preferred) — but RNG alone does NOT give an arbitrary scoreline
(corrected R5).** Seeding makes question/category selection + AI behaviour *replayable*; it
does not let you "dial in" a draw, because scoring depends on more than RNG:
- **human answer time** is server-authoritative — the fake clock must advance to the intended
  answer time *before* the bot emits its answer;
- **AI planned answer time** (seeded, but still timing-dependent);
- **question kind** — `multipleChoice` / `countdown` / `putInOrder` / `clues` each score via
  different functions (`possession-round-resolver.ts`, `scoring.ts`);
- **the actual question payloads** selected.
So the correct formulation: **seeded RNG makes the match replayable; then a SCORE PLANNER in
the harness reads the emitted questions (kind + payload) and the real scoring functions, and
computes a deterministic per-round answer+timing plan for the bot (and the AI's planned answer
via its seam) to reach the target scoreline (e.g. an exact draw).** The bot owns the human
seat so it controls human answer correctness AND timing (via when it emits, against the fake
clock); the AI side is constrained via `aiCorrectness` + seeded timing. Do NOT bypass scoring —
the planner works *through* the real resolver. Replayability (failure replay) is the standalone
win of the RNG seam even before the planner.

**B. Test-only scenario driver (fallback, no engine change).** A harness-level "answer plan"
that controls BOTH sides through legitimate inputs: the bot answers per a fixed plan (it owns
the human seat), and the AI is constrained via `aiCorrectness` + intercepting the AI answer
at the scheduler boundary to apply a planned correct/wrong + timing — without skipping the
real scoring/resolution. More harness code, still no scoring bypass.

**C. Don't hard-require a draw in S-clean (always-valid baseline).** S-clean plays a normal
match to a terminal state and asserts phase/score/terminal invariants regardless of winner.
A SEPARATE scenario (using A or B) deterministically reaches a draw → penalty ban → shootout
so the penalty path is always covered. This decouples "match completes correctly" from
"penalty path covered" and avoids flakiness.

Plan: ship **C immediately** (penalty coverage via a controlled driver) and adopt **A** as
the determinism foundation — seedable RNG is the cleanest way to make the whole suite
reproducible and is a prerequisite for trustworthy fuzzing in Slice 2. B only if A is
rejected. The chosen mechanism is an explicit Slice 1 deliverable, not left to runtime luck.

**DONE (Option A implemented — commits 7475f45 / 570651a + this round):** the seedable RNG
seam is in `core/rng.ts`; all scenario-path `Math.random()` sites + the put_in_order shuffle
route through it; SQL question randomness is pinned via `REGRESSION_DETERMINISTIC`. Original
note kept below for context.**
A tiny RNG module (e.g. `src/core/rng.ts`) exposes `getRandom()` defaulting to `Math.random`
in prod. Replace the nondeterministic `Math.random()` call sites in `possession-ai.ts`
(answer timing, clue index, countdown-found) and the JS shuffles in `lobbies.service.ts`
(:11, :155) with `getRandom()`. Prod behaviour unchanged (still `Math.random`).

**Two corrections from R5 — both mandatory:**
1. **Scoped, NOT global-mutable seed.** Do NOT implement `seedRng(seed)` as shared global
   state — Slice 2 runs many matches concurrently and a global seed would cross-contaminate.
   Use a **scoped RNG**: `withSeed(seed, fn)` backed by `AsyncLocalStorage` (so every async
   call inside a match reads that match's RNG), or a **per-match seed lookup** keyed by
   matchId. `getRandom()` resolves the current scope's RNG, falling back to `Math.random` when
   unscoped (prod).
2. **SQL randomness must also be controlled.** Question/category selection uses
   **`ORDER BY RANDOM()` / `TABLESAMPLE SYSTEM`** in Postgres (`match-questions.repo.ts`:
   139/152/161/186; `lobbies.repo.ts`:354/378) — a JS RNG seam does NOT touch these, so
   questions/categories would still vary. For Slice 1, either (a) use **fixed question/category
   fixtures** for the deterministic scenarios (seed a known small set so selection is
   effectively pinned), or (b) make the random SQL accept a **deterministic ordering in test
   mode** (e.g. `ORDER BY md5(id || :seed)` / `setseed()` before the query). Fixtures (a) are
   simpler for Slice 1; (b) is the general solution for fuzzing.

C still provides the controlled penalty-reach driver on top. Done as part of Slice 1.

## Slice 1 setup checklist (must all be in place before scenarios run)
- Local Docker Postgres + Redis up; engine env (`NODE_ENV`, DB/Redis URLs,
  `RANKED_HUMAN_QUEUE_ENABLED=true`) configured.
- **One ranked ticket PER SCENARIO** — seed/reset a ticket before each scenario OR use a
  fresh test user per scenario (ticket is consumed at draft start; a single ticket would
  block scenario 2).
- **Matchmaking driven in fake time via `rankedTick`/`processFallbacks`** (not `processPairs`)
  so queue→AI fallback fires after the deadline.
- **Scoped seedable RNG** (`withSeed`/AsyncLocalStorage or per-match seed; never global
  mutable) wired into `possession-ai.ts` + JS shuffles.
- **SQL randomness pinned** for deterministic scenarios — fixed question/category fixtures
  (Slice 1) and/or deterministic `ORDER BY` in test mode (Slice 2 fuzzing).
- **Score planner** that reads emitted questions (kind + payload) + scoring functions and
  produces the per-round answer+timing plan to hit the target scoreline (e.g. draw → penalties).
- Realtime timer scheduler started; fake-time advance loop drives scheduler + JS timers +
  matchmaking tick + wall clock + microtasks.

## Build slices — REVISED
1. **Foundation + the three real bugs.** Folder + in-process adapter that drives the
   **socket lifecycle layer** + **full fake-time loop (incl. matchmaking tick)** +
   **ticket/queue setup** + **determinism mechanism** + timer-instrumented recorder + the
   scenarios above + invariants 1–6. Prove each invariant catches its bug by reverting one
   fix and seeing red. (local Docker DB/Redis) **This is the gate-worthy slice.**
2. **Scale + chaos** — runner does N matches with randomized scenario combos; summary
   report (pass/fail, first failing event + timer state per violation).
3. **Staging runner** — Socket.IO adapter + CLI `--count N`, dedicated staging test users
   (see auth note), reusing bot + invariants.
4. **LLM reviewer** — Gemini Flash reads traces, flags anomalies; promote to invariants.

## Location
Top-level `game-regression/` (tooling, not shipped). Imports the engine from
`../backend-node/src`. Run via its own scripts; the LOCAL runner can also be wired into
CI as a gate once stable.

## NOT a CI gate until proven (review summary)
Do NOT wire this as a blocking regression gate until Slice 1 demonstrably catches the three
bugs we just investigated (orphaned-active-match, expired-question-replay-on-resume,
halftime-finalize-before-ban-window). Acceptance for Slice 1 = revert each of those fixes
one at a time and confirm the corresponding invariant turns RED. Until then it runs
advisory-only. A harness that's green over known red bugs is worse than none.

## Open risks
- **Fake-time fidelity is the #1 risk (P2a)**: the engine mixes Redis-scheduler timers,
  JS `setTimeout`, and raw `Date.now()/new Date()` (32 sites). The advance loop must drive
  ALL of them in the right order or matches hang / diverge from prod. Validate Slice 1
  output against a known-good real match shape before trusting any result.
- **Socket-lifecycle fidelity (P1b)**: disconnect/rejoin/reconnect MUST go through the
  socket entry points + session guard + connect hydration, not possession handlers, or the
  harness passes while staging breaks. This is an acceptance criterion, not a nicety.
- **Trace completeness (P2b)**: emitted-events-only traces can't diagnose freezes ("nothing
  emitted"). Must capture timer scheduled/fired/cancelled + state snapshots + final DB state.
- **DB coupling / speed**: real local DB makes "thousands" take minutes, not seconds.
  Mitigate with a transactional/throwaway test DB and parallelism; tune match count for CI.
- **Determinism**: AI answer timing + question selection have randomness; seed where
  possible so failures reproduce.
- **Staging pollution (P2c)**: dedicated test users + cleanup + (ideally) a test-only
  matchmaking namespace; never a personal token for repeated smoke runs.
