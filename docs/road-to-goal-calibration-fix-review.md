# Road to Goal calibration fix — local review

Status: local and uncommitted. No push, staging deployment, production deployment,
OTA publication, simulator, or emulator testing.

## Cause and fix

The old selector rejected questions updated after the daily calibration. Bulk
question or translation edits could therefore leave zero eligible questions and
make commitment preparation return HTTP 503 despite a populated published pool.

The candidate keeps valid published questions selectable. Measured accuracy is
used only when its question and payload are unchanged since calibration and its
difficulty still matches. Otherwise, the existing rules-manifest zone prior is
used. This is not a new payout algorithm or an edit to historical calibration.

Existing prepared commitments and paid rounds keep their original snapshots,
hashes, and odds. Preparing a commitment still does not debit the wallet. No
migration, feature-flag, stake, or payout-path change is included.

## Verification on 17 October 2026

- Typecheck and production TypeScript build passed.
- Road to Goal unit suite: 60 tests passed across 10 files.
- Real PostgreSQL selection/freshness integration: 3 tests passed, none skipped.
- Staging database rehearsal: live pool prepared all 11 zones. Temporary copies
  reproduced zero old-rule eligibility after bulk question edits and separately
  after payload edits; patched selection prepared all 11 zones with zone priors.
  Missing calibration rows also prepared all 11 zones.
- Staging rehearsal asserted zero persistent public-table writes, rolled back
  completely, and left zero temporary tables. Existing in-memory snapshot hashes
  stayed unchanged.
- Simulator/emulator testing remained paused.

The staging rehearsal uses actual patched repository/service code with staging
data, not a remotely deployed staging HTTP endpoint. The full persisted-wallet
concurrency integration suite and full backend CI were not rerun. The live-pool
timing includes local network round trips and is not a server performance claim.

## Review and release boundary

Branch: `fix/road-to-goal-calibration-20261017`.
Base: `106c98329e44b3ec72ee08aa08216b3d9be06322`.

Review the local diff before pushing. A scoped staging deployment and HTTP smoke
check remain release gates before any production promotion. Production is unchanged.

Reproduce the staging-data rehearsal with a private staging-only environment file:

```sh
node --import tsx scripts/verify-road-to-goal-calibration-staging.mjs --env-file <private-staging-env-file>
```

The harness refuses non-staging project connections and prints aggregate results
only. It does not start the API, create accounts, play games, or send analytics.
