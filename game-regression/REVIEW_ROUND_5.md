# Game Regression Design — Round 5 review request

Two blockers were raised last round. Both are now resolved in `DESIGN.md`. Please confirm
they're closed (and flag anything else) before we build Slice 1.

## Blocker 1 — Ranked queue → AI fallback needs ticket + loop tick (was P1)
**Verified in code:**
- Ticket preflight: `ranked-matchmaking.service.ts:93` requires `wallet.tickets >= 1`, else
  the join is blocked with `insufficientTickets`.
- AI fallback is NOT immediate: it fires from `rankedTick → processFallbacks` on the loop `setInterval`
  (line 395), which pops the `ranked:mm:timeouts` ZSET for entries `deadlineAt <= now`
  (line 304). `ranked:queue_join` only queues.
- Gated by `RANKED_HUMAN_QUEUE_ENABLED` (line 393).

**Resolution (DESIGN.md):**
- New "Slice 1 setup checklist": seed ≥1 ticket; run `rankedMatchmakingService.start(io)` /
  a deterministic tick seam; `RANKED_HUMAN_QUEUE_ENABLED=true`.
- The fake-time advance loop now explicitly **drives the matchmaking `setInterval`/`rankedTick → processFallbacks`
  tick** (step 4), advancing past the queue deadline so AI fallback fires.
- Key-facts section documents the loop+ticket gating.

→ Please confirm: is seeding the wallet + ticking `rankedTick → processFallbacks` in fake time sufficient to
deterministically reach the AI match, or is there another gate (search keys, country
detection, RP/placement preconditions) we're missing?

## Blocker 2 — "Forced draw → penalties" needs deterministic control (was P2)
**Verified in code:**
- `aiCorrectness` IS settable via `ranked_context.aiCorrectness` (`possession-ai.ts:113`).
- BUT the AI uses raw `Math.random()` for timing/clue/countdown (lines 43/52/59/66) and there
  is **no RNG injection seam** — so outcomes (and thus a draw) are not reproducible by setting
  correctness alone.

**Resolution (DESIGN.md), no scoring bypass:**
- **Option C (now):** S-clean asserts phase/score/terminal invariants regardless of winner; a
  SEPARATE controlled scenario deterministically reaches draw → penalty ban → shootout, so the
  penalty path is always covered without flakiness.
- **Option A (user-approved, Slice 1):** add a small seedable RNG seam — `getRandom()` defaults
  to `Math.random` in prod, `seedRng(seed)` in tests; swap the nondeterministic call sites in
  `possession-ai.ts` + question/category selection. Prod behaviour unchanged; tests get full
  reproducibility + failure replay. This is a small change to shipped code, done in Slice 1.

→ Please confirm: is seeding RNG + setting `aiCorrectness` + a fixed bot answer plan enough to
construct an arbitrary scoreline (incl. an exact draw), given scoring also depends on answer
*speed*? If speed-based points need control too, the bot's answer timing (it owns the human
seat) + seeded AI timing should cover both sides — confirm that reasoning holds.

## Unchanged-but-confirmed from prior rounds
- No `dev:quick_match` — real `ranked:queue_join` path (exercises halftime banning).
- Withheld-`halftime_ui_ready` scenario is precise (stay in HALFTIME, rebased deadline, no q7).
- Staging trace is reduced; internal-state invariants are local-only (`requires` tag).
- Recorder captures `socket.emit` + `io.to(user:...)` + `io.emit`, not just match-room.
- Not a CI gate until Slice 1 catches all three reverted fixes (red).

## Build order if approved
Slice 1: RNG seam + fake-time loop (scheduler + JS timers + matchmaking tick + wall clock) +
socket-lifecycle adapter + ticket/queue setup + recorder + the 4 scenarios + invariants 1–6,
proving each catches its bug by reverting the fix. Local Docker DB/Redis.
