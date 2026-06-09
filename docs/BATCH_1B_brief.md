# Batch 1B — Correct completion/forfeit behavior (Codex implementation brief)

Builds on Batch 1A (PR #47, merged to staging — the orphan sweeper no longer forfeits ranked
matches; it logs audit-only and leaves them active). 1B makes completion CORRECT: progress-aware
resolution, presence-aware forfeits, one completion lock, no fabricated stats. Seams below were
re-verified against current `staging`.

## Resolution hierarchy (the core rule)
When a match is stuck / a participant is gone, resolve in this order:
1. **goals** differ → winner by goals
2. tied → **penalty_goals** differ → winner by penalty goals
3. tied → **total_points** differ → winner by points (`total_points_fallback`)
4. tied → **correct_answers** differ → winner by correct answers (public method still `total_points_fallback`)
5. still tied / undecidable → **abandon, no RP** (terminal `status='abandoned'`)

Forfeit (with surcharge) is allowed ONLY when **exactly one player is clearly absent and ≥1 is clearly
present**. A present/leading/finished player must never be the forfeit loser. Manual user-requested
forfeit stays an explicit forfeit and bypasses progress override.

## Verified seams (current staging)
- **`decideWinner`** — `src/realtime/possession-completion.ts:31-72` — already does goals → penalty_goals
  → total_points_fallback with a `totalPointsFallbackUsed` flag. EXTEND it (or wrap it) to add the
  `correct_answers` tie-break before the final undecidable case. Public `winnerDecisionMethod` stays
  `goals` | `penalty_goals` | `total_points_fallback`; if `correct_answers` decided it, map to
  `total_points_fallback` and add a log field/comment so the mapping is intentional + UI-safe.
- **`finalizeMatchAsForfeit`** — `src/realtime/services/match-forfeit.service.ts`:
  - winner pick `:139-144` (`roster.find(p => p.user_id !== forfeitingUserId)`) — the "other seat wins"
    logic; must become presence-aware (absent loses) and must not fire when progress is determinable.
  - fake-stats inflation `:164-168` (bumps winner `total_points` toward full) — progress completions
    must NOT inflate; real forfeits must not fabricate a perfect `12/12`.
  - lock `:115` uses `lock:match:${matchId}:forfeit`.
- **`completePossessionMatch` / natural completion** — `src/realtime/possession-completion.ts:139-143`
  (sets `state.winnerDecisionMethod = decision.method`).
- **Round resolver lock** — `src/realtime/possession-round-resolver.ts:77` uses
  `lock:match:${matchId}:resolve`. (Different key from the forfeit lock → the race 1B fixes.)
- **Grace expiry + reconnect-limit** — `src/realtime/services/match-disconnect.service.ts`
  (`resolveExpiredGraceWindow`, the reconnect-limit forfeit path). Route both through the shared helpers.
- **Orphan sweeper (1A audit-only today)** — `src/realtime/services/user-session-guard.service.ts:161-189`
  — replace the audit-only return with the real resolution order. Add `updated_at` to the staleness
  check, raise threshold to 15 min, phase guard.
- **Stale thresholds** — `user-session-guard.service.ts:25-26` (`STALE_ACTIVE_MATCH_MS = 5min`,
  `STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS = 90s`).
- **Presence-correct precedent** — `src/realtime/services/stale-match-sweeper.service.ts` already picks
  the ABSENT player by presence key; reuse its approach for the shared presence helper.

## Key changes
1. **Shared progress decision helper** — wrap/extend `decideWinner` to return basis
   `goals | penalty_goals | total_points | correct_answers | undecidable`; public method unchanged.
2. **Shared presence helper** (new) — used by orphan sweeper, grace expiry, stale sweeper.
   - Present if: AI user, **live `match:<id>` room socket**, `connectingUserId`, or `matchPresenceKey`.
   - **`connectingUserId` is UNCONDITIONALLY present** (this is the core of the BJ bug).
   - **Room socket presence beats an expired/missing `matchPresenceKey`** (75s TTL can falsely read absent).
   - Absent if: `matchDisconnectKey`, or no socket/presence signal in stale cleanup.
   - Forfeit only when exactly one absent loser + ≥1 clear present counterpart; else abandon/no RP.
3. **One completion lock** — `lock:match:${matchId}:complete` for progress completion AND forfeit
   finalization. **Re-read the match under the lock and require `status='active'`** before acting
   (close the read-then-lock race). Route grace expiry + reconnect-limit through the shared helpers;
   remove the duplicate inline grace completion branch.
4. **Orphan cleanup** (`user-session-guard.service.ts:161-189`): use `updated_at` not `started_at`
   (already on `MatchRow` from 1A); 15-min threshold; **phase guard independent of staleness** — skip
   `HALFTIME` with a future deadline and the penalty ban interlude; resolution order = progress →
   absent-forfeit → terminal abandon; never forfeit the connecting user just for connecting.
5. **No fabricated stats** — progress completions never inflate; forfeits don't fake `12/12`.
6. **Abandon = terminal `status='abandoned'`**, NOT "leave active", and triggers NO ranked settlement.

## Test plan
- **Unit (progress decision):** goals / penalty_goals / total_points / correct_answers (mapped to
  `total_points_fallback`) / fully-tied undecidable.
- **Extend the existing regression test** `tests/regression/orphan-sweeper-attribution.test.ts`
  (already merged, PR #50 — currently asserts "present user not forfeited, match stays active" for 1A).
  For 1B, ADD assertions:
  - **BJ case:** leading 1:0 on goals, both stuck pre-final-Q, present player reconnects → match
    **completes as the leading player's win by `goals`**, NOT forfeit, opponent stats are real (no 12/12).
  - One clear absent opponent, no determinable progress → absent player forfeits.
  - Both absent / unclear + tied progress → **abandon, no RP**.
  - HALFTIME/penalty interlude is skipped even if stale by `updated_at`.
- **Presence unit tests:** connecting user always present; room socket beats missing presence key; AI present.
- **Grace/reconnect-limit:** leading/finished disconnected player completes naturally (no surcharge);
  clear absent forfeits; both gone/undecidable abandons; no path calls the fake-stats inflation.
- **Lock race:** concurrent progress completion + forfeit on `lock:match:<id>:complete` → only one
  terminal result commits.
- **Run:** `npm run lint`; focused `npm test -- tests/realtime/user-session-guard.service.test.ts
  tests/realtime/match-realtime.service.integration.test.ts tests/realtime/stale-match-sweeper.service.test.ts`;
  then the regression suite `REGRESSION_DB_URL=... npm run test:regression`; then full `npm test`.

## Implementation nuances (don't skip)
- **Re-read + `status='active'` check happens INSIDE the lock**, not before it (read-then-lock race).
- **Room socket > presence key** when they disagree (presence TTL can expire under a present user).
- **`connectingUserId` ⇒ present, full stop** — not "only if other signals are inconclusive".
- **Abandon writes a real terminal status** the frontend reads as void/no-result (don't reintroduce
  "active forever").
- Structure the shared helpers so a later single `completeMatchByDecision()` consolidation is easy.

## Assumptions
- Implement in `backend-node`. No DB migration (`matches.updated_at` exists; `MatchRow.updated_at`
  added in 1A). Public result enums unchanged. Abandoned ranked matches → no ranked settlement, no RP.
