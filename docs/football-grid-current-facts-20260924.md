# Football Grid fact update — 24 September 2026

This batch adds individually cited answers that the current staging releases
miss. It is **not** a complete 1950–August 2026 corpus. The main appearance
snapshot still ends on 28 June 2026; these August additions come from primary
match and competition records instead of extending that snapshot by assumption.

The review input is
[`current-facts-20260924.json`](../scripts/football-grid-content-generator/current-facts-20260924.json).
Each entry names the existing player UUID, exact clue key, source URL and
observed fact. Club membership requires an appearance, not merely a signing.
The Falcao and Tielemans trophy entries have winning-final evidence.

| Evidence | Added relationships |
| --- | --- |
| [Georgian Erovnuli Liga: Kvaratskhelia's Batumi debut](https://erovnuliliga.ge/ge/news/6510-kvaratskhelias-debiuti-batumshi-tbilisuri-derbi-da-otkhi-dadzabuli-matchi) | Kvaratskhelia × Dinamo Batumi |
| [UEFA: Falcao's 2012 Europa League win](https://www.uefa.com/uefaeuropaleague/news/0250-0c50fb7a9e5f-dc5a349f670c-1000/) | Falcao × Europa League winner |
| [PSG: Akliouche's Super Cup debut](https://www.psg.fr/en/content/debut-for-maghnes-akliouche-with-paris-saint-germain-aston-villa-fc-european-super-cup-20262027), [PSG: Godts and Ferran's Ligue 1 debuts](https://www.psg.fr/en/content/debuts-for-mika-godts-and-ferran-psg-ligue-1-rennes-players-2026-2027) | Three PSG club facts; Godts and Ferran Ligue 1 facts |
| [Premier League: Tzolis against Coventry](https://www.premierleague.com/en/news/4698358/should-you-triple-up-on-arsenal-and-who-are-their-best-three-picks), [LaLiga match record: Arsenal at Villa on 31 August](https://www.laliga.com/en-NG/match/temporada-2026-2027-premier-league-a-villa-arsenal-2) | Tzolis, Bruno Guimarães and Konsa × Arsenal |
| [Premier League: Tielemans at Hull](https://www.premierleague.com/en/news/4713141), [Premier League: Andrey Santos starting against Hull](https://www.premierleague.com/en/news/4678902) | Tielemans and Santos × Manchester United |
| [Aston Villa statement via Premier League](https://www.premierleague.com/en/news/4679515/tielemans-completes-man-utd-move) | Tielemans × Europa League winner |

Against the two published staging manifests, the offline transform adds 12
criterion/player pairs to European boards and 13 to themed boards. Themed imports
five existing identities from the European catalog with their reviewed names,
aliases and portrait keys. Every imported portrait already appears in the
staging asset registry and resolves to a file.

Rebuilding every intersection adds 508 answers across 402 European cells and
235 answers across 208 themed cells without removing an existing answer.
All 1,486 English/Georgian canonical-name checks on those new cell answers
resolved to the intended player. The resolver uses the same aliases regardless
of the UI locale; this does not certify every informal spelling in all languages.

Both published staging source manifests were pinned to their live release IDs,
board counts and manifest checksums. Strict validation adds no new findings.
The European release has no strict findings. The themed release retains its
259 inherited asset/difficulty findings, already present in its published source;
the publisher's transformed-source check must reject any newly introduced one.

Historical player identities, missing clubs, manager intervals, teammate match
overlap and trophy records still have major gaps, especially before 2012.
There is no honest all-player or all-season coverage claim yet. The larger
1990–2012 draft remains separately unapproved until its identities and source
use are reviewed.
