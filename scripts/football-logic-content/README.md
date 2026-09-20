# Football Logic daily content (data-backed riddles)

Every riddle is a fact computed from the Transfermarkt dataset
(`quizball-worktrees/grid-launch-data/transfermarkt`) with a uniqueness check,
so nothing is written from memory. Families:

- `transfer_fee` — two crests, "€X M move from the first club to the second in season S"; unique by (from, to, season, fee).
- `transfer_position` — two crests, "which <position> moved …"; unique by (from, to, season, position) over *all* transfers (loans included), paid moves only.
- `club_top_scorer` — crest + flag, top league scorer of the club in a season; margin ≥ 2 goals, ≥ 10 goals.
- `country_club_scorer` — flag + crest, country's top scorer for the club since 2012 (all comps); margin ≥ 3, ≥ 12 goals.

Only seasons from 2012/13 (dataset appearance coverage) and only players present in
the published grid release, whose alias tables (full/family/given names, accentless,
reordered, nicknames, Georgian) become the accepted answers. Images are real crests
(`imgs/club-logos`) and flag-icons SVGs (`imgs/football-grid/v1/flags`).

Run (python venv with duckdb + psycopg + certifi):

    # inputs: aliases.csv + criteria.csv dumped from the published grid release (see gen header)
    python football-logic-generate.py            # -> questions.json + review.csv
    python football-logic-insert.py <DATABASE_URL> https://<project>.supabase.co/storage/v1/object/public

The insert script publishes the rows (`ranked_eligible = true` is required by the
daily picker), sets `footballLogic.questionCount` to 5 (3 easy / 1 medium / 1 hard per round), and writes
`inserted-ids.<db>.json` for rollback. `clubs-ka.json` holds Georgian club names
(OpenRouter transliteration, reviewed) used in explanations.
