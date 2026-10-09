# Reviewed Football Grid report: a legend with clubs but no leagues (9 October 2026)

A player reported that "Nazario" was refused for **PSV × Serie A** in Tic Tac Toe. The report is correct: Ronaldo
(Ronaldo Luís Nazário de Lima) played for PSV and, with Inter and AC Milan, in Serie A. This is a small, reviewable
correction of that one person's records. It is not a claim of complete historical coverage, and the code change alone
does not alter live answers: the offline draft stays `requires_review` until its evidence and a fresh environment
export pass the content release process ([answer corrections](football-grid-answer-corrections.md)).

## Why he was refused

League clues (`league:*`, "senior league appearance") are derived from the dated appearance source, which starts in
July 2012. The legends were added from Wikidata careers, which give clubs only. In the served European release
(2026092403) his record has five clubs and no league; 133 players are in that state and 1,435 board cells cross a club
with a league. The themed release (2026092404) holds him twice — "Ronaldo" (PSV, Barcelona, Inter, Real Madrid) and
"Ronaldo Nazário" (Corinthians, Cruzeiro, Inter; the record that owns the alias "nazario") — and neither has a league.

## The correction (`reviewed-player-reports-20261009`)

Facts and citations are in
[`reviewed-report-followup-20261009.json`](../scripts/football-grid-content-generator/reviewed-report-followup-20261009.json).
Every fact cites an official club, league or UEFA page that was opened and read on 9 October 2026:

| Fact | Source |
| --- | --- |
| Eredivisie, with PSV (42 league goals in two seasons) | [PSV](https://www.psv.nl/media/artikel/psv-tv-special-over-ronaldo-op-fox) |
| La Liga, with Barcelona (34 league goals in 1996-97, Pichichi) | [FC Barcelona](https://www.fcbarcelona.com/en/football/first-team/news/2191787/25-years-since-ronaldo-signed-for-fc-barcelona) |
| Serie A, with Inter (49 league goals) | [Inter](https://www.inter.it/en/news/2020-06-06-facts-ronaldo-fenomeno-inter-hall-of-fame) |
| Played for PSV, Barcelona, Real Madrid and AC Milan (the clubs the themed "Ronaldo Nazário" record lacks; AC Milan also for the themed "Ronaldo" record) | [PSV](https://www.psv.nl/media/artikel/psv-tv-special-over-ronaldo-op-fox), [FC Barcelona](https://www.fcbarcelona.com/en/card/648048/ronaldo-luiz-nazario), [Real Madrid](https://www.realmadrid.com/en-US/the-club/history/football-legends/ronaldo-luis-nazario-de-lima), [AC Milan](https://www.acmilan.com/en/club/legends/players/ronaldo) |

The pinned season aggregates (`salimt/football-datasets`, provider id 3140) agree on every league and season; they are a
cross-check only, not the cited source (their reuse status is not established).

The batch reuses the correction transform with one addition: a fact marked `presentOnly` completes a display record
that the release already holds and is skipped where the record is absent. Without it the European record would be
imported into the themed pack as a third record of the same person. The Georgian family name "ნაზარიო" is added to the
European record (the themed record already has it).

Against the 9 October staging exports (same release numbers and player ids as production):

| Release | Memberships | Aliases | Cells | Answers added | Answers removed | Boards touched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| European 2026092403 → draft | 3 | 1 | 130 | 130 | 0 | 111 of 2,000 |
| Themed 2026092404 → draft | 11 | 0 | 133 | 178 | 0 | 107 of 949 |

Every added answer is one of his three records. These numbers must be recalculated from fresh exports before publishing.

How his names resolve in the cells that change (the release's own aliases, before → after):

| Typed | European (130 cells) | Themed (133 cells) |
| --- | --- | --- |
| "Nazario", "Ronaldo Nazario", "ნაზარიო" | refused → accepted in all 130 | refused → accepted in all 133 |
| "Ronaldo" (shared with other footballers called Ronaldo) | (no such alias on his European record) | refused → accepted in 34; accepted → asks for a fuller name in 11 |
| "რონალდო" (shared likewise, Cristiano Ronaldo among them) | refused → accepted in 121; accepted → asks for a fuller name in 9 | refused → accepted in 35; accepted → asks for a fuller name in 10 |

"Asks for a fuller name" is the resolver's rule for two different footballers who both fit a cell (Real Madrid ×
La Liga now fits two Ronaldos); it is not a refusal.

## Not in this batch

- **The two themed records are not merged.** "Ronaldo Nazário" now carries the European clubs and the leagues;
  "Ronaldo" gets the leagues and AC Milan, and deliberately not the Brazilian clubs (another "Ronaldo" record already
  answers those cells under that name). The "already used" rule cannot tell the two records are one person: after
  "Ronaldo" in one cell, "Ronaldo Nazário" is still accepted in another. That was already so where both records met
  (Inter); it now covers more cells. Merging needs an identity-reconciliation transform (it replaces ids in stored
  cells), which the additive correction transform deliberately cannot do.
- **The other legends.** The same gap affects the other players who have clubs but no league. The pinned aggregates hold
  season-level league appearances for them; turning those into answers needs reviewed identity links (the legends carry
  no provider id in release evidence) and a decision on that source's reuse status, or a citation per fact as here.
