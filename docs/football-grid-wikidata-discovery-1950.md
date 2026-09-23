# Football Grid historical club discovery from 1950

Status on 23 September 2026: **source inventory, not playable answers**. The raw
snapshot stays outside Git in the private directory selected with `--out`.
Reviewers with access to the source release exports can reproduce the scan with
the command below and inspect its `summary.json` and per-club raw claim files.
The script is repeatable and resumes by club after a network failure. It makes
no database writes and produces no release manifest.

The open source is [Wikidata](https://www.wikidata.org/wiki/Wikidata:Data_access),
whose data is CC0. The script uses club IDs already evidenced in our releases,
checks those against Wikidata's Transfermarkt team ID property (P7223), then
collects player team memberships (P54) and head coaches (P286). It follows
[Wikidata Query Service limits](https://www.mediawiki.org/wiki/Wikidata_query_service/Implementation)
with sequential queries and a named user agent. Names alone never merge a
football player into Quizball. An exact label match between two of our own
club keys is recorded as a review candidate, not a verified mapping.

The first full scan read **89 distinct mapped clubs**. These cover 118 of 334
club clue keys; 216 keys remain unmapped or conflicted. Raw results contain
63,572 P54 query rows and 1,035 manager query rows. A statement can appear
more than once when Wikidata has multiple qualifiers or provider IDs. The subset with a
dated stint and a positive appearance count names 10,045 distinct players whose
stint overlaps 1950–1989, 13,096 for 1990–2012, and 4,635 for 2013–2026.
These era counts overlap. Only **14** of the pre-1990 players link to an
existing Quizball UUID under the strict provider ID rule. The source also has
114 dated, nondeprecated manager claims overlapping 1950–1989. The raw claim
and candidate counts are in `summary.json`; all raw rows retain the Wikidata
statement URI and their qualifiers for later review.

These counts describe **available claims**, not league/season completeness.
P54 can describe coaching or youth membership, missing dates and misleading
appearance counts occur, and a club stint alone proves neither league play
nor a trophy. Year-level dates are insufficient to prove precise teammate or
manager overlap. Every candidate remains `requires_review`; the report is
`publishable: false`. The existing 2012–28 June 2026 appearance snapshot and
older incomplete sources remain separate. This scan does not close the July
or August 2026 gap.

To reproduce or resume the scan using freshly exported source manifests:

```sh
python3 scripts/football-grid-content-generator/fetch-wikidata-club-history.py \
  --manifest EUROPEAN_SOURCE.json --manifest THEMED_SOURCE.json \
  --out PRIVATE_DISCOVERY_DIR --from-year 1950 --through-year 2026
python3 -m unittest tests/football-grid/test_wikidata_club_history.py
```

Next work before gameplay: resolve the 216 club keys and historic player
identities, independently corroborate senior appearances with official club
and competition archives, preserve date precision, review managers and
competition boundaries, add English/Georgian names and safe aliases, then
rebuild intersections and replay submitted answers. Keep an explicit
club-by-season evidence matrix: unknown is never a negative answer. Older
content releases remain available for rollback while new reviewed content
is tested in staging.
