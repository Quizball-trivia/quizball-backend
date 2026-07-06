# Chaos fuzzer — real findings

## Finding 1 (open): older live tab is not accepted as presence proof
Seed 2055058878 (run tag 1783325805, m1). Engine rule: the count-skip and the
reconnect-limit liveness re-check only accept same-user sockets whose
`connectedAt >= disconnectedConnectedAt` (anti-zombie). A user whose OLDER tab
is live, in the match room, and heartbeating — while a NEWER socket dies —
gets a counted disconnect, and at count > MAX an instant reconnect-limit
forfeit, despite verifiable presence. Heartbeat freshness (only in-room sockets
can write match stage presence) is the correct anti-zombie proof for this
check, not connectedAt ordering. Fix belongs in the be#162 family
(match-disconnect.service: use in-room sockets + fresh heartbeat for the
count-skip/limit re-check socket set).

## Finding 2 (fixed in be#162): stale disconnect double-count → wrongful forfeit
Rediscovered autonomously by seed 2055058878 on pre-fix code (run tag
1783316529, m1): staleDisconnect@q5 + flap(3)@q7 + multiTab@q8 ended in
[presentPlayerNeverForfeited] with the AI awarded a forfeit win.

## Triage notes
- m19 (flap(3)+flap(1) resume stuck): harness race, not engine — see artifacts/TRIAGE-m19.md.

## Finding 3 (open, UPGRADED): terminal resolution can abandon a match with a live present player
Second evidence path (run 1783330368 m2, seed base 42): multiTab@q4 — the
count-skip works (no disconnect counted), yet ~7s later the match dies
MATCH_ABANDONED ("could not be resolved from active progress") with the live
tab present and heartbeating. FLAKY (same seed passed the previous run) →
race in the disconnect→terminal-resolution path (progress completion failing
under lock/pause contention, falling through to abandon). Needs its own
engine investigation; the chaos invariant keeps this red intentionally.

Original evidence: silent-client rejoin abandons instead of resolving from progress
Seed run 1783327891 m8 (withholdReadyAcks@q2 + quitRejoin@q3): rejoin whose
resume ui-ready gate never completes ends the RANKED match `abandoned`
("Match abandoned because it could not be resolved from active progress") at
q3 with 3 answered rounds — arguably should resolve from progress (present AI
opponent, past the early no-contest window). Terminal state is legitimate for
a silent client; the outcome attribution is the question.

## Tuning note
Chaos plans stretch matches (real 20s graces per drop); use
FUZZ_PLAY_MAX_MS>=240000 for chaos runs (m7: full 12 questions played, budget
clipped before final_results at the default 90s).
