# Road to Goal backend contract

Base path: `/api/v1/road-to-goal`. Every endpoint requires the normal QuizBall
session. New rounds are guarded by `ROAD_TO_GOAL_ENABLED`; existing rounds can
always be read or settled while the flag is off.

## Flow

1. `POST /rounds/commitments` with `{ "stake": 25,
   "request_nonce": "<uuid>", "auto_cashout_zone": null }`. This selects and
   calibrates the ordered 11-question run, generates the server seed, and
   returns a commitment that binds the round id, stake, auto-cashout setting,
   calibration, rules manifest, and ordered salted question digests. It does not receive the
   player seed or debit the wallet. Keep the nonce stable across retries.
2. Verify the returned rules manifest and keep the displayed commitment. Then
   `POST /rounds` with `{ "commitment_id": "<uuid>",
   "client_nonce": "<uuid>", "client_seed": "<1-128 chars>" }`. This atomically
   debits the stake, consumes the commitment, and serves zone 1. Keep this
   second nonce stable across ambiguous retries. A replay returns the same
   authoritative state; always branch on the response `status`.
3. `POST /rounds/answer` with `round_id`, `question_id`, `option_id`, the
   response's `state_version`, and a stable `request_nonce` UUID.
4. Correct answers use the displayed higher survival probability; wrong and
   late answers use the displayed lower probability. The committed server roll
   decides whether the player dribbles through or is tackled.
5. A survived answer returns `phase: "decision"`. Call `POST /rounds/continue`
   or `POST /rounds/cashout`, also with stable request nonces. Continue serves
   the next question with a fresh 15-second client deadline. Zone 11 success
   auto-credits the exact 4x return in the same transaction.

`GET /rounds/current` resumes an active run. `GET /rounds/:roundId` reads any
owned run, including a terminal run after a lost response. Mutations are row
locked and version gated, so clients should refresh after a `409`.
Question timeouts count as wrong answers and still run the committed survival
roll. If a player leaves at a decision point, the five-minute decision deadline
auto-cashes the already-earned return. Heartbeats do not extend either deadline.

Stake and payout writes are atomic with the wallet mutation and immutable store
ledger entry. A dedicated Road to Goal key table enforces one stake and at most
one payout per round without scanning or locking the historical global ledger.
Stable request nonces make ambiguous client retries return the authoritative
round instead of charging twice.

Before an answer, the question includes its expected accuracy and exact
correct/wrong survival odds. The client never receives the remaining question set or any correct option
before answering. The answer response includes only the current
`correct_option_id`, allowing the UI to reveal the result.

Questions with media include `question.image` (`url`, `width`, `height`, and an
optional `aspect_ratio`). Text-only questions return `image: null`.

The prepared response includes commitment-v3 before the backend accepts the
player seed. It exposes only an ordered list of salted per-zone digests; prompts,
answers, and salts remain hidden. `GET /rounds/:roundId/proof` reveals the server
seed plus snapshots and salts only for questions actually dealt, along with the
client seed, every applied probability, and every deterministic roll. The client
must compare this proof with the exact pre-seed envelope it retained. It can then
reproduce the commitment, verify each disclosed question leaf, and reproduce the
complete played portion without receiving unserved answer keys.

## Question rotation

Every prepared run queries the current public, ranked-eligible, published MCQ
pool; there is no global fixed or cached 11-question set. The commitment pins
four easy, four medium, and three hard questions in order before the player
seed is disclosed. Only a question actually served to the player counts as
exposed; hidden snapshots in an expired or abandoned commitment do not affect
rotation.

Selection exhausts questions the player has never been assigned before. Only
when a difficulty pool is exhausted are repeats allowed, ordered like ranked
play: lowest exposure count first, then longest since last exposure, with a
random tie-break. Newly published or materially edited questions enter after the
next immutable daily calibration snapshot. Unpublished or archived questions
leave selection immediately; questions already committed to a paid run remain
pinned for that run.

## Calibration and RTP

Each run pins an immutable daily, rules-versioned calibration. Ranked human
accuracy is the initial question signal. Road to Goal accuracy is measured for
each question at each reached zone, blends in gradually, and becomes primary
after 100 observations. Gameplay timeouts count as wrong for survival but stay
separate in editorial statistics. Difficulty priors are 80% easy, 65% medium,
and 50% hard; survivor-conditioned cold-start zone priors account for the fact
that stronger players are more likely to reach later zones. Expected accuracy
is clamped to 35–95%.

The multiplier ladder implies a target survival probability for each zone.
Correct and wrong odds are placed around that target with a 10 percentage-point
skill gap (shrunk only at the 0.5–99.5% safety bounds). Under the published
question-serving and cashout model, the calibrated population theoretical RTP
is approximately 98% at each cashout point (within one basis point after integer
probability discretization). The cold-start survivor mix is a documented 50/50
two-cohort model until enough question-and-zone observations replace it. This is
not a per-player guarantee and does not promise 98% for every possible player
strategy. Odds are never personalized and never changed to chase short-term
realized RTP. Provable fairness demonstrates reproducibility of committed inputs;
it does not prove unbiased editorial question selection.

## Question query benchmark

After applying the migrations to the target environment:

```sh
npm run road-to-goal:bench
```

The benchmark uses a transaction-local shadow history table. It warms the
normal empty-history path, then fills that temporary history with the current
eligible pool and measures the real unseen miss plus least-exposed fallback.
It takes 50 samples of each, reports min/p50/p95/max, and fails when either p95
exceeds 50 ms. No persistent schema or data is changed. Sample count and budget
can be overridden with `ROAD_TO_GOAL_BENCH_SAMPLES` and
`ROAD_TO_GOAL_BENCH_P95_MS`.

Read-only staging measurement on 2026-08-18 (6,981 eligible MCQs): the previous
48-row `ORDER BY random()` shape took 20.06 ms in its sampled plan. Ten
`EXPLAIN ANALYZE` runs of the UUID-pivot shape measured 2.30 ms p50 and 7.18 ms
p95 (1.50–7.18 ms), before applying the new `(difficulty, id)` partial index.
No staging schema or data was changed while measuring.

Read-only plan verification on 2026-08-19 used the current 6,924-question
active pool (3,012 easy, 2,906 medium, 1,006 hard) and a session-only temporary
player-history table. Server execution was 6.37 ms for the normal unseen path
and 26.50 ms for the fully exhausted least-exposed fallback. The temporary
table was dropped with the transaction; no persistent staging data or schema
was changed.

Local integration measurement after the immutable-calibration eligibility gate
on 2026-08-20 took 50 samples per path. The full select-plus-bulk-validation
unseen path measured 7.68 ms p50 / 21.28 ms p95, while a fully exhausted history
followed by least-exposed fallback measured 8.25 ms p50 / 14.57 ms p95. Both
were below the enforced 50 ms p95 budget.
