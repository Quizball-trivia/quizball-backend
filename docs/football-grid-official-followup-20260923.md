# Confirmed historical answer corrections — 23 September

This batch corrects 63 missing relationships for 38 existing player identities,
individually checked against 30 official UEFA, Premier League and club records.
It is separate from the unapproved 1,301-fact historical archive proposal.
The versioned fact list retains the citation and factual basis for each
club, league, manager or club-teammate relationship. Teammate evidence records
actual appearances, not merely overlapping squad membership.

## Scope and preparation

The existing correction CLI accepts an explicit final batch argument:

```sh
npx tsx scripts/football-grid-answer-corrections.ts SOURCE.json SAME_ENVIRONMENT_CATALOG.json DRAFT.json NEW_VERSION official-rejections-20260923
```

Omitting the argument retains the original September 21 correction. Unknown
batches fail. The new batch may follow the original correction, but cannot be
applied twice. It cannot approve an unrelated pending historical source.
When the source predates the original correction, the batch also unions those
five already reviewed player corrections and the same surname repair. Existing
memberships are skipped, so production's current baseline remains unchanged;
staging can reach the same corrected answer sets directly from its original
non-research sources without publishing intermediate releases.
Preparation remains offline and outputs a pending review package. Publishing
re-exports the live source and catalog and recomputes the exact selected batch;
modified facts, identities, aliases or source content fail that comparison.

## Production-snapshot verification

Against releases 2026092221 and 2026092222:

| Pack | Added relationships | Added display records | Added answer entries | Removed answers |
| --- | ---: | ---: | ---: | ---: |
| European | 58 | 0 | 1,991 | 0 |
| Themed | 50 | 6 | 879 | 0 |

Relationships shared across packs account for the 108 entries from 63 unique
facts. The six display records and 18 aliases come from the same environment's
existing European catalog; no new player UUID is invented. Existing aliases,
answers, board keys, recognizable samples and difficulty labels are preserved.

Replaying the snapshot captured 22 September at 20:21 UTC covered 10,719
submissions, including 206 passes. All 5,604 previously correct answers retain
their resolved player. Compared with the currently served corrected releases,
**115 additional human submissions change from wrong to correct**. Another 142
old rejections were already corrected by the previous release. No ambiguous or
already-used outcome becomes an arbitrary accepted player.

All 11,480 added-answer checks pass using complete cell answer sets: canonical
English and Georgian names, plus Spanish and Turkish uppercase forms. This
does not establish exhaustive nickname or transliteration coverage.

## Rollout and rollback

1. Merge the reviewed tooling through staging before production promotion.
2. Export fresh source/catalog manifests in each target environment and prepare
   this exact batch. Keep staging's broader research releases and their data.
3. Review the citations and draft, then use the explicit approval command.
4. Import as non-playable. Copy ES/TR labels from the source, carry current board
   quarantines by canonical checksum, and verify every imported portrait.
5. Rehearse on staging: valid and invalid answers, ambiguous surnames, repeated
   players, all four locales and pinned old matches. Confirm no new validation
   findings compared with the source.
6. For production, activate only the verified candidates, then atomically switch
   release exclusions. Keep old releases for pinned matches and rollback.
7. Rollback changes only release selection: re-enable the previous pair and
   disable this pair. Never restore the entire database or rewrite old attempts.

No schema migration or runtime resolver change is required for this batch.
The main modern appearance snapshot still ends on **28 June 2026**. This
correction does not establish complete 1990–2012, 1950–1989, or July–August 2026
coverage. Those gaps remain explicit in the historical coverage audit.
