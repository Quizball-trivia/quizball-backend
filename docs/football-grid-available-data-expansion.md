# Available football data expansion — 22 September 2026

The requested horizon is 1950 through 31 August 2026, with 1990–2012 first.
After checking availability, the owner asked to use the data already available
and decide how to fill missing periods afterward. **This is a tested local
answer draft, not a completed historical corpus or a live content release.**

## Effective coverage boundaries

The main supplier now explicitly reports that collection is paused:
[pinned supplier notice](https://github.com/dcaribou/transfermarkt-datasets/blob/e44f186d6f06dd8452aaf54c7921ba66c961f637/README.md).
The local checksummed snapshot contains 1,894,350 appearance rows for 29,531
source players, dated **3 July 2012–28 June 2026**. The later dates on downloads
and Git commits do not extend those observations. July/August 2026 remain uncovered
by this snapshot. The aggregate archive has season records starting in 2025,
but season totals are not dated match appearances and cannot certify an August cutoff.

The expanded aggregate inventory includes all ten league clues and all other
competitions appearing in the 90 clubs with existing source-ID evidence. Compared
with the earlier ten-league-only audit, this includes more source observations:

| Season-start interval | Observed source players | Positive player/club/competition/season rows |
| --- | ---: | ---: |
| 1990–2012 | 12,089 | 103,455 |
| 1950–1989 | 239 | 872 |
| 2013 onward, through the available source | 16,913 | 116,473 |

Player counts overlap between intervals. In total, this inventory contains 24,555
identities and 220,800 positive aggregate rows. The oldest scoped aggregate
observation is **1972**: the 1950–1989 row does not imply coverage of the 1950s
or 1960s. The earlier four-player legends pilot is separate discovery evidence.
These are source observations, not newly imported players or certified complete squads.

The current clue union has 334 club **keys**, ten leagues, 43 managers, 154 teammate
targets, 50 countries, 12 trophy/award clues and 14 other criteria. Keys can refer
to the same club under different names/formats. Only 90 club keys have direct
provider-ID evidence in the audited input. The remaining 244 stay explicit:
104 have one exact-name source candidate, four have multiple candidates and 136
have none. Name matching does not automatically merge clubs or populate answers.

## New match-evidenced historical facts

`derive-epl-history-facts.py` revalidates both pinned raw sources, reruns the EPL
archive audit and cross-source appearance-count comparison, and derives additions
only for existing Quizball identities whose names also match. The candidate
identity links remain reviewable; the script does not apply them to the database.

The resulting input is 33,449 corroborated appearances across 285 mapped player
identities. It retains 171,192 excluded appearances without a reconciled identity
and 664 without agreeing player/club/season counts. These are unresolved records,
not evidence that those players fail a football rule.

| Proposed additions | European release | Themed release |
| --- | ---: | ---: |
| Club | 209 | 227 |
| Premier League | 85 | 199 |
| Manager | 123 | 118 |
| Club teammate | 552 | 447 |
| Total | 969 | 991 |

There are 1,301 distinct criterion-key/player pairs across these overlapping
release proposals. Managers require a match strictly inside one unambiguous,
dated managerial tenure or an officially evidenced bounded service interval; 18 appearances have no such manager witness and are
held out. A teammate requires both players to have appeared for the same club
in the same match. Opponents, unused substitutes and national-team overlap cannot
produce these facts. Trophy, country and award completeness is not inferred.

The archive has a missing end date for Wenger's Arsenal tenure. The pinned
[`historical-manager-intervals.json`](../scripts/football-grid-content-generator/historical-manager-intervals.json)
uses [Arsenal's official 17-year service record](https://www.arsenal.com/news/features/behind-the-numbers-wenger-s-17-years)
to witness dates strictly between 1 October 1996 and 1 October 2013. This is
a bounded evidence interval, not an invented departure date. Missing endpoints
without such evidence remain excluded.

Each fact preserves the archived appearance row, match date, player identities,
matching source appearance counts, and manager/teammate witness where applicable.
First/last witness dates never become a continuous employment or playing interval.

## Local answer drafts and replay

`prepare-epl-history-draft.py` binds the candidate to the exact audited input bytes,
retains all existing memberships and answers, carries existing aliases/portraits,
and rebuilds every row/column intersection. It does not create new player UUIDs.
Donor imports require existing English and Georgian display/name records and a
portrait reference from the same environment; unknown identities are held out.

- European: 969 added facts; 15,720 added player/cell combinations across 3,248
  cells and 1,165 boards. No player imports are needed.
- Themed: 991 added facts; 173 existing player displays and 775 existing aliases
  carried from the donor catalog; 4,758 added player/cell combinations across
  1,146 cells and 380 boards.
- Both drafts preserve every original answer. Their complete-intersection rebuild
  also fills any existing membership/intersection omissions in the input.
- Structural validation adds no errors. The themed release retains its two
  pre-existing difficulty-distribution findings; difficulty has not been recalibrated.
- Replaying all 6,218 retained non-pass submissions keeps all 3,353 originally
  correct submissions correct with the same player. Compared with the preceding
  confirmed-fix draft, historical additions change six wrong submissions to correct,
  with no other outcome changes. Including preceding fixes, 69 original wrong
  submissions become correct, two ambiguous and two already-used.

The six incremental recoveries are Ronaldo as Rio Ferdinand's club teammate,
Piqué's Premier League appearance history, Gerrard/Alonso under Rafael Benítez,
and Robin van Persie/Ashley Cole under Arsène Wenger.
Official Liverpool profiles corroborate the two manager relationships:
[Gerrard](https://www.liverpoolfc.com/info/steven-gerrard),
[Alonso](https://www.liverpoolfc.com/info/xabi-alonso).
Manchester United documents its [2000–2009 history](https://www.manutd.com/en/club/history/history-by-decade/2000-2009)
and [Piqué's first-team career](https://www.manutd.com/en/academy/life-after-the-academy).
These spot checks do not substitute for reviewing every proposed historical fact.

The replay is a counterfactual answer-resolution check against original turns and
claims, not a replay of entire matches or a claim that past rewards were corrected.
Older pinned content versions retain the previous confirmed-fix counterfactual;
the historical additions are applied only to the two current release snapshots.

## Reproduce

Use the existing raw snapshots described in the [first historical audit](football-grid-history-1990-2012.md).
Use separate output filenames; commands refuse to overwrite existing reports.

```sh
python scripts/football-grid-content-generator/audit-available-coverage.py \
  --raw RAW --dataset MODERN_DATASET \
  --manifest EUROPEAN_DRAFT --manifest THEMED_DRAFT \
  --from-year 1950 --through-date 2026-08-31 --out COVERAGE.json
python scripts/football-grid-content-generator/derive-epl-history-facts.py \
  --raw RAW --manifest EUROPEAN_DRAFT --manifest THEMED_DRAFT --out FACTS.json
python scripts/football-grid-content-generator/prepare-epl-history-draft.py \
  --fact-report FACTS.json --manifest EUROPEAN_DRAFT --manifest THEMED_DRAFT \
  --base-index 0 --out EUROPEAN_HISTORY_DRAFT.json
# Repeat the preceding command with --base-index 1 for the themed draft.
python -m unittest discover -s tests/football-grid -p 'test_*.py'
```

All 31 Python regression tests pass. The archive decoder additionally needs
`pyreadr==0.5.3`; tests themselves use synthetic fixtures and need no downloads,
network, database or production credentials. Machine-readable measurements and
artifact digests are in [the expansion summary](football-grid-available-data-summary.json).
Raw snapshots, generated manifests and private player-attempt replay data are
retained outside the repository.

## What still prevents a gameplay release or a full-coverage claim

The drafts retain `UNREVIEWED` approval markers and pending source reviews. Both
fail the normal publisher schema, and the unrelated confirmed-fix approval command
rejects them. No application deployment, migration, content activation or database write occurred.

Before promotion: resolve remaining identity/source reviews, allocate fresh release
versions, verify portraits and names, evaluate alias ambiguity/difficulty, preserve
quarantines, regenerate against fresh environment exports and rehearse on staging.
The new fields do not magically fill 1990/91–1991/92 English First Division,
historical leagues absent from the archive, trophy histories, unmapped players or
July/August 2026. Complete 1990–2012 coverage remains unfinished.
