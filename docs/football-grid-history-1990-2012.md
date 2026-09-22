# Historical coverage: 1990–2012 first

The owner prioritised this era on 22 September 2026, ahead of 1950–1989. This is
the first source acquisition and audit, **not a completed content release**.
Nothing here changes playable answers, player records or live matches.

The follow-up [available-data expansion](football-grid-available-data-expansion.md)
extends the inventory toward the requested August 2026 horizon, derives witnessed
historical manager/teammate facts, and tests additive answer drafts. It also records
the owner's decision to use currently available data before sourcing missing periods.

## What was acquired and measured

1. [salimt/football-datasets](https://github.com/salimt/football-datasets), pinned
   at `4701b2bb96b4c26817c35d41d4e1ba940fb04832`: 1,878,719 player/season/competition
   rows overall. Filtering positive appearances to the ten leagues used by our
   clues, including boundary seasons 1989/90 and 2012/13, yields **50,120 rows and
   10,949 source player identities**. Only 1,330 have existing provider-ID links
   in the audited release evidence; this is not a count of the full player database.
   The remaining 9,619 need identity reconciliation, not automatic new UUIDs.
2. [pssguy/epldata](https://github.com/pssguy/epldata), pinned at
   `c61f77af99b6cc814e698909557e059768270dee`: a separate Premier League match and
   lineup archive. The 1992/93–2011/12 audit retains **205,305 appearance records
   for 3,118 source players**. It reports 79 unresolved records (76 have no team-game
   link, so their period cannot be established; three in-period appearances lack
   a player-stint link) and one malformed game record. These records are excluded
   from the retained observations. Duplicate IDs, duplicate player/game records,
   disagreeing stint/team joins and non-eleven starter counts are checked.
3. The second source demonstrates a major hole in the first: **1992/93 has 102
   observed players in the aggregates versus 544 in the match archive**. Finding
   all club names or all seasons is therefore not proof of complete player coverage.

The season matrix and reproducible counts are in
[`football-grid-history-1990-2012-audit.json`](football-grid-history-1990-2012-audit.json).
Every season is explicitly marked missing, not applicable or observed/incomplete;
none is certified as complete.

## Proposed facts, not approved answers

Against the existing confirmed-fix drafts, the aggregate audit produces **1,478
European-release and 2,355 themed-release candidate club/league memberships**.
The same football relationship may occur in both releases; do not sum these as
unique football facts. Only existing same-provider IDs can produce candidates,
with an additional exact English identity/alias check. Name disagreements are
held out. Club keys are derived from each release's evidence, including both
current club-key formats. Missing translations and portraits remain separate work.

Proposals preserve the original season and CSV record locator. They do not invent
exact playing dates from season totals. Zero appearances, unused squad places,
conflicting aggregates and pre-1992 Premier League rows cannot create a proposal.
Manager, teammate, trophy and nationality facts are **not inferred** from these
season aggregates. Being born in a country is not national representation.

The EPL discovery cross-match found 1,382 unique exact name/date-of-birth candidates
against the aggregate provider's profiles; 1,736 remain unresolved. These are
review candidates, not applied identity links. Numerical IDs from the two providers
are unrelated. No surname-only or fuzzy-name identity merges are permitted.

The independent cross-check compares **5,518 player/club/seasons** for those
identity candidates. Appearance counts agree in **5,314**, differ in **192**, and
are absent from the aggregate source in **12**. Both directions of an identity
match must be unique; invalid or missing birth dates cannot create a candidate.
An explicit club crosswalk keeps the original Wimbledon distinct from successor
clubs. Disagreements stay visible instead of choosing the larger count.

This corroborates at least one witness for **294 European and 426 themed
club/league proposals** above. These counts overlap between releases and are not
newly accepted answers: the proposals still require review and release generation.
Matching two sources supports a fact; it does not certify every season as complete.

## Source validation and boundaries

- Official [Premier League history](https://www.premierleague.com/en/history)
  establishes the August 1992 start and the change from 22 to 20 clubs. English
  football in 1990/91 and 1991/92 needs First Division evidence and must not silently
  satisfy a clue explicitly labelled Premier League.
- Retained archive totals match official examples: [Henry: 258 appearances](https://www.premierleague.com/en/news/1299931)
  and [Schmeichel: 310](https://www.premierleague.com/en/news/1653036).
  These spot checks do not independently verify all other players or matches.
- The aggregate repository has no published license file at the pinned commit;
  its reuse status is **not established**, not inherited from the unrelated
  dcaribou CC0 snapshot. EPL's package description declares MIT. Record provenance
  and review source reuse before including either source in a gameplay release.
- Scottish competition predecessors and other renamed competitions need an
  explicit continuity policy before old seasons satisfy modern labels.
- Source acquisition leads for remaining verification include the official
  [DFB 1990/91 archive](https://datencenter.dfb.de/bundesliga/1990-1991/mannschaft/bayern-muenchen),
  [BDFutbol's 1990/91 archive](https://www.bdfutbol.com/en/t/t1990-91.html),
  [Lega Serie A champions archive](https://www.legaseriea.it/serie-a/albo), and the
  [UEFA 2010/11 statistics handbook](https://www.uefa.com/MultimediaFiles/Download/EuroExperience/uefaorg/Publications/01/53/55/84/1535584_DOWNLOAD.pdf).
  These are leads/spot-check sources, not already imported comprehensive datasets.

## Reproduce

Use a separate artifact directory. Raw third-party snapshots and generated player
observations are not committed to this repository. The fetcher uses fixed commits,
checksums and exclusive installation; it will not overwrite a changed cached file.

```sh
python scripts/football-grid-content-generator/fetch-historical-sources.py --out RAW
python scripts/football-grid-content-generator/audit-historical-coverage.py \
  --raw RAW --manifest EUROPEAN.json --manifest THEMED.json --out HISTORICAL.json
# RDS decoding needs pyreadr==0.5.3; no R runtime or repository execution is used.
python scripts/football-grid-content-generator/audit-epl-history.py \
  --raw RAW/epldata --comparison HISTORICAL.json --out EPL.json
python scripts/football-grid-content-generator/crosscheck-epl-history.py \
  --raw RAW --epl EPL.json --historical HISTORICAL.json --out CROSSCHECK.json
python -m pip install -r scripts/football-grid-content-generator/requirements-test.txt
python -m unittest discover -s tests/football-grid -p 'test_*.py'
```

The offline Python tests also run in the `football-data-audits` CI job on every
PR. CI uses synthetic fixtures and has no database credentials or source downloads.

Both reports are deliberately unpublishable (`publishable: false`,
`coverageComplete: false`). They have no database connection or approval command.
Historical imports/generation now also reject legacy files that omit approval,
and the generator uses the fetched national-team classification instead of relying
only on whether a team's label contains the word "national".

## Remaining release work

1. Fill and verify competition-season rosters and appearances, including the 1990
   boundary and pre-Premier-League English seasons. Resolve malformed/dangling
   archive records and source reuse status. Preserve unknowns in the report.
2. Reconcile source identities with the full environment-specific player catalog;
   review conflicting names, add Georgian names/aliases and verified imagery.
3. Derive manager and club-teammate facts from witnessed matches or precise verified
   overlap, and trophy facts from winning-campaign appearances and official winners.
4. Generate additive release manifests with every qualifying row/column intersection;
   preserve existing answers, quarantines and releases pinned by active matches.
5. Replay retained submissions, review the changed difficulty and ambiguous names,
   rehearse on staging, then publish/activate the reviewed content on production.

Only after these gates pass can this era be described as covered for the declared
scope. The 1950–1989 expansion follows; it does not delay confirmed fixes already
prepared in the separate correction release.
