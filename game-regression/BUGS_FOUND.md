# Potential findings from the regression harness

Status legend: 🔴 likely real bug · 🟡 needs investigation (could be harness artifact) · ⚪ ruled out (false positive in our invariant)

---

## 🔴 #2 — Reconnect/resume DOUBLE-DRIVES the round loop (rewinds & replays rounds; ~2/3 of runs)

**Classification (2026-06-03, after Codex P1/P2 review): REAL engine bug, flaky (~2/3).**
NOT a harness artifact, NOT a concurrency-contamination artifact, NOT fast-timers-only.

### How it was ruled IN as real (the isolation work Codex asked for)
- Reproduced in **single-run, FRESH-process** matches (one `bootMatch` per OS process, no
  loop, no shared scheduler/DB across runs): **3 single runs → 1 stuck, 1 clean, 1 duplicate-
  dispatch.** Single-process reproduction excludes the P1 parallel-DB contamination and any
  in-process loop leakage.
- The bot now **respects `playableAt`** (waits out the reveal window before answering, incl.
  the resume's reveal-remaining offset) — `runner.mts playMatch`. The failure persists with
  that fidelity fix in place, so it is not "the bot answered before the question was playable."
- Hydration is ruled out: rejoin hydration re-emits with `socket.emit`
  (`possession-question-dispatch.ts:202`, recorded as `server->socket`); the duplicate
  dispatches are `server->room` broadcasts, which only the engine's room dispatch path emits.

### The mechanism (captured trace, fast-timers, one failing run)
After the bot disconnects (post-q2) and **one** `match:resume` fires, the round loop advances
normally q3→q4→q5 — then **rewinds to q3** and replays q3→q4→q5 a SECOND time:
```
32 match:opponent_disconnected
38 match:resume                 ← exactly ONE resume
40 match:question q=3   42 round_result q=3
45 match:question q=4   48 round_result q=4
51 match:question q=5            ← progressed to q5
54 match:question q=3   55 round_result q=3   ← ⚠️ REWIND to q3, resolved AGAIN
60 match:question q=4   62 round_result q=4   ← q4 resolved AGAIN
65 match:question q=5   67 round_result q=5
70 match:question q=6 … → q10 → final_results  (this run happened to recover)
```
Invariants that fire: `oneQuestionPerQIndex` (q3/q4/q5 re-dispatched, no intervening resume)
and `oneRoundResultPerQIndex` (q3/q4 resolved twice).

**Diagnosis:** the resume/rejoin path starts a SECOND question-advancement driver that races
the original (pre-disconnect) round chain. The two drivers double-dispatch and double-resolve
the rounds that were in flight across the pause. The two observed outcomes are the two ways the
race lands:
- **duplicate dispatch (recovers):** both drivers run, rounds 3-5 resolve twice, but the loop
  re-converges and the match still reaches `final_results`.
- **stuck match (wedges):** the racing drivers leave the state machine inconsistent; the match
  never reaches terminal — DB left `status='active'`, `phase='NORMAL_PLAY'`. (In the stuck
  capture, Redis still held live `possession_ai_answer` / `possession_question` timer keys for
  the in-flight qIndex, i.e. timers were scheduled but the loop didn't advance.)

This is the orphaned-active-match class (see project memory `orphaned_active_matches`) — a
disconnect/resume can strand a match in `active` forever.

### Why the harness suite didn't catch it every time
The single reconnect test in `disconnect-scenarios.test.ts` passed in one suite run purely
because that run hit the ~1/3 clean case. The test is itself **flaky** against this bug — it is
NOT a reliable green. (Options: run the reconnect scenario N× and require all-clean, or mark it
`fails`/quarantined until the engine fix lands so it documents the bug rather than flapping CI.)

### For review — do NOT change the engine unilaterally (per "document big ones for me to review")
Likely fix sites to investigate (engine owner): the rejoin/resume entry
(`match-disconnect.service.ts` resume countdown → `possession-question-dispatch.ts` resume
re-dispatch) must be **idempotent** w.r.t. an already-running round chain — i.e. resuming must
ADOPT the in-flight round driver, not spawn a parallel one. Suspect: a resume-scheduled
`sendQuestion`/round-advance firing alongside a pre-disconnect AI-answer/question timer that
survived the pause in Redis.

Repro: `npm run test:regression` (flaky), or the focused probe described in this folder's
status notes (single-run, fresh process, ~2/3 fail).

---

## 🟡 #1 — A normal-play question dispatched at qIndex 12 (13th normal question)

**Invariant:** `questionCounterInRange` — a NORMAL-play question must have `qIndex < total`.

**Observed (1 of 5 runs, 2026-06-03):**
```
completed:true q:14 phases:NORMAL_PLAY,LAST_ATTACK,HALFTIME,COMPLETED
FAIL [questionCounterInRange] @seq 89 Normal-play question qIndex 12 >= total 12
  ("question 13 of 12"). {"qIndex":12,"total":12,"phaseKind":"normal"}
```

**Why it might be REAL:** `POSSESSION_QUESTIONS_PER_HALF = 6`, total normal = 12 (q0–q5 half 1,
q6–q11 half 2). q11 is the LAST normal question — there should be no 13th NORMAL question.
A `phaseKind:'normal'` question at qIndex 12 is, on its face, the literal "question 13 of 12"
overflow this invariant guards against.

**Why it might be a HARNESS ARTIFACT (needs investigation before calling it an engine bug):**
- It appeared in only 1 of 5 runs, and ONLY in a run with an UNUSUAL phase order:
  `NORMAL_PLAY → LAST_ATTACK → HALFTIME → COMPLETED` (last_attack BEFORE halftime, which is
  odd). The other 4 runs were clean.
- The harness collapses many timers (REGRESSION_FAST_TIMERS) and the bot answers at fixed fast
  timing. It is possible the fast/uneven timing pushes the state machine into a corner that a
  real player's pacing wouldn't, producing an extra dispatch. That would be a harness-fidelity
  issue, not a shipped bug.

**Next step to classify it:**
1. Reproduce deterministically (it's RNG-seeded — capture the seed when it fails) and dump the
   FULL trace around seq 89 (phase transitions, normalQuestionsAnsweredInHalf/Total,
   half boundary) to see how a 13th normal question got dispatched.
2. Check whether the same sequence happens WITHOUT fast-timers (real timing) — if it only
   happens with fast-timers, it's a harness artifact; if it reproduces at real speed, it's a
   real engine bug worth fixing.
3. Specifically inspect the LAST_ATTACK→HALFTIME ordering — is that a legal sequence, or is the
   half-boundary logic being entered twice?

DO NOT "fix" the engine for this until classified — it may be the harness, not the game.
