# Persistent Bot Roster — DRY-RUN REPORT

> **APPROVAL REQUIRED.** Nothing has been written to any database. Review this
> report in full. To create this exact roster, run the creation script with the
> report hash and the seed below:
>
> ```
> tsx scripts/persistent-bot-roster/create.ts \
>   --approved-report <sha256-of-THIS-file> \
>   --seed 20260727 \
>   --patterns scripts/persistent-bot-roster/patterns.json
> ```
>
> The creation script recomputes this file's sha256 and refuses to run unless it
> matches `--approved-report`, and refuses unless `--seed` matches the seed the
> report was generated with. The approved report hash + seed + the checked-in
> patterns.json reproduce this identical roster.

- **Seed:** `20260727`
- **Roster size:** 1000
- **patterns.json measured against:** postgresql://postgres.nsdfiprfmhdqhbfxfwpv:***@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
- **patterns.json generated at:** 2026-07-27T19:11:47.376Z
- **Frozen exclusion set:** 23489 names, sha256 `de7ea7c59a59b57fa7a62b754e0280edd79da96e65ebbcfcdf9b28b33f7f1dd9`

## Cohort & methodology

- Real users with an identity: **11245**
- ...with a chosen (non-null) nickname: **152**
- ...named AND ever played a match (name-pattern cohort): **122**
- Distinct real users who ever played a match: **6190**

Name STRUCTURE (word count, casing, digit/separator rates, trailing-digit tokens) is
measured over the **named-and-played** cohort (n=122) — the population the
bots impersonate. The ~11k never-named signups carry no name signal and are excluded.
Small-n caveat: at this sample size, rates under ~3% (e.g. Georgian-script, underscore)
are 1–2 people and are treated as rare/presence-only, deliberately not reproduced at their
exact single-user frequency.

Effective name space probe: 3533 distinct names in 5000 independent
draws (70.7% unique) — the reachable space comfortably exceeds
roster size + exclusion set, so rejection sampling rarely re-draws.

## OVERRIDDEN distributions (deliberate divergence from measured data)

These fields do NOT mimic the raw measurement because the raw signal is a
contaminated artifact. Approving this report attests to these decisions.

### Country — OVERRIDDEN

Raw country is FI-dominated: geoip defaults ~97% of never-named signups to FI (0 Georgian-script names among them). The product is Georgian-first, so the generator imposes a GE-dominant distribution with a small international tail. This is a deliberate override of a measurement artifact, not a mimic of measured data.

Raw measured (top): FI 10863, GE 297, US 25, (null) 22, GB 14, GR 6, TR 5, DE 4

Imposed target: GE 85, US 3, GB 3, TR 2, GR 2, DE 2, ES 3

### Avatar hair — OVERRIDDEN

Raw hair is ~92% the app-default `hair_boy_basic` — an artifact of
most users never customizing. Reproducing it would make 1,000 bots look copy-pasted, so
the default is flattened to a plurality and other hairstyles are lifted to a visible floor.

### Rename propensity — OVERRIDDEN

Staging under-samples renames (measured 1.32% — very young data). The
generator uses the plan target lifetime rename rate of 12%.

## Distribution summaries (generated vs measured)

### Name structure

| feature | measured | generated |
|---|---|---|
| single-word | 66.4% | 60.8% |
| two-word (first+last) | 33.6% | 39.2% |
| has digit | 11.5% | 16.5% |
| has space | 33.6% | 39.2% |
| all-lowercase | 34.4% | 36.6% |
| Georgian-script | 1.6% | 1.0% |

### Country

| value | measured share | generated share |
|---|---|---|
| GE | 85.0% | 87.2% |
| US | 3.0% | 2.4% |
| GB | 3.0% | 2.5% |
| TR | 2.0% | 2.0% |
| GR | 2.0% | 1.8% |
| DE | 2.0% | 1.3% |
| ES | 3.0% | 2.8% |

### Skill bands

| band | target | generated |
|---|---|---|
| B1 (bottom) | 20.0% | 21.1% |
| B2 | 30.0% | 29.6% |
| B3 | 30.0% | 27.4% |
| B4 | 15.0% | 16.6% |
| B5 (top) | 5.0% | 5.3% |

### Schedule archetypes

| archetype | target | generated |
|---|---|---|
| evening (17:00–1:00) | 51.5% | 49.6% |
| daytime (11:00–17:00) | 34.7% | 34.9% |
| morning (7:00–11:00) | 10.9% | 11.3% |
| night_owl (0:00–2:00) | 3.0% | 4.2% |

### Daily match cap

| cap | generated |
|---|---|
| 2 | 52.0% |
| 3 | 21.8% |
| 10 | 15.1% |
| 15 | 9.9% |
| 21 | 1.2% |

### Sparse fields (mimicking real coverage)

- favorite_club non-null: measured 0.84%, generated 1.2%
- avatarCustomization present: generated 4.2% (real coverage is sparse)
- will rename over season: generated 11.8% (target 12%)

## Sample of 30 generated identities

| # | nickname | country | city | club | band | cap | schedule | rename |
|---|---|---|---|---|---|---|---|---|
| 0 | sopho vashaliani | GE | Poti |  | B1 (bottom) | 15 | morning | yes |
| 33 | IuriT | GE | Tbilisi |  | B2 | 2 | evening |  |
| 66 | Lado Qoridshvili | GE | Tbilisi |  | B2 | 10 | morning |  |
| 99 | striker | GE | Rustavi |  | B3 | 15 | morning |  |
| 132 | zaza inasaridze | GE | Telavi |  | B2 | 2 | morning |  |
| 165 | temuruna22 | GE | Gori |  | B4 | 2 | evening |  |
| 198 | Koka Eliashvili | GE | Tbilisi |  | B5 (top) | 2 | daytime |  |
| 231 | cf | GE | Ozurgeti |  | B2 | 2 | daytime | yes |
| 264 | MishaB | GE | Batumi |  | B3 | 2 | daytime |  |
| 297 | Reziika.baller | GE | Zugdidi |  | B5 (top) | 2 | evening |  |
| 330 | koka samkharidze | GE | Kutaisi |  | B2 | 2 | daytime |  |
| 363 | Vakhoiko | ES | Barcelona |  | B2 | 2 | evening |  |
| 396 | Iuri Mamulidze | GE | Telavi |  | B1 (bottom) | 10 | evening |  |
| 429 | Roin Ubilua | GE | Gori |  | B1 (bottom) | 2 | evening |  |
| 462 | Ilia Rustavadze | GE | Kutaisi |  | B4 | 3 | evening | yes |
| 495 | Koka69 | GE | Akhaltsikhe |  | B1 (bottom) | 2 | daytime |  |
| 528 | კოკა | GE | Poti |  | B2 | 15 | evening |  |
| 561 | tornike ubiliani | GE | Zugdidi |  | B3 | 2 | evening |  |
| 594 | Ramaz Tsagurishvili | GE | Tbilisi |  | B2 | 2 | evening |  |
| 627 | peikrishvili | GE | Telavi |  | B1 (bottom) | 2 | night_owl |  |
| 660 | lukaska | GE | Akhaltsikhe |  | B4 | 3 | daytime |  |
| 693 | davitd | GE | Kutaisi |  | B1 (bottom) | 3 | evening |  |
| 726 | lika dgebshvili | GE | Ozurgeti |  | B2 | 15 | evening |  |
| 759 | Mamuka Ratianashvili | GE | Akhaltsikhe |  | B2 | 3 | evening |  |
| 792 | hamsik971 | GE | Poti |  | B3 | 3 | evening | yes |
| 825 | dataa | GB | Birmingham |  | B3 | 10 | evening |  |
| 858 | Shalva Chanturishvili | GE | Rustavi | Real Madrid | B3 | 2 | evening | yes |
| 891 | luka ubilidze | GE | Batumi |  | B4 | 2 | evening |  |
| 924 | elgujao | GE | Tbilisi |  | B3 | 2 | evening |  |
| 957 | Nugzar Zumbulidze | GR | Thessaloniki |  | B3 | 10 | evening |  |

## Full roster

All 1000 rows are in the accompanying `roster.csv` (same seed, same run).

## Invariants the creation script will enforce post-write

- Exactly this many `users` rows with `is_ai=true`, `ai_kind='persistent'`.
- Every roster user has `coins=0`, `tickets=0`, `tickets_refill_started_at=NULL`.
- Zero `user_identities` rows for any roster user (bots cannot authenticate).
- Every roster user has a `ranked_profiles` row: `rp=450`, `placement_status='unplaced'`.
- Every roster user has a `synthetic_player_profiles` row tagged with the generation batch.
- All nicknames unique (case-insensitive) and absent from the frozen exclusion set;
  a live final-collision re-check runs against current data as a separate pass.

