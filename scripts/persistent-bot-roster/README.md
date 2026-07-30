# Persistent bot roster generator (PR5)

Generates 1,000 permanent synthetic "players" (persistent roster bots) with
realistic Georgian identities, activity schedules, and hidden skill — behind a
**dry-run approval gate**. Nothing writes to any database until a human approves
the generated report by its sha256. Spec: `PERSISTENT-BOTS-PLAN.md` §1.2/§1.3.

## Pipeline

```
measure.ts  ──▶  patterns.json  ──▶  generate.ts  ──▶  REPORT.md + roster.csv + roster.manifest.json
 (read-only)      (checked in)        (dry-run)          (human reviews REPORT.md, approves its sha256)
                                                                      │
                                              approved sha256 + seed ─┘
                                                                      ▼
                                                   create.ts ──▶ users + ranked_profiles + synthetic_player_profiles
                                                   (staging first)    (idempotent, batched, invariant-checked)
                                                                      │
                                                        rollback.ts ──┘  (delete exactly one batch by tag)
```

## Determinism

One master seed drives everything. Each bot attribute draws from its own
per-`(bot, field)` sub-stream, derived as `hash(masterSeed, botIndex, field)`
via an xmur3-mixed mulberry32 (see `prng.ts`). Regenerating with the same seed
against the same `patterns.json` reproduces the **identical** roster, so the
creation script rebuilds exactly what was approved. The report embeds the seed;
`create.ts` refuses to run unless `--seed` matches it and `--approved-report`
matches the report file's sha256.

The `patterns.json` freezes the case-insensitive nickname exclusion set
(all `users.nickname` ∪ `nickname_history` old+new) captured at measurement time.
The generator and the creation script use this frozen snapshot so a name free at
approval cannot silently become taken (by a live signup) before creation, which
would otherwise diverge the reproducible sequence. Creation additionally runs a
live final-collision check as a separate post-pass, skipping any name that became
taken and warning to re-measure.

## Commands

```bash
# 1. Measure real patterns (READ-ONLY; never touches DATABASE_URL).
#    Point at a read-only DB role; the wrapper runs BEGIN READ ONLY + verifies
#    SHOW transaction_read_only='on'.
ROSTER_MEASURE_DATABASE_URL='postgres://…pooler…' \
  npm run roster:measure -- --out scripts/persistent-bot-roster/patterns.json

# 2. Generate the dry-run report + CSV + manifest (no DB writes).
npm run roster:generate -- --seed 20260728 --count 1000 \
  --patterns scripts/persistent-bot-roster/patterns.json \
  --out-dir scripts/persistent-bot-roster/out

# 3. HUMAN REVIEW: read out/REPORT.md, note its sha256.

# 4. Create on STAGING after approval. The MANIFEST is the single source of truth
#    (binds report/patterns/seed/count/exclusion + a digest of ALL rows). Creation
#    regenerates and matches the digest, runs the app nickname moderator over every
#    name, and inserts all 1,000 in ONE transaction (fail-closed on any collision).
#    It writes a per-environment RECEIPT next to the manifest.
DATABASE_URL='postgres://…staging…' \
  npm run roster:create -- \
    --manifest scripts/persistent-bot-roster/out/roster.manifest.json \
    --report   scripts/persistent-bot-roster/out/REPORT.md \
    --patterns scripts/persistent-bot-roster/patterns.json \
    --approved-report <sha256-of-REPORT.md> \
    --batch roster-2026-07-28

# 5. Roll back a batch (receipt-driven; deletes ONLY the receipt's ids).
DATABASE_URL='postgres://…staging…' \
  npm run roster:rollback -- \
    --receipt  scripts/persistent-bot-roster/out/receipt-roster-2026-07-28.json \
    --manifest scripts/persistent-bot-roster/out/roster.manifest.json \
    --patterns scripts/persistent-bot-roster/patterns.json
```

`--dry` on create/rollback verifies the gate and reports what WOULD happen
without writing. Typecheck the scripts with `npm run lint:roster`.

## What creation writes (per bot)

- `users`: `is_ai=true`, `ai_kind='persistent'`, `coins=0`, `tickets=0`,
  `tickets_refill_started_at=NULL` (neutralized refill — the global refill cron
  already excludes `is_ai`), no `email`, no `user_identities` (bots can't auth).
- `ranked_profiles`: byte-for-byte the `ranked.repo.ensureProfile` unplaced
  defaults — `rp=450`, `tier='Youth Prospect'`, `placement_status='unplaced'`.
- `synthetic_player_profiles`: hidden `base_skill`/band, `consistency`,
  `speed_offset`, `category_affinities` (keyed on real hyphenated slugs),
  `schedule` (carries `{batch, manifestDigest}`), `daily_cap` (sampled jointly
  with the schedule archetype), city/coords, `favorite_club`, `rename_propensity`,
  JS-safe `personality_seed`.

## Rollback provenance

`create.ts` writes a **receipt** (`receipt-<batch>.json`) listing the created user
ids + the manifest digest. `rollback.ts` deletes ONLY those ids, and inside one
locking transaction verifies per id: `is_ai` + `ai_kind='persistent'`, no
identity, `schedule.batch` matches, and the nickname matches the regenerated
manifest row. It refuses any bot with an active reservation / hosted lobby / live
match, and refuses bots carrying gameplay history (match_players / friendships /
ranked_rp_changes) unless `--force`. **Receipts are per-environment** — a staging
receipt lists staging ids; use the prod receipt to roll back prod.

## Measured vs OVERRIDDEN

The report labels every distribution as MEASURED (mimics real data) or OVERRIDDEN
(a deliberate divergence from a contaminated/artifact signal):

- **Country — OVERRIDDEN.** Raw country is FI-dominated (geoip default on
  never-named signups); the product is Georgian-first, so the generator imposes a
  GE-dominant distribution.
- **Avatar hair — OVERRIDDEN.** Raw hair is ~92% the app default; flattened to a
  plurality for variety.
- **Rename propensity — OVERRIDDEN.** Staging under-samples renames (young data);
  uses the plan's ~12% lifetime target.
- **Name structure cohort.** Measured over the 122 real users who both chose a
  nickname AND played a match — the population bots impersonate. Rates under ~3%
  (Georgian-script, underscore) are treated as rare/presence-only given the small
  sample.
```
