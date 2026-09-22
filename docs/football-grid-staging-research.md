# Historical answer rehearsal on staging

Historical source review is still pending. A rehearsal must not change that status or grant production approval. The content CLI accepts a manifest with pending sources only with `--staging-research`, an explicit `stagingResearchOnly` marker, and the exact Quizball staging database identity. Normal publication and production targets reject it. Export preserves the database's source-review status.

The snapshot must declare `historical-staging-rehearsal-v1`, the staging project ref, original release version, immutable release ID/stored checksum, and the canonical digest of a fresh source export. Publish and activate require `--transformed-from VERSION --staging-source SOURCE.json`. The source must remain published. Existing sources, players, memberships, aliases, assets, board definitions and answers are retained. Only existing validator findings carry over; all new findings block. Asset files are still verified at activation.

1. Export both served staging releases, retaining their database identities/checksums.
2. Prepare confirmed answer corrections and cross-checked historical additions offline. Retain the pending source-review records and evidence. Save checksums and an additive comparison.
3. Run locale/name and historical-submission regression checks. Build/verify an asset registry.
4. Publish new versions with the explicit research flags; they initially remain non-playable.
5. Carry criterion locale labels and effective board quarantines from their corresponding source releases.
6. Activate, then disable the old releases with reversible release-level quarantine events. Preserve the old records for pinned matches and rollback.
7. Smoke test actual matches, correct/wrong answers and persisted locale/diagnostics in English, Georgian, Spanish and Turkish. Capture desktop/mobile boards.
8. Roll back by enabling the old releases and disabling the new ones in one transaction; do not delete content or gameplay rows.

This path is for staging review only. It does not certify complete historical coverage, football facts, portraits or source reuse. Production requires a separately reviewed normal manifest and explicit promotion approval.
