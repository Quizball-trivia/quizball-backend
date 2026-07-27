# Persistent Bot Roster — DRY-RUN REPORT

> **APPROVAL REQUIRED.** Nothing has been written to any database. Review this
> report in full. To create this exact roster, approve it by passing this file's
> sha256 to the creation script, which consumes the accompanying manifest as its
> single source of truth:
>
> ```
> tsx scripts/persistent-bot-roster/create.ts \
>   --manifest scripts/persistent-bot-roster/out/roster.manifest.json \
>   --report  scripts/persistent-bot-roster/out/REPORT.md \
>   --patterns scripts/persistent-bot-roster/patterns.json \
>   --approved-report <sha256-of-THIS-file> \
>   --batch <unique-batch-id>
> ```
>
> The manifest binds the report hash, patterns hash, seed, count, exclusion
> snapshot, and a digest of ALL rows. Creation refuses to run unless (a) the report
> bytes hash to `--approved-report` AND to `manifest.reportSha256`, (b) the supplied
> patterns.json hashes to `manifest.patternsSha256`, and (c) regenerating from the
> manifest seed/count reproduces `manifest.rosterSha256`. There are no independent
> patterns/count inputs that could pair an approved report with a different roster.

- **Roster digest (manifest.rosterSha256):** `b599d79af8ca1d1c83a8827677d833c5e2bcc7b3c2d91917ffef9f682ee54609`
- **Seed:** `20260728`
- **Roster size:** 1000
- **patterns.json measured against:** postgresql://postgres.nsdfiprfmhdqhbfxfwpv:***@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
- **patterns.json generated at:** 2026-07-27T20:44:46.908Z
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

Effective name space probe: 3608 distinct names in 5000 independent
draws (72.2% unique) — the reachable space comfortably exceeds
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

### Activity archetype MIX — OVERRIDDEN (session/cap distributions MEASURED)

Per-user sessionization runs over 6091 players, and each archetype's
session-length and daily-cap distributions are MEASURED from its members. The archetype
MIX WEIGHTS, however, are imposed to the plan design (evening-dominant, night-owl a
~3% minority): the per-user modal-hour signal is contaminated — a timestamp artifact
parks ~46% of users at exactly 00:00 Tbilisi — so weighting the mix by measured modal
hours would be meaningless. Night-owl caps are additionally clamped below the plan's
15-match ceiling.

## Distribution summaries (generated vs measured)

### Name structure

| feature | measured | generated |
|---|---|---|
| single-word | 66.4% | 63.0% |
| two-word (first+last) | 33.6% | 37.0% |
| has digit | 11.5% | 18.4% |
| has space | 33.6% | 37.0% |
| all-lowercase | 34.4% | 39.1% |
| Georgian-script | 1.6% | 1.0% |

### Country

| value | measured share | generated share |
|---|---|---|
| GE | 85.0% | 84.2% |
| US | 3.0% | 3.7% |
| GB | 3.0% | 3.1% |
| TR | 2.0% | 1.9% |
| GR | 2.0% | 0.9% |
| DE | 2.0% | 1.8% |
| ES | 3.0% | 4.4% |

### Skill bands

| band | target | generated |
|---|---|---|
| B1 (bottom) | 20.0% | 20.4% |
| B2 | 30.0% | 29.4% |
| B3 | 30.0% | 29.9% |
| B4 | 15.0% | 15.0% |
| B5 (top) | 5.0% | 5.3% |

### Schedule archetypes (per-user sessionization, §1.3)

Archetypes are clustered from **per-user** activity: each of the
6091 real players' match-start sequences was segmented into sessions
on 20-minute gaps, and each user assigned to an hour-band archetype by modal hour. The
daily cap is drawn JOINTLY from the chosen archetype's own cap quantiles, so a night-owl
can never receive a high day cap. The aggregate histogram (below) is disclosure only.

| archetype | window | target | generated | cap p50/p90 |
|---|---|---|---|---|
| evening | 17:00–01:23 | 55.0% | 54.0% | 2/10 |
| daytime | 11:00–17:00 | 30.0% | 30.1% | 6/8 |
| morning | 7:00–11:00 | 12.0% | 12.4% | 10/12 |
| night_owl | 0:00–5:00 | 3.0% | 3.5% | 8/8 |

### Daily match cap by archetype (joint sampling check)

| archetype | max generated cap | mean cap |
|---|---|---|
| evening | 20 | 5.5 |
| daytime | 21 | 7.7 |
| morning | 13 | 10.9 |
| night_owl | 8 | 8.0 |

### Sparse fields (mimicking real coverage)

- favorite_club non-null: measured 0.84%, generated 0.8%
- avatarCustomization present: generated 4.4% (real coverage is sparse)
- will rename over season: generated 11.0% (target 12%)

## Sample of 30 generated identities

| # | nickname | country | city | club | band | cap | schedule | rename |
|---|---|---|---|---|---|---|---|---|
| 0 | TasoN | GE | Gori |  | B2 | 21 | daytime |  |
| 33 | ElgujaD | GE | Zugdidi |  | B2 | 10 | evening |  |
| 66 | Eka Chanturieli | GE | Poti |  | B2 | 2 | evening |  |
| 99 | JabaR | US | New York |  | B2 | 8 | evening | yes |
| 132 | hamsikika | GE | Ozurgeti |  | B2 | 6 | daytime |  |
| 165 | Tazo | GE | Rustavi |  | B2 | 2 | evening |  |
| 198 | Anaka | GE | Kutaisi |  | B4 | 10 | evening |  |
| 231 | Gochaka111 | ES | Madrid |  | B3 | 10 | evening |  |
| 264 | datunaika | GE | Rustavi |  | B1 (bottom) | 12 | morning |  |
| 297 | nikoz | GE | Tbilisi |  | B1 (bottom) | 10 | evening |  |
| 330 | Temuri Nachkebshvili | GE | Zugdidi |  | B2 | 10 | morning |  |
| 363 | Zezva | GE | Poti |  | B4 | 10 | morning |  |
| 396 | nikouna | GR | Thessaloniki |  | B2 | 10 | evening |  |
| 429 | Sergo Mgelidze | GE | Akhaltsikhe |  | B5 (top) | 8 | evening |  |
| 462 | kako | GE | Gori |  | B5 (top) | 8 | night_owl | yes |
| 495 | zuriko lesgashvili | GE | Rustavi |  | B3 | 21 | daytime |  |
| 528 | jabaka14 | GE | Zugdidi |  | B3 | 2 | evening |  |
| 561 | Bachana Ugreliadze | GE | Poti |  | B1 (bottom) | 8 | evening |  |
| 594 | Zviad Lobzhua | GE | Tbilisi |  | B2 | 6 | daytime |  |
| 627 | Nika Lezhavshvili47 | TR | Izmir |  | B2 | 7 | daytime | yes |
| 660 | Mamuka Ubilshvili | GR | Thessaloniki |  | B2 | 8 | daytime |  |
| 693 | ZurikoZ | GE | Batumi |  | B3 | 2 | evening |  |
| 726 | anaz | GE | Batumi |  | B1 (bottom) | 8 | night_owl | yes |
| 759 | Zura Chkhikvshvili | DE | Berlin |  | B3 | 6 | daytime |  |
| 792 | Lasha Ugulshvili | GE | Gori |  | B2 | 10 | evening |  |
| 825 | sophoo23 | GE | Poti |  | B2 | 6 | daytime |  |
| 858 | Sopho Ugreliidze | US | Los Angeles |  | B1 (bottom) | 8 | evening |  |
| 891 | Tamta Nachkebidze164 | GE | Kutaisi | Real Madrid | B4 | 6 | daytime |  |
| 924 | kaka111 | GE | Poti |  | B3 | 20 | evening |  |
| 957 | Sopho Gogichshvili | GE | Kutaisi |  | B2 | 8 | evening | yes |

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

