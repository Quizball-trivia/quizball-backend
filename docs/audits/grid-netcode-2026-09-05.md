# Grid / Football Tic Tac Toe correctness review — September 5, 2026

The initial review reproduced four defects. The follow-up requested by the user fixes all four in the same backend and web worktrees. Application changes and permanent regression tests are uncommitted; no schema migration, push, or deployment was made.

## Follow-up resolution

- **P1 settlement:** open-series settlement remains retryable until the next game commits or the series closes. Deferred attempts do not finalize zero eligibility, mark rewards settled, or release a bot reservation. Concurrent retries pay the deciding result once.
- **P1 stale snapshots:** the client rejects superseded matches and older handoff versions, preserves pending commands on duplicate handoffs, and accepts forward series recovery. Ignored old completions are acknowledged without replacing the current board. Fresh-socket resync explicitly restores opponent/series context; terminal resync does not rebind a socket playing a newer game.
- **P1 readiness:** handoff and ready commands retry at 1, 2, then 4-second intervals using the same command ID for the same version. Same-version snapshots cannot postpone retries. Commands are not buffered offline; retries stop on acknowledgement, phase/match change, asset unavailability, or unmount.
- **P2 draws:** offers, acceptances, and declines enforce the database turn deadline. A pending admitted answer/pass retains priority over draw mutations. The exact deadline is accepted consistently with answer admission; a command one millisecond late is rejected.

### Follow-up verification

- **597 backend tests passed**, including all **48 PostgreSQL runtime integration tests**. The runtime suite was rerun after the final resync changes.
- **126 web tests passed**, including store ordering, dropped ready commands, reconnect retries, lost next-game handoffs, old-result acknowledgement, and active-match rejoin after PLAY.
- **24 new regression cases** were added across backend and web; existing draw fixtures now use timestamps inside their live turn window.
- Backend TypeScript check, web TypeScript check, focused web lint, and whitespace checks all passed. The unrelated Trivia Mines type errors observed during the first check were resolved by other ongoing workspace edits before the final check.
- The initial review's 19 dedicated auction integration scenarios were not rerun; no multi-replica live fault-injection or deployment test is claimed.

The remainder records the original review findings and evidence before these fixes.

## Workspaces

| Workspace | Branch | Current HEAD |
| --- | --- | --- |
| `/Users/user/dev/quizball-worktrees/grid-bo3-backend` | `feat/grid-bo3-series` | `46b99113ac6a60d54440c38c83b5cd333729bbf7` |
| `/Users/user/dev/quizball-worktrees/grid-parity-web` | `feat/grid-bo3-web` | `61215b367591658c6476e1f283a10c112c571be3` |

Both contain staged, unstaged, and untracked work. At initial review, the affected application files matched HEAD: these defects were present in the checked-out implementation, rather than introduced by the uncommitted daily-game edits. Ports 3000 and 8000 have running Node listeners. No commits, pushes, deployments, or changes to the running servers were made during the initial review. The follow-up changes source files used by the existing development watchers.

The hashes above are verified HEADs. Local `staging` references have different merge bases; they should not be treated as freshly verified remote staging bases.

## 1. P1 — Settlement can permanently finalize zero rewards before the series closes

Source: [football-grid-settlement.service.ts:264](/Users/user/dev/quizball-worktrees/grid-bo3-backend/src/modules/football-grid/football-grid-settlement.service.ts:264), especially the completed-outbox write at line 288. The independent settlement worker calls `settleMatch` directly at line 586; series advancement is performed separately by the realtime delivery path.

If the settlement worker wins the race after a deciding game terminalizes, `readSeriesOutcome` still sees an open series. Settlement writes `series_in_progress` eligibility and marks the outbox completed. Once series advancement records the winner, later settlement calls read that completed zero result instead of evaluating the finished series.

Database reproduction: create a BO3 game; forfeit player B; settle before advancing the series; advance; settle again. Player A's winner XP remains **0**, failing the assertion that it should be positive. The same premature-finalization branch handles coins and TP on normally decided series. This reproduction used a forfeit, where coins and TP are intentionally zero, to isolate the missing XP.

Fix direction: distinguish “this game has not been folded into the series yet” from “this game was folded and the series continues.” Defer settlement for the former, using a durable transaction/ordering contract shared by both workers. Do not finalize zero eligibility or release a continuing bot reservation before advancement is safe.

## 2. P1 — An old game's snapshot can replace the current game

Source: [footballGrid.store.ts:163](/Users/user/dev/quizball-worktrees/grid-parity-web/src/stores/footballGrid.store.ts:163), and `isOlderState` at line 90. Ordinary Grid state events are passed straight into this store by [socket-handlers.ts:860](/Users/user/dev/quizball-worktrees/grid-parity-web/src/lib/realtime/socket-handlers.ts:860).

The stale-state check only compares versions when match IDs are equal. An incoming snapshot for another match therefore bypasses the guard. A delayed old-game response after the next BO3 handoff can restore the previous terminal board and leave the UI pointed at the wrong game. The special protection for previous-game `grid:completed` events does not protect `grid:state`, `grid:paused`, or `grid:turn_resolved`.

Client reproduction: load match 2; deliver a terminal state snapshot from match 1. Expected active ID: `match-2`; actual ID: **`match-1`**.

Fix direction: authorize match switches through handoff/rejoin transitions and reject ordinary snapshots for superseded matches. Also enforce monotonic versions on repeated handoff payloads. Preserve initial reload recovery when no current match exists.

## 3. P1 — A transient ready failure can become a loading no-show

Source: [useRealtimeFootballGrid.ts:134](/Users/user/dev/quizball-worktrees/grid-parity-web/src/features/football-grid/realtime/useRealtimeFootballGrid.ts:134); the handoff effect uses the same pattern at line 118.

The hook records a match/version key before sending `grid:client_ready`. A temporary server error leaves that key set. Another snapshot with the same version is suppressed, and readiness has no acknowledgement timeout/retry loop. A reconnect or a peer's state advance can happen to recover it, but neither is guaranteed. The backend ready handler can fail during presence registration before committing readiness, so this is reachable without a transport disconnect.

Client reproduction: enter loading with the peer already acknowledged; emit ready; inject a temporary presence error; deliver the unchanged authoritative snapshot; advance 15 seconds. There is still only **one** ready emission. The server's loading ceiling is 20 seconds, after which the match may be cancelled as a no-show.

Fix direction: retry unacknowledged barrier commands with bounded backoff and stable command IDs, stopping after the authoritative participant flag or phase changes. Reset/reconcile safely on transient errors, match changes, and reconnects.

## 4. P2 — Draw acceptance can beat an already-expired turn

Source: [football-grid.service.ts:585](/Users/user/dev/quizball-worktrees/grid-bo3-backend/src/modules/football-grid/football-grid.service.ts:585) and [football-grid.engine.ts:393](/Users/user/dev/quizball-worktrees/grid-bo3-backend/src/modules/football-grid/football-grid.engine.ts:393).

Draw response validates membership, state version, and phase, but never checks the persisted turn deadline. If timer processing is delayed, the row can remain in `turn` after its deadline. A late acceptance then completes the game as a draw even though offers are meant to lapse with their turn. The database timestamp is passed to the engine only to timestamp the resulting state.

Database reproduction: offer a draw; set both turn/phase deadlines to one second in the past; accept at the current version before the timer worker runs. The operation succeeds with **`completionReason: draw_agreed`**, instead of rejecting/adjudicating the expired turn.

Fix direction: apply the same authoritative deadline and admitted-command ordering rules used for answers/passes before accepting draw mutations. Cover exact cutoff boundaries and delayed timer delivery.

## Verification

| Existing test group | Result |
| --- | --- |
| Grid and auction backend suites | 527 passed; 19 skipped |
| Included Grid PostgreSQL runtime integration suite | All 40 passed (included in 527) |
| Shared session guards, ranked disconnect/ready handling, timer scheduler | 59 passed |
| Web Grid, socket handlers/client, auction realtime adapters | 109 passed |
| Additional targeted review regressions | 4 failed, confirming the four defects above |

Total existing tests: **586 backend + 109 web passed**. The two new backend reproductions executed against the local PostgreSQL test database. They did not use staging or production. Temporary test copies were removed from both source trees after the review; their source and captured output remain under `/tmp/grid-audit-*` for this session.

The 19 skipped cases are the dedicated auction disconnect, lifecycle, and ranked-parity regression scenarios; they require `REGRESSION_DB_URL`. They were not counted as passing. Their harness flushes its selected Redis database, so those scenarios need an isolated test environment before running alongside other development work.

## Existing protections inspected

- Database-owned state versions, durable command admission, duplicate command replay, and processing leases.
- Simultaneous handoff/ready acknowledgement handling, plus no-show and late-reconnect database cutoffs.
- Per-socket presence leases and generations, replacement sockets, bounded disconnect pause budgets, and simultaneous-disconnect outcomes.
- Durable phase and bot deadlines, recovery polling for lost Redis timers, and service-interruption recovery.
- Result outbox retries and explicit result acknowledgement tokens.
- Pairing/session locks and cross-mode session guard integration with ranked and auction.
- Claim/event integrity tests, transactional settlement budgets, reward replay/reversal tests, and backend-only Grid table access in the migration.

These protections have useful coverage, but their presence does not prove every interleaving. No real multi-replica socket fault-injection campaign, server-process kill/restart test, or live deployment schema/performance audit was run in this review. Auction/ranked were reviewed through their shared infrastructure and selected suites, not exhaustively audited as independent modes.

## DuckDB and allowance

Default `python3` fails `import duckdb` with `ModuleNotFoundError`. DuckDB is imported by `scripts/football-grid-content-generator/football-grid-build-launch-manifest.py`; the live Node/PostgreSQL gameplay runtime does not require it. It is therefore a content-generation environment issue, separate from the defects above. No Python packages were installed during this review.

At the initial allowance check, the main weekly window was 44% used / **56% remaining**, resetting September 12, 2026 at 12:27 Tbilisi time. A usage percentage cannot reliably be converted into remaining development hours.
