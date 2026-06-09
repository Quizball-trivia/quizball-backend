# Staging (online) harness — design

A SEPARATE tool from the local in-process harness. The local harness calls the
engine's functions directly (FakeIo, no network) — great for logic bugs, but it
cannot test the real WebSocket, real auth, real Supabase/Redis, the deployed
Railway code, or network reconnect/latency races. The staging harness is an
**external real client** that connects over the network, exactly like the app.

## Goals (decided)
1. **Network smoke test** — a few real matches over the real socket confirm the
   deployed code + auth + network path work end-to-end.
2. **Post-deploy / pre-promotion gate** (Codex P2) — runs AFTER staging is deployed,
   as a go/no-go for PROMOTING to production. The staging deploy already happened; a
   failure should **block promotion / trigger rollback or alert**, not block staging.
3. **Reconnect/latency focus** — actually drop + reconnect a real WebSocket
   mid-match and assert the full resume sequence (the bug-#2 class in-process can't reproduce).

## Triple-source verification (the key upgrade)
The staging harness checks a match THREE ways, not just one. CRITICAL (Codex P1): a
standalone unattended script CANNOT call the Railway/PostHog MCP tools — those only
exist inside an agent session. For a real gate, use the provider **APIs/CLI with
explicit env credentials**, not MCP.

1. **Client event stream** (what the bot's socket receives) → reuse the existing
   trace invariants (`checkInvariants` / `checkPartyInvariants` /
   `finalResultsWellFormed` / `winnerMatchesResults`). No engine access needed —
   `match:final_results` carries scores/winner/standings. THIS IS THE PRIMARY GATE.
2. **Railway server logs** (Railway **API/CLI**, creds: `RAILWAY_TOKEN`,
   `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`) → scan the
   deploy's logs for ERROR/unhandled-rejection/stack traces. **Correlation required
   (Codex)**: filter by `matchId` / `userId` / a harness `runId`, NOT time-window
   only — a time-only scan false-fails if another staging tester errors in the same
   minute. If logs don't carry enough correlation today, ADD structured log fields
   (matchId/runId) before depending on this as a gate; until then it's ADVISORY.
3. **PostHog events** (PostHog **API**, creds: `POSTHOG_PROJECT_ID`,
   `POSTHOG_PERSONAL_API_KEY`) → assert the expected analytics fired. **The contract
   must match REALITY, not the defined-but-unemitted list (Codex P1).** Verified
   actually-emitted (have call sites): `ranked_queue_joined`, `draft_started`,
   `draft_completed`, `possession_phase_entered`, `penalty_taken`, `match_completed`,
   `match_abandoned`, `level_up`, `lobby_created`, `lobby_joined`, `party_quiz_started`,
   `socket_connected`, `socket_disconnected`, `achievement_unlocked`.
   DEFINED BUT NOT EMITTED (0 call sites — do NOT assert): `ranked_match_found`,
   `rank_points_changed`, `match_created`, `lobby_left`. Asserting these today fails a
   healthy match. → Build the expected-event matrix from the emitted set only; if you
   want the missing ones, ADD the backend emit call sites first as a separate change.
   PostHog flush is BATCHED → poll with a **2-5 min ceiling**, never assert immediately.

A match is "clean" only if all three agree: client invariants hold, server logs are
error-free, and the expected analytics fired (and no error events).

## How it connects (verified against the code + the existing e2e script)
- Socket auth: the server reads `socket.handshake.auth.token` (`socket-auth.ts:30`)
  → `authProvider.verifyToken(token)`. Connect with `io(URL, { auth: { token } })`.
- **TWO tokens required (Codex P1):** ranked-vs-AI needs one user, but a real friendly
  HUMAN-vs-HUMAN lobby needs TWO distinct logged-in users. Require `STAGING_TEST_TOKEN_A`
  and `STAGING_TEST_TOKEN_B` (separate accounts), never committed. This matches the
  existing online script `scripts/test-friendly-e2e.ts` (`TEST_ACCESS_TOKEN` +
  `TEST_ACCESS_TOKEN_B`) — BUILD ON THAT proven shape, don't reinvent.
- Reuse the existing bot logic (answer MCQ/specials, halftime ban, party ready-ack)
  but emit over the real `socket.io-client` instead of calling handlers directly.

## Shape (a standalone script — NOT a vitest test, NOT MCP-dependent)
`game-regression/staging/run.mts` with explicit named SCENARIOS (Codex):
`ranked_ai_smoke`, `friendly_possession_smoke`, `friendly_party_smoke`, `reconnect_smoke`.
1. Connect `socket.io-client`(s) to the staging URL with token A (and B for friendly);
   record the real event stream into the same EventTrace shape.
2. Enter a match: ranked queue (real AI fallback, 1 token) OR create+start a friendly
   lobby (2 tokens, like test-friendly-e2e.ts).
3. Play to completion over the real socket (reuse bot answer logic).
4. **reconnect_smoke (phase-aware, Codex P2):** mid-match `socket.disconnect()` then
   reconnect, and assert the FULL sequence with generous waits — opponent observes the
   disconnect → reconnect availability / session state → resume countdown → `match:resume`
   (emitted AFTER the countdown; hydration is async post-connect, socket-server.ts:358)
   → a fresh question → completion. Do NOT assert resume immediately on reconnect.
5. Run the trace invariants on the recorded stream (the PRIMARY gate signal).
6. **Railway logs** via the Railway API/CLI (env creds), filtered by matchId/userId/runId
   (NOT time-window only) → fatal server errors fail the gate.
7. **PostHog** via the PostHog API (env creds), poll with a 2-5 min ceiling (batched
   flush) → assert the EMITTED-event matrix (not the unemitted events) and no
   `error_occurred`. ANALYTICS-missing is a fail ONLY after the event contract is
   corrected + stable; until then it is ADVISORY (warn, don't fail).
8. Print a per-source, per-scenario report; exit 0 (all clean) / 1 (a hard failure).

## Gate policy (Codex)
- FAIL the gate on: (a) client-side match non-completion / invariant violation, and
  (b) fatal server errors in the correlated Railway logs.
- WARN only (not fail, for now) on: missing/unexpected PostHog analytics — until the
  event contract is corrected and proven stable, and logs carry correlation fields.

## Scale & safety (important)
- Staging is LIVE infra: do NOT fuzz 1000 matches there (rate limits, real RP/tickets,
  cost, pollutes real data). Bulk fuzzing stays LOCAL. Staging runs a HANDFUL of
  smoke/gate matches (one per named scenario).
- The test users' RP/tickets WILL change on staging — use dedicated throwaway
  accounts; consider resetting them between runs (if a staging admin endpoint exists).
- Correlate (not time-box) log/analytics queries by matchId/userId/runId.

## Build order (Codex-approved, revised)
1. **Phase 1 — client-only gate (no MCP, no provider creds):** extend
   `scripts/test-friendly-e2e.ts`'s shape into `game-regression/staging/run.mts` with
   the 4 named scenarios; verify purely on the client event stream + invariants.
   This alone is a useful gate and needs only the two tokens + staging URL.
2. **Phase 2 — Railway logs:** add correlated (matchId/userId/runId) log scanning via
   the Railway API/CLI. If logs lack correlation fields, add them first.
3. **Phase 3 — PostHog:** add the emitted-event matrix check via the PostHog API,
   polled with a 2-5 min ceiling, ADVISORY until the contract is stable.

## Open questions to resolve before building
1. Staging URL (`BACKEND_URL`/WS) + **TWO** test-user tokens
   (`STAGING_TEST_TOKEN_A` / `_B`) — user to provide (separate accounts).
2. Railway provider creds (`RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`,
   `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`) and whether staging logs already
   carry `matchId`/`runId` for correlation (if not, add structured fields first).
3. PostHog provider creds (`POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY`).
4. Reset strategy for the test users' RP/wallet between gate runs (admin endpoint?).
5. Where this runs operationally — it's a post-staging-deploy / pre-PROMOTION gate;
   a failure should block promotion / alert, not block the (already-done) staging deploy.

## Status
Concept APPROVED by review. The MCP-based verification was corrected to provider
APIs/CLI; the analytics contract was corrected to the actually-emitted events; two
tokens are required; reconnect asserts the full phase-aware sequence; logs must be
correlated; gate fails on client non-completion + fatal server errors, analytics
advisory until stable. Ready to build Phase 1 once the URL + two tokens are provided.

## What this does NOT replace
The local harness remains the primary, high-volume bug-finder (fuzzing, all the
invariants, the LLM judge). The staging harness is a small, high-fidelity
confirmation that the DEPLOYED system works over the real network — a gate, not a fuzzer.
