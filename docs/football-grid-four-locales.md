# Tic Tac Toe answers in four interface languages

The interface locale is now carried as `en`, `ka`, `es` or `tr` through searches, practice starts, commands, attempt history, accepted claims and queue analytics. The shared alias pool is independent of the interface language: a reviewed Georgian alias is accepted in the Spanish UI, and a canonical Latin name is accepted in the Georgian UI, if that player belongs in the selected cell.

Content imports may contain explicitly reviewed ES/TR aliases alongside EN/KA and transliteration aliases. Existing Latin names are used in English, Spanish and Turkish; duplicating every Latin alias into three locale rows is unnecessary. A new language tag does not invent translations or nicknames.

## Matching and content checks

Accent stripping and Georgian case normalization remain unchanged. After checking existing exact normalized identities, the resolver now checks Turkish dotted/dotless i keyboard forms and German ß/SS case forms. Existing exact identities remain authoritative, multiple qualifying owners remain ambiguous, and already-used players remain unavailable. This fallback does not enable arbitrary fuzzy matching. Published alias keys and checksums are not rewritten.

The display-name coverage check is part of `validateManifest`, which is used before publishing. It checks canonical Latin and Georgian names, Spanish/Turkish uppercase forms, and Georgian uppercase against the shared alias pool without relying on typo matching. Run it separately with:

```sh
npx tsx scripts/football-grid-locale-coverage.ts MANIFEST.json NEW_REPORT.json
```

On the retained 21 September production release exports, 24,390 forms across 4,878 European player records and 6,255 forms across 1,251 themed player records pass. Records overlap between releases. The first run exposed six uppercase failures across Stefan Kießling, Kevin Großkreutz and Pascal Groß; the orthographic fallback fixes those. These are stored-name coverage checks, not independent verification of every Georgian translation, nickname or football fact. Historical and alias curation remain necessary.

## Deployment and rollback

1. Apply both migrations through the normal runner. The first widens four locale CHECK constraints using NOT VALID to avoid scans under the brief exclusive lock. The second validates them in a separate transaction under a weaker lock. Both have a two-second lock timeout; retry a failed migration after contention clears. No tables, rows, aliases, balances or historical attempts are deleted or rewritten. RLS/grants are unchanged.
2. Deploy the backend to staging and wait for all replicas to finish. Verify Spanish/Turkish searches, guest practice, answers and persisted locales.
3. Deploy the companion web change; it sends the actual UI locale instead of mapping ES/TR to EN. Test one accepted name and one invalid answer in each language, plus a shared surname and a repeated player. Only then promote the same changes backend-first to production.
4. Keep the widened database checks if rolling back. Prefer a forward backend fix once clients send ES/TR: an older backend rejects those client requests and cannot recover ES/TR queue snapshots. Reverting the web first reduces new affected clients but does not replace pages already open; it is not a seamless backend rollback. Content release activation is separate and is unchanged by this code release.

## Verification

- 251 Grid/backend tests passed, including 65 database-backed runtime tests on the isolated `rehearsal_grid_locales_20260922` database. Sixteen exercise every input-alias/interface-language combination and check locale persistence in the inbox, attempts and claims.
- Backend application typecheck passed.
- Companion web: 19 focused tests, typecheck and changed-file lint passed.
- No production or staging writes were made during this implementation.
