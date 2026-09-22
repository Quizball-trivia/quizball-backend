# Historical identity review — 22 September 2026

The large EPL history draft reached staging; it was not included in the smaller
production correction release. Neither constitutes complete 1990–2012 coverage.
The source coverage and unresolved league/club gaps remain documented in
[the available-data expansion](football-grid-available-data-expansion.md).

`review-epl-identity-witnesses.py` adds a second identity check before selecting
historical facts for production. It pins the existing modern profile snapshot,
checks full dates of birth, existing provider-ID-to-UUID mappings and accepted
exact names, and verifies both players in same-club, same-match teammate evidence.
It fails on conflicting duplicate IDs or changed appearance witnesses. It never
creates players, changes content approval, publishes data or connects to a database.
The extra profile snapshot is corroboration, not a claim of independent primary
football research or proof of exhaustive coverage.

## Initial result using the modern profile snapshot alone

| Result | Distinct criterion/player facts |
| --- | ---: |
| Identity checks passed | 1,132 |
| Held: answer player's separate profile missing | 75 |
| Held: teammate target's separate profile missing | 94 |
| Total | 1,301 |

The witnessed matches run from **15 August 1992 through 13 May 2012**. Missing
retired-player profiles are unresolved identity evidence, not proof that a football
relationship is false. Overlapping European/themed proposals are counted once.
This checkpoint adds no playable answers. Source-use review, remaining identities,
manager evidence and a fresh four-locale release replay still precede activation.

## Retired identities resolved with separately pinned records

The 169 held facts involve 17 retired players absent from the modern profile
snapshot. A dated Wikidata entity snapshot now corroborates each existing provider
ID, exact name and full birth date. This brings the same proposal to **1,301
identity-confirmed facts and zero identity holds**, without adding or changing a
membership. The entity IDs, revisions and extracted identity fields are recorded in
[`retired-identity-provenance.json`](../scripts/football-grid-content-generator/retired-identity-provenance.json).

The optional `--retired-entities` input must match the pinned raw snapshot hash.
The audit accepts a unique provider ID and an exact Gregorian birth date from a
human entity; it respects preferred/deprecated statements and never turns a
year-only date into January 1. For example, Schmeichel's less precise 1963 statement
does not override his preferred 18 November 1963 birth date. The supplement cannot
replace an existing modern profile. Conflicting dates/IDs remain held.

Wikidata structured data is [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing).
This supports corroborating identities; it does not approve the separate historical
appearance sources or fill missing football history. The dated snapshots and
original witness checks remain required. All 46 historical-data tests pass.

The modern appearance snapshot runs from **3 July 2012 through 28 June 2026**.
July and August 2026 are not covered by those observations. There is no complete
1950–1989 corpus: the scoped aggregate inventory only starts in 1972, with sparse
records. Other historical leagues and the 1990/91–1991/92 English seasons remain
gaps; a source player's presence is not equivalent to a complete career.

## Reproduce

```sh
python scripts/football-grid-content-generator/review-epl-identity-witnesses.py \
  --fact-report FACTS.json --archive EPL_AUDIT.json --crosscheck CROSSCHECK.json \
  --profiles players.csv.gz --out IDENTITY_REVIEW.json
# Include --retired-entities RETIRED_WIKIDATA_ENTITIES.json to check the 17 retirees.
python -m unittest discover -s tests/football-grid -p 'test_*.py'
```

Use the pinned files from the preceding audits; the report binds input hashes and
refuses to overwrite output. The historical fact report SHA-256 is
`27f73bdb27ac9f812b912cba1d1cabd35a9df536fcd7788b0bb012eb3b877c27`.
Private gameplay replays and generated releases stay outside the repository.
