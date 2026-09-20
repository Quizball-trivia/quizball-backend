# Football Grid backend runbook

## Launch gates

Football Grid is deliberately unavailable until every gate below is green:

1. Apply `20260819120000_football_grid_backend.sql` before deploying the new
   application build. The migration backfills `matches.game_variant`, installs
   a compatibility insert trigger for rolling deploys, then makes the durable
   discriminator mandatory.
2. Produce and approve a licensed relationship manifest. A launch publish must
   contain at least 500 immutable boards, have the 25/60/15 difficulty mix,
   nine answers and two reviewed recognizable samples per cell, and exact
   English and Georgian aliases for every exposed footballer.
3. Record provider/database rights, permitted use, attribution, retention,
   approval owner, and evidence for every membership. Legal approval of the
   synthetic-opponent disclosure is a separate launch gate.
4. Run the migration contract, content validation, unit/integration tests, and
   a multi-replica socket/load rehearsal in staging.
5. Enable in order, with a completed canary and rollback check between each
   step: content, private lobby, random human queue, XP, TP/leaderboard,
   persistent bots, then coins. Ship the bot-governor schema and v2-capable
   application while `FOOTBALL_GRID_BOT_MODEL_VERSION=1`; flip to version 2
   only after every replica reports the compatible build. Do not enable Grid
   bots unless the shared persistent-bot roster is enabled and populated.

The safe defaults are:

```text
FOOTBALL_GRID_CONTENT_ENABLED=false
FOOTBALL_GRID_QUEUE_ENABLED=false
FOOTBALL_GRID_LOBBY_ENABLED=false
FOOTBALL_GRID_BOTS_ENABLED=false
FOOTBALL_GRID_BOT_MODEL_VERSION=1
FOOTBALL_GRID_BOT_GOVERNOR_ENABLED=true
FOOTBALL_GRID_COINS_ENABLED=false
FOOTBALL_GRID_POINTS_ENABLED=false
FOOTBALL_GRID_RISK_HASH_SECRET=<32+ random characters when coins or TP are enabled>
FOOTBALL_GRID_XP_ENABLED=true
FOOTBALL_GRID_BOT_FALLBACK_MS=10000
```

## Content workflow

The content command accepts a normalized JSON manifest containing sources,
criteria, a complete asset-key catalog, evidence-backed memberships, reviewed
player display/image records, aliases, and optionally boards. Launch validation
requires every criterion header and exposed player portrait to resolve to a key
in that catalog. Activation additionally resolves every key through a JSON
asset registry and verifies that its real file exists, so crests, flags, league
art, player imagery, and wildcard artwork cannot silently ship with gaps.

```bash
npm run grid:content -- generate relationships.json --limit 1000 --out candidates.json
npm run grid:content -- review candidates.json --asset-registry assets.json --out football-grid-review-pack
npm run grid:content -- validate approved-manifest.json
npm run grid:content -- publish approved-manifest.json
npm run grid:content -- activate approved-manifest.json --asset-registry assets.json
```

`generate` finds 3x3 criterion bicliques whose nine cells each contain at least
nine verified footballers. Generated boards are stamped `UNREVIEWED` and cannot
pass a launch publish. Reviewers select recognizable samples, correct
difficulty, enter their approver identity, and review the static HTML (including
sample names, portraits, and cell evidence), board CSV, and provenance-rights
CSV. `--feasibility` is accepted only by validation; it may be used for pool
design but can never make content runtime-selectable.

`publish` stages an immutable, non-playable `feasibility` release. `activate`
reruns every launch check, verifies the physical asset registry, requires at
least 500 approved boards, and is the only transition to runtime-selectable
`published`. `retire` stops future selection without mutating historical
content. Never repair an active or retired release in place; running matches
remain pinned to their board, answer, alias, resolver, and checksum snapshot.
Approved source records are immutable too. Reusing a source key and dataset
version is accepted only when provider, rights, attribution, retention, owner,
and approval timestamp exactly match the existing record; otherwise staging
fails with a provenance conflict and must use a new dataset version.

To stop new selection immediately, append a `disable` row to
`football_grid_content_quarantines` for one board or its whole release. To
restore it, append a newer `enable` row. Quarantine rows are append-only, and
equal-timestamp decisions are deterministically ordered by ID. A disable stays
authoritative until a later explicit enable at the same board/release scope;
another temporary disable cannot accidentally supersede it after expiring.
Enable events cannot expire. Quarantine never mutates live matches.

Operators must use the authenticated admin endpoints rather than direct SQL:
`POST /api/v1/admin/football-grid/content/quarantines` appends a disable or
enable, and `GET /api/v1/admin/football-grid/content/quarantines` returns its
ordered history. Each write validates the published release/board relationship
and records the actor, reason, expiry, and quarantine ID in `audit_logs` in the
same transaction.

## Runtime ownership

The database is authoritative for state versions, command admission time,
deadlines, claims, presence generations, pairings, terminal state, and rewards.
Redis owns only queues, short-lived pairing fences, socket presence leases, and
the durable timer index. A Redis outage therefore disables new random searches
and avoids false disconnect forfeits; it does not rewrite a match.

Every player command supplies `matchId`, `commandId`, and
`expectedStateVersion`. Answer commands additionally supply `cellIndex`,
`locale` (`en` or `ka`), and bounded text. Reusing a command ID with the same
payload replays the stored result; reusing it with another payload fails.
Ambiguous answers preserve the current turn and deadline. Wrong, already-used,
pass, and timeout advance the turn.

The client must send `grid:presence_heartbeat` every 5 seconds; leases expire
after 15 seconds
while bound to a Grid match. Match-found handoff has 15 seconds, ready loading
has 20 seconds, countdown is 3 seconds, turns are 20 seconds, reconnect grace
is 30 seconds, and each player starts with 60 seconds total pause budget.

Terminal delivery is also acknowledged. On `grid:completed`, the client must
persist/render the full result payload and then send `grid:completed_ack` with
the same `matchId`, `terminalStateVersion`, and per-attempt `ackToken`. The
unpredictable token exists only in `grid:completed`; terminal `grid:state` can
never acknowledge or suppress a result that was not delivered. The server
keeps the delivery in `awaiting_ack` and replays the complete result with a new
token on retry or terminal resync until that exact ACK is durable.

Friend/private/public/code/challenge matches are exactly two humans and award
XP only. Random matches can award TP and coins. Bots are persistent roster
identities, are selected near the human's Ranked RP, and pin tier/RP/model,
governor adjustment, config, and random seed into the match. Friend lobbies and
rematches never add bots.

## Economy and moderation

Grid settlement uses its own transactional outbox and ledgers. It is safe to
retry. XP is 70/60/50 for win/draw/loss and 20 for a forfeit loss. Random coin
rewards are 700/250/250 for win/draw/loss; forfeits pay no coins. The rolling
coin cap is 3,500 per 24 hours. Random TP rewards are 50/30/10 for
win/draw/loss; forfeits pay no TP. TP is independently controlled by
`FOOTBALL_GRID_POINTS_ENABLED` and is not reduced by the coin cap or coin
feature flag. Coins and TP share the three-rewarded-matches-per-human-pair,
five-rewarded-bot-matches, minimum-participation, and risk-hold controls. Bots
never receive Grid rewards.

Coin and TP settlement also require privacy-preserving handoff observations
hashed with `FOOTBALL_GRID_RISK_HASH_SECRET`. Network identity comes only from the
deployment's trusted client-IP resolver, never a raw client-supplied forwarding
header. The v1 evaluator holds missing trusted network identity, same-device
opponents when device identity is available, repeated same-network opponents,
and abnormal reward velocity for admin review. Device identity is an optional
additional signal, not a payout requirement. Staging/production refuse to boot
with Grid coins or TP enabled unless the hash secret is configured.

Held coin events never credit a wallet and remain inside the rolling cap even
when older than 24 hours. An audited release rechecks the cap under the user's
reward-budget lock and records `credited_at`; an audited denial creates a
reversal without debiting the wallet. Committed rewards age out of the cap from
their actual credit time, not their original hold time.

Held TP never credits the leaderboard balance. Releasing or reversing held TP
uses the same replay-safe, audited pattern as coins, but TP has no rolling
balance cap.

Players can report a rejected attempt at most five times per 24 hours. Reports
retain the immutable match, release, board, submitted value, and resolver
context for review. Admin endpoints under `/api/v1/admin/football-grid` inspect
settlement, release/reverse coin or TP events with an audit record, list
reports, and record report decisions. These routes require admin auth.
Accepting a report also requires a newer published release whose reviewed alias
and memberships uniquely resolve the submitted answer against both original
cell criteria; an arbitrary release ID is rejected.

## Product analytics (PostHog)

Football Grid uses named, low-volume events. Global click autocapture and
full-app session replay remain disabled. Never add submitted answer text,
normalized answer text, player email, IP address, device identity, or risk
hashes to PostHog. Answer behavior is aggregated from authoritative database
rows when the match reaches a terminal state.

The launch funnel is:

1. `football_grid_viewed` — unique people who saw the mode.
2. `football_grid_play_started` — people who intentionally started the demo or
   entered the play flow.
3. `football_grid_queue_joined` — server-confirmed random queue entry.
4. `football_grid_match_found` — server-created opponent pairing, including
   queue wait, human/bot type, origin, and board version.
5. `match_started` filtered to `mode = football_grid` — both clients became
   ready and the authoritative countdown began.
6. `match_completed` filtered to `mode = football_grid` — a real result. Loading
   no-shows, simultaneous disconnects, and administrative cancellations emit
   `match_abandoned` instead so they do not inflate completion conversion.

Supporting events are `football_grid_queue_left`,
`football_grid_engagement_ended`, `football_grid_rematch_response`, and
`football_grid_missing_answer_reported`. The demo additionally emits
`football_grid_demo_completed`; it must not be combined with authoritative
online completions.

`football_grid_engagement_ended` carries elapsed and foreground-active seconds
plus aggregate visit counters. `match_completed` carries duration, result,
completion reason, origin, human/bot opponent, board/version/difficulty, turns,
claims, answer-outcome counts, pass/timeout counts, average response time, XP,
coins, TP, and the separate coin/TP eligibility reasons. Retried server events
use a deterministic UUID and stable occurrence timestamp so PostHog eventually
deduplicates them.

Create the staging PostHog dashboard only after the first staging events are
visible in the data schema. Include:

- unique viewers, play starters, queue joiners, starters, and completers;
- view → play → queue → found → started → completed conversion and median time
  between steps;
- p50/p95 queue wait split by human/bot and locale;
- p50/p95 active engagement and authoritative match duration;
- completion, abandonment, rematch acceptance, and D1/D7 return rates;
- result/completion-reason distribution split by origin and opponent type;
- answer accuracy, wrong/ambiguous/already-used/pass/timeout rates and response
  time split by board difficulty/version;
- missing-answer report rate by board/cell and reward eligibility distribution.

Keep staging and production on their separate PostHog project tokens. Local
development has no token by default and must not pollute either project.

## Monitoring and SLO alerts

Dashboard these metrics split by origin/opponent/outcome where available:

- `quizball_football_grid_queue_wait_duration_ms`: alert when human p95 exceeds
  20 seconds for 10 minutes or bot p95 exceeds fallback plus 10 seconds.
- `quizball_football_grid_content_exhaustion_total`: any production increase is
  a page; disable queue/lobby entry until content selection is understood.
- `quizball_football_grid_commands_total` and
  `quizball_football_grid_resolver_duration_ms`: alert if command error rate is
  above 1% or resolver p95 above 250 ms for 10 minutes.
- `quizball_football_grid_phase_timeouts_total` and
  `quizball_football_grid_presence_transitions_total`: watch for deploy/network
  spikes and abnormal loading no-shows.
- `quizball_football_grid_settlements_total` and
  `quizball_football_grid_reward_eligibility_total`: page on failed settlements
  or a sudden eligibility-reason distribution change.
- `quizball_football_grid_pairing_recovery_total`: any sustained requeue volume
  indicates a matchmaking or database reliability problem.

Also alert on stale `football_grid_pairings.status='claimed'`, nonterminal
matches whose deadline is overdue, command inbox rows past their processing
lease, failed settlement outbox rows, result deliveries stuck in
`processing`/`awaiting_ack`, and persistent-bot reservations nearing expiry
while their match is active.

## Incident controls

- Content problem: set `FOOTBALL_GRID_CONTENT_ENABLED=false` and append an
  audited disable through the quarantine admin endpoint for the affected
  board/release. Append an explicit audited enable only after review. Existing
  matches remain pinned and auditable.
- Matchmaking problem: set `FOOTBALL_GRID_QUEUE_ENABLED=false`; private lobby
  matches can remain enabled independently.
- Bot problem: set `FOOTBALL_GRID_BOTS_ENABLED=false`; queued humans continue to
  wait for humans and no ephemeral Grid bot is created.
- TP problem: set `FOOTBALL_GRID_POINTS_ENABLED=false`; XP, gameplay, and coins
  can continue. Reconcile/reverse through the TP ledger admin tools, never by
  directly changing `users.tic_tac_toe_points`.
- Coin problem: set `FOOTBALL_GRID_COINS_ENABLED=false`; XP, TP, and gameplay can
  continue. Reconcile/reverse through the coin ledger admin tools, never by
  directly decrementing a wallet.
- Gameplay problem: disable queue and lobby entry. Do not delete active rows;
  the deadline/recovery workers or an explicit administrative no-contest own
  terminalization and reward suppression.
