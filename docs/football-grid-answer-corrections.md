# Tic Tac Toe rejected-answer correction — local review

This change prepares new content and private rejection diagnostics; nothing has been deployed. The confirmed content correction itself needs no migration. The separate diagnostic logging change requires its additive migration before the backend deploy.

## Changes

- Preserve colliding English surnames in future generated aliases. The existing resolver accepts a surname only when exactly one player fits the selected cell, asks for clarification if multiple fit, and still enforces the already-used rule. No new fuzzy matching or first-name expansion.
- Add an offline repair tool for existing manifests. It derives missing surnames from display identities anchored by an exact English alias, preserving every owner of a shared surname.
- Add official-source-backed Henry/Wenger/Premier League, Ronaldo/Premier League title, Coutinho/Suárez club teammate, and Dele/Tottenham/England facts where the criteria exist. Import missing display/portrait records and exact EN/KA aliases from an explicitly supplied catalog; reject identity or image-origin mismatches.
- Expand affected answer lists to the complete stored row/column intersection. Preserve existing answer order, recognizable samples, board keys, difficulty labels and all old answers. Increment changed board versions.
- Produce a `requires_review` wrapper with a source digest and change summary. The new source has `pending_review` rights status and changed boards/release are `UNREVIEWED`; neither the wrapper nor its nested candidate passes the existing publisher schema as-is. No human approval is invented.

## Local preparation

From this backend checkout:

```sh
npx tsx scripts/football-grid-answer-corrections.ts SOURCE.json SAME_ENVIRONMENT_PLAYER_CATALOG.json OUTPUT_DRAFT.json NEW_VERSION
```

Use fresh exports of both current releases and the European release as the player catalog for that environment. The CLI has no database connection or publish command. Output creation is exclusive: it refuses to overwrite an existing file. Release numbers in a local draft are proposals, not reservations in either database.

## Verification on the retained production snapshot

Snapshot cutoff: 21 September 2026, 22:15:05 Asia/Tbilisi. Counts are submissions, not unique humans, and can include QA. Replay is a counterfactual against the original match state, not a rewriting or re-simulation of matches.

| Original outcome | Candidate outcome | Submissions |
| --- | --- | ---: |
| Correct | Correct, same player | 3,353 |
| Wrong | Correct | 63 |
| Wrong | Ambiguous | 2 |
| Wrong | Already used | 2 |
| Wrong | Wrong | 2,685 |
| Ambiguous | Ambiguous | 49 |
| Already used | Already used | 64 |

All 6,218 saved non-pass submissions replayed. All five confirmed false-rejection reports now resolve correctly. The Messi and Hamšík reports remain wrong, and Theo Hernández remains invalid for the intended club-only teammate rule.

Correction to the initial audit's surname finding: of the 19 previously unused-player alias gaps, **18 now resolve correctly and one needs a fuller name**. The original cross-release lookup did not include every surname owner. “Muller” for Germany × Bundesliga has multiple qualifying players; silently choosing Thomas would be unsafe. The twentieth, already-used Mbappé case now returns already used. Another saved “Thuram” also needs clarification. Ambiguous answers do not consume a turn in the existing engine.

The broader surname repair accounts for additional improvements beyond the original 19 cases. These are matches against the candidate's stored football facts; this is not an independent biography audit of all 2,752 rejected attempts.

Current candidate packages:

- European: 2,000 boards; four missing memberships; 1,251 added aliases; 202 added answers across 202 cells; no existing answers removed.
- Themed: 949 boards; Henry and Dele display records imported; four missing memberships; 447 added aliases; 433 added answers across 178 cells; no existing answers removed.

Structural validation: European has no findings. Themed retains exactly its two existing European-subset difficulty-distribution findings (easy 25.10%, normal 60.12%); no new findings. The validator does not infer difficulty from the added answer counts, so playability/difficulty review is still part of rehearsal.

64 relevant Vitest tests and one Python generator test pass. Application `tsc --noEmit` passes. A separate strict check including the legacy content CLI still reports its six pre-existing errors, reproduced in the untouched checkout; none point at the new correction tool or tests. Do not describe the extended CLI typecheck as passing. The newly imported Henry and Dele portrait URLs both returned HTTP 200 with image/webp.

## Before staging or production

1. Review the draft facts, source records, alias changes and all replay outcome changes. Finish the remaining football-fact audit separately; this patch does not claim exhaustive historical coverage.
2. Use the new explicit `approve-answer-corrections DRAFT --approved-by REVIEWER --out REVIEWED_MANIFEST` step only after review. This writes a separate file; it does not publish. The publishing/activation path now supports `--transformed-from SOURCE_VERSION` for the answer-correction transform, independently of the existing strict label-only path. It re-exports the live source and player catalog and regenerates the prescribed correction; only an exact match may inherit existing validation findings. Tests reject unrelated alias-policy changes, changed facts, moved source content and missing review status. Never hand-edit away the themed difficulty findings or pass this content as a label-only change.
3. Obtain fresh source exports and regenerate the candidates for each environment, preserving its own IDs and storage origin. Verify source state has not moved, confirm new version availability and approve the candidate explicitly. Recheck the newly imported portraits in the target environment.
4. Publish to staging through reviewed tooling. Carry forward board quarantines by unchanged canonical board checksum before activation; test that banned boards remain unavailable. Rehearse the confirmed positive cases, ambiguous surnames, repeated players and invalid answers through real gameplay.
5. After release authorization, publish/activate the same reviewed correction on production; keep old releases available for pinned matches and rollback. Restrict new matchmaking to the corrected releases. Do not rewrite prior attempt outcomes, award retrospective wins, delete old releases or mark player reports resolved without verifying the live correction.

## Broader coverage audit and repair draft (22 September)

`audit-source-coverage.py` verifies all pinned dataset checksums, joins by existing numeric evidence IDs, and compares clubs, leagues, managers and witnessed club teammates with each release. It also checks every stored cell against its complete membership intersection. National-team overlap is explicitly excluded from club-teammate proposals. Conflicting identity IDs fail the audit rather than using name guesses.

The source has 1,894,350 appearances for 29,531 players, dated **2012-07-03 through 2026-06-28**, and 50,149 player records. Only 4,831 identities are mapped by the audited releases' evidence. No coverage claim extends to every source player or to earlier careers.

Findings before repair:

- European: no additional missing club/league/manager/witnessed-club-teammate facts within the mapped source scope. This does **not** establish historical or trophy completeness.
- Themed: 14,776 missing facts within that scope, including 541 for players already displayed in the release; 126 cells omit members of the already-stored intersections.
- Sharing compatible criteria with the European catalog reveals further existing country, trophy and wildcard memberships omitted from the themed release. Those facts inherit their original evidence; they have not all been independently fact-checked.

`football-grid-catalog-coverage.ts` produces a **separate, unpublishable broader draft** from the confirmed correction, matching-environment catalog and source report. It refuses mismatched criterion meanings, source versions, conflicting player names and foreign storage origins. It adds full available aliases for imported identities and rebuilds complete intersections. Unknown bilingual identities remain explicitly unresolved.

Measured broader themed draft, in addition to the confirmed repair:

- 3,846 display records; 24,804 catalog memberships plus 1,215 witnessed source memberships; 16,321 aliases.
- 167,058 additional player–cell combinations across 7,364 cells; zero removed answers across all 949 boards.
- 20 unresolved display/name identities, covering 37 proposed facts. If resolved, seven further player–cell combinations across two boards' cells would become available.
- Re-audit leaves one known-source teammate membership unresolved. Historical, source-universe, nationality, trophy and wildcard completeness remain unproven.
- Replay of all 6,218 retained non-pass submissions: 67 wrong→correct, two wrong→ambiguous, two wrong→already-used; all 3,353 correct submissions keep the same resolved player. Old releases use the confirmed correction for the counterfactual; the broader catalog applies only to the currently served themed version. This is not a re-simulation of complete matches.
- Structural validation adds no errors and retains the two prior themed difficulty-distribution findings. Difficulty labels were preserved, not re-estimated; the much larger answer sets need gameplay/difficulty review.

The confirmed-fix approval command deliberately rejects `catalog-coverage-draft-v1`. Do not relabel this broader draft as the prescribed confirmed fix. It requires its own reviewed release path, source freshness checks, portrait verification, quarantine carry-over and rehearsal.

Example offline audit (repeat `--manifest` for each release):

```sh
python scripts/football-grid-content-generator/audit-source-coverage.py \
  --dataset PINNED_DATASET_DIRECTORY --manifest EXPORTED_MANIFEST.json \
  --out NEW_REPORT.json --require-no-source-gaps
```

The final flag exits 2 for known-source omissions or inconsistent intersections. It cannot certify historical completeness. The report explicitly records a 1950 coverage target and incomplete status.

## Private rejection diagnostics

The resolver now attaches a bounded private diagnostic: reason, exact/safe-typo match method, up to 20 unique candidate UUIDs, full candidate count and cell-candidate count. Empty input, absent alias, recognised-but-outside-cell, ambiguous exact/typo results and already-used answers are separate. The service corrects the reason when the authoritative claim lookup detects an already-used player.

`20260921194011_grid_answer_diagnostics.sql` adds a nullable JSONB column to attempts, with a two-second lock timeout and 15-second statement timeout. No backfill or permission changes. Existing attempts and passes remain NULL; NULL never means no issue. Existing RLS and revoked `anon`/`authenticated` access remain in place. Diagnostics are written atomically with command completion and never included in command responses, cached result payloads or gameplay broadcasts. A recognised player absent from a cell is **not proof that the football answer is invalid**; it is a reason to inspect the evidence.

Apply the migration before new backend code. On timeout, fail the migration and retry later; do not deploy the dependent code first. Old backend code remains compatible with the added column, so rollback restores the previous backend and keeps the column/data. No historical matches or rewards are rewritten.

Verification: 69 relevant unit tests, 49 runtime integration tests against a dedicated local database, six Python tests and 13 migration-runner tests pass; application typecheck passes. Integration tests verify actual diagnostic persistence and absence from user-visible responses. The isolated database is `rehearsal_grid_answers_20260921`; production and staging were not written. Applying the diagnostic migration twice succeeds; RLS stays enabled and both public client roles still lack SELECT access. The legacy content CLI retains its six independently reproduced pre-existing strict-typecheck errors; the new coverage script/tests add none.

Historical work and remaining evidence requirements: [1950-onward coverage](football-grid-historical-coverage.md).
