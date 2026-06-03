# Potential findings from the regression harness

Status legend: 🔴 likely real bug · 🟡 needs investigation (could be harness artifact) · ⚪ ruled out (false positive in our invariant)

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
