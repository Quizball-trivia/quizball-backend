# Football Grid coverage ledger and missing-answer triage

This read-only tool audits immutable release manifests. It does not connect to a database, publish a release, or accept a reported answer during a match.

Run it against the **currently serving** European and themed manifests. Do not use an old source export as the baseline.

```bash
python3 scripts/football-grid-content-generator/football-grid-coverage-ledger.py \
  --manifest european=/path/to/serving-european.json \
  --manifest themed=/path/to/serving-themed.json \
  --discovery-summary /path/to/historical-discovery-summary.json \
  --output-dir /path/to/private-audit-output
```

Outputs:

- `summary.json`: release IDs, distinct board labels and intersections, held club identities and priority list, plus cell consistency checks.
- `criteria.csv`: every clue, its currently accepted member count and how often it appears in board cells.
- `pairs.csv`: each distinct row/column pair, answer count, repeated-cell differences, and answers missing from or unsupported by the two membership lists.
- `club-seasons.csv`: one row per club and year 1950–2026. Every row starts as `applicability=unchecked` and `source_status=not_assessed`; this is a research checklist, **not** a claim that an applicable season is missing.

The summary distinguishes published catalog entries from clues actually placed on stored boards. Tackle held club identities that appear on boards first; the other held keys are a later catalog-cleanup batch.

The existing player-facing “Report missing answer” action stores the rejected attempt and its pinned board version. The admin report endpoint returns the original row and column clue keys and board theme. Export its JSON response to a private file and add `--reports /path/to/reports.json`. This produces `report-triage.json`, `alias-proposals.json`, and `fact-review-candidates.json`. The latter two are review queues, never auto-published content.

Triage meanings:

| Value | Next action |
| --- | --- |
| `accepted_in_current_release` | Confirm the correction in gameplay and close the report against the fixing release. |
| `name_alias_review` | Check whether an unrecognized form of a known, already valid player name is safe to add. |
| `football_fact_review` | Check the player's claimed relationship with **both** clues against reliable evidence. The report may still be incorrect. |
| `ambiguous_name`, `ambiguous_identity_or_fact` | Resolve identity; never silently choose a player. |
| `player_or_spelling_research` | Find and verify the player identity before considering facts or aliases. |
| `retired_criterion`, `pair_not_served_in_current_release` | Review against the original pinned release; the current pack cannot directly replay the same clue pair. |
| `missing_context` | Re-export from the updated admin endpoint. |

An “automatic addition” means the report can automatically create a **candidate for review**. It must not insert an unverified player or football fact into a live release. A reviewer records the identity, source, eligibility rule and reuse rights, builds a new immutable candidate, replays prior attempts, and stages it. The existing admin decision path marks a report accepted only after a newer published release actually resolves that answer for both clues.

The cell consistency checks compare stored answers with the intersection of the two membership lists. A zero means the release is internally consistent; it does **not** prove the underlying historical memberships are complete.
