# Daily content playbook

Run this before (and periodically after) any daily challenge or mini-game goes to
players. One command produces the numbers; the checklist says what "good" means.

    python scripts/daily-content-audit/daily_content_audit.py <DATABASE_URL> out.json 4
    # venv needs: psycopg certifi   (prod: use the pooler URL, port 6543)

## Checklist per game mode

1. **Supply.** `pool / per_day ≥ 120` (4 months without a repeat). The pool is what
   the daily picker can actually see: published, public, ranked-eligible, in an
   active non-featured category, and inside the config's `categoryIds` (empty = all).
   Fix: add content, or widen `daily_challenge_configs.settings.categoryIds`.
2. **Difficulty spread.** Target mostly easy, some medium, few hard (Football Logic
   enforces 3/1/1 per round in the picker; other modes rely on the pool mix).
3. **Locales.** Zero missing `en`/`ka`/`es` on every text field: prompt, explanation,
   options, items, clues, matchup names, display answer. Accepted answers must include
   a Georgian spelling. The built-in translator fills Georgian only; Spanish gaps are
   filled with `translate_es.py` (see Spanish section below).
4. **Answers.** Typed-answer modes (Who Am I, Career Path, Football Logic): accepted
   answers cover full name, family name, accentless and Georgian; the web matcher adds
   1–2 typo tolerance and whole-word (surname-only) matches.
5. **Images.** Every image URL returns 200, lives in our bucket (no Wikimedia
   hotlinks: they skip the optimizer and can vanish), is ≤ 500 KB at rest, and the
   UI renders it with `object-contain` so crests/flags are never cropped. SVG flags
   pass through the Supabase transform as WebP; nothing SVG may hit `/_next/image`.
6. **Facts.** Content is either data-backed (Football Logic, Career Path club
   chains, grid boards: computed from the Transfermarkt dataset with uniqueness
   checks) or agent-generated and passed through the publish validator + the
   question-quality program (quarantine of unverifiable items). New pools must say
   which of the two they are; "written from memory" is not a source.
7. **Freshness.** Chains, "current club", season-bound facts re-checked each summer
   window against the latest Transfermarkt drop (2026-27 done 2026-09-05).

## Spanish fill

`scripts/football-logic-content/../translate_es.py <db> apply <question_type…>` walks
every `{en,…}` object lacking `es`, translates via OpenRouter (proper nouns kept,
countries/tournaments localised), writes only empty fields, keeps snapshots.

## Where the numbers came from (2026-09-05 prod run)

See `scripts/daily-content-audit/prod_audit_2026-09-05.json` and the artifact report
shared in chat.
