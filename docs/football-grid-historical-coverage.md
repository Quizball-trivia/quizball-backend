# Football knowledge coverage from 1950 onward

Status: **incomplete; research and preparation only**. On 22 September the owner prioritised **1990–2012 first, then 1950–1989**. Years refer to when players played, not when they were born. Start with the clubs and competitions referenced by existing Tic Tac Toe clues; worldwide league coverage is not assumed complete. The measured first acquisition and its unresolved gaps are documented in [1990–2012 source audit](football-grid-history-1990-2012.md).

## What is established

The pinned appearance source starts in July 2012. The existing legends list is explicitly focused on 1990–2012. Historical supplements add some clubs, country and teammate facts; they do not establish complete league, manager or trophy histories. Main release exports contain no display records for the pilot's Di Stéfano, Puskás, Gento or Kubala identities.

The appearance snapshot also stops on 28 June 2026. Matches and transfers after that date need an updated source and review; the backfill is not exclusively a pre-2012 problem. The intended horizon is 1950 through the present, with the actual observed cutoff always shown separately.

An offline four-player discovery pilot now exists. It is an ingestion test, not an exhaustive list or approved football data. New discovery packages carry `requires_review`, source claim IDs, qualifiers and references. The importer and generator reject these packages until an explicit reviewer approves them. Legacy packages with missing review status are also rejected: re-audit them and record approval before generation or import. Original files can still be inspected offline, but omission is never approval.

The pilot exposed two importer defects now covered by tests:

- Wikidata P54 can contain coaching roles: Kubala's raw output included 13 coaching stints. Qualified coaching/unknown roles and deprecated claims are now held outside playing careers, with the excluded claims retained for review.
- National teams can have a specific subclass rather than the generic national-team class. The fetcher now follows subclass ancestry with a depth limit and recognises explicit national-football-team labels, keeping national teams out of club-career classification.

This is still a discovery source. A structured ID is not proof that every attached fact is true. Independently verify careers and resolve contradictory sources; do not publish directly from search's first matching name.

## Rules that must stay explicit

| Clue | Evidence required | Historical boundary |
| --- | --- | --- |
| Played for a club | Senior playing appearance; exclude coaching, youth-only and trials | Preserve renamed/merged club identities explicitly |
| Played in a league | Recorded appearance in the named competition | Premier League starts 1992; an English-top-flight clue must explicitly include the former First Division |
| Won a trophy | Follow the existing winning-campaign-appearance rule | Define successor competitions explicitly; never infer a title from a partial-season first-place table |
| Played under a manager | Verified playing appearance or precisely evidenced playing/manager overlap | Exclude the player's own later coaching job |
| Club teammate | Verified senior club overlap; shared match is a sufficient witness | National teammates alone do not qualify; same season without actual overlap is insufficient evidence |
| Country | Declare nationality versus senior representation | Citizenship and national-team caps are different facts; youth caps must not become senior caps |

Official historical reference starting points:

- [UEFA 1955/56 European Cup archive](https://www.uefa.com/uefachampionsleague/history/seasons/1955/) and [UEFA history](https://www.uefa.com/about/our-history/) for competition continuity and historical matches.
- [FIFA's 1950 Brazil–Uruguay account](https://www.fifa.com/en/articles/uruguay-brazil-1950-maracanazo) for a primary-source historical match example.
- [Premier League history](https://www.premierleague.com/en/history) for the 1992 competition boundary.
- [Real Madrid's 1951–1960 history](https://www.realmadrid.com/static/en/about-real-madrid/history/football/1951-1960/), [Gento's official profile](https://www.realmadrid.com/en-US/the-club/history/football-legends/francisco-gento-lopez) and [Barcelona's Kubala player archive](https://players.fcbarcelona.com/en/player/451-kubala-laszloladislav-laszi-kubala-stecz) for the first historical pilot.

These are reference sources, not evidence of a licensed comprehensive bulk player database. Record reuse permissions and image rights separately from factual provenance.

## Completion criteria and remaining work

1. Inventory the supported competitions and seasons from 1950 through the current source cutoff. Track club appearances, league appearances, titles, managers and teammates separately for each era. Empty/missing data means unknown, never “no players qualify.”
2. Obtain season squads and appearance/manager histories for the chosen scope, with stable provider IDs and source citations. Club stints alone do not prove all league appearances, titles or teammate overlaps. The four-player pilot must grow into competition/season coverage, including obscure qualifying players.
3. Resolve identities against existing UUIDs. Preserve both sides of disputed mappings; review Georgian names and accepted aliases. Missing portraits must not be mistaken for evidence that a player fails the football rule.
4. Review historical facts against official sources, including shootout winners and predecessor competitions. Keep exact dates or date precision; never turn year-only dates into falsely precise career overlap.
5. Regenerate every eligible intersection from the verified catalog. Evaluate newly ambiguous names and recalibrate difficulty from actual answer counts and familiarity; do not silently broaden modern league labels.
6. Replay retained submissions, confirmed positive/negative reports and ambiguity/repeated-player checks. Every release includes source checksums, source coverage results and a list of unresolved facts/identities.
7. Rehearse on staging with real gameplay and matching assets; retain old pinned releases and quarantines. Promote only reviewed content. Do not mutate active matches or use an AI guess as the live answer authority.

No claim of gap-free coverage is justified yet. The current improvements repair confirmed omissions, expose additional gaps and make the pipeline safer; the historical corpus still needs acquisition and verification.
